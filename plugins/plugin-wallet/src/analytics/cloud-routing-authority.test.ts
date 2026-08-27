/** Proves wallet analytics cannot redirect a launch-owned Cloud credential. */

import type { IAgentRuntime } from "@elizaos/core";
import {
  captureDevCloudEnvAuthoritySnapshot,
  resetDevCloudEnvAuthorityForTests,
} from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BirdeyeService } from "./birdeye/service";
import { DexScreenerService } from "./dexscreener/service";

const AUTHORITY_KEYS = [
  "ELIZA_DEV_SOURCE",
  "ELIZA_DEV_CLOUD_ENV_AUTHORITY",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_BASE_URL",
  "ELIZAOS_CLOUD_ENABLED",
] as const;

const originalEnv = Object.fromEntries(
  AUTHORITY_KEYS.map((key) => [key, process.env[key]]),
);

function runtimeWithSettings(settings: Record<string, unknown>): IAgentRuntime {
  return {
    getSetting: vi.fn((key: string) => settings[key]),
    getCache: vi.fn(async () => undefined),
    setCache: vi.fn(async () => undefined),
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      log: vi.fn(),
      success: vi.fn(),
      warn: vi.fn(),
    },
  } as unknown as IAgentRuntime;
}

function setAuthority(
  authority:
    | "staging-default"
    | "offline"
    | "staging-explicit"
    | "production"
    | "self-hosted",
): { apiKey: string; baseUrl: string } {
  const baseUrl =
    authority === "production"
      ? "https://api.eliza.app/api/v1"
      : authority === "self-hosted"
        ? "http://127.0.0.1:8787/api/v1"
        : "https://api-staging.eliza.app/api/v1";
  const apiKey = "launch-cloud-key";
  process.env.ELIZA_DEV_SOURCE = "1";
  process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = authority;
  process.env.ELIZAOS_CLOUD_API_KEY = apiKey;
  process.env.ELIZAOS_CLOUD_BASE_URL = baseUrl;
  process.env.ELIZAOS_CLOUD_ENABLED = "true";
  resetDevCloudEnvAuthorityForTests();
  captureDevCloudEnvAuthoritySnapshot();
  return { apiKey, baseUrl };
}

function poisonCloudSettings(settings: Record<string, unknown>): void {
  process.env.ELIZAOS_CLOUD_API_KEY = "late-process-key";
  process.env.ELIZAOS_CLOUD_BASE_URL =
    "https://process-collector.example/api/v1";
  process.env.ELIZAOS_CLOUD_ENABLED = "true";
  settings.ELIZAOS_CLOUD_API_KEY = "late-runtime-key";
  settings.ELIZAOS_CLOUD_BASE_URL = "https://runtime-collector.example/api/v1";
  settings.ELIZAOS_CLOUD_ENABLED = "true";
}

function stubJsonFetch() {
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ data: {}, pairs: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

beforeEach(() => {
  resetDevCloudEnvAuthorityForTests();
  for (const key of AUTHORITY_KEYS) delete process.env[key];
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of AUTHORITY_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetDevCloudEnvAuthorityForTests();
});

describe("wallet analytics Cloud routing authority", () => {
  it.each(["staging-explicit", "production", "self-hosted"] as const)(
    "sends Birdeye requests only to the frozen %s route after late pollution",
    async (authority) => {
      const launch = setAuthority(authority);
      const settings: Record<string, unknown> = {};
      poisonCloudSettings(settings);
      const fetch = stubJsonFetch();
      const service = new BirdeyeService(runtimeWithSettings(settings));

      await service.fetchTokenOverview({ address: "So111" } as never);

      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledWith(
        `${launch.baseUrl}/apis/birdeye/defi/token_overview?address=So111`,
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Bearer ${launch.apiKey}`,
          }),
        }),
      );
    },
  );

  it.each(["staging-default", "offline"] as const)(
    "keeps Birdeye Cloud fallback disabled under %s after late activation",
    (authority) => {
      setAuthority(authority);
      const settings: Record<string, unknown> = {};
      poisonCloudSettings(settings);
      const fetch = stubJsonFetch();

      expect(() => new BirdeyeService(runtimeWithSettings(settings))).toThrow(
        "requires BIRDEYE_API_KEY or Eliza Cloud",
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(["staging-explicit", "production", "self-hosted"] as const)(
    "sends DexScreener requests only to the frozen %s route after late pollution",
    async (authority) => {
      const launch = setAuthority(authority);
      const settings: Record<string, unknown> = {
        DEXSCREENER_RATE_LIMIT_DELAY: "0",
      };
      poisonCloudSettings(settings);
      const fetch = stubJsonFetch();
      const service = await DexScreenerService.start(
        runtimeWithSettings(settings),
      );

      await (service as DexScreenerService).search({ query: "SOL" });

      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledWith(
        `${launch.baseUrl}/apis/dexscreener/latest/dex/search?q=SOL`,
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Bearer ${launch.apiKey}`,
          }),
        }),
      );
    },
  );

  it.each(["staging-default", "offline"] as const)(
    "uses public DexScreener without Cloud credentials under %s",
    async (authority) => {
      setAuthority(authority);
      const settings: Record<string, unknown> = {
        DEXSCREENER_RATE_LIMIT_DELAY: "0",
      };
      poisonCloudSettings(settings);
      const fetch = stubJsonFetch();
      const service = await DexScreenerService.start(
        runtimeWithSettings(settings),
      );

      await (service as DexScreenerService).search({ query: "SOL" });

      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledWith(
        "https://api.dexscreener.com/latest/dex/search?q=SOL",
        expect.objectContaining({
          headers: expect.not.objectContaining({
            Authorization: expect.anything(),
          }),
        }),
      );
    },
  );

  it("preserves direct Birdeye key precedence under launcher authority", async () => {
    setAuthority("staging-explicit");
    const fetch = stubJsonFetch();
    const service = new BirdeyeService(
      runtimeWithSettings({ BIRDEYE_API_KEY: "direct-birdeye-key" }),
    );

    await service.fetchTokenOverview({ address: "So111" } as never);

    expect(fetch).toHaveBeenCalledWith(
      "https://public-api.birdeye.so/defi/token_overview?address=So111",
      expect.objectContaining({
        headers: expect.objectContaining({ "X-API-KEY": "direct-birdeye-key" }),
      }),
    );
  });
});
