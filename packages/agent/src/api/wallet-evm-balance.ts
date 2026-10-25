/** Host credential/RPC composition for the wallet-owned read implementation. */
import {
  type EvmProviderKeys,
  type EvmProviderKeyset,
  fetchResolvedEvmBalances,
  fetchResolvedEvmNfts,
} from "@elizaos/plugin-wallet/read";

export {
  type AnkrTokenAsset,
  DEFAULT_EVM_CHAINS,
  type EvmBalanceChainConfig as EvmChainConfig,
  type EvmProviderKeys,
  fetchEvmNativeBalanceViaRpc,
} from "@elizaos/plugin-wallet/read";

import {
  resolveAvalancheRpcUrls,
  resolveBaseRpcUrls,
  resolveBscRpcUrls,
  resolveEthereumRpcUrls,
} from "./wallet-rpc.ts";

function normalizeApiKey(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeStringArray(
  values: ReadonlyArray<string | null | undefined> | null | undefined,
): string[] {
  return [
    ...new Set(
      (values ?? [])
        .map((value) => normalizeApiKey(value))
        .filter((value): value is string => Boolean(value)),
    ),
  ];
}

export function resolveEvmProviderKeys(
  alchemyOrKeys: string | EvmProviderKeys | null | undefined,
  maybeAnkrKey?: string | null,
): EvmProviderKeyset {
  if (typeof alchemyOrKeys === "string" || alchemyOrKeys == null) {
    const alchemyKey = typeof alchemyOrKeys === "string" ? alchemyOrKeys : null;
    return {
      alchemyKey: normalizeApiKey(alchemyKey),
      ankrKey: normalizeApiKey(maybeAnkrKey),
      cloudManagedAccess: false,
      bscRpcUrls: resolveBscRpcUrls({ cloudManagedAccess: false }),
      ethereumRpcUrls: resolveEthereumRpcUrls({ cloudManagedAccess: false }),
      baseRpcUrls: resolveBaseRpcUrls({ cloudManagedAccess: false }),
      avaxRpcUrls: resolveAvalancheRpcUrls({ cloudManagedAccess: false }),
      nodeRealBscRpcUrl: normalizeApiKey(
        process.env.NODEREAL_BSC_RPC_URL ?? null,
      ),
      quickNodeBscRpcUrl: normalizeApiKey(
        process.env.QUICKNODE_BSC_RPC_URL ?? null,
      ),
      bscRpcUrl: normalizeApiKey(process.env.BSC_RPC_URL ?? null),
      ethereumRpcUrl: normalizeApiKey(process.env.ETHEREUM_RPC_URL ?? null),
      baseRpcUrl: normalizeApiKey(process.env.BASE_RPC_URL ?? null),
      avaxRpcUrl: normalizeApiKey(process.env.AVALANCHE_RPC_URL ?? null),
    };
  }
  const cloudManagedAccess = Boolean(alchemyOrKeys.cloudManagedAccess);
  return {
    alchemyKey: normalizeApiKey(alchemyOrKeys.alchemyKey),
    ankrKey: normalizeApiKey(alchemyOrKeys.ankrKey ?? maybeAnkrKey),
    cloudManagedAccess,
    bscRpcUrls: normalizeStringArray([
      ...(alchemyOrKeys.bscRpcUrls ?? []),
      alchemyOrKeys.nodeRealBscRpcUrl ?? process.env.NODEREAL_BSC_RPC_URL,
      alchemyOrKeys.quickNodeBscRpcUrl ?? process.env.QUICKNODE_BSC_RPC_URL,
      alchemyOrKeys.bscRpcUrl ?? process.env.BSC_RPC_URL,
      ...resolveBscRpcUrls({ cloudManagedAccess }),
    ]),
    ethereumRpcUrls: normalizeStringArray([
      ...(alchemyOrKeys.ethereumRpcUrls ?? []),
      alchemyOrKeys.ethereumRpcUrl ?? process.env.ETHEREUM_RPC_URL,
      ...resolveEthereumRpcUrls({ cloudManagedAccess }),
    ]),
    baseRpcUrls: normalizeStringArray([
      ...(alchemyOrKeys.baseRpcUrls ?? []),
      alchemyOrKeys.baseRpcUrl ?? process.env.BASE_RPC_URL,
      ...resolveBaseRpcUrls({ cloudManagedAccess }),
    ]),
    avaxRpcUrls: normalizeStringArray([
      ...(alchemyOrKeys.avaxRpcUrls ?? []),
      alchemyOrKeys.avaxRpcUrl ?? process.env.AVALANCHE_RPC_URL,
      ...resolveAvalancheRpcUrls({ cloudManagedAccess }),
    ]),
    nodeRealBscRpcUrl: normalizeApiKey(
      alchemyOrKeys.nodeRealBscRpcUrl ?? process.env.NODEREAL_BSC_RPC_URL,
    ),
    quickNodeBscRpcUrl: normalizeApiKey(
      alchemyOrKeys.quickNodeBscRpcUrl ?? process.env.QUICKNODE_BSC_RPC_URL,
    ),
    bscRpcUrl: normalizeApiKey(
      alchemyOrKeys.bscRpcUrl ?? process.env.BSC_RPC_URL,
    ),
    ethereumRpcUrl: normalizeApiKey(
      alchemyOrKeys.ethereumRpcUrl ?? process.env.ETHEREUM_RPC_URL,
    ),
    baseRpcUrl: normalizeApiKey(
      alchemyOrKeys.baseRpcUrl ?? process.env.BASE_RPC_URL,
    ),
    avaxRpcUrl: normalizeApiKey(
      alchemyOrKeys.avaxRpcUrl ?? process.env.AVALANCHE_RPC_URL,
    ),
  };
}

export function fetchEvmBalances(
  address: string,
  alchemyOrKeys: string | EvmProviderKeys | null | undefined,
  maybeAnkrKey?: string | null,
  knownTokenAddresses?: string[],
) {
  return fetchResolvedEvmBalances(
    address,
    resolveEvmProviderKeys(alchemyOrKeys, maybeAnkrKey),
    knownTokenAddresses,
  );
}
export function fetchEvmNfts(
  address: string,
  alchemyOrKeys: string | EvmProviderKeys | null | undefined,
  maybeAnkrKey?: string | null,
) {
  return fetchResolvedEvmNfts(
    address,
    resolveEvmProviderKeys(alchemyOrKeys, maybeAnkrKey),
  );
}
