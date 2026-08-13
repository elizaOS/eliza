/**
 * Payout-specific EVM resolution (#13100).
 *
 * The shared {@link resolveEvmRpc} is consumed by token-redemption address
 * validation, the BNB/USD Chainlink oracle, admin RPC status, and identity
 * routing. Making it globally `PAYOUT_TESTNET`-dependent would send those
 * mainnet consumers to testnet while they still construct mainnet chain
 * clients and contracts.
 *
 * This module is the **payout-only** analogue: it bundles chain + RPC + asset
 * into a single coherent resolution object so a testnet payout never ends up
 * with a mainnet chain or mainnet token contract. It is used exclusively by
 * payout consumers (payout-processor, payout-status, redemption creation).
 *
 * Environment is resolved from cloud-aware bindings ({@link getCloudAwareEnv}),
 * not raw `process.env`, so a wrangler staging var on a Cloudflare Worker
 * selects the intended environment in the actual Worker path.
 */

import { type Chain, base, baseSepolia, bsc, bscTestnet, mainnet, sepolia } from "viem/chains";

import type { PayoutAsset } from "./payout-assets";
import {
  USDC_TESTNET_TOKEN_ADDRESSES,
  USDC_TOKEN_ADDRESSES,
  USDC_DECIMALS,
} from "./payout-assets";
import { ELIZA_DECIMALS } from "./token-constants";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import type { SupportedNetwork } from "../services/eliza-token-price";
import { ELIZA_TOKEN_ADDRESSES } from "../services/eliza-token-price";

export type EvmPayoutNetwork = "ethereum" | "base" | "bnb";

export type PayoutEnvironment = "mainnet" | "testnet";

/** Portable process-env-like type for optional override parameters. */
type ProcessEnvLike = Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// MAINNET CHAINS
// ---------------------------------------------------------------------------

const MAINNET_CHAINS: Record<EvmPayoutNetwork, Chain> = {
  ethereum: mainnet,
  base,
  bnb: bsc,
};

// ---------------------------------------------------------------------------
// TESTNET CHAINS
// ---------------------------------------------------------------------------

const TESTNET_CHAINS: Record<EvmPayoutNetwork, Chain> = {
  ethereum: sepolia,
  base: baseSepolia,
  bnb: bscTestnet,
};

// ---------------------------------------------------------------------------
// NETWORK KEY MAPPINGS
// ---------------------------------------------------------------------------

/** Environment-variable key suffix per mainnet network (matches shared resolver). */
const MAINNET_NETWORK_KEY: Record<EvmPayoutNetwork, string> = {
  ethereum: "ETHEREUM",
  base: "BASE",
  bnb: "BSC",
};

/** Environment-variable key suffix per testnet network. */
const TESTNET_NETWORK_KEY: Record<EvmPayoutNetwork, string> = {
  ethereum: "SEPOLIA",
  base: "BASE_SEPOLIA",
  bnb: "BSC_TESTNET",
};

const ALCHEMY_MAINNET_SUBDOMAIN: Record<EvmPayoutNetwork, string | null> = {
  ethereum: "eth-mainnet",
  base: "base-mainnet",
  bnb: null,
};

const INFURA_MAINNET_SUBDOMAIN: Record<EvmPayoutNetwork, string | null> = {
  ethereum: "mainnet",
  base: "base-mainnet",
  bnb: null,
};

// ---------------------------------------------------------------------------
// ENVIRONMENT RESOLUTION (cloud-aware)
// ---------------------------------------------------------------------------

/**
 * Resolve the payout environment from cloud-aware bindings.
 *
 * Reads `PAYOUT_TESTNET`, `NODE_ENV`, and `ENVIRONMENT` through
 * {@link getCloudAwareEnv} so a Cloudflare Worker staging var is honoured.
 * Defaults to mainnet in production; test/dev auto-selects testnet.
 */
export function resolvePayoutEnvironment(env?: ProcessEnvLike): PayoutEnvironment {
  const e = env ?? getCloudAwareEnv();
  if (e.PAYOUT_TESTNET === "true") return "testnet";
  if (e.NODE_ENV === "development") return "testnet";
  if (e.NODE_ENV === "test") return "testnet";
  return "mainnet";
}

// ---------------------------------------------------------------------------
// RESOLUTION TYPES
// ---------------------------------------------------------------------------

export interface PayoutEvmRpcResolution {
  url: string;
  source:
    | "crypto_direct"
    | "explicit"
    | "x402"
    | "alchemy"
    | "infura"
    | "public_default";
}

export interface PayoutTokenAsset {
  address: string;
  decimals: number;
  symbol: string;
}

/**
 * Coherent payout resolution for an EVM rail: chain + RPC + asset are all
 * from the same environment (mainnet or testnet). This is the single object a
 * payout consumer uses to construct its viem clients and read/write token
 * contracts — it can never mix a mainnet chain with a testnet RPC or testnet
 * token.
 */
export interface PayoutEvmResolution {
  /** The viem Chain coherent with the payout environment. */
  chain: Chain;
  /** Chain ID for logging / diagnostics. */
  chainId: number;
  /** RPC URL coherent with the chain. */
  rpc: PayoutEvmRpcResolution;
  /** Token contract (mainnet or testnet) for this rail + asset. */
  asset: PayoutTokenAsset;
  /** The resolved payout environment. */
  environment: PayoutEnvironment;
  /** Whether this is a testnet resolution. */
  isTestnet: boolean;
}

// ---------------------------------------------------------------------------
// MAINNET RPC RESOLUTION
// ---------------------------------------------------------------------------

function env(key: string, e: ProcessEnvLike): string | null {
  const v = e[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function resolveMainnetRpc(
  network: EvmPayoutNetwork,
  e: ProcessEnvLike,
): PayoutEvmRpcResolution {
  const key = MAINNET_NETWORK_KEY[network];

  const direct = env(`CRYPTO_DIRECT_${key}_RPC_URL`, e);
  if (direct) return { url: direct, source: "crypto_direct" };

  const explicit = env(`${key}_RPC_URL`, e);
  if (explicit) return { url: explicit, source: "explicit" };

  const x402 = env(`X402_${key}_RPC_URL`, e);
  if (x402) return { url: x402, source: "x402" };

  const alchemy = env("ALCHEMY_API_KEY", e);
  if (alchemy && ALCHEMY_MAINNET_SUBDOMAIN[network]) {
    return {
      url: `https://${ALCHEMY_MAINNET_SUBDOMAIN[network]}.g.alchemy.com/v2/${alchemy}`,
      source: "alchemy",
    };
  }

  const infura = env("INFURA_API_KEY", e);
  if (infura && INFURA_MAINNET_SUBDOMAIN[network]) {
    return {
      url: `https://${INFURA_MAINNET_SUBDOMAIN[network]}.infura.io/v3/${infura}`,
      source: "infura",
    };
  }

  return {
    url: MAINNET_CHAINS[network].rpcUrls.default.http[0],
    source: "public_default",
  };
}

// ---------------------------------------------------------------------------
// TESTNET RPC RESOLUTION
// ---------------------------------------------------------------------------

function resolveTestnetRpc(
  network: EvmPayoutNetwork,
  e: ProcessEnvLike,
): PayoutEvmRpcResolution {
  const key = TESTNET_NETWORK_KEY[network];

  // Payout-specific testnet override (highest priority for staging).
  const payoutOverride = env(`PAYOUT_TESTNET_${key}_RPC_URL`, e);
  if (payoutOverride) return { url: payoutOverride, source: "explicit" };

  // Standard testnet env var (e.g. SEPOLIA_RPC_URL, BASE_SEPOLIA_RPC_URL).
  const explicit = env(`${key}_RPC_URL`, e);
  if (explicit) return { url: explicit, source: "explicit" };

  // Chain's built-in testnet public RPC (last resort).
  return {
    url: TESTNET_CHAINS[network].rpcUrls.default.http[0],
    source: "public_default",
  };
}

// ---------------------------------------------------------------------------
// TOKEN ASSET RESOLUTION
// ---------------------------------------------------------------------------

function resolveTokenAsset(
  network: SupportedNetwork,
  asset: PayoutAsset,
  isTestnet: boolean,
): PayoutTokenAsset {
  if (asset === "usdc") {
    const table = isTestnet ? USDC_TESTNET_TOKEN_ADDRESSES : USDC_TOKEN_ADDRESSES;
    return { address: table[network], decimals: USDC_DECIMALS, symbol: "USDC" };
  }
  return {
    address: ELIZA_TOKEN_ADDRESSES[network],
    decimals: ELIZA_DECIMALS[network],
    symbol: "elizaOS",
  };
}

// ---------------------------------------------------------------------------
// COHERENT RESOLUTION
// ---------------------------------------------------------------------------

/**
 * Resolve a coherent chain + RPC + asset bundle for a payout on an EVM rail.
 *
 * In testnet mode the chain, RPC URL, and token contract are ALL testnet
 * (e.g. Base Sepolia chain, Base Sepolia RPC, Base Sepolia USDC). In mainnet
 * mode they are ALL mainnet. The shared {@link resolveEvmRpc} is never called
 * — this is fully independent of the non-payout consumers.
 *
 * @param network The EVM payout network (ethereum, base, bnb).
 * @param asset   The payout asset (usdc or eliza).
 * @param envOverride Optional env override (for testing). Defaults to cloud-aware bindings.
 */
export function resolvePayoutEvm(
  network: EvmPayoutNetwork,
  asset: PayoutAsset,
  envOverride?: ProcessEnvLike,
): PayoutEvmResolution {
  const e = envOverride ?? getCloudAwareEnv();
  const environment = resolvePayoutEnvironment(e);
  const isTestnet = environment === "testnet";

  const chain = isTestnet ? TESTNET_CHAINS[network] : MAINNET_CHAINS[network];
  const rpc = isTestnet ? resolveTestnetRpc(network, e) : resolveMainnetRpc(network, e);
  const tokenAsset = resolveTokenAsset(network, asset, isTestnet);

  return {
    chain,
    chainId: chain.id,
    rpc,
    asset: tokenAsset,
    environment,
    isTestnet,
  };
}

/**
 * Resolve just the chain for a payout rail (mainnet or testnet depending on
 * payout environment). Used by consumers that need the viem Chain without the
 * full resolution object.
 */
export function resolvePayoutChain(
  network: EvmPayoutNetwork,
  envOverride?: ProcessEnvLike,
): Chain {
  const e = envOverride ?? getCloudAwareEnv();
  const isTestnet = resolvePayoutEnvironment(e) === "testnet";
  return isTestnet ? TESTNET_CHAINS[network] : MAINNET_CHAINS[network];
}

/**
 * Resolve just the RPC URL for a payout rail. Coherent with the payout
 * environment — testnet mode yields a testnet RPC.
 */
export function resolvePayoutRpc(
  network: EvmPayoutNetwork,
  envOverride?: ProcessEnvLike,
): PayoutEvmRpcResolution {
  const e = envOverride ?? getCloudAwareEnv();
  const isTestnet = resolvePayoutEnvironment(e) === "testnet";
  return isTestnet ? resolveTestnetRpc(network, e) : resolveMainnetRpc(network, e);
}

// ---------------------------------------------------------------------------
// TESTNET CHAIN TABLE (exported for consumers that need direct access)
// ---------------------------------------------------------------------------

export const PAYOUT_TESTNET_CHAINS: Record<EvmPayoutNetwork, Chain> = TESTNET_CHAINS;
export const PAYOUT_MAINNET_CHAINS: Record<EvmPayoutNetwork, Chain> = MAINNET_CHAINS;
