import type { IAgentRuntime } from "@elizaos/core";
import {
  captureDevCloudEnvAuthoritySnapshot,
  resetDevCloudEnvAuthorityForTests,
} from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSolanaCloudProxyTuple, SolanaService } from "./service";

const AUTHORITY_KEYS = [
  "ELIZA_DEV_SOURCE",
  "ELIZA_DEV_CLOUD_ENV_AUTHORITY",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_BASE_URL",
  "ELIZAOS_CLOUD_ENABLED",
] as const;

const originalEnv = Object.fromEntries(AUTHORITY_KEYS.map((key) => [key, process.env[key]]));

function runtimeWithSettings(settings: Record<string, string>) {
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ data: { items: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
  );
  const runtime = {
    fetch,
    getSetting: vi.fn((key: string) => settings[key]),
    getServiceLoadPromise: vi.fn(async () => undefined),
    getService: vi.fn(() => null),
    logger: {
      error: vi.fn(),
      info: vi.fn(),
      success: vi.fn(),
      warn: vi.fn(),
    },
  } as unknown as IAgentRuntime;
  return { runtime, fetch };
}

function setAuthority(
  authority: "staging-default" | "offline" | "staging-explicit" | "production" | "self-hosted"
): { baseUrl: string; apiKey: string } {
  const baseUrl =
    authority === "production"
      ? "https://api.eliza.app/api/v1"
      : authority === "self-hosted"
        ? "http://127.0.0.1:8787/api/v1"
        : "https://api-staging.eliza.app/api/v1";
  const apiKey =
    authority === "staging-default" || authority === "offline" ? "" : "launch-cloud-key";
  process.env.ELIZA_DEV_SOURCE = "1";
  process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = authority;
  process.env.ELIZAOS_CLOUD_BASE_URL = baseUrl;
  process.env.ELIZAOS_CLOUD_API_KEY = apiKey;
  process.env.ELIZAOS_CLOUD_ENABLED = "true";
  resetDevCloudEnvAuthorityForTests();
  captureDevCloudEnvAuthoritySnapshot();
  return { baseUrl, apiKey };
}

beforeEach(() => {
  resetDevCloudEnvAuthorityForTests();
  for (const key of AUTHORITY_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of AUTHORITY_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetDevCloudEnvAuthorityForTests();
});

describe("Solana Cloud proxy launch authority", () => {
  it.each(["staging-default", "offline"] as const)(
    "keeps %s disabled after late runtime activation",
    (authority) => {
      setAuthority(authority);
      const { runtime, fetch } = runtimeWithSettings({
        ELIZAOS_CLOUD_API_KEY: "late-production-key",
        ELIZAOS_CLOUD_BASE_URL: "https://collector.example/api/v1",
        ELIZAOS_CLOUD_ENABLED: "true",
      });

      expect(resolveSolanaCloudProxyTuple(runtime)).toBeNull();
      const service = new SolanaService(runtime);
      const rpcEndpoint = (service as unknown as { connection: { rpcEndpoint: string } }).connection
        .rpcEndpoint;
      expect(rpcEndpoint).toBe("https://api.mainnet-beta.solana.com");
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it.each(["staging-explicit", "production", "self-hosted"] as const)(
    "uses the exact frozen %s tuple after late runtime/process pollution",
    async (authority) => {
      const launch = setAuthority(authority);
      process.env.ELIZAOS_CLOUD_API_KEY = "late-process-key";
      process.env.ELIZAOS_CLOUD_BASE_URL = "https://process-collector.example/api/v1";
      const { runtime, fetch } = runtimeWithSettings({
        ELIZAOS_CLOUD_API_KEY: "late-runtime-key",
        ELIZAOS_CLOUD_BASE_URL: "https://runtime-collector.example/api/v1",
        ELIZAOS_CLOUD_ENABLED: "true",
      });

      expect(resolveSolanaCloudProxyTuple(runtime)).toEqual({
        apiKey: launch.apiKey,
        baseUrl: launch.baseUrl,
      });
      const service = new SolanaService(runtime);
      const rpcEndpoint = (service as unknown as { connection: { rpcEndpoint: string } }).connection
        .rpcEndpoint;
      expect(rpcEndpoint).toBe(`${launch.baseUrl}/proxy/solana-rpc?api_key=${launch.apiKey}`);
      await (
        service as unknown as {
          birdeyeFetchWithRetry: (url: string) => Promise<Record<string, unknown>>;
        }
      ).birdeyeFetchWithRetry("https://public-api.birdeye.so/defi/tokenlist");
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledWith(
        `${launch.baseUrl}/proxy/birdeye/defi/tokenlist`,
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Bearer ${launch.apiKey}`,
          }),
        })
      );
    }
  );

  it("preserves direct Birdeye and Solana RPC precedence", () => {
    setAuthority("staging-explicit");
    const { runtime } = runtimeWithSettings({
      BIRDEYE_API_KEY: "direct-birdeye-key",
      SOLANA_RPC_URL: "https://direct-solana.example",
      ELIZAOS_CLOUD_API_KEY: "late-cloud-key",
      ELIZAOS_CLOUD_BASE_URL: "https://collector.example/api/v1",
      ELIZAOS_CLOUD_ENABLED: "true",
    });
    const service = new SolanaService(runtime);
    const rpcEndpoint = (service as unknown as { connection: { rpcEndpoint: string } }).connection
      .rpcEndpoint;
    expect(rpcEndpoint).toBe("https://direct-solana.example");
  });
});
