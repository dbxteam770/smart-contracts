const TestToken = artifacts.require("TestToken.sol");
// using mock contract here, as we need to read the hasInited value
const MockKyberStaking = artifacts.require("MockStakingContract.sol");

const Helper = require("../test/helper.js");
const BN = web3.utils.BN;
const { DEPOSIT, DELEGATE, WITHDRAW, NO_ACTION } = require("./simulator/stakingActionsGenerator.js");
const { expectRevert } = require('@openzeppelin/test-helpers');
const StakeGenerator = require("./simulator/stakingActionsGenerator.js");

//global variables
//////////////////
const { precisionUnits, zeroBN } = require("../helper.js");
const NUM_RUNS = 13000;

// accounts
let admin;
let daoSetter;
let stakers;

// token
let kncToken;
let kncAddress;
const tokenDecimals = 18;

// staking and its params
let kyberStaking;
let epochPeriod = new BN(30);
let firstBlockTimestamp;

// for keeping score
let numDepositSuccess = 0;
let numDepositFail = 0;
let numDelegateSuccess = 0;
let numDelegateFail = 0;
let numWithdrawFail = 0;
let numWithdrawSuccess = 0;
let numNoActionSuccess = 0;
let numNoActionFail = 0;

contract('KyberStaking simulator', async (accounts) => {
    before('one time init: Stakers, KyberStaking, KNC token', async() => {
        admin = accounts[1];
        daoSetter = accounts[2];
        stakers = accounts;
        kncToken = await TestToken.new("kyber Crystals", "KNC", 18);
        kncAddress = kncToken.address;

        // prepare kyber staking
        firstBlockTimestamp = await Helper.getCurrentBlockTime();

        kyberStaking = await MockKyberStaking.new(
            kncToken.address,
            epochPeriod,
            firstBlockTimestamp,
            daoSetter
          );
    });

    beforeEach("deposits some KNC tokens to each account, gives allowance to staking contract", async() => {
        // 1M KNC token
        let kncTweiDepositAmount = new BN(1000000).mul(precisionUnits);
        let maxAllowance = (new BN(2)).pow(new BN(255));
        // transfer tokens, approve staking contract
        for(let i = 0; i < stakers.length; i++) {
            await kncToken.transfer(stakers[i], kncTweiDepositAmount);
            let expectedResult = await kncToken.balanceOf(stakers[i]);
            Helper.assertEqual(expectedResult, kncTweiDepositAmount, "staker did not receive tokens");
            await kncToken.approve(kyberStaking.address, maxAllowance, {from: stakers[i]});
            expectedResult = await kncToken.allowance(stakers[i], kyberStaking.address);
            Helper.assertEqual(expectedResult, maxAllowance, "staker did not give sufficient allowance");
        }
    });

    it("fuzz tests kyberStaking contract. Verify that conditions hold", async() => {
        let result;
        for(let loop = 0; loop < NUM_RUNS; loop++) {
            let operation = StakeGenerator.genNextOp();
            switch(operation) {
                case DEPOSIT:
                    result = await StakeGenerator.genDeposit(kncToken, stakers);
                    result.delegatedAddress = await kyberStaking.methods.getLatestDelegatedAddress(result.staker);
                    console.log(result.msg);
                    console.log(`Deposit: staker ${result.staker}, amount: ${result.amount}`);
                    let isValid = await executeAndVerifyDepositInvariants(kyberStaking, result);
                    incrementCount(isValid, numDepositSuccess, numDepositFail);
                    break;

                case DELEGATE:
                    result = await StakeGenerator.genDelegate(stakers);
                    console.log(result.msg);
                    console.log(`Delegate: staker ${result.staker}, address: ${result.delegatedAddress}`);
                    await kyberStaking.delegate(result.delegatedAddress, {from: result.staker});
                    let isValid = await verifyDelegateInvariants(kyberStaking, stakers, result);
                    incrementCount(isValid, numDelegateSuccess, numDelegateFail);
                    break;

                case WITHDRAW:
                    result = await StakeGenerator.genWithdraw(kyberStaking, stakers);
                    result.delegatedAddress = await kyberStaking.methods.getLatestDelegatedAddress(result.staker);
                    console.log(result.msg);
                    console.log(`Withdrawal: staker ${result.staker}, amount: ${result.amount}`);
                    if (result.isValid) {
                        try {
                            await kyberStaking.withdraw(result.amount, {from: result.staker});
                        } catch(e) {
                            console.log('Valid withdrawal, but failed');
                            console.log(e);
                            numWithdrawFail++;
                            break;
                        }
                    } else {
                        await expectRevert.unspecified(
                            kyberStaking.withdraw(result.amount, {from: result.staker})
                        );
                    }
                    let isValid = await verifyWithdrawInvariants(kyberStaking, stakers, result);
                    incrementCount(isValid, numWithdrawSuccess, numWithdrawFail);
                    break;
                case NO_ACTION:
                    console.log("Do nothing for this epoch...");
                    let isValid = await verifyNoActionInvariants(kyberStaking, stakers, result);
                    incrementCount(isValid, numNoActionSuccess, numNoActionFail);
                    break;
                default:
                    console.log("unexpected operation: " + operation);
                    break;
            }
        }

        console.log(`--- SIM RESULTS ---`);
        console.log(`Deposit: fails = ${numDepositFail}, success = ${numDepositSuccess}`);
        console.log(`Delegate: fails = ${numDelegateFail}, success = ${numDelegateSuccess}`);
        console.log(`Withdrawals: fails = ${numWithdrawFail}, success = ${numWithdrawSuccess}`);
        console.log(`Do nothing: fails = ${numNoActionFail}, success = ${numNoActionSuccess}`);
    });
});

async function executeAndVerifyDepositInvariants(staking, result) {
    let isValid = false;
    let initState = await getState(staking, result);
    let currentBlockTime = await Helper.getCurrentBlockTime();
    await Helper.setNextBlockTimestamp(
        currentBlockTime.add(new BN(10))
    );

    // do deposit
    if (result.isValid) {
        try {
            await kyberStaking.deposit(result.amount, {from: result.staker});
        } catch(e) {
            console.log('Valid deposit, but failed');
            console.log(e);
            return false;
        }
    } else {
        await expectRevert.unspecified(
            await kyberStaking.deposit(result.amount, {from: result.staker})
        );
    }

    let newState = await getState(staking, result);
    isValid = await verifyCurrentEpochConditions(DEPOSIT, initState, newState);
    if (!isValid) { return false };
}

async function getState(staking, result) {
    let res = {};
    res.epochNum = await staking.methods.getCurrentEpochNumber();
    let nextEpochNum = res.epochNum.add(new BN(1));

    res.stakerInitedCurEpoch = await staking.methods.getHasInitedValue(result.staker, res.epochNum);
    res.oldDelegateInitedCurEpoch = await staking.methods.getHasInitedValue(currStakerData.delegatedAddress, res.epochNum);
    res.newDelegateInitedCurEpoch = await staking.methods.getHasInitedValue(result.delegatedAddress, res.epochNum);

    res.stakerInitedNextEpoch = await staking.methods.getHasInitedValue(result.staker, res.epochNum);
    res.oldDelegateInitedNextEpoch = await staking.methods.getHasInitedValue(currStakerData.delegatedAddress, res.epochNum);
    res.newDelegateInitedNextEpoch = await staking.methods.getHasInitedValue(result.delegatedAddress, res.epochNum);

    res.stakerDataCurEpoch = await staking.methods.getStakerDataForPastEpoch(result.staker, res.epochNum);
    res.oldDelegateDataCurEpoch = await staking.methods.getStakerDataForPastEpoch(currStakerData.delegatedAddress, res.epochNum);
    res.newDelegateDataCurEpoch = await staking.methods.getStakerDataForPastEpoch(result.delegatedAddress, res.epochNum);

    res.stakerDataNextEpoch = await staking.methods.getStakerDataForPastEpoch(result.staker, nextEpochNum);
    res.oldDelegateDataNextEpoch = await staking.methods.getStakerDataForPastEpoch(currStakerData.delegatedAddress, nextEpochNum);
    res.newDelegateDataNextEpoch = await staking.methods.getStakerDataForPastEpoch(result.delegatedAddress, nextEpochNum);

    res.latestStakerData = await getLatestStakeData(staking, result.staker);
    res.latestOldDelegateData = await getLatestStakeData(staking, latestStakerDataBefore.delegatedAddress);
    res.latestNewDelegateData = await getLatestStakeData(staking, result.delegatedAddress);
}

async function getLatestStakeData(staking, address) {
    let res = {
        'stake': zeroBN,
        'delegatedStake': zeroBN,
        'delegatedAddress': zeroAddress
    }
    res.stake = await staking.methods.getLatestStakeBalance(address);
    res.delegatedStake = await staking.methods.getLatestDelegatedStake(address);
    res.delegatedAddress = await staking.methods.getLatestDelegatedAddress(address);
    return res;
}

async function verifyCurrentEpochConditions(operation, initState, newState) { 
    switch(operation) {
        case WITHDRAW:
            break;
        default: 
            if (initState.epochNum == newState.epochNum) {
                
            } else {
                
            }
    }
}

function incrementCount(isValid, successCount, failCount) {
    if (isValid) {
        successCount+= 1;
    } else {
        failCount+= 1;
    }
}
