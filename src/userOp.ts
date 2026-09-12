import { createModularAccountV2Client } from "@account-kit/smart-contracts";
import { mainnet, alchemy } from "@account-kit/infra";
import { signer } from "./signer.js";
import errorMessage from "./errorMessage.js";
import "dotenv/config";

const API_KEY = process.env.API_KEY;
const POLICY_ID = process.env.POLICY_ID;
const STAKING_CONTRACT_ADDRESS = process.env.STAKING_CONTRACT_ADDRESS;
const TOKEN_CONTRACT_ADDRESS = process.env.TOKEN_CONTRACT_ADDRESS;

if (
  !TOKEN_CONTRACT_ADDRESS ||
  !STAKING_CONTRACT_ADDRESS ||
  !API_KEY ||
  !POLICY_ID
) {
  throw new Error("❌ Missing Required Environment Variables!");
}

export type SmartAccountClient = Awaited<
  ReturnType<typeof createModularAccountV2Client>
>;

export const createSmartAccount = async (): Promise<
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

export const sendUserOp = async (
  unstakeTxCallData: string | undefined,
  transferTxCallData: string,
  smartAccountClient: SmartAccountClient,
  blockNumber: number,
): Promise<void> => {
  try {
    // Sending Batch User Operations
    console.log("⚙️ Sending User Operations..");
    const uo = [];
    // Only add unstake operation if calldata was provided
    if (unstakeTxCallData) {
      uo.push({
        target: STAKING_CONTRACT_ADDRESS as `0x${string}`,
        value: 0n,
        data: unstakeTxCallData as `0x${string}`,
      });
    }
    // Always add transfer operation
    uo.push({
      target: TOKEN_CONTRACT_ADDRESS as `0x${string}`,
      value: 0n,
      data: transferTxCallData as `0x${string}`,
    });
    const uoHash = await smartAccountClient.sendUserOperation({ uo });
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
