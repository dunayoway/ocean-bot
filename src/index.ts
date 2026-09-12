import { ethers } from "ethers";
import fs from "fs";
import errorMessage from "./errorMessage.js";
import { createSmartAccount, sendUserOp } from "./userOp.js";
import { startHover } from "./oceanHawk.js";
import "dotenv/config";

// Load environment variables
const ALCHEMY_ETH_RPC_URL = process.env.ALCHEMY_ETH_RPC_URL;
const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY;
const VAULT_WALLET_ADDRESS = process.env.VAULT_WALLET_ADDRESS;
const TOKEN_CONTRACT_ADDRESS = process.env.TOKEN_CONTRACT_ADDRESS;
const STAKING_CONTRACT_ADDRESS = process.env.STAKING_CONTRACT_ADDRESS;
const API_KEY = process.env.API_KEY;
const POLICY_ID = process.env.POLICY_ID;

if (
  !ALCHEMY_ETH_RPC_URL ||
  !WALLET_PRIVATE_KEY ||
  !VAULT_WALLET_ADDRESS ||
  !TOKEN_CONTRACT_ADDRESS ||
  !STAKING_CONTRACT_ADDRESS ||
  !API_KEY ||
  !POLICY_ID
) {
  throw new Error("❌ Missing Required Environment Variables!");
}

// Initialize provider and signer
const provider = new ethers.JsonRpcProvider(ALCHEMY_ETH_RPC_URL);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

// Initialize contracts
interface ContractAbis {
  oceanAbi: ethers.InterfaceAbi;
  veOceanAbi: ethers.InterfaceAbi;
}

const abi: ContractAbis = JSON.parse(
  fs.readFileSync("./constants.json", "utf-8"),
);
const oceanAbi = abi.oceanAbi;
const veOceanAbi = abi.veOceanAbi;
const ocean = new ethers.Contract(TOKEN_CONTRACT_ADDRESS, oceanAbi, wallet);
const veOcean = new ethers.Contract(
  STAKING_CONTRACT_ADDRESS,
  veOceanAbi,
  wallet,
);

// Types for the shapes passed between helpers
interface TokenInfo {
  tokenSymbol: string;
  tokenDecimals: number;
}

interface LockInfo {
  amount: bigint;
  end: number;
}

interface CallData {
  unstakeTxCallData: string;
  transferTxCallData: string;
}

const getTokenInfo = async (): Promise<TokenInfo | undefined> => {
  try {
    const tokenSymbol: string = await ocean.symbol();
    const tokenDecimals: number = await ocean.decimals();
    return { tokenSymbol, tokenDecimals };
  } catch (error) {
    console.error("❌❌ Error Getting Token Info:", errorMessage(error));
    return undefined;
  }
};

const getLockInfo = async (
  blockTime: number,
  tokenSymbol: string,
  tokenDecimals: number,
): Promise<LockInfo | undefined> => {
  try {
    const lock = await veOcean.locked(wallet.address);
    const amount: bigint = lock.amount;
    const end = Number(lock.end); // Convert BigInt timestamp to number
    const timeLeft = end - blockTime;
    // Convert to human-readable format
    const days = Math.floor(timeLeft / 86400);
    const hours = Math.floor((timeLeft % 86400) / 3600);
    const minutes = Math.floor((timeLeft % 3600) / 60);
    const seconds = timeLeft % 60;
    console.log(
      `💰 Lock Amount: ${ethers.formatUnits(
        amount,
        tokenDecimals,
      )} ${tokenSymbol}\n⌚️ Lock End Time: ${new Date(
        end * 1000,
      ).toLocaleString()}\n⏰ Time Left: ${days}d ${hours}h ${minutes}m ${seconds}s`,
    );
    return { amount, end };
  } catch (error) {
    console.error("❌❌ Error Getting Lock Info:", errorMessage(error));
    return undefined;
  }
};

const getCallData = async (amount: bigint): Promise<CallData | undefined> => {
  try {
    const unstakeTxCallData = veOcean.interface.encodeFunctionData("withdraw");
    const transferTxCallData = ocean.interface.encodeFunctionData("transfer", [
      VAULT_WALLET_ADDRESS,
      amount,
    ]);
    return { unstakeTxCallData, transferTxCallData };
  } catch (error) {
    console.error("❌❌ Error Getting Calldata:", errorMessage(error));
    return undefined;
  }
};

const main = async (): Promise<void> => {
  console.log(
    "------------------------------------------------------------------------------",
  );

  const smartAccountClient = await createSmartAccount();
  if (!smartAccountClient) {
    console.warn("‼️ No Smart Account Client! Exiting...");
    return;
  }

  const tokenInfo = await getTokenInfo();
  if (!tokenInfo) {
    console.warn("‼️ No Token Info Found! Exiting...");
    return;
  }
  const { tokenSymbol, tokenDecimals } = tokenInfo;

  startHover(
    TOKEN_CONTRACT_ADDRESS,
    ocean,
    tokenDecimals,
    tokenSymbol,
    smartAccountClient,
  );

  let withdrawalInProgress = false;
  provider.on("block", async (blockNumber: number) => {
    console.log(
      "------------------------------------------------------------------------------",
    );

    const block = await provider.getBlock(blockNumber);
    if (!block) {
      console.warn("‼️ Could Not Fetch Block! Skipping...");
      return;
    }
    const blockTime = block.timestamp;

    const lockInfo = await getLockInfo(blockTime, tokenSymbol, tokenDecimals);
    if (!lockInfo) {
      console.warn("‼️ No Lock Info Found! Skipping This Block...");
      return;
    }
    const { amount, end } = lockInfo;
    if (amount > 0n) {
      const callData = await getCallData(amount);
      if (!callData) {
        console.warn("‼️ No Call Data! Skipping...");
        return;
      }
      const { unstakeTxCallData, transferTxCallData } = callData;
      if (blockTime >= end && !withdrawalInProgress) {
        console.log(
          "⌛️ Lock Period Has Ended. Proceeding to Unstake and Transfer Tokens...\n",
        );
        withdrawalInProgress = true;
        try {
          await sendUserOp(
            unstakeTxCallData,
            transferTxCallData,
            smartAccountClient,
            blockNumber,
          );
        } finally {
          withdrawalInProgress = false;
        }
      } else {
        console.log("⏳ Lock Period Still Active!");
      }
    } else {
      console.warn("⚠️ No Tokens to Unstake and Transfer.");
    }

    console.log(
      "------------------------------------------------------------------------------",
    );
  });
};

main().catch((error: unknown) => {
  console.error("❌ Error Running Script:", errorMessage(error));
  process.exit(1);
});
