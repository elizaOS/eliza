/**
 * @module convenience
 * Environment-variable-driven wallet bootstrap helpers.
 *
 * Provides three dead-simple factory functions that read all configuration
 * from process environment variables so that any agent can set up a fully
 * functional wallet in 3 lines without touching viem directly:
 *
 * ```typescript
 * import { walletFromEnv, setPolicyFromEnv, x402FromEnv } from 'agentwallet-sdk';
 *
 * const wallet = walletFromEnv();
 * await setPolicyFromEnv(wallet);
 * const client = x402FromEnv(wallet);
 * ```
 *
 * ### Environment variables
 *
 * | Variable              | Required | Default        | Description                                      |
 * |-----------------------|----------|----------------|--------------------------------------------------|
 * | AGENT_PRIVATE_KEY     | ✅ yes   | —              | EOA private key (0x-prefixed hex, 32 bytes)      |
 * | AGENT_WALLET_ADDRESS  | ✅ yes   | —              | AgentAccountV2 smart-wallet address              |
 * | CHAIN_NAME            | no       | base           | Chain name (base, mainnet, arbitrum, …)          |
 * | CHAIN_ID              | no       | —              | Alternative to CHAIN_NAME — numeric chain id     |
 * | RPC_URL               | no       | chain default  | Custom JSON-RPC endpoint                         |
 * | SPEND_LIMIT_PER_TX    | no       | —              | Per-tx USDC limit (decimal, e.g. "1.00")         |
 * | SPEND_LIMIT_DAILY     | no       | —              | Daily USDC limit  (decimal, e.g. "10.00")        |
 * | SPEND_ALLOWLIST       | no       | —              | Comma-separated recipient addresses              |
 * | X402_SUPPORTED_NETWORKS | no     | (all mainnet)  | Comma-separated "chain:chainId" network strings  |
 * | X402_GLOBAL_DAILY_LIMIT | no     | —              | Global daily x402 USDC limit (decimal)           |
 * | X402_PER_REQUEST_MAX  | no       | —              | Per-request max USDC spend (decimal)             |
 */

import type { Address, Chain, Hex } from "viem";
import { createWalletClient, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  arbitrum,
  base,
  baseSepolia,
  mainnet,
  optimism,
  polygon,
} from "viem/chains";
import type { AgentWalletConfig } from "./types.js";
import { createWallet, NATIVE_TOKEN, setSpendPolicy } from "./wallet-core.js";
import { createX402Client } from "./x402/middleware.js";
import { DEFAULT_SUPPORTED_NETWORKS, USDC_ADDRESSES } from "./x402/types.js";

// ─── Chain registry ────────────────────────────────────────────────────────

/**
 * Well-known chains, keyed by name (lower-case) or numeric id.
 * Extend this map if you need additional L2s.
 */
const CHAIN_MAP: Record<string, Chain> = {
  base,
  "base-sepolia": baseSepolia,
  basesepolia: baseSepolia,
  mainnet,
  ethereum: mainnet,
  eth: mainnet,
  arbitrum,
  arb: arbitrum,
  optimism,
  op: optimism,
  polygon,
  matic: polygon,
};

/** Fallback RPC endpoints for chains that have no public default in viem. */
const DEFAULT_RPC: Record<string, string> = {
  base: "https://mainnet.base.org",
  "base-sepolia": "https://sepolia.base.org",
  mainnet: "https://cloudflare-eth.com",
  ethereum: "https://cloudflare-eth.com",
  arbitrum: "https://arb1.arbitrum.io/rpc",
  optimism: "https://mainnet.optimism.io",
  polygon: "https://polygon-rpc.com",
};

/**
 * Resolve a chain object from either a name string or a numeric chain id.
 * Tries CHAIN_MAP by name, then falls back to scanning by chainId.
 *
 * @param nameOrId - Chain name ("base", "arbitrum", …) or numeric id (8453, …).
 * @returns The viem Chain object, or `base` as the default.
 */
function resolveChain(nameOrId: string | number): Chain {
  if (typeof nameOrId === "number") {
    const found = Object.values(CHAIN_MAP).find((c) => c.id === nameOrId);
    return found ?? base;
  }
  const key = nameOrId.toLowerCase().trim();
  return CHAIN_MAP[key] ?? base;
}

/** Maps a viem chain to the string key expected by `createWallet` (subset of networks). */
function chainToCreateWalletKey(chain: Chain): AgentWalletConfig["chain"] {
  switch (chain.id) {
    case 8453:
      return "base";
    case 84532:
      return "base-sepolia";
    case 1:
      return "ethereum";
    case 42161:
      return "arbitrum";
    case 137:
      return "polygon";
    default:
      throw new Error(
        `[walletFromEnv] Unsupported chain for AgentWallet (${chain.name}, id ${chain.id}). ` +
          `Use base, base-sepolia, ethereum, arbitrum, or polygon.`,
      );
  }
}

// ─── USDC scaling ──────────────────────────────────────────────────────────

const USDC_DECIMALS = 6;

/**
 * Parse a human-readable USDC amount (e.g. "1.50") into base units (bigint).
 * Returns `undefined` if the string is falsy or not a valid number.
 *
 * @param value - Decimal string such as "0.50" or "100".
 */
function parseUsdc(value: string | undefined): bigint | undefined {
  if (!value || value.trim() === "") return undefined;
  try {
    return parseUnits(value.trim(), USDC_DECIMALS);
  } catch {
    console.warn(`[walletFromEnv] Could not parse USDC amount: "${value}"`);
    return undefined;
  }
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Create a fully configured AgentWallet from environment variables.
 *
 * Reads:
 * - **AGENT_PRIVATE_KEY** — EOA signing key (required; 0x-prefixed 32-byte hex)
 * - **AGENT_WALLET_ADDRESS** — AgentAccountV2 contract address (required)
 * - **CHAIN_NAME** or **CHAIN_ID** — target chain (optional; defaults to Base mainnet)
 * - **RPC_URL** — custom RPC endpoint (optional; uses chain default if omitted)
 *
 * @param options - Optional overrides for chain and rpcUrl.
 * @param options.chain  - Chain name that takes precedence over the env var.
 * @param options.rpcUrl - RPC endpoint that takes precedence over the env var.
 * @returns A fully configured wallet object (same shape as `createWallet()`).
 *
 * @throws {Error} If AGENT_PRIVATE_KEY is missing or not a valid hex key.
 * @throws {Error} If AGENT_WALLET_ADDRESS is missing.
 *
 * @example
 * ```typescript
 * const wallet = walletFromEnv({ chain: 'base-sepolia' });
 * ```
 */
export function walletFromEnv(options?: {
  chain?: string;
  rpcUrl?: string;
}): ReturnType<typeof createWallet> {
  // ── Private key ────────────────────────────────────────────────────────
  const rawKey = process.env.AGENT_PRIVATE_KEY;
  if (!rawKey || rawKey.trim() === "") {
    throw new Error(
      "[walletFromEnv] AGENT_PRIVATE_KEY environment variable is required. " +
        "Set it to the 0x-prefixed 32-byte hex private key of your agent EOA.",
    );
  }
  const privateKey = (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as Hex;

  // ── Wallet (smart-contract) address ────────────────────────────────────
  const walletAddress = process.env.AGENT_WALLET_ADDRESS;
  if (!walletAddress || walletAddress.trim() === "") {
    throw new Error(
      "[walletFromEnv] AGENT_WALLET_ADDRESS environment variable is required. " +
        "Set it to the address of your deployed AgentAccountV2 smart wallet.",
    );
  }

  // ── Chain resolution ────────────────────────────────────────────────────
  const chainSource =
    options?.chain ??
    process.env.CHAIN_NAME ??
    (process.env.CHAIN_ID ? process.env.CHAIN_ID : undefined);

  const chain = chainSource
    ? resolveChain(
        /^\d+$/.test(String(chainSource))
          ? parseInt(chainSource, 10)
          : String(chainSource),
      )
    : base;

  // ── RPC URL ─────────────────────────────────────────────────────────────
  const rpcUrl =
    options?.rpcUrl ??
    process.env.RPC_URL ??
    DEFAULT_RPC[chain.name.toLowerCase()] ??
    DEFAULT_RPC.base;

  // ── Build viem walletClient ──────────────────────────────────────────────
  const account = privateKeyToAccount(privateKey);
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(rpcUrl),
  });

  // ── Delegate to core createWallet ────────────────────────────────────────
  return createWallet({
    accountAddress: walletAddress as Address,
    chain: chainToCreateWalletKey(chain),
    rpcUrl,
    walletClient,
  });
}

/**
 * Apply a spending policy to a wallet from environment variables.
 *
 * Reads:
 * - **SPEND_LIMIT_PER_TX** — maximum USDC per single transaction (e.g. "1.00")
 * - **SPEND_LIMIT_DAILY**  — maximum USDC per 24-hour period (e.g. "10.00")
 * - **SPEND_ALLOWLIST**    — comma-separated ERC-20 token addresses to restrict
 *
 * If neither limit is set, logs a warning and falls back to queue-for-approval
 * mode (perTxLimit = 0, periodLimit = 0) so all agent transactions must be
 * manually approved. This is the safest default.
 *
 * @param wallet - Wallet returned by `walletFromEnv()` (or `createWallet()`).
 * @returns Promise that resolves to the on-chain tx hash of the policy update.
 *
 * @example
 * ```typescript
 * await setPolicyFromEnv(wallet);
 * ```
 */
export async function setPolicyFromEnv(
  wallet: ReturnType<typeof createWallet>,
): Promise<string> {
  const perTxLimit = parseUsdc(process.env.SPEND_LIMIT_PER_TX);
  const periodLimit = parseUsdc(process.env.SPEND_LIMIT_DAILY);

  // Determine which USDC token address to use for this chain
  const chainId = wallet.chain.id;
  const networkKey = Object.keys(USDC_ADDRESSES).find((k) => {
    const parts = k.split(":");
    return parts.length === 2 && parseInt(parts[1], 10) === chainId;
  });
  // Use USDC if found for this chain, otherwise fall back to native ETH (zero address)
  const token: Address = networkKey
    ? (USDC_ADDRESSES[networkKey] as Address)
    : NATIVE_TOKEN;

  // Warn and use safe defaults when no limits are configured
  if (perTxLimit === undefined && periodLimit === undefined) {
    console.warn(
      "[setPolicyFromEnv] Neither SPEND_LIMIT_PER_TX nor SPEND_LIMIT_DAILY is set. " +
        "Defaulting to queue-for-approval mode (all agent transactions require owner sign-off). " +
        "Set these env vars to enable autonomous spending.",
    );
    const hash = await setSpendPolicy(wallet, {
      token,
      perTxLimit: 0n,
      periodLimit: 0n,
      periodLength: 86400, // 24 h
    });
    console.info(
      `[setPolicyFromEnv] Queue-for-approval policy set. tx: ${hash}`,
    );
    return hash;
  }

  const resolvedPerTxLimit = perTxLimit ?? 0n;
  const resolvedPeriodLimit = periodLimit ?? 0n;

  const hash = await setSpendPolicy(wallet, {
    token,
    perTxLimit: resolvedPerTxLimit,
    periodLimit: resolvedPeriodLimit,
    periodLength: 86400, // 24 h
  });

  console.info(
    `[setPolicyFromEnv] Policy set — perTx: ${resolvedPerTxLimit} base units, ` +
      `daily: ${resolvedPeriodLimit} base units on ${wallet.chain.name}. tx: ${hash}`,
  );

  return hash;
}

/**
 * Create an x402 payment client from environment variables.
 *
 * Reads:
 * - **X402_SUPPORTED_NETWORKS**   — comma-separated "chain:chainId" strings
 *   (e.g. "base:8453,arbitrum:42161"); defaults to all supported mainnets
 * - **X402_GLOBAL_DAILY_LIMIT**   — total daily USDC budget across all x402
 *   services (decimal, e.g. "5.00")
 * - **X402_PER_REQUEST_MAX**      — per-request USDC ceiling (decimal)
 *
 * Sensible defaults: supports all 10 mainnet x402 chains, unlimited daily spend
 * (rely on the agent's on-chain spend policy as the hard limit), 1 auto-retry.
 *
 * @param wallet - Wallet returned by `walletFromEnv()` (or `createWallet()`).
 * @returns A configured X402Client instance.
 *
 * @example
 * ```typescript
 * const client = x402FromEnv(wallet);
 * const data = await client.fetch('https://api.example.com/premium-endpoint');
 * ```
 */
export function x402FromEnv(
  wallet: ReturnType<typeof createWallet>,
): ReturnType<typeof createX402Client> {
  // Supported networks — override with comma-separated list or use all defaults
  const networksEnv = process.env.X402_SUPPORTED_NETWORKS;
  const supportedNetworks: string[] = networksEnv
    ? networksEnv
        .split(",")
        .map((s: string) => s.trim())
        .filter(Boolean)
    : [...DEFAULT_SUPPORTED_NETWORKS];

  // Global daily limit
  const globalDailyLimitUsdc = parseUsdc(process.env.X402_GLOBAL_DAILY_LIMIT);
  const globalPerRequestMaxUsdc = parseUsdc(process.env.X402_PER_REQUEST_MAX);

  return createX402Client(wallet, {
    supportedNetworks,
    ...(globalDailyLimitUsdc !== undefined && {
      globalDailyLimit: globalDailyLimitUsdc,
    }),
    ...(globalPerRequestMaxUsdc !== undefined && {
      globalPerRequestMax: globalPerRequestMaxUsdc,
    }),
    autoPay: true,
    maxRetries: 1,
  });
}
