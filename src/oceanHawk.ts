import { ethers } from "ethers";
import "dotenv/config";

// ============================================================
// ENVIRONMENT
// ============================================================
const ETH_RPC_URL: string | undefined = process.env.ALCHEMY_ETH_RPC_URL;
const WALLET_PRIVATE_KEY: string | undefined = process.env.WALLET_PRIVATE_KEY;
const VAULT_WALLET_ADDRESS: string | undefined =
  process.env.VAULT_WALLET_ADDRESS;

if (!ETH_RPC_URL || !WALLET_PRIVATE_KEY || !VAULT_WALLET_ADDRESS) {
  throw new Error("❌ Missing Required Environment Variables");
}

// ============================================================
// CONFIGURATION
// ============================================================
// Add 20% to estimated gas as a safety buffer.
const GAS_BUFFER_BPS: bigint = 2000n;

// ============================================================
// PROVIDER
// ============================================================
const ethProvider = new ethers.WebSocketProvider(ETH_RPC_URL);
// ============================================================
// WALLET
// ============================================================
const ethWallet = new ethers.Wallet(WALLET_PRIVATE_KEY, ethProvider);
const walletAddress = ethWallet.address;
console.log(`🔍 Watching wallet: ${walletAddress}\n`);

// ============================================================
// GAS HELPERS
// ============================================================
interface Eip1559FeeData {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}
interface LegacyFeeData {
  gasPrice: bigint;
}
type FeeData = Eip1559FeeData | LegacyFeeData;

async function getFeeData(provider: ethers.Provider): Promise<FeeData> {
  const feeData = await provider.getFeeData();
  if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
    return {
      maxFeePerGas: feeData.maxFeePerGas,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
    };
  }
  if (feeData.gasPrice) {
    return {
      gasPrice: feeData.gasPrice,
    };
  }
  throw new Error("❌ Unable to Determine Gas Price");
}

function addGasBuffer(gasCost: bigint): bigint {
  return gasCost + (gasCost * GAS_BUFFER_BPS) / 10000n;
}

// ============================================================
// SWEEP LOCK
// ============================================================
type Network = "ETH";
const sweepState: Record<Network, boolean> = {
  ETH: false,
};

// ============================================================
// NATIVE TOKEN SWEEP
// ============================================================
async function sweepNative({
  wallet,
  provider,
  network,
  symbol,
}: {
  wallet: ethers.Wallet;
  provider: ethers.Provider;
  network: Network;
  symbol: string;
}) {
  const balance: bigint = await provider.getBalance(wallet.address);
  if (balance === 0n) {
    console.log(`[${network}] 🏧 Wallet balance is 0`);
    return;
  }
  console.log(
    `[${network}] 🏧 Current balance: ${ethers.formatEther(balance)} ${symbol}`,
  );
  // Estimate gas for the native transfer.
  // value is zero here because we only want the
  // gas requirement for the transaction.
  const gasLimit: bigint = await provider.estimateGas({
    from: wallet.address,
    to: VAULT_WALLET_ADDRESS,
    value: 0n,
  });
  const feeData: FeeData = await getFeeData(provider);
  let gasCost;
  if ("maxFeePerGas" in feeData) {
    gasCost = gasLimit * feeData.maxFeePerGas;
  } else {
    gasCost = gasLimit * feeData.gasPrice;
  }
  const gasReserve: bigint = addGasBuffer(gasCost);
  console.log(
    `[${network}] ⛽️ Gas reserve: ${ethers.formatEther(gasReserve)} ${symbol}`,
  );
  if (balance <= gasReserve) {
    console.log(`[${network}] ❌ Balance is not enough to cover gas.`);
    return;
  }
  // Sweep everything except the amount required
  // to pay for the transaction.
  const sweepAmount: bigint = balance - gasReserve;
  console.log(
    `[${network}] ⚙️ Sweeping ${ethers.formatEther(sweepAmount)} ${symbol} to vault...`,
  );
  const txRequest: ethers.TransactionRequest = {
    to: VAULT_WALLET_ADDRESS,
    value: sweepAmount,
    gasLimit,
  };
  if ("maxFeePerGas" in feeData) {
    txRequest.maxFeePerGas = feeData.maxFeePerGas;
    txRequest.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
  } else {
    txRequest.gasPrice = feeData.gasPrice;
  }
  const tx: ethers.TransactionResponse =
    await wallet.sendTransaction(txRequest);
  console.log(`[${network}] ✔️ Sweep submitted: ${tx.hash}`);
  await tx.wait();
  console.log(`[${network}] ✅ Sweep confirmed: ${tx.hash}`);
}

// ============================================================
// PROCESSED TRANSACTIONS
// ============================================================
const processedNative = new Set<string>();

// ============================================================
// NATIVE TOKEN MONITOR HELPER
// ============================================================
function watchNativeToken({
  provider,
  wallet,
  network,
  symbol,
}: {
  provider: ethers.Provider;
  wallet: ethers.Wallet;
  network: Network;
  symbol: string;
}) {
  provider.on("block", async (blockNumber) => {
    try {
      const block: ethers.Block | null = await provider.getBlock(
        blockNumber,
        true,
      );
      if (!block?.prefetchedTransactions) {
        return;
      }
      for (const tx of block.prefetchedTransactions) {
        if (
          !tx.to ||
          tx.to.toLowerCase() !== walletAddress.toLowerCase() ||
          tx.value <= 0n
        ) {
          continue;
        }
        if (processedNative.has(tx.hash)) {
          continue;
        }
        console.log(
          `\n[${network}] 💰 Received ${ethers.formatEther(tx.value)} ${symbol}`,
        );
        console.log(`💸 From: ${tx.from}`);
        console.log(`💳 Tx:   ${tx.hash}`);
        if (sweepState[network]) {
          console.log(
            `[${network}] ⏳ Sweep already running. Skipping trigger.`,
          );
          continue;
        }
        sweepState[network] = true;
        try {
          await sweepNative({
            wallet,
            provider,
            network,
            symbol,
          });
          processedNative.add(tx.hash);
        } finally {
          sweepState[network] = false;
        }
      }
    } catch (error) {
      console.error(`[${network}] ❌ Watcher error:`, error);
    }
  });
}

// ============================================================
// ETH NATIVE TOKEN
// ============================================================
export function startHover() {
  watchNativeToken({
    provider: ethProvider,
    wallet: ethWallet,
    network: "ETH",
    symbol: "ETH",
  });
}

// ============================================================
// CONNECTION ERRORS
// ============================================================
ethProvider.on("error", (error) => {
  console.error("❌ Ethereum WebSocket error:", error);
});

// ============================================================
// STARTUP
// ============================================================
console.log("👀 Watching Ethereum...");
