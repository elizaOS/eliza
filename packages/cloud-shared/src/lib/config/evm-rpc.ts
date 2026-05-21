/**
 * EVM RPC URL resolution.
 *
 * Single source of truth for which RPC endpoint each EVM network uses when
 * reading balances, signing payouts, or verifying inbound transactions.
 *
 * Resolution order per network (first non-empty wins):
 *   1. CRYPTO_DIRECT_<NETWORK>_RPC_URL   (matches direct-wallet-payments naming)
 *   2. <NETWORK>_RPC_URL                  (e.g. BASE_RPC_URL, ETHEREUM_RPC_URL, BSC_RPC_URL)
 *   3. X402_<NETWORK>_RPC_URL             (matches x402-facilitator naming)
 *   4. ALCHEMY_API_KEY-derived URL        (if provided)
 *   5. INFURA_API_KEY-derived URL         (if provided)
 *   6. chain's built-in public RPC        (last resort — rate-limited, unreliable)
 *
 * The Solana RPC resolver lives in direct-wallet-payments.ts (solanaRpcUrl).
 */

import { base, bsc, type Chain, mainnet } from "viem/chains";

import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { EVM_CHAINS } from "./token-constants";

export type EvmPayoutNetwork = "ethereum" | "base" | "bnb";

const NETWORK_KEY: Record<EvmPayoutNetwork, string> = {
  ethereum: "ETHEREUM",
  base: "BASE",
  bnb: "BSC",
};

const ALCHEMY_SUBDOMAIN: Record<EvmPayoutNetwork, string | null> = {
  ethereum: "eth-mainnet",
  base: "base-mainnet",
  bnb: null,
};

const INFURA_SUBDOMAIN: Record<EvmPayoutNetwork, string | null> = {
  ethereum: "mainnet",
  base: "base-mainnet",
  bnb: null,
};

function env(key: string): string | null {
  const v = getCloudAwareEnv()[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function builtinPublicRpc(network: EvmPayoutNetwork): string {
  switch (network) {
    case "ethereum":
      return mainnet.rpcUrls.default.http[0];
    case "base":
      return base.rpcUrls.default.http[0];
    case "bnb":
      return bsc.rpcUrls.default.http[0];
  }
}

/**
 * Resolve the RPC URL for an EVM payout network.
 *
 * Never returns null — falls back to the chain's built-in public RPC, but
 * logs a warning via the returned `source` so callers can surface "RPC is
 * unconfigured" in admin dashboards.
 */
export function resolveEvmRpc(network: EvmPayoutNetwork): {
  url: string;
  source:
    | "crypto_direct"
    | "explicit"
    | "x402"
    | "alchemy"
    | "infura"
    | "public_default";
} {
  const key = NETWORK_KEY[network];

  const direct = env(`CRYPTO_DIRECT_${key}_RPC_URL`);
  if (direct) return { url: direct, source: "crypto_direct" };

  const explicit = env(`${key}_RPC_URL`);
  if (explicit) return { url: explicit, source: "explicit" };

  const x402 = env(`X402_${key}_RPC_URL`);
  if (x402) return { url: x402, source: "x402" };

  const alchemy = env("ALCHEMY_API_KEY");
  if (alchemy && ALCHEMY_SUBDOMAIN[network]) {
    return {
      url: `https://${ALCHEMY_SUBDOMAIN[network]}.g.alchemy.com/v2/${alchemy}`,
      source: "alchemy",
    };
  }

  const infura = env("INFURA_API_KEY");
  if (infura && INFURA_SUBDOMAIN[network]) {
    return {
      url: `https://${INFURA_SUBDOMAIN[network]}.infura.io/v3/${infura}`,
      source: "infura",
    };
  }

  return { url: builtinPublicRpc(network), source: "public_default" };
}

export function evmChain(network: EvmPayoutNetwork): Chain {
  const chain = EVM_CHAINS[network];
  if (!chain) throw new Error(`Unknown EVM network: ${network}`);
  return chain;
}

export function listEvmPayoutNetworks(): readonly EvmPayoutNetwork[] {
  return ["ethereum", "base", "bnb"];
}
