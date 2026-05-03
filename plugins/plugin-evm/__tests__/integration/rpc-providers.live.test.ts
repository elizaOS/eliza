/** Live integration tests for the multi-provider RPC abstraction. */

import type { IAgentRuntime } from "@elizaos/core";
import { beforeAll, describe, expect, it } from "vitest";
import {
  initRPCProviderManager,
  type ResolvedRPCProvider,
  type RPCProviderManager,
  validateRPCProviderConfig,
} from "../../rpc-providers";
import {
  ELIZA_CLOUD_API_KEY,
  ELIZA_CLOUD_BASE_URL,
  HAS_ELIZA_CLOUD_RPC_KEY,
  LIVE_EVM_RPC_TEST,
  PUBLIC_FALLBACK_RPC_CANDIDATES,
  PUBLIC_FALLBACK_RPC_URLS,
  shouldUseElizaCloudRpc,
} from "./live-rpc";

const LIVE_CHAINS = Object.keys(PUBLIC_FALLBACK_RPC_URLS) as Array<
  keyof typeof PUBLIC_FALLBACK_RPC_URLS
>;
type LiveChain = (typeof LIVE_CHAINS)[number];
type LiveResolvedRPCProvider = ResolvedRPCProvider & { chainName: LiveChain };

const RPC_MAX_ATTEMPTS = 2;
const rpcJsonCache = new Map<string, Promise<unknown>>();
let useElizaCloudRpc = false;

beforeAll(async () => {
  useElizaCloudRpc = await shouldUseElizaCloudRpc();
});

function createMockRuntime(
  settings: Record<string, string | undefined> = {},
  evmChains: string[] = LIVE_CHAINS
): IAgentRuntime {
  return {
    getSetting(key: string): string | undefined {
      return settings[key] ?? process.env[key];
    },
    character: {
      settings: {
        chains: {
          evm: evmChains,
        },
      },
    },
  } as IAgentRuntime;
}

function createLiveRuntime(
  overrides: Record<string, string | undefined> = {},
  evmChains: string[] = LIVE_CHAINS
): IAgentRuntime {
  return createMockRuntime(
    {
      ALCHEMY_API_KEY: "",
      INFURA_API_KEY: "",
      ANKR_API_KEY: "",
      ...(useElizaCloudRpc
        ? {
            EVM_RPC_PROVIDER: "elizacloud",
            ELIZAOS_CLOUD_API_KEY: ELIZA_CLOUD_API_KEY,
            ELIZAOS_CLOUD_BASE_URL: ELIZA_CLOUD_BASE_URL,
            ELIZAOS_CLOUD_ENABLED: "1",
            ELIZAOS_CLOUD_USE_RPC: "true",
          }
        : {
            ELIZAOS_CLOUD_API_KEY: "",
            ELIZAOS_CLOUD_BASE_URL: "",
            ELIZAOS_CLOUD_ENABLED: "",
            ELIZAOS_CLOUD_USE_RPC: "",
            ETHEREUM_PROVIDER_MAINNET: PUBLIC_FALLBACK_RPC_URLS.mainnet,
            ETHEREUM_PROVIDER_BASE: PUBLIC_FALLBACK_RPC_URLS.base,
            ETHEREUM_PROVIDER_BSC: PUBLIC_FALLBACK_RPC_URLS.bsc,
          }),
      ...overrides,
    },
    evmChains
  );
}

function getExpectedRpcUrl(chain: keyof typeof PUBLIC_FALLBACK_RPC_URLS): string {
  if (useElizaCloudRpc) {
    return `${ELIZA_CLOUD_BASE_URL}/proxy/evm-rpc/${chain}`;
  }
  return PUBLIC_FALLBACK_RPC_URLS[chain];
}

function requireResolvedProvider(
  manager: RPCProviderManager,
  chain: keyof typeof PUBLIC_FALLBACK_RPC_URLS
): LiveResolvedRPCProvider {
  const resolved = manager.resolveForChain(chain);
  expect(resolved).not.toBeNull();
  return {
    ...(resolved as ResolvedRPCProvider),
    chainName: chain,
  };
}

async function postRpc(
  provider: LiveResolvedRPCProvider,
  body: Record<string, unknown>
): Promise<Response> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < RPC_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(provider.rpcUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...provider.headers,
        },
        body: JSON.stringify(body),
      });
      if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
        lastError = new Error(`RPC call failed: ${response.status} ${response.statusText}`);
        if (attempt < RPC_MAX_ATTEMPTS - 1) {
          const retryAfterSeconds = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
          const retryDelayMs =
            Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
              ? retryAfterSeconds * 1000
              : Math.min(8_000, 1_000 * 2 ** attempt);
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
          continue;
        }
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < RPC_MAX_ATTEMPTS - 1) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(8_000, 1_000 * 2 ** attempt)));
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function getProviderCandidates(provider: LiveResolvedRPCProvider): LiveResolvedRPCProvider[] {
  if (useElizaCloudRpc) {
    return [provider];
  }

  const orderedUrls = [
    provider.rpcUrl,
    ...PUBLIC_FALLBACK_RPC_CANDIDATES[provider.chainName].filter((url) => url !== provider.rpcUrl),
  ];

  return orderedUrls.map((rpcUrl) => ({
    ...provider,
    rpcUrl,
  }));
}

function getRpcCacheKey(provider: LiveResolvedRPCProvider, body: Record<string, unknown>): string {
  return JSON.stringify({
    chain: provider.chainName,
    url: useElizaCloudRpc ? provider.rpcUrl : undefined,
    headers: provider.headers,
    body,
  });
}

async function rpcCallJson<T>(
  provider: LiveResolvedRPCProvider,
  body: Record<string, unknown>
): Promise<T> {
  const cacheKey = getRpcCacheKey(provider, body);
  const existing = rpcJsonCache.get(cacheKey) as Promise<T> | undefined;
  if (existing) {
    return existing;
  }

  const request = (async () => {
    let lastError: unknown = null;

    for (const candidate of getProviderCandidates(provider)) {
      try {
        const response = await postRpc(candidate, body);
        const responseText = await response.text();

        if (!responseText) {
          lastError = new Error(
            response.ok
              ? "RPC response missing body"
              : `RPC call failed: ${response.status} ${response.statusText}`
          );
          continue;
        }

        let data: T;
        try {
          data = JSON.parse(responseText) as T;
        } catch (error) {
          lastError = new Error(
            `RPC response was not valid JSON: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
          continue;
        }

        if (
          !response.ok &&
          (!data || typeof data !== "object" || !("error" in (data as Record<string, unknown>)))
        ) {
          lastError = new Error(`RPC call failed: ${response.status} ${response.statusText}`);
          continue;
        }

        return data;
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  })();

  rpcJsonCache.set(cacheKey, request);
  try {
    return await request;
  } catch (error) {
    rpcJsonCache.delete(cacheKey);
    throw error;
  }
}

async function rpcGetBlockNumber(provider: LiveResolvedRPCProvider): Promise<bigint> {
  const data = await rpcCallJson<{
    result?: string;
    error?: { message: string };
  }>(provider, {
    jsonrpc: "2.0",
    method: "eth_blockNumber",
    params: [],
    id: 1,
  });
  if (data.error) {
    throw new Error(`RPC error: ${data.error.message}`);
  }
  if (!data.result) {
    throw new Error("RPC response missing result");
  }
  return BigInt(data.result);
}

async function rpcGetBalance(provider: LiveResolvedRPCProvider, address: string): Promise<bigint> {
  const data = await rpcCallJson<{
    result?: string;
    error?: { message: string };
  }>(provider, {
    jsonrpc: "2.0",
    method: "eth_getBalance",
    params: [address, "latest"],
    id: 1,
  });
  if (data.error) {
    throw new Error(`RPC error: ${data.error.message}`);
  }
  if (!data.result) {
    throw new Error("RPC response missing result");
  }
  return BigInt(data.result);
}

describe.skipIf(!LIVE_EVM_RPC_TEST)("Managed RPC live tests", () => {
  let manager: RPCProviderManager;

  beforeAll(() => {
    manager = initRPCProviderManager(createLiveRuntime());
  });

  it("validates the live RPC configuration", () => {
    const result = validateRPCProviderConfig(createLiveRuntime());
    expect(result.valid).toBe(true);
    if (useElizaCloudRpc) {
      expect(result.providers).toContain("elizacloud");
    } else if (HAS_ELIZA_CLOUD_RPC_KEY) {
      expect(result.providers).not.toContain("elizacloud");
    } else {
      expect(result.providers).toEqual([]);
    }
    expect(result.warnings).toEqual([]);
  });

  it("resolves the expected live RPC URLs for supported chains", () => {
    for (const chain of LIVE_CHAINS) {
      const resolved = requireResolvedProvider(manager, chain);
      expect(resolved.rpcUrl).toBe(getExpectedRpcUrl(chain));
      if (useElizaCloudRpc) {
        expect(resolved.providerName).toBe("elizacloud");
        expect(resolved.headers.Authorization).toBe(`Bearer ${ELIZA_CLOUD_API_KEY}`);
      } else {
        expect(resolved.headers).toEqual({});
      }
    }
  });

  for (const chain of LIVE_CHAINS) {
    it(`fetches a live block number for ${chain}`, async () => {
      const resolved = requireResolvedProvider(manager, chain);
      const blockNumber = await rpcGetBlockNumber(resolved);
      expect(blockNumber).toBeGreaterThan(0n);
      console.log(`${chain} block: ${blockNumber}`);
    });
  }

  it("fetches Vitalik balance on mainnet (known non-zero)", async () => {
    const resolved = requireResolvedProvider(manager, "mainnet");
    const vitalikAddress = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
    const balance = await rpcGetBalance(resolved, vitalikAddress);
    expect(balance).toBeGreaterThan(0n);
  });
});

describe.skipIf(!LIVE_EVM_RPC_TEST)("Provider priority live", () => {
  it("explicit custom RPC overrides still take precedence", async () => {
    const runtime = createLiveRuntime({
      ETHEREUM_PROVIDER_MAINNET: PUBLIC_FALLBACK_RPC_URLS.mainnet,
    });
    const manager = initRPCProviderManager(runtime);
    const resolved = requireResolvedProvider(manager, "mainnet");
    expect(resolved.rpcUrl).toBe(PUBLIC_FALLBACK_RPC_URLS.mainnet);

    const blockNumber = await rpcGetBlockNumber(resolved);
    expect(blockNumber).toBeGreaterThan(0n);
  });

  it("coverage reflects the active live RPC source", () => {
    const manager = initRPCProviderManager(createLiveRuntime());
    expect(manager.isChainCovered("mainnet")).toBe(true);
    expect(manager.isChainCovered("base")).toBe(true);
    expect(manager.isChainCovered("bsc")).toBe(true);
    expect(manager.isChainCovered("optimism")).toBe(useElizaCloudRpc);
  });
});

describe.skipIf(!LIVE_EVM_RPC_TEST)("EVM RPC data verification", () => {
  let manager: RPCProviderManager;

  beforeAll(() => {
    manager = initRPCProviderManager(createLiveRuntime());
  });

  it("mainnet block number is plausible (> 20M, year 2025+)", async () => {
    const blockNumber = await rpcGetBlockNumber(requireResolvedProvider(manager, "mainnet"));
    expect(blockNumber).toBeGreaterThan(20_000_000n);
    expect(blockNumber).toBeLessThan(100_000_000n);
  });

  it("Base block number is plausible", async () => {
    const blockNumber = await rpcGetBlockNumber(requireResolvedProvider(manager, "base"));
    expect(blockNumber).toBeGreaterThan(1_000_000n);
    expect(blockNumber).toBeLessThan(500_000_000n);
  });

  it("BSC block number is plausible", async () => {
    const blockNumber = await rpcGetBlockNumber(requireResolvedProvider(manager, "bsc"));
    expect(blockNumber).toBeGreaterThan(1_000_000n);
    expect(blockNumber).toBeLessThan(500_000_000n);
  });

  it("random unused address returns negligible balance", async () => {
    const resolved = requireResolvedProvider(manager, "mainnet");
    const randomAddr = "0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF";
    const balance = await rpcGetBalance(resolved, randomAddr);
    expect(balance).toBeGreaterThanOrEqual(0n);
    expect(balance).toBeLessThan(10_000_000_000_000_000_000n);
  });

  it("RPC response includes valid hex block number format", async () => {
    const data = await rpcCallJson<{
      jsonrpc: string;
      id: number;
      result: string;
    }>(requireResolvedProvider(manager, "mainnet"), {
      jsonrpc: "2.0",
      method: "eth_blockNumber",
      params: [],
      id: 1,
    });
    expect(data.jsonrpc).toBe("2.0");
    expect(data.id).toBe(1);
    expect(data.result).toMatch(/^0x[0-9a-f]+$/);
  });
});

describe.skipIf(!LIVE_EVM_RPC_TEST)("EVM RPC error handling", () => {
  let manager: RPCProviderManager;

  beforeAll(() => {
    manager = initRPCProviderManager(createLiveRuntime());
  });

  it("invalid RPC method returns a JSON-RPC error", async () => {
    const data = await rpcCallJson<{
      error?: { code: number; message: string };
    }>(requireResolvedProvider(manager, "mainnet"), {
      jsonrpc: "2.0",
      method: "eth_nonExistentMethod",
      params: [],
      id: 1,
    });
    expect(data.error).toBeDefined();
    expect(typeof data.error?.code).toBe("number");
    expect(typeof data.error?.message).toBe("string");
  });

  it("invalid address format returns a JSON-RPC error", async () => {
    const data = await rpcCallJson<{
      error?: { code: number; message: string };
    }>(requireResolvedProvider(manager, "mainnet"), {
      jsonrpc: "2.0",
      method: "eth_getBalance",
      params: ["not-a-valid-address", "latest"],
      id: 1,
    });
    expect(data.error).toBeDefined();
  });
});
