import {
  _resetCloudSecretsForTesting,
  resetDevCloudEnvAuthorityForTests,
  scrubCloudSecretsFromEnv,
} from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchCloudCredits,
  resolveCloudApiKey as resolveConnectionCloudApiKey,
  resolveCloudConnectionSnapshot,
} from "../lib/cloud-connection.js";
import {
  resolveCloudApiKey as resolveRouteCloudApiKey,
  resolveCloudApiKeyWithRuntimeOverride,
} from "./cloud-api-key.js";

const ENV_KEYS = [
  "ELIZA_DEV_SOURCE",
  "ELIZA_DEV_CLOUD_ENV_AUTHORITY",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_BASE_URL",
  "NODE_ENV",
] as const;

const originalEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>;

const cloudRoutedConfig = {
  serviceRouting: {
    llmText: { backend: "elizacloud", transport: "cloud-proxy" },
  },
};

describe("development Cloud environment authority", () => {
  beforeEach(() => {
    resetDevCloudEnvAuthorityForTests();
    _resetCloudSecretsForTesting();
    delete process.env.ELIZAOS_CLOUD_API_KEY;
    process.env.ELIZA_DEV_SOURCE = "1";
    process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "offline";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetDevCloudEnvAuthorityForTests();
    _resetCloudSecretsForTesting();
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it.each([
    {
      source: "persisted config",
      config: {
        ...cloudRoutedConfig,
        cloud: { apiKey: "persisted-production-key" },
      },
      runtime: {},
    },
    {
      source: "runtime settings",
      config: cloudRoutedConfig,
      runtime: { getSetting: () => "runtime-production-key" },
    },
    {
      source: "character secrets",
      config: cloudRoutedConfig,
      runtime: {
        getSetting: () => undefined,
        character: {
          secrets: { ELIZAOS_CLOUD_API_KEY: "character-production-key" },
        },
      },
    },
  ])("does not resurrect a key from $source", ({ config, runtime }) => {
    expect(resolveRouteCloudApiKey(config, runtime)).toBeNull();
    expect(resolveConnectionCloudApiKey(config, runtime)).toBeUndefined();
  });

  it("does not resurrect a sealed key", () => {
    process.env.ELIZAOS_CLOUD_API_KEY = "sealed-production-key";
    scrubCloudSecretsFromEnv();

    expect(resolveConnectionCloudApiKey(cloudRoutedConfig)).toBeUndefined();
  });

  it("does not let an authenticated runtime service override blocked authority", () => {
    expect(
      resolveCloudApiKeyWithRuntimeOverride(
        "runtime-auth-production-key",
        cloudRoutedConfig,
      ),
    ).toBeNull();
  });

  it("uses only the launcher's canonical key for an explicit staging target", () => {
    process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "staging-explicit";
    process.env.ELIZAOS_CLOUD_API_KEY = "staging-key";
    const config = {
      ...cloudRoutedConfig,
      cloud: { apiKey: "persisted-production-key" },
    };
    const runtime = {
      getSetting: () => "runtime-production-key",
      character: {
        secrets: { ELIZAOS_CLOUD_API_KEY: "character-production-key" },
      },
    };

    expect(resolveRouteCloudApiKey(config, runtime)).toBe("staging-key");
    expect(resolveConnectionCloudApiKey(config, runtime)).toBe("staging-key");
    expect(
      resolveCloudApiKeyWithRuntimeOverride(
        "runtime-auth-production-key",
        config,
        runtime,
      ),
    ).toBe("staging-key");
  });

  it.each(["staging-default", "offline"])(
    "ignores stale authenticated runtime state under %s authority",
    async (authority) => {
      process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = authority;
      process.env.ELIZAOS_CLOUD_API_KEY = "late-production-key";
      process.env.ELIZAOS_CLOUD_BASE_URL =
        "https://api.eliza.app/api/v1";
      const runtimeClientGet = vi.fn(async () => ({ balance: 99 }));
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const runtime = {
        getService: () => ({
          isAuthenticated: () => true,
          getClient: () => ({ get: runtimeClientGet }),
          getOrganizationId: () => "production-org",
          getUserId: () => "production-user",
        }),
        getSetting: () => "persisted-production-value",
        character: { secrets: {} },
      } as never;

      expect(resolveCloudConnectionSnapshot(cloudRoutedConfig, runtime)).toMatchObject({
        apiKey: undefined,
        authConnected: false,
        cloudAuth: null,
        connected: false,
        organizationId: undefined,
        userId: undefined,
      });
      await expect(fetchCloudCredits(cloudRoutedConfig, runtime)).resolves.toEqual({
        balance: null,
        connected: false,
      });
      expect(runtimeClientGet).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["staging-explicit", "https://api-staging.eliza.app/api/v1"],
    ["self-hosted", "https://self-hosted.example:8787/api/v1"],
  ])(
    "uses only the frozen %s key/base when stale runtime auth is connected",
    async (authority, launchBaseUrl) => {
      process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = authority;
      process.env.ELIZAOS_CLOUD_API_KEY = "launcher-key";
      process.env.ELIZAOS_CLOUD_BASE_URL = launchBaseUrl;
      process.env.NODE_ENV = "development";
      resolveConnectionCloudApiKey(cloudRoutedConfig);

      process.env.ELIZAOS_CLOUD_API_KEY = "late-production-key";
      process.env.ELIZAOS_CLOUD_BASE_URL =
        "https://api.eliza.app/api/v1";
      const runtimeClientGet = vi.fn(async () => ({ balance: 99 }));
      const runtime = {
        getService: () => ({
          isAuthenticated: () => true,
          getClient: () => ({ get: runtimeClientGet }),
          getOrganizationId: () => "production-org",
          getUserId: () => "production-user",
        }),
        getSetting: () => "persisted-production-value",
        character: { secrets: {} },
      } as never;
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ balance: 12.5 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

      await expect(fetchCloudCredits(cloudRoutedConfig, runtime)).resolves.toMatchObject({
        balance: 12.5,
        connected: true,
      });
      expect(runtimeClientGet).not.toHaveBeenCalled();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0] ?? [];
      expect(url).toBe(`${launchBaseUrl}/credits/balance`);
      expect((init as RequestInit | undefined)?.headers).toMatchObject({
        Authorization: "Bearer launcher-key",
      });
    },
  );
});
