import { ethers } from "ethers";
import fs from "fs";
import { createModularAccountV2Client } from "@account-kit/smart-contracts";
import { mainnet, alchemy } from "@account-kit/infra";
import { signer } from "./signer.js";
import "dotenv/config";
import { startHover } from "./oceanHawk.js";

startHover();

// Load environment variables
const ALCHEMY_ETH_RPC_URL = process.env.ALCHEMY_ETH_RPC_URL;
// const ALCHEMY_ETH_SEPOLIA_RPC_URL = process.env.ALCHEMY_ETH_SEPOLIA_RPC_URL;
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
type SmartAccountClient = Awaited<
  ReturnType<typeof createModularAccountV2Client>
>;

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const createSmartAccount = async (): Promise<
  SmartAccountClient | undefined
> => {
  try {
    // Constructing the Smart Account Client
    console.log("⚙️ Creating Smart Wallet...");
    console.log(`🔑 Signer: ${signer.inner.address}`);
    const smartAccountClient = await createModularAccountV2Client({
      mode: "7702",
      transport: alchemy({ apiKey: API_KEY }),
      chain: mainnet,
      signer,
      policyId: POLICY_ID,
    });
    return smartAccountClient;
  } catch (error) {
    console.error("❌❌ Error Creating Smart Wallet:", errorMessage(error));
    return undefined;
  }
};

const sendUserOp = async (
  unstakeTxCallData: string,
  transferTxCallData: string,
  smartAccountClient: SmartAccountClient,
  blockNumber: number,
): Promise<void> => {
  try {
    // const gasEstimate = await provider.estimateGas({
    //   from: signer.inner.address,
    //   to: STAKING_CONTRACT_ADDRESS,
    //   data: unstakeTxCallData,
    // });

    // console.log("withdraw() gas estimate:", gasEstimate.toString());
    // Sending Batch User Operations
    console.log("⚙️ Sending User Operations..");
    const uoHash = await smartAccountClient.sendUserOperation({
      uo: [
        {
          target: STAKING_CONTRACT_ADDRESS as `0x${string}`,
          value: 0n,
          data: unstakeTxCallData as `0x${string}`,
        },
        {
          target: TOKEN_CONTRACT_ADDRESS as `0x${string}`,
          value: 0n,
          data: transferTxCallData as `0x${string}`,
        },
      ],
    });
    console.log("⚙️ Awaiting Confirmation...");
    const txHash =
      await smartAccountClient.waitForUserOperationTransaction(uoHash);
    console.log(
      `✅ User Operations Sent At Block #${blockNumber}\nUserOp Hash: https://etherscan.io/tx/${txHash}`,
    );
  } catch (error) {
    console.error("❌❌ Error Sending User Operations:", errorMessage(error));
  }
};

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
    const lock = await veOcean.locked(signer.inner.address);
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
      let withdrawalInProgress = false;
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
