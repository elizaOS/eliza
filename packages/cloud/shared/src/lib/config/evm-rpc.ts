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

import { base, baseSepolia, bsc, bscTestnet, type Chain, mainnet, sepolia } from "viem/chains";

import { getPayoutEnvironment } from "./payout-networks";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { EVM_CHAINS } from "./token-constants";

export type EvmPayoutNetwork = "ethereum" | "base" | "bnb";

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

function env(key: string): string | null {
  const v = getCloudAwareEnv()[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

const MAINNET_CHAINS: Record<EvmPayoutNetwork, Chain> = {
  ethereum: mainnet,
  base: base,
  bnb: bsc,
};

const TESTNET_CHAINS: Record<EvmPayoutNetwork, Chain> = {
  ethereum: sepolia,
  base: baseSepolia,
  bnb: bscTestnet,
};

/**
 * The testnet RPC env keys searched in `resolveEvmRpc`. Mirrors the mainnet key
 * pattern with a `_SEPOLIA` / `_TESTNET` suffix so a staging deployment can set
 * the testnet endpoint without colliding with a mainnet endpoint on the same var.
 */
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

function builtinPublicRpc(network: EvmPayoutNetwork, testnet: boolean): string {
  const table = testnet ? TESTNET_CHAINS : MAINNET_CHAINS;
  return table[network].rpcUrls.default.http[0];
}

/**
 * Resolve the RPC URL for an EVM payout network.
 *
 * In testnet mode (PAYOUT_TESTNET=true, or NODE_ENV development/test) the
 * resolver returns a testnet endpoint and the matching testnet chain, so chain
 * ID, RPC, and the (testnet) USDC token address all agree on the environment.
 * Never returns null — falls back to the chain's built-in public RPC, but
 * flags it via the returned `source` so callers can surface "RPC is
 * unconfigured" in admin dashboards.
 */
export function resolveEvmRpc(network: EvmPayoutNetwork): {
  url: string;
  source: "crypto_direct" | "explicit" | "x402" | "alchemy" | "infura" | "public_default";
} {
  const testnet = getPayoutEnvironment() === "testnet";

  if (testnet) {
    // Testnet-mode RPC resolution: explicit testnet endpoints first, then the
    // provider keys, then the built-in public testnet RPC. We deliberately do
    // NOT honor mainnet-named vars (CRYPTO_DIRECT_BASE_RPC_URL, BASE_RPC_URL) in
    // testnet mode: staging sets those to the Base mainnet endpoint, and using
    // them would sign a Base mainnet transfer while the token config resolved
    // the Base Sepolia USDC address — the exact chain/token incoherence #13100
    // exists to fix.
    const testnetExplicit = env(testnetRpcEnvKey(network));
    if (testnetExplicit) return { url: testnetExplicit, source: "explicit" };

    const alchemy = env("ALCHEMY_API_KEY");
    const alchemySub = ALCHEMY_SUBDOMAIN_TESTNET[network];
    if (alchemy && alchemySub) {
      return {
        url: `https://${alchemySub}.g.alchemy.com/v2/${alchemy}`,
        source: "alchemy",
      };
    }

    const infura = env("INFURA_API_KEY");
    const infuraSub = INFURA_SUBDOMAIN_TESTNET[network];
    if (infura && infuraSub) {
      return {
        url: `https://${infuraSub}.infura.io/v3/${infura}`,
        source: "infura",
      };
    }

    return { url: builtinPublicRpc(network, true), source: "public_default" };
  }

  const key = NETWORK_KEY[network];

  const direct = env(`CRYPTO_DIRECT_${key}_RPC_URL`);
  if (direct) return { url: direct, source: "crypto_direct" };

  const explicit = env(`${key}_RPC_URL`);
  if (explicit) return { url: explicit, source: "explicit" };

  const x402 = env(`X402_${key}_RPC_URL`);
  if (x402) return { url: x402, source: "x402" };

  const alchemy = env("ALCHEMY_API_KEY");
  if (alchemy && ALCHEMY_SUBDOMAIN_MAINNET[network]) {
    return {
      url: `https://${ALCHEMY_SUBDOMAIN_MAINNET[network]}.g.alchemy.com/v2/${alchemy}`,
      source: "alchemy",
    };
  }

  const infura = env("INFURA_API_KEY");
  if (infura && INFURA_SUBDOMAIN_MAINNET[network]) {
    return {
      url: `https://${INFURA_SUBDOMAIN_MAINNET[network]}.infura.io/v3/${infura}`,
      source: "infura",
    };
  }

  return { url: builtinPublicRpc(network, false), source: "public_default" };
}

/**
 * Resolve the viem chain for an EVM payout network, environment-aware.
 *
 * In testnet mode this returns the testnet chain (e.g. Base Sepolia, chainId
 * 84532) so the signed transaction's chain ID matches the RPC endpoint and the
 * (testnet) token address the transfer is built against. Returning the mainnet
 * chain while the RPC resolves a testnet endpoint caused #13100's signature
 * domain mismatch.
 */
export function evmChain(network: EvmPayoutNetwork): Chain {
  const testnet = getPayoutEnvironment() === "testnet";
  const table = testnet ? TESTNET_CHAINS : MAINNET_CHAINS;
  const chain = table[network];
  if (!chain) throw new Error(`Unknown EVM network: ${network}`);
  return chain;
}

/**
 * Back-compat: the mainnet-only chain table. Callers that must resolve the
 * mainnet chain regardless of environment (token-redemption-secure address
 * validation, direct-wallet-payments) keep this; payout execution paths should
 * use {@link evmChain} for environment coherence.
 */
export function evmChainMainnet(network: EvmPayoutNetwork): Chain {
  const chain = EVM_CHAINS[network];
  if (!chain) throw new Error(`Unknown EVM network: ${network}`);
  return chain;
}

export function listEvmPayoutNetworks(): readonly EvmPayoutNetwork[] {
  return ["ethereum", "base", "bnb"];
}
