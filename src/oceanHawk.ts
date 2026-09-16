import { ethers } from "ethers";
import fs from "fs";
import { SmartAccountClient, sendUserOp } from "./userOp";
import "dotenv/config";

// ============================================================
// ENVIRONMENT
// ============================================================
const ETH_RPC_URL: string | undefined = process.env.ALCHEMY_ETH_RPC_URL;
const WALLET_PRIVATE_KEY: string | undefined = process.env.WALLET_PRIVATE_KEY;
const TOKEN_CONTRACT_ADDRESS: string | undefined =
  process.env.TOKEN_CONTRACT_ADDRESS;
const VAULT_WALLET_ADDRESS: string | undefined =
  process.env.VAULT_WALLET_ADDRESS;

if (
  !ETH_RPC_URL ||
  !WALLET_PRIVATE_KEY ||
  !TOKEN_CONTRACT_ADDRESS ||
  !VAULT_WALLET_ADDRESS
) {
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
// OCEAN CONTRACT
// ============================================================
const oceanAbi: ethers.InterfaceAbi = JSON.parse(
  fs.readFileSync("./constants.json", "utf-8"),
).oceanAbi;
const oceanInterface = new ethers.Interface(oceanAbi);
// const ocean = new ethers.Contract(TOKEN_CONTRACT_ADDRESS, oceanAbi, ethWallet);

// ============================================================
// EVENT FILTER
// ============================================================
const transferTopic = ethers.id("Transfer(address,address,uint256)");
const walletTopic = ethers.zeroPadValue(walletAddress, 32);

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
  let gasCost: bigint;
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
// OCEAN SWEEP
// ============================================================
async function sweepOcean({
  wallet,
  provider,
  contract,
  network,
  decimals,
  symbol,
  smartAccountClient,
  blockNumber,
}: {
  wallet: ethers.Wallet;
  provider: ethers.Provider;
  contract: ethers.Contract;
  network: Network;
  decimals: number;
  symbol: string;
  smartAccountClient: SmartAccountClient;
  blockNumber: number;
}) {
  const balance: bigint = await contract.balanceOf(wallet.address);
  if (balance === 0n) {
    console.log(`[${network} ${symbol}] 🏧 Balance is 0`);
    return;
  }
  console.log(
    `[${network} ${symbol}] 🏧 Current balance: ${ethers.formatUnits(
      balance,
      decimals,
    )} ${symbol}`,
  );
  // Estimate gas for transferring the entire
  // current USDC balance.
  const gasLimit: bigint = await contract.transfer.estimateGas(
    VAULT_WALLET_ADDRESS,
    balance,
  );
  const feeData: FeeData = await getFeeData(provider);
  let gasCost: bigint;
  if ("maxFeePerGas" in feeData) {
    gasCost = gasLimit * feeData.maxFeePerGas;
  } else {
    gasCost = gasLimit * feeData.gasPrice;
  }
  const gasReserve: bigint = addGasBuffer(gasCost);
  const nativeBalance: bigint = await provider.getBalance(wallet.address);
  console.log(
    `[${network} ${symbol}] 🏧 Native balance: ${ethers.formatEther(nativeBalance)}`,
  );
  console.log(
    `[${network} ${symbol}] ⛽️ Gas reserve: ${ethers.formatEther(gasReserve)}`,
  );
  // Create OCEAN transfer calldata
  const transferTxCallData = contract.interface.encodeFunctionData("transfer", [
    VAULT_WALLET_ADDRESS,
    balance,
  ]);
  // ------------------------------------------------
  // NOT ENOUGH NATIVE GAS → USE USER OPERATION
  // ------------------------------------------------
  if (nativeBalance < gasReserve) {
    console.log(`[${network} ${symbol}] ⚠️ Insufficient native token for gas.`);
    console.log(
      `[${network} ${symbol}] 🤖 Sending transfer through UserOperation...`,
    );
    await sendUserOp(
      undefined,
      transferTxCallData,
      smartAccountClient,
      blockNumber,
    );
    return;
  }
  const tx = await contract.transfer(VAULT_WALLET_ADDRESS, balance, {
    gasLimit,
    ...("maxFeePerGas" in feeData
      ? {
          maxFeePerGas: feeData.maxFeePerGas,
          maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
        }
      : {
          gasPrice: feeData.gasPrice,
        }),
  });
  console.log(`[${network} ${symbol}] ✔️ Sweep submitted: ${tx.hash}`);
  await tx.wait();
  console.log(
    `[${network} ${symbol}] ✅ Swept ${ethers.formatUnits(
      balance,
      decimals,
    )} ${symbol}`,
  );
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
// USDC MONITOR HELPER
// ============================================================
function watchOcean({
  provider,
  oceanAddress,
  wallet,
  contract,
  network,
  decimals,
  symbol,
  smartAccountClient,
}: {
  provider: ethers.Provider;
  oceanAddress: string;
  wallet: ethers.Wallet;
  contract: ethers.Contract;
  network: Network;
  decimals: number;
  symbol: string;
  smartAccountClient: SmartAccountClient;
}) {
  provider.on(
    {
      address: oceanAddress,
      topics: [transferTopic, null, walletTopic],
    },
    async (log) => {
      try {
        const parsed = oceanInterface.parseLog(log);
        if (!parsed) {
          return;
        }
        const from = parsed.args[0];
        const value = parsed.args[2];
        const formatted = ethers.formatUnits(value, decimals);
        console.log(
          `\n[${symbol} - ${network}] 💰 Received ${formatted} ${symbol}`,
        );
        console.log(`💸 From: ${from}`);
        console.log(`💳 Tx:   ${log.transactionHash}`);
        if (sweepState[network]) {
          console.log(
            `[${symbol} - ${network}] ⏳ Sweep already running. Skipping trigger.`,
          );
          return;
        }
        sweepState[network] = true;
        try {
          await sweepOcean({
            wallet,
            provider,
            contract,
            network,
            symbol,
            decimals,
            smartAccountClient,
            blockNumber: log.blockNumber + 1,
          });
        } finally {
          sweepState[network] = false;
        }
      } catch (error) {
        console.error(`[${symbol} - ${network}] ❌ Watcher error:`, error);
      }
    },
  );
}

// ============================================================
// ETH NATIVE TOKEN
// ============================================================
export function startHover(
  tokenAddress: string,
  tokenContract: ethers.Contract,
  decimals: number,
  symbol: string,
  smartAccountClient: SmartAccountClient,
) {
  const network = "ETH";
  watchNativeToken({
    provider: ethProvider,
    wallet: ethWallet,
    network,
    symbol: "ETH",
  });
  watchOcean({
    provider: ethProvider,
    oceanAddress: tokenAddress,
    wallet: ethWallet,
    contract: tokenContract,
    network,
    decimals,
    symbol,
    smartAccountClient,
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
console.log("👀 Monitoring Ethereum & OCEAN...");
