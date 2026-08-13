/**
 * EVM RPC URL resolution.
 *
 * The shared resolver remains mainnet-only because non-payout consumers pair it
 * with mainnet chain metadata. Payout callers use the payout-specific resolver
 * and chain helper so staging selects a coherent testnet RPC and chain.
 *
 * The Solana RPC resolver lives in direct-wallet-payments.ts (solanaRpcUrl).
 */

import { base, baseSepolia, bsc, bscTestnet, type Chain, mainnet, sepolia } from "viem/chains";

import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { getPayoutEnvironment } from "./payout-networks";
import { EVM_CHAINS } from "./token-constants";

export type EvmPayoutNetwork = "ethereum" | "base" | "bnb";

type EvmRpcResolution = {
  url: string;
  source: "crypto_direct" | "explicit" | "x402" | "alchemy" | "infura" | "public_default";
};

const NETWORK_KEY: Record<EvmPayoutNetwork, string> = {
  ethereum: "ETHEREUM",
  base: "BASE",
  bnb: "BSC",
};

const ALCHEMY_SUBDOMAIN_MAINNET: Record<EvmPayoutNetwork, string | null> = {
  ethereum: "eth-mainnet",
  base: "base-mainnet",
  bnb: null,
};

const INFURA_SUBDOMAIN_MAINNET: Record<EvmPayoutNetwork, string | null> = {
  ethereum: "mainnet",
  base: "base-mainnet",
  bnb: null,
};

const ALCHEMY_SUBDOMAIN_TESTNET: Record<EvmPayoutNetwork, string | null> = {
  ethereum: "eth-sepolia",
  base: "base-sepolia",
  bnb: null,
};

const INFURA_SUBDOMAIN_TESTNET: Record<EvmPayoutNetwork, string | null> = {
  ethereum: "sepolia",
  base: "base-sepolia",
  bnb: null,
};

const MAINNET_CHAINS: Record<EvmPayoutNetwork, Chain> = {
  ethereum: mainnet,
  base,
  bnb: bsc,
};

const TESTNET_CHAINS: Record<EvmPayoutNetwork, Chain> = {
  ethereum: sepolia,
  base: baseSepolia,
  bnb: bscTestnet,
};

function env(key: string): string | null {
  const value = getCloudAwareEnv()[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function testnetRpcEnvKey(network: EvmPayoutNetwork): string {
  switch (network) {
    case "ethereum":
      return "SEPOLIA_RPC_URL";
    case "base":
      return "BASE_SEPOLIA_RPC_URL";
    case "bnb":
      return "BNB_TESTNET_RPC_URL";
  }
}

/**
 * Resolve a mainnet EVM RPC URL for shared consumers.
 *
 * Resolution order is direct-wallet, explicit, x402, provider-derived, then
 * the chain's built-in public RPC. Payout environment flags do not affect this
 * contract because callers such as price oracles and ERC-8004 use mainnet
 * chains and contracts.
 */
export function resolveEvmRpc(network: EvmPayoutNetwork): EvmRpcResolution {
  const key = NETWORK_KEY[network];

  const direct = env(`CRYPTO_DIRECT_${key}_RPC_URL`);
  if (direct) return { url: direct, source: "crypto_direct" };

  const explicit = env(`${key}_RPC_URL`);
  if (explicit) return { url: explicit, source: "explicit" };

  const x402 = env(`X402_${key}_RPC_URL`);
  if (x402) return { url: x402, source: "x402" };

  const alchemy = env("ALCHEMY_API_KEY");
  const alchemySubdomain = ALCHEMY_SUBDOMAIN_MAINNET[network];
  if (alchemy && alchemySubdomain) {
    return {
      url: `https://${alchemySubdomain}.g.alchemy.com/v2/${alchemy}`,
      source: "alchemy",
    };
  }

  const infura = env("INFURA_API_KEY");
  const infuraSubdomain = INFURA_SUBDOMAIN_MAINNET[network];
  if (infura && infuraSubdomain) {
    return {
      url: `https://${infuraSubdomain}.infura.io/v3/${infura}`,
      source: "infura",
    };
  }

  return { url: MAINNET_CHAINS[network].rpcUrls.default.http[0], source: "public_default" };
}

/** Resolve the RPC used by payout execution and payout balance gates. */
export function resolvePayoutEvmRpc(network: EvmPayoutNetwork): EvmRpcResolution {
  if (getPayoutEnvironment() === "mainnet") return resolveEvmRpc(network);

  const explicit = env(testnetRpcEnvKey(network));
  if (explicit) return { url: explicit, source: "explicit" };

  const alchemy = env("ALCHEMY_API_KEY");
  const alchemySubdomain = ALCHEMY_SUBDOMAIN_TESTNET[network];
  if (alchemy && alchemySubdomain) {
    return {
      url: `https://${alchemySubdomain}.g.alchemy.com/v2/${alchemy}`,
      source: "alchemy",
    };
  }

  const infura = env("INFURA_API_KEY");
  const infuraSubdomain = INFURA_SUBDOMAIN_TESTNET[network];
  if (infura && infuraSubdomain) {
    return {
      url: `https://${infuraSubdomain}.infura.io/v3/${infura}`,
      source: "infura",
    };
  }

  return { url: TESTNET_CHAINS[network].rpcUrls.default.http[0], source: "public_default" };
}

/** Resolve the mainnet viem chain used by shared non-payout consumers. */
export function evmChain(network: EvmPayoutNetwork): Chain {
  const chain = EVM_CHAINS[network];
  if (!chain) throw new Error(`Unknown EVM network: ${network}`);
  return chain;
}

/** Resolve the environment-aware viem chain used by payout callers. */
export function payoutEvmChain(network: EvmPayoutNetwork): Chain {
  return getPayoutEnvironment() === "testnet" ? TESTNET_CHAINS[network] : MAINNET_CHAINS[network];
}

export function listEvmPayoutNetworks(): readonly EvmPayoutNetwork[] {
  return ["ethereum", "base", "bnb"];
}
