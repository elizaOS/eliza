import type { MiladyConfig } from "../config/config";

export const DEFAULT_CLOUD_API_BASE_URL = "https://elizacloud.ai/api/v1";
export const DEFAULT_PUBLIC_BSC_RPC_URLS = [
  "https://bsc-dataseed1.binance.org/",
] as const;
export const DEFAULT_PUBLIC_ETHEREUM_RPC_URLS = [
  "https://ethereum.publicnode.com/",
] as const;
export const DEFAULT_PUBLIC_BASE_RPC_URLS = [
  "https://base.publicnode.com/",
] as const;
export const DEFAULT_PUBLIC_AVALANCHE_RPC_URLS = [
  "https://avalanche.publicnode.com/ext/bc/C/rpc",
] as const;
export const DEFAULT_PUBLIC_SOLANA_RPC_URLS = [
  "https://api.mainnet-beta.solana.com",
] as const;

export interface WalletRpcResolutionOptions {
  cloudManagedAccess?: boolean | null;
  cloudApiKey?: string | null;
  cloudBaseUrl?: string | null;
}

export interface WalletRpcReadiness {
  cloudManagedAccess: boolean;
  managedBscRpcReady: boolean;
  evmBalanceReady: boolean;
  solanaBalanceReady: boolean;
  bscRpcUrls: string[];
  ethereumRpcUrls: string[];
  baseRpcUrls: string[];
  avalancheRpcUrls: string[];
  solanaRpcUrls: string[];
}

type SupportedCloudEvmRpcChain = "mainnet" | "base" | "bsc" | "avalanche";

export function normalizeRpcUrl(url: string | null | undefined): string | null {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function uniqueRpcUrls(
  ...groups: Array<ReadonlyArray<string | null | undefined>>
): string[] {
  return [
    ...new Set(
      groups
        .flat()
        .map((url) => normalizeRpcUrl(url))
        .filter((url): url is string => Boolean(url)),
    ),
  ];
}

function normalizeSecret(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveCloudApiBaseUrl(
  rawBaseUrl?: string | null,
): string | null {
  const candidate =
    normalizeSecret(rawBaseUrl ?? process.env.ELIZAOS_CLOUD_BASE_URL) ??
    DEFAULT_CLOUD_API_BASE_URL;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    parsed.hash = "";
    parsed.search = "";
    const normalizedBase = parsed.toString().replace(/\/+$/, "");
    return normalizedBase.endsWith("/api/v1")
      ? normalizedBase
      : `${normalizedBase}/api/v1`;
  } catch {
    return null;
  }
}

export function resolveCloudApiKey(
  config?: Pick<MiladyConfig, "cloud"> | null,
): string | null {
  return normalizeSecret(
    config?.cloud?.apiKey ?? process.env.ELIZAOS_CLOUD_API_KEY,
  );
}

function buildCloudRpcProxyUrl(
  pathname: string,
  options: WalletRpcResolutionOptions = {},
): string | null {
  const cloudApiKey = normalizeSecret(
    options.cloudApiKey ?? process.env.ELIZAOS_CLOUD_API_KEY,
  );
  const cloudManagedAccess = options.cloudManagedAccess ?? Boolean(cloudApiKey);
  if (!cloudManagedAccess || !cloudApiKey) {
    return null;
  }

  const cloudBaseUrl = resolveCloudApiBaseUrl(options.cloudBaseUrl);
  if (!cloudBaseUrl) {
    return null;
  }

  const url = new URL(
    pathname.replace(/^\/+/, ""),
    `${cloudBaseUrl.replace(/\/+$/, "")}/`,
  );
  url.searchParams.set("api_key", cloudApiKey);
  return normalizeRpcUrl(url.toString());
}

export function buildCloudEvmRpcUrl(
  chain: SupportedCloudEvmRpcChain,
  options: WalletRpcResolutionOptions = {},
): string | null {
  return buildCloudRpcProxyUrl(`proxy/evm-rpc/${chain}`, options);
}

export function buildCloudSolanaRpcUrl(
  options: WalletRpcResolutionOptions = {},
): string | null {
  return buildCloudRpcProxyUrl("proxy/solana-rpc", options);
}

export function hasElizaCloudRpcAccess(
  config?: Pick<MiladyConfig, "cloud"> | null,
): boolean {
  return Boolean(resolveCloudApiKey(config));
}

export function resolveBscRpcUrls(
  options: WalletRpcResolutionOptions = {},
): string[] {
  return uniqueRpcUrls(
    [
      process.env.NODEREAL_BSC_RPC_URL,
      process.env.QUICKNODE_BSC_RPC_URL,
      process.env.BSC_RPC_URL,
      buildCloudEvmRpcUrl("bsc", options),
    ],
    options.cloudManagedAccess ? DEFAULT_PUBLIC_BSC_RPC_URLS : [],
  );
}

export function resolveEthereumRpcUrls(
  options: WalletRpcResolutionOptions = {},
): string[] {
  return uniqueRpcUrls(
    [process.env.ETHEREUM_RPC_URL, buildCloudEvmRpcUrl("mainnet", options)],
    options.cloudManagedAccess ? DEFAULT_PUBLIC_ETHEREUM_RPC_URLS : [],
  );
}

export function resolveBaseRpcUrls(
  options: WalletRpcResolutionOptions = {},
): string[] {
  return uniqueRpcUrls(
    [process.env.BASE_RPC_URL, buildCloudEvmRpcUrl("base", options)],
    options.cloudManagedAccess ? DEFAULT_PUBLIC_BASE_RPC_URLS : [],
  );
}

export function resolveAvalancheRpcUrls(
  options: WalletRpcResolutionOptions = {},
): string[] {
  return uniqueRpcUrls(
    [process.env.AVALANCHE_RPC_URL, buildCloudEvmRpcUrl("avalanche", options)],
    options.cloudManagedAccess ? DEFAULT_PUBLIC_AVALANCHE_RPC_URLS : [],
  );
}

export function resolveSolanaRpcUrls(
  options: WalletRpcResolutionOptions = {},
): string[] {
  return uniqueRpcUrls(
    [process.env.SOLANA_RPC_URL, buildCloudSolanaRpcUrl(options)],
    options.cloudManagedAccess ? DEFAULT_PUBLIC_SOLANA_RPC_URLS : [],
  );
}

export function resolveWalletRpcReadiness(
  config?: Pick<MiladyConfig, "cloud"> | null,
): WalletRpcReadiness {
  const cloudApiKey = resolveCloudApiKey(config);
  const cloudBaseUrl = resolveCloudApiBaseUrl(config?.cloud?.baseUrl);
  const cloudManagedAccess = Boolean(cloudApiKey);
  const cloudOptions = {
    cloudManagedAccess,
    cloudApiKey,
    cloudBaseUrl,
  } satisfies WalletRpcResolutionOptions;
  const bscRpcUrls = resolveBscRpcUrls(cloudOptions);
  const ethereumRpcUrls = resolveEthereumRpcUrls(cloudOptions);
  const baseRpcUrls = resolveBaseRpcUrls(cloudOptions);
  const avalancheRpcUrls = resolveAvalancheRpcUrls(cloudOptions);
  const solanaRpcUrls = resolveSolanaRpcUrls(cloudOptions);

  return {
    cloudManagedAccess,
    managedBscRpcReady: bscRpcUrls.length > 0,
    evmBalanceReady: Boolean(
      process.env.ALCHEMY_API_KEY?.trim() ||
        process.env.ANKR_API_KEY?.trim() ||
        bscRpcUrls.length > 0 ||
        ethereumRpcUrls.length > 0 ||
        baseRpcUrls.length > 0 ||
        avalancheRpcUrls.length > 0,
    ),
    solanaBalanceReady: Boolean(
      process.env.HELIUS_API_KEY?.trim() || solanaRpcUrls.length > 0,
    ),
    bscRpcUrls,
    ethereumRpcUrls,
    baseRpcUrls,
    avalancheRpcUrls,
    solanaRpcUrls,
  };
}
