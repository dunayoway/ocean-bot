import { LocalAccountSigner } from "@aa-sdk/core";
import "dotenv/config";

const privateKey = process.env.WALLET_PRIVATE_KEY as `0x${string}` | undefined;

if (!privateKey) {
  throw new Error("❌ Missing required environment variable: WALLET_PRIVATE_KEY");
}

export const signer = LocalAccountSigner.privateKeyToAccountSigner(privateKey);
