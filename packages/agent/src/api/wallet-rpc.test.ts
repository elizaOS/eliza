/**
 * Behavioral coverage for `wallet-rpc.ts`: URL normalization, network-mode
 * resolution, provider inference, cloud-proxy composition, public-fallback
 * ordering, config updates, and readiness. Drives the real module; process.env
 * is isolated because the resolver reads credentials from it.
 */
import {
  DEFAULT_WALLET_RPC_SELECTIONS,
  resolveCloudApiBaseUrl,
  type WalletConfigUpdateRequest,
  type WalletRpcSelections,
} from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyWalletRpcConfigUpdate,
  buildCloudEvmRpcUrl,
  buildCloudSolanaRpcUrl,
  DEFAULT_PUBLIC_AVALANCHE_RPC_URLS,
  DEFAULT_PUBLIC_BASE_RPC_URLS,
  DEFAULT_PUBLIC_BSC_RPC_URLS,
  DEFAULT_PUBLIC_BSC_TESTNET_RPC_URLS,
  DEFAULT_PUBLIC_ETHEREUM_RPC_URLS,
  DEFAULT_PUBLIC_SOLANA_RPC_URLS,
  DEFAULT_PUBLIC_SOLANA_TESTNET_RPC_URLS,
  getInventoryProviderOptions,
  getStoredWalletRpcSelections,
  hasElizaCloudRpcAccess,
  normalizeRpcUrl,
  resolveAvalancheRpcUrls,
  resolveBaseRpcUrls,
  resolveBscRpcUrls,
  resolveEthereumRpcUrls,
  resolveSolanaRpcUrls,
  resolveWalletNetworkMode,
  resolveWalletRpcReadiness,
} from "./wallet-rpc.ts";

const ENV_KEYS = [
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_BASE_URL",
  "ELIZA_DEV_SOURCE",
  "ELIZA_WALLET_NETWORK",
  "ALCHEMY_API_KEY",
  "INFURA_API_KEY",
  "ANKR_API_KEY",
  "ETHEREUM_RPC_URL",
  "BASE_RPC_URL",
  "AVALANCHE_RPC_URL",
  "HELIUS_API_KEY",
  "BIRDEYE_API_KEY",
  "NODEREAL_BSC_RPC_URL",
  "QUICKNODE_BSC_RPC_URL",
  "BSC_RPC_URL",
  "BSC_TESTNET_RPC_URL",
  "SOLANA_RPC_URL",
  "SOLANA_TESTNET_RPC_URL",
] as const;

type EnvSnapshot = Partial<Record<(typeof ENV_KEYS)[number], string>>;

type RpcConfig = {
  cloud?: { apiKey?: string; baseUrl?: string };
  env?: Record<string, string>;
  wallet?: {
    rpcProviders?: Partial<Record<keyof WalletRpcSelections, string>>;
    network?: "mainnet" | "testnet";
  };
};

function snapshotEnv(): EnvSnapshot {
  const snap: EnvSnapshot = {};
  for (const key of ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) snap[key] = value;
  }
  return snap;
}

function restoreEnv(snap: EnvSnapshot): void {
  for (const key of ENV_KEYS) {
    const value = snap[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function clearWalletEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

function normalizedUrls(urls: readonly string[]): string[] {
  const out: string[] = [];
  for (const url of urls) {
    const normalized = normalizeRpcUrl(url);
    if (normalized) out.push(normalized);
  }
  return out;
}

function expectedCloudEvmUrl(
  chain: "mainnet" | "base" | "bsc" | "avalanche",
  apiKey: string,
  cloudBaseUrl?: string,
): string {
  const base = resolveCloudApiBaseUrl(cloudBaseUrl);
  const url = new URL(`proxy/evm-rpc/${chain}`, `${base.replace(/\/+$/, "")}/`);
  url.searchParams.set("api_key", apiKey);
  return url.toString();
}

function expectedCloudSolanaUrl(apiKey: string, cloudBaseUrl?: string): string {
  const base = resolveCloudApiBaseUrl(cloudBaseUrl);
  const url = new URL("proxy/solana-rpc", `${base.replace(/\/+$/, "")}/`);
  url.searchParams.set("api_key", apiKey);
  return url.toString();
}

const ALL_CUSTOM: WalletRpcSelections = {
  evm: "alchemy",
  bsc: "nodereal",
  solana: "helius-birdeye",
};

describe("normalizeRpcUrl", () => {
  it("returns null for missing, non-string, empty, and whitespace input", () => {
    expect(normalizeRpcUrl(null)).toBeNull();
    expect(normalizeRpcUrl(undefined)).toBeNull();
    expect(normalizeRpcUrl("")).toBeNull();
    expect(normalizeRpcUrl("   ")).toBeNull();
  });

  it("rejects non-http(s) protocols and unparseable values", () => {
    expect(normalizeRpcUrl("ftp://rpc.example")).toBeNull();
    expect(normalizeRpcUrl("file:///tmp/rpc")).toBeNull();
    expect(normalizeRpcUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeRpcUrl("not a url")).toBeNull();
    expect(normalizeRpcUrl("example.com")).toBeNull();
  });

  it("accepts http and https and canonicalizes via URL#toString", () => {
    expect(normalizeRpcUrl("https://bsc.publicnode.com")).toBe(
      "https://bsc.publicnode.com/",
    );
    expect(normalizeRpcUrl("  http://127.0.0.1:8545/  ")).toBe(
      "http://127.0.0.1:8545/",
    );
    expect(normalizeRpcUrl("https://rpc.example/path?api_key=abc")).toBe(
      "https://rpc.example/path?api_key=abc",
    );
  });
});

describe("public RPC catalogs", () => {
  it("keep non-empty https fallbacks in declared order without duplicates", () => {
    const catalogs = [
      DEFAULT_PUBLIC_BSC_RPC_URLS,
      DEFAULT_PUBLIC_BSC_TESTNET_RPC_URLS,
      DEFAULT_PUBLIC_ETHEREUM_RPC_URLS,
      DEFAULT_PUBLIC_BASE_RPC_URLS,
      DEFAULT_PUBLIC_AVALANCHE_RPC_URLS,
      DEFAULT_PUBLIC_SOLANA_RPC_URLS,
      DEFAULT_PUBLIC_SOLANA_TESTNET_RPC_URLS,
    ];
    for (const catalog of catalogs) {
      expect(catalog.length).toBeGreaterThan(0);
      expect(normalizedUrls(catalog)).toEqual([
        ...new Set(normalizedUrls(catalog)),
      ]);
      for (const url of catalog) {
        expect(url.startsWith("https://")).toBe(true);
      }
    }
  });
});

describe("resolveWalletNetworkMode", () => {
  let snap: EnvSnapshot;

  beforeEach(() => {
    snap = snapshotEnv();
    clearWalletEnv();
  });

  afterEach(() => {
    restoreEnv(snap);
  });

  it("prefers an explicit fallback over config and env", () => {
    process.env.ELIZA_WALLET_NETWORK = "testnet";
    expect(
      resolveWalletNetworkMode({ wallet: { network: "testnet" } }, "mainnet"),
    ).toBe("mainnet");
    expect(
      resolveWalletNetworkMode({ wallet: { network: "mainnet" } }, "testnet"),
    ).toBe("testnet");
  });

  it("reads config.wallet.network then ELIZA_WALLET_NETWORK, case-insensitively", () => {
    expect(resolveWalletNetworkMode({ wallet: { network: "testnet" } })).toBe(
      "testnet",
    );
    process.env.ELIZA_WALLET_NETWORK = " TESTNET ";
    expect(resolveWalletNetworkMode()).toBe("testnet");
    process.env.ELIZA_WALLET_NETWORK = "MainNet";
    expect(resolveWalletNetworkMode()).toBe("mainnet");
  });

  it("treats unknown or empty values as mainnet, including an empty fallback", () => {
    process.env.ELIZA_WALLET_NETWORK = "devnet";
    expect(resolveWalletNetworkMode()).toBe("mainnet");
    expect(
      resolveWalletNetworkMode({ wallet: { network: "testnet" } }, ""),
    ).toBe("mainnet");
    expect(resolveWalletNetworkMode(null, undefined)).toBe("mainnet");
  });

  it("does not treat BSC_TESTNET_RPC_URL as a network-mode switch", () => {
    process.env.BSC_TESTNET_RPC_URL = "https://bsc-testnet.publicnode.com/";
    expect(resolveWalletNetworkMode()).toBe("mainnet");
  });
});

describe("getInventoryProviderOptions", () => {
  it("exposes evm, bsc, and solana catalogs with cloud free and others keyed", () => {
    const options = getInventoryProviderOptions();
    expect(options.map((chain) => chain.id)).toEqual(["evm", "bsc", "solana"]);

    for (const chain of options) {
      const cloud = chain.rpcProviders.find((p) => p.id === "eliza-cloud");
      expect(cloud?.requiresKey).toBe(false);
      expect(cloud?.envKey).toBeNull();
      for (const provider of chain.rpcProviders) {
        if (provider.id === "eliza-cloud") continue;
        expect(provider.requiresKey).toBe(true);
        expect(provider.envKey).toBeTruthy();
      }
    }

    const evmIds = options[0]?.rpcProviders.map((p) => p.id);
    expect(evmIds).toEqual(["eliza-cloud", "infura", "alchemy", "ankr"]);
    const bscIds = options[1]?.rpcProviders.map((p) => p.id);
    expect(bscIds).toEqual([
      "eliza-cloud",
      "alchemy",
      "ankr",
      "nodereal",
      "quicknode",
    ]);
    const solanaIds = options[2]?.rpcProviders.map((p) => p.id);
    expect(solanaIds).toEqual(["eliza-cloud", "helius-birdeye"]);
  });
});

describe("getStoredWalletRpcSelections", () => {
  it("fills missing and invalid providers with the shared defaults", () => {
    expect(getStoredWalletRpcSelections()).toEqual(
      DEFAULT_WALLET_RPC_SELECTIONS,
    );
    expect(getStoredWalletRpcSelections(null)).toEqual(
      DEFAULT_WALLET_RPC_SELECTIONS,
    );
    expect(
      getStoredWalletRpcSelections({
        wallet: { rpcProviders: { evm: "alchemy", bsc: "nope" } },
      }),
    ).toEqual({
      evm: "alchemy",
      bsc: DEFAULT_WALLET_RPC_SELECTIONS.bsc,
      solana: DEFAULT_WALLET_RPC_SELECTIONS.solana,
    });
  });
});

describe("cloud RPC access and proxy URLs", () => {
  let snap: EnvSnapshot;

  beforeEach(() => {
    snap = snapshotEnv();
    clearWalletEnv();
  });

  afterEach(() => {
    restoreEnv(snap);
  });

  it("denies cloud RPC access without a usable API key", () => {
    expect(hasElizaCloudRpcAccess()).toBe(false);
    expect(hasElizaCloudRpcAccess({ cloud: { apiKey: "   " } })).toBe(false);
    process.env.ELIZAOS_CLOUD_API_KEY = "cloud-key";
    expect(hasElizaCloudRpcAccess()).toBe(true);
    expect(hasElizaCloudRpcAccess({ cloud: { apiKey: "from-config" } })).toBe(
      true,
    );
  });

  it("denies cloud RPC access when every stored selection is a custom provider", () => {
    process.env.ELIZAOS_CLOUD_API_KEY = "cloud-key";
    expect(
      hasElizaCloudRpcAccess({
        cloud: { apiKey: "cloud-key" },
        wallet: { rpcProviders: ALL_CUSTOM },
      }),
    ).toBe(false);
  });

  it("builds cloud proxy URLs only when managed access and a key are both present", () => {
    expect(buildCloudEvmRpcUrl("bsc")).toBeNull();
    expect(buildCloudSolanaRpcUrl()).toBeNull();

    process.env.ELIZAOS_CLOUD_API_KEY = "cloud-key";
    expect(
      buildCloudEvmRpcUrl("bsc", { cloudManagedAccess: false }),
    ).toBeNull();
    expect(
      buildCloudEvmRpcUrl("bsc", {
        cloudManagedAccess: true,
        cloudApiKey: "   ",
      }),
    ).toBeNull();

    const built = buildCloudEvmRpcUrl("bsc", { cloudManagedAccess: true });
    expect(built).toBe(expectedCloudEvmUrl("bsc", "cloud-key"));
    expect(buildCloudSolanaRpcUrl({ cloudManagedAccess: true })).toBe(
      expectedCloudSolanaUrl("cloud-key"),
    );
  });

  it("covers every supported EVM cloud chain and honors an explicit API key", () => {
    for (const chain of ["mainnet", "base", "bsc", "avalanche"] as const) {
      expect(
        buildCloudEvmRpcUrl(chain, {
          cloudManagedAccess: true,
          cloudApiKey: "explicit",
        }),
      ).toBe(expectedCloudEvmUrl(chain, "explicit"));
    }
  });

  it("composes a loopback cloud base URL without forcing https", () => {
    const built = buildCloudEvmRpcUrl("mainnet", {
      cloudManagedAccess: true,
      cloudApiKey: "local-key",
      cloudBaseUrl: "http://127.0.0.1:8787/api/v1",
    });
    expect(built).toBe(
      expectedCloudEvmUrl(
        "mainnet",
        "local-key",
        "http://127.0.0.1:8787/api/v1",
      ),
    );
    expect(built?.startsWith("http://127.0.0.1:8787/")).toBe(true);
  });
});

describe("resolveBscRpcUrls", () => {
  let snap: EnvSnapshot;

  beforeEach(() => {
    snap = snapshotEnv();
    clearWalletEnv();
  });

  afterEach(() => {
    restoreEnv(snap);
  });

  it("returns an empty list when unmanaged and no operator URLs are set", () => {
    expect(resolveBscRpcUrls()).toEqual([]);
    expect(resolveBscRpcUrls({ cloudManagedAccess: false })).toEqual([]);
  });

  it("orders operator URLs ahead of the cloud proxy, then public fallbacks", () => {
    process.env.BSC_RPC_URL = "https://custom-bsc.example/rpc";
    process.env.NODEREAL_BSC_RPC_URL = "https://nodereal.example/bsc";
    process.env.QUICKNODE_BSC_RPC_URL = "https://quicknode.example/bsc";
    process.env.ELIZAOS_CLOUD_API_KEY = "cloud-key";

    expect(
      resolveBscRpcUrls({
        cloudManagedAccess: true,
        cloudApiKey: "cloud-key",
        walletNetwork: "mainnet",
      }),
    ).toEqual([
      "https://nodereal.example/bsc",
      "https://quicknode.example/bsc",
      "https://custom-bsc.example/rpc",
      expectedCloudEvmUrl("bsc", "cloud-key"),
      ...normalizedUrls(DEFAULT_PUBLIC_BSC_RPC_URLS),
    ]);
  });

  it("uses testnet public defaults and omits the cloud proxy on testnet", () => {
    process.env.ELIZAOS_CLOUD_API_KEY = "cloud-key";
    process.env.BSC_TESTNET_RPC_URL = "https://custom-bsc-testnet.example/";
    expect(
      resolveBscRpcUrls({
        cloudManagedAccess: true,
        cloudApiKey: "cloud-key",
        walletNetwork: "testnet",
      }),
    ).toEqual([
      "https://custom-bsc-testnet.example/",
      ...normalizedUrls(DEFAULT_PUBLIC_BSC_TESTNET_RPC_URLS),
    ]);
  });

  it("dedupes equivalent URLs after slash canonicalization and drops invalid ones", () => {
    process.env.BSC_RPC_URL = "https://bsc.publicnode.com";
    process.env.NODEREAL_BSC_RPC_URL = "not-a-url";
    expect(resolveBscRpcUrls({ cloudManagedAccess: true })).toEqual(
      normalizedUrls(DEFAULT_PUBLIC_BSC_RPC_URLS),
    );
  });
});

describe("resolve Ethereum / Base / Avalanche RPC URLs", () => {
  let snap: EnvSnapshot;

  beforeEach(() => {
    snap = snapshotEnv();
    clearWalletEnv();
  });

  afterEach(() => {
    restoreEnv(snap);
  });

  it("stays empty without managed access or custom URLs", () => {
    expect(resolveEthereumRpcUrls()).toEqual([]);
    expect(resolveBaseRpcUrls()).toEqual([]);
    expect(resolveAvalancheRpcUrls()).toEqual([]);
  });

  it("prepends a custom URL, then the cloud proxy, then public fallbacks", () => {
    process.env.ETHEREUM_RPC_URL = "https://eth-custom.example/";
    process.env.BASE_RPC_URL = "https://base-custom.example/";
    process.env.AVALANCHE_RPC_URL = "https://avax-custom.example/";
    const options = {
      cloudManagedAccess: true,
      cloudApiKey: "cloud-key",
    };
    expect(resolveEthereumRpcUrls(options)).toEqual([
      "https://eth-custom.example/",
      expectedCloudEvmUrl("mainnet", "cloud-key"),
      ...normalizedUrls(DEFAULT_PUBLIC_ETHEREUM_RPC_URLS),
    ]);
    expect(resolveBaseRpcUrls(options)).toEqual([
      "https://base-custom.example/",
      expectedCloudEvmUrl("base", "cloud-key"),
      ...normalizedUrls(DEFAULT_PUBLIC_BASE_RPC_URLS),
    ]);
    expect(resolveAvalancheRpcUrls(options)).toEqual([
      "https://avax-custom.example/",
      expectedCloudEvmUrl("avalanche", "cloud-key"),
      ...normalizedUrls(DEFAULT_PUBLIC_AVALANCHE_RPC_URLS),
    ]);
  });
});

describe("resolveSolanaRpcUrls", () => {
  let snap: EnvSnapshot;

  beforeEach(() => {
    snap = snapshotEnv();
    clearWalletEnv();
  });

  afterEach(() => {
    restoreEnv(snap);
  });

  it("always includes public defaults even without cloud access", () => {
    expect(resolveSolanaRpcUrls()).toEqual(
      normalizedUrls(DEFAULT_PUBLIC_SOLANA_RPC_URLS),
    );
    expect(resolveSolanaRpcUrls({ walletNetwork: "testnet" })).toEqual(
      normalizedUrls(DEFAULT_PUBLIC_SOLANA_TESTNET_RPC_URLS),
    );
  });

  it("orders operator URLs and the mainnet cloud proxy ahead of public defaults", () => {
    process.env.SOLANA_RPC_URL = "https://sol-custom.example/";
    process.env.SOLANA_TESTNET_RPC_URL = "https://sol-testnet-custom.example/";
    expect(
      resolveSolanaRpcUrls({
        cloudManagedAccess: true,
        cloudApiKey: "cloud-key",
        walletNetwork: "mainnet",
      }),
    ).toEqual([
      "https://sol-testnet-custom.example/",
      "https://sol-custom.example/",
      expectedCloudSolanaUrl("cloud-key"),
      ...normalizedUrls(DEFAULT_PUBLIC_SOLANA_RPC_URLS),
    ]);
    expect(
      resolveSolanaRpcUrls({
        cloudManagedAccess: true,
        cloudApiKey: "cloud-key",
        walletNetwork: "testnet",
      }),
    ).toEqual([
      "https://sol-testnet-custom.example/",
      "https://sol-custom.example/",
      ...normalizedUrls(DEFAULT_PUBLIC_SOLANA_TESTNET_RPC_URLS),
    ]);
  });
});

describe("applyWalletRpcConfigUpdate", () => {
  let snap: EnvSnapshot;

  beforeEach(() => {
    snap = snapshotEnv();
    clearWalletEnv();
  });

  afterEach(() => {
    restoreEnv(snap);
  });

  it("writes selections and network mode into config and process.env", () => {
    const config: RpcConfig = { env: {} };
    const update: WalletConfigUpdateRequest = {
      selections: ALL_CUSTOM,
      walletNetwork: "testnet",
      credentials: {
        ALCHEMY_API_KEY: "  alk  ",
        NODEREAL_BSC_RPC_URL: "https://nodereal.example/bsc",
        HELIUS_API_KEY: "helius-key",
        BIRDEYE_API_KEY: "birdeye-key",
      },
    };
    applyWalletRpcConfigUpdate(config, update);
    expect(config.wallet).toEqual({
      rpcProviders: ALL_CUSTOM,
      network: "testnet",
    });
    expect(config.env?.ELIZA_WALLET_NETWORK).toBe("testnet");
    expect(process.env.ELIZA_WALLET_NETWORK).toBe("testnet");
    expect(config.env?.ALCHEMY_API_KEY).toBe("alk");
    expect(process.env.ALCHEMY_API_KEY).toBe("alk");
    expect(config.env?.NODEREAL_BSC_RPC_URL).toBe(
      "https://nodereal.example/bsc",
    );
    expect(config.env?.SOLANA_RPC_URL).toBe(
      "https://mainnet.helius-rpc.com/?api-key=helius-key",
    );
    expect(process.env.SOLANA_RPC_URL).toBe(
      "https://mainnet.helius-rpc.com/?api-key=helius-key",
    );
  });

  it("preserves an existing network when the update omits walletNetwork", () => {
    const config: RpcConfig = {
      wallet: {
        network: "testnet",
        rpcProviders: DEFAULT_WALLET_RPC_SELECTIONS,
      },
    };
    applyWalletRpcConfigUpdate(config, {
      selections: DEFAULT_WALLET_RPC_SELECTIONS,
    });
    expect(config.wallet?.network).toBe("testnet");
    expect(process.env.ELIZA_WALLET_NETWORK).toBeUndefined();
  });

  it("deletes empty-string selected keys and omitted unselected keys", () => {
    process.env.INFURA_API_KEY = "old-infura";
    process.env.ALCHEMY_API_KEY = "existing-alchemy";
    process.env.ANKR_API_KEY = "existing-ankr";
    const config: RpcConfig = {
      env: {
        INFURA_API_KEY: "old-infura",
        ALCHEMY_API_KEY: "existing-alchemy",
        ANKR_API_KEY: "existing-ankr",
      },
    };
    applyWalletRpcConfigUpdate(config, {
      selections: {
        evm: "alchemy",
        bsc: "eliza-cloud",
        solana: "eliza-cloud",
      },
      credentials: {
        ALCHEMY_API_KEY: "",
      },
    });
    expect(config.env?.ALCHEMY_API_KEY).toBeUndefined();
    expect(process.env.ALCHEMY_API_KEY).toBeUndefined();
    expect(config.env?.INFURA_API_KEY).toBeUndefined();
    expect(process.env.INFURA_API_KEY).toBeUndefined();
    expect(config.env?.ANKR_API_KEY).toBeUndefined();
    expect(process.env.ANKR_API_KEY).toBeUndefined();
  });

  it("still stores a non-empty submitted credential for an unselected provider", () => {
    const config: RpcConfig = { env: {} };
    applyWalletRpcConfigUpdate(config, {
      selections: {
        evm: "alchemy",
        bsc: "eliza-cloud",
        solana: "eliza-cloud",
      },
      credentials: {
        ALCHEMY_API_KEY: "alk",
        INFURA_API_KEY: "still-written",
      },
    });
    expect(config.env?.ALCHEMY_API_KEY).toBe("alk");
    expect(config.env?.INFURA_API_KEY).toBe("still-written");
    expect(process.env.INFURA_API_KEY).toBe("still-written");
  });

  it("keeps a selected credential that the update omitted", () => {
    process.env.ALCHEMY_API_KEY = "still-here";
    const config: RpcConfig = { env: { ALCHEMY_API_KEY: "still-here" } };
    applyWalletRpcConfigUpdate(config, {
      selections: {
        evm: "alchemy",
        bsc: "eliza-cloud",
        solana: "eliza-cloud",
      },
    });
    expect(config.env?.ALCHEMY_API_KEY).toBe("still-here");
    expect(process.env.ALCHEMY_API_KEY).toBe("still-here");
  });

  it("does not delete SOLANA_RPC_URL when an empty Helius key arrives with an explicit Solana URL string", () => {
    process.env.SOLANA_RPC_URL = "https://sol-custom.example/";
    const config: RpcConfig = {
      env: { SOLANA_RPC_URL: "https://sol-custom.example/" },
    };
    applyWalletRpcConfigUpdate(config, {
      selections: ALL_CUSTOM,
      credentials: {
        HELIUS_API_KEY: "",
        SOLANA_RPC_URL: "https://sol-kept.example/",
        ALCHEMY_API_KEY: "alk",
        NODEREAL_BSC_RPC_URL: "https://nodereal.example/bsc",
      },
    });
    expect(config.env?.SOLANA_RPC_URL).toBe("https://sol-kept.example/");
    expect(process.env.SOLANA_RPC_URL).toBe("https://sol-kept.example/");
  });

  it("clears SOLANA_RPC_URL when Helius is an empty string and Solana URL is omitted", () => {
    process.env.SOLANA_RPC_URL = "https://sol-custom.example/";
    const config: RpcConfig = {
      env: { SOLANA_RPC_URL: "https://sol-custom.example/" },
    };
    applyWalletRpcConfigUpdate(config, {
      selections: ALL_CUSTOM,
      credentials: {
        HELIUS_API_KEY: "",
        ALCHEMY_API_KEY: "alk",
        NODEREAL_BSC_RPC_URL: "https://nodereal.example/bsc",
      },
    });
    expect(config.env?.SOLANA_RPC_URL).toBeUndefined();
    expect(process.env.SOLANA_RPC_URL).toBeUndefined();
  });
});

describe("resolveWalletRpcReadiness", () => {
  let snap: EnvSnapshot;

  beforeEach(() => {
    snap = snapshotEnv();
    clearWalletEnv();
  });

  afterEach(() => {
    restoreEnv(snap);
  });

  it("reports an unmanaged, Solana-ready default when nothing is configured", () => {
    const readiness = resolveWalletRpcReadiness();
    expect(readiness.walletNetwork).toBe("mainnet");
    expect(readiness.cloudManagedAccess).toBe(false);
    expect(readiness.selectedRpcProviders).toEqual(
      DEFAULT_WALLET_RPC_SELECTIONS,
    );
    expect(readiness.legacyCustomChains).toEqual([]);
    expect(readiness.bscRpcUrls).toEqual([]);
    expect(readiness.ethereumRpcUrls).toEqual([]);
    expect(readiness.baseRpcUrls).toEqual([]);
    expect(readiness.avalancheRpcUrls).toEqual([]);
    expect(readiness.managedBscRpcReady).toBe(false);
    expect(readiness.evmBalanceReady).toBe(false);
    expect(readiness.solanaRpcUrls).toEqual(
      normalizedUrls(DEFAULT_PUBLIC_SOLANA_RPC_URLS),
    );
    expect(readiness.solanaBalanceReady).toBe(true);
  });

  it("infers providers from env keys when no stored selections exist", () => {
    process.env.ALCHEMY_API_KEY = "alk";
    process.env.NODEREAL_BSC_RPC_URL = "https://nodereal.example/bsc";
    process.env.HELIUS_API_KEY = "helius-key";
    const readiness = resolveWalletRpcReadiness({});
    expect(readiness.selectedRpcProviders).toEqual({
      evm: "alchemy",
      bsc: "nodereal",
      solana: "helius-birdeye",
    });
    expect(readiness.evmBalanceReady).toBe(true);
    expect(readiness.solanaBalanceReady).toBe(true);
  });

  it("prefers Infura over Ankr, and QuickNode over Alchemy, when inferring", () => {
    process.env.INFURA_API_KEY = "infura";
    process.env.ANKR_API_KEY = "ankr";
    process.env.QUICKNODE_BSC_RPC_URL = "https://quicknode.example/bsc";
    process.env.ALCHEMY_API_KEY = "alk";
    expect(resolveWalletRpcReadiness().selectedRpcProviders).toEqual({
      evm: "alchemy",
      bsc: "quicknode",
      solana: DEFAULT_WALLET_RPC_SELECTIONS.solana,
    });

    delete process.env.ALCHEMY_API_KEY;
    expect(resolveWalletRpcReadiness().selectedRpcProviders.evm).toBe("infura");
    delete process.env.INFURA_API_KEY;
    expect(resolveWalletRpcReadiness().selectedRpcProviders.evm).toBe("ankr");
  });

  it("uses stored selections even when env keys would infer a different provider", () => {
    process.env.ALCHEMY_API_KEY = "alk";
    const readiness = resolveWalletRpcReadiness({
      wallet: { rpcProviders: { evm: "infura" } },
    });
    expect(readiness.selectedRpcProviders.evm).toBe("infura");
    expect(readiness.selectedRpcProviders.bsc).toBe(
      DEFAULT_WALLET_RPC_SELECTIONS.bsc,
    );
  });

  it("enables managed access and public EVM fallbacks when a cloud key matches eliza-cloud", () => {
    process.env.ELIZAOS_CLOUD_API_KEY = "cloud-key";
    const readiness = resolveWalletRpcReadiness({
      cloud: { apiKey: "cloud-key" },
    });
    expect(readiness.cloudManagedAccess).toBe(true);
    expect(readiness.managedBscRpcReady).toBe(true);
    expect(readiness.evmBalanceReady).toBe(true);
    expect(readiness.bscRpcUrls[0]).toBe(
      expectedCloudEvmUrl("bsc", "cloud-key"),
    );
    expect(readiness.bscRpcUrls.slice(1)).toEqual(
      normalizedUrls(DEFAULT_PUBLIC_BSC_RPC_URLS),
    );
    expect(readiness.solanaRpcUrls[0]).toBe(
      expectedCloudSolanaUrl("cloud-key"),
    );
  });

  it("keeps managed access off when stored selections avoid eliza-cloud", () => {
    process.env.ELIZAOS_CLOUD_API_KEY = "cloud-key";
    const readiness = resolveWalletRpcReadiness({
      cloud: { apiKey: "cloud-key" },
      wallet: { rpcProviders: ALL_CUSTOM },
    });
    expect(readiness.cloudManagedAccess).toBe(false);
    expect(readiness.bscRpcUrls).toEqual([]);
    expect(readiness.selectedRpcProviders).toEqual(ALL_CUSTOM);
  });

  it("flags legacy custom chains only when the chain still uses the default provider", () => {
    process.env.ETHEREUM_RPC_URL = "https://eth-custom.example/";
    process.env.BSC_RPC_URL = "https://bsc-custom.example/";
    process.env.SOLANA_RPC_URL = "https://sol-custom.example/";
    const defaultLegacy = resolveWalletRpcReadiness();
    expect(defaultLegacy.legacyCustomChains).toEqual(["evm", "bsc", "solana"]);

    const custom = resolveWalletRpcReadiness({
      wallet: { rpcProviders: ALL_CUSTOM },
    });
    expect(custom.legacyCustomChains).toEqual([]);
  });

  it("honors config.wallet.network for readiness and testnet public catalogs", () => {
    const readiness = resolveWalletRpcReadiness({
      wallet: { network: "testnet" },
    });
    expect(readiness.walletNetwork).toBe("testnet");
    expect(readiness.solanaRpcUrls).toEqual(
      normalizedUrls(DEFAULT_PUBLIC_SOLANA_TESTNET_RPC_URLS),
    );
    expect(readiness.bscRpcUrls).toEqual([]);
  });

  it("treats an empty rpcProviders object as unstored so inference still runs", () => {
    process.env.ANKR_API_KEY = "ankr";
    const readiness = resolveWalletRpcReadiness({
      wallet: { rpcProviders: {} },
    });
    expect(readiness.selectedRpcProviders.evm).toBe("ankr");
    expect(readiness.selectedRpcProviders.bsc).toBe("ankr");
  });
});
