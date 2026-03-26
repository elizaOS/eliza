/**
 * buyGas action — ElizaOS plugin-gas-station
 *
 * Swaps USDC for native gas (POL/ETH) via the GasStation contract.
 * Contract source: https://github.com/pino12033/gas-station-sol
 *
 * The action supports two modes:
 *   - LIVE: calls a deployed GasStation contract on Polygon (mainnet/testnet)
 *   - MOCK: simulates the swap locally (used when contract is not yet deployed)
 *
 * Environment variables:
 *   GAS_STATION_ADDRESS     — deployed contract address (required for live mode)
 *   GAS_STATION_RPC_URL     — EVM RPC endpoint (default: Polygon mainnet public RPC)
 *   GAS_STATION_PRIVATE_KEY — agent wallet private key (required for live mode)
 *   GAS_STATION_USDC        — USDC token address (default: Polygon mainnet USDC)
 *   GAS_STATION_MOCK        — set to "true" to force mock mode (default: true when no address set)
 */

import type { Action, HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";

// ─── GasStation ABI (minimal — only the functions we need) ────────────────────

const GAS_STATION_ABI = [
  // quote(uint256 tokenAmount) → (grossNative, feeNative, netNative, sufficient)
  {
    name: "quote",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenAmount", type: "uint256" }],
    outputs: [
      { name: "grossNative", type: "uint256" },
      { name: "feeNative", type: "uint256" },
      { name: "netNative", type: "uint256" },
      { name: "sufficient", type: "bool" },
    ],
  },
  // buyGas(uint256 tokenAmount, address recipient) → void
  {
    name: "buyGas",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenAmount", type: "uint256" },
      { name: "recipient", type: "address" },
    ],
    outputs: [],
  },
  // liquidity() → uint256
  {
    name: "liquidity",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// ERC-20 approve ABI
const ERC20_ABI = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_RPC = "https://polygon-rpc.com";
const POLYGON_USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
const USDC_DECIMALS = 6;
const ONE_USDC = BigInt(10 ** USDC_DECIMALS);

// ─── Helper: parse USDC amount from user input ────────────────────────────────

function parseUsdcAmount(raw: string | number): bigint {
  const n = parseFloat(String(raw));
  if (isNaN(n) || n <= 0) throw new Error(`Invalid USDC amount: ${raw}`);
  // Convert to 6-decimal integer
  return BigInt(Math.round(n * 10 ** USDC_DECIMALS));
}

// ─── Mock mode implementation ─────────────────────────────────────────────────

interface MockQuoteResult {
  amountUsdc: number;
  estimatedPol: number;
  fee: number;
  note: string;
}

function mockBuyGas(amountUsdc: number): MockQuoteResult {
  // Simulate: 1 USDC ≈ 10 POL at 3% fee (illustrative)
  const RATE = 10; // POL per USDC
  const FEE_BPS = 300; // 3%
  const gross = amountUsdc * RATE;
  const fee = (gross * FEE_BPS) / 10000;
  const net = gross - fee;
  return {
    amountUsdc,
    estimatedPol: net,
    fee: amountUsdc * (FEE_BPS / 10000),
    note: "MOCK MODE — contract not deployed yet. Deploy GasStation.sol on Polygon to enable live swaps.",
  };
}

// ─── Live mode implementation ─────────────────────────────────────────────────

interface LiveBuyGasResult {
  txHash: string;
  amountUsdc: number;
  netPol: string;
  recipient: string;
}

async function liveBuyGas(
  amountUsdc: number,
  contractAddress: string,
  privateKey: string,
  rpcUrl: string,
  usdcAddress: string,
  recipient?: string,
): Promise<LiveBuyGasResult> {
  // Dynamic import of viem — keeps this optional if not installed
  const { createPublicClient, createWalletClient, http, parseEther, formatEther } =
    await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");
  const { polygon } = await import("viem/chains");

  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const recipientAddr = (recipient ?? account.address) as `0x${string}`;

  const publicClient = createPublicClient({ chain: polygon, transport: http(rpcUrl) });
  const walletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http(rpcUrl),
  });

  const tokenAmount = parseUsdcAmount(amountUsdc);

  // 1. Get quote
  const [, , netNative, sufficient] = (await publicClient.readContract({
    address: contractAddress as `0x${string}`,
    abi: GAS_STATION_ABI,
    functionName: "quote",
    args: [tokenAmount],
  })) as [bigint, bigint, bigint, boolean];

  if (!sufficient) {
    throw new Error(
      "GasStation has insufficient POL liquidity. Try again later or contact the operator.",
    );
  }

  // 2. Approve USDC
  const approveTx = await walletClient.writeContract({
    address: usdcAddress as `0x${string}`,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [contractAddress as `0x${string}`, tokenAmount],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveTx });

  // 3. Buy gas
  const buyTx = await walletClient.writeContract({
    address: contractAddress as `0x${string}`,
    abi: GAS_STATION_ABI,
    functionName: "buyGas",
    args: [tokenAmount, recipientAddr],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: buyTx });

  if (receipt.status !== "success") {
    throw new Error(`buyGas transaction reverted: ${buyTx}`);
  }

  return {
    txHash: buyTx,
    amountUsdc,
    netPol: formatEther(netNative),
    recipient: recipientAddr,
  };
}

// ─── Action ───────────────────────────────────────────────────────────────────

export const buyGasAction: Action = {
  name: "BUY_GAS",

  description:
    "Swap USDC for native gas (POL/ETH) using the GasStation contract on Polygon. " +
    "Use this when you need gas tokens to pay for blockchain transactions. " +
    "Specify the USDC amount (e.g. 'buy gas for 2 USDC', 'get 5 USDC worth of gas').",

  similes: [
    "BUY_GAS",
    "GET_GAS",
    "SWAP_USDC_FOR_GAS",
    "BUY_POL",
    "GET_NATIVE_TOKEN",
    "FUND_GAS",
    "TOP_UP_GAS",
  ],

  examples: [
    [
      {
        name: "user",
        content: { text: "Buy gas for 2 USDC" },
      },
      {
        name: "agent",
        content: {
          text: "Swapping 2 USDC for native gas via GasStation. You'll receive approximately 19.4 POL after the 3% fee.",
          actions: ["BUY_GAS"],
        },
      },
    ],
    [
      {
        name: "user",
        content: { text: "I need gas tokens, use 5 USDC" },
      },
      {
        name: "agent",
        content: {
          text: "Processing gas purchase: 5 USDC → ~48.5 POL (after 3% fee). Approving USDC and calling GasStation...",
          actions: ["BUY_GAS"],
        },
      },
    ],
  ],

  parameters: [
    {
      name: "amount_usdc",
      description: "Amount of USDC to spend on gas (e.g. 1, 2.5, 5)",
      required: true,
      schema: {
        type: "number",
        minimum: 0.01,
        maximum: 50,
        description: "USDC amount between 0.01 and 50",
      },
    },
    {
      name: "recipient",
      description:
        "Ethereum address to receive the gas tokens (defaults to agent wallet address)",
      required: false,
      schema: {
        type: "string",
        pattern: "^0x[a-fA-F0-9]{40}$",
        description: "EVM address (0x...)",
      },
    },
  ],

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    // Always valid — falls back to mock mode if no contract is configured
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    options: Record<string, unknown>,
    callback: HandlerCallback | undefined,
  ) => {
    // ── Extract parameters ─────────────────────────────────────────────────

    const params = (options?.parameters ?? {}) as Record<string, unknown>;

    // Try to extract amount from structured params first, then from message text
    let amountUsdc: number;
    if (params.amount_usdc != null) {
      amountUsdc = parseFloat(String(params.amount_usdc));
    } else {
      // Fallback: parse from raw message text
      const text = (message.content?.text ?? "").toLowerCase();
      const match = text.match(/(\d+(?:\.\d+)?)\s*(?:usdc|usd|dollars?)/i);
      if (!match) {
        await callback?.({
          text: "Please specify the USDC amount. Example: 'buy gas for 2 USDC'",
          actions: ["REPLY"],
        });
        return { success: false, error: "Missing amount_usdc parameter" };
      }
      amountUsdc = parseFloat(match[1]);
    }

    if (isNaN(amountUsdc) || amountUsdc <= 0) {
      await callback?.({
        text: `Invalid USDC amount: ${params.amount_usdc}. Please provide a positive number.`,
        actions: ["REPLY"],
      });
      return { success: false, error: "Invalid amount" };
    }

    const recipient = params.recipient as string | undefined;

    // ── Determine mode ─────────────────────────────────────────────────────

    const contractAddress = runtime.getSetting("GAS_STATION_ADDRESS");
    const privateKey = runtime.getSetting("GAS_STATION_PRIVATE_KEY");
    const isMock =
      runtime.getSetting("GAS_STATION_MOCK") === "true" ||
      !contractAddress ||
      !privateKey;

    // ── Execute ────────────────────────────────────────────────────────────

    if (isMock) {
      const result = mockBuyGas(amountUsdc);
      const text = [
        `🔧 **GasStation (Mock Mode)**`,
        ``,
        `Simulated swap: **${amountUsdc} USDC** → **${result.estimatedPol.toFixed(4)} POL**`,
        `Fee: ${(result.fee).toFixed(4)} USDC (3%)`,
        ``,
        `⚠️ ${result.note}`,
        ``,
        `To enable live swaps:`,
        `1. Deploy GasStation.sol on Polygon (see pino12033/gas-station-sol)`,
        `2. Set \`GAS_STATION_ADDRESS\` in your agent config`,
        `3. Set \`GAS_STATION_PRIVATE_KEY\` (agent wallet)`,
      ].join("\n");

      await callback?.({ text, actions: ["REPLY"] });
      return { success: true, mock: true, ...result };
    }

    // Live mode
    const rpcUrl = runtime.getSetting("GAS_STATION_RPC_URL") ?? DEFAULT_RPC;
    const usdcAddress = runtime.getSetting("GAS_STATION_USDC") ?? POLYGON_USDC;

    try {
      await callback?.({
        text: `⏳ Swapping ${amountUsdc} USDC for gas... (approving USDC, then calling GasStation)`,
        actions: ["CONTINUE"],
      });

      const result = await liveBuyGas(
        amountUsdc,
        contractAddress,
        privateKey,
        rpcUrl,
        usdcAddress,
        recipient,
      );

      const text = [
        `✅ **Gas purchased successfully!**`,
        ``,
        `- Spent: **${amountUsdc} USDC**`,
        `- Received: **${result.netPol} POL**`,
        `- Recipient: \`${result.recipient}\``,
        `- Tx: \`${result.txHash}\``,
        `- [View on PolygonScan](https://polygonscan.com/tx/${result.txHash})`,
      ].join("\n");

      await callback?.({ text, actions: ["REPLY"] });
      return { success: true, mock: false, ...result };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await callback?.({
        text: `❌ Gas purchase failed: ${errorMsg}`,
        actions: ["REPLY"],
      });
      return { success: false, error: errorMsg };
    }
  },
};
