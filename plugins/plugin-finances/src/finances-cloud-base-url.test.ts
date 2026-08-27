/**
 * Pins the finances Plaid config against the SDK's base-URL contract.
 *
 * `PlaidManagedClient` hands `config.apiBaseUrl` straight to `ElizaCloudClient`,
 * which accepts an origin or a base ending at `/api/v1` and throws on anything
 * else. The route-level webhook tests stub below that constructor, so they stay
 * green on a base the real client would reject — this asserts against the real
 * constructor instead.
 */
import { ElizaCloudClient } from "@elizaos/cloud-sdk";
import {
  captureDevCloudEnvAuthoritySnapshot,
  resetDevCloudEnvAuthorityForTests,
} from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveFinancesCloudManagedClientConfig } from "./finances-service";

const configMocks = vi.hoisted(() => ({
  durable: {} as Record<string, unknown>,
  effective: {} as Record<string, unknown>,
}));

vi.mock("@elizaos/agent/config/config", () => ({
  loadElizaConfig: () => configMocks.durable,
  loadEffectiveElizaConfig: () => configMocks.effective,
}));

describe("finances cloud managed-client base URL", () => {
  const previousBaseUrl = process.env.ELIZAOS_CLOUD_BASE_URL;
  const previousApiKey = process.env.ELIZAOS_CLOUD_API_KEY;
  const previousDevSource = process.env.ELIZA_DEV_SOURCE;
  const previousDevAuthority = process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY;
  const previousDevTarget = process.env.ELIZA_DEV_CLOUD_TARGET;

  beforeEach(() => {
    resetDevCloudEnvAuthorityForTests();
    delete process.env.ELIZA_DEV_SOURCE;
    delete process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY;
    delete process.env.ELIZA_DEV_CLOUD_TARGET;
    process.env.ELIZAOS_CLOUD_BASE_URL = "https://cloud.example";
    delete process.env.ELIZAOS_CLOUD_API_KEY;
    configMocks.durable = {};
    configMocks.effective = {};
  });

  afterEach(() => {
    if (previousBaseUrl === undefined)
      delete process.env.ELIZAOS_CLOUD_BASE_URL;
    else process.env.ELIZAOS_CLOUD_BASE_URL = previousBaseUrl;
    if (previousApiKey === undefined) delete process.env.ELIZAOS_CLOUD_API_KEY;
    else process.env.ELIZAOS_CLOUD_API_KEY = previousApiKey;
    if (previousDevSource === undefined) delete process.env.ELIZA_DEV_SOURCE;
    else process.env.ELIZA_DEV_SOURCE = previousDevSource;
    if (previousDevAuthority === undefined)
      delete process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY;
    else process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = previousDevAuthority;
    if (previousDevTarget === undefined)
      delete process.env.ELIZA_DEV_CLOUD_TARGET;
    else process.env.ELIZA_DEV_CLOUD_TARGET = previousDevTarget;
    resetDevCloudEnvAuthorityForTests();
  });

  it("produces a base the real SDK client accepts", () => {
    const config = resolveFinancesCloudManagedClientConfig();
    const client = new ElizaCloudClient({
      baseUrl: config.siteUrl,
      apiBaseUrl: config.apiBaseUrl,
      apiKey: "test-key",
    });
    expect(client.apiBaseUrl).toBe("https://cloud.example/api/v1");
  });

  it("rejects a base trimmed to /api, so the trim cannot be reintroduced", () => {
    const config = resolveFinancesCloudManagedClientConfig();
    expect(() => {
      new ElizaCloudClient({
        baseUrl: config.siteUrl,
        apiBaseUrl: config.apiBaseUrl.replace(/\/v1$/, ""),
        apiKey: "test-key",
      });
    }).toThrow(/must be an origin or end at \/api\/v1/);
  });

  it("uses the effective staging view instead of durable production Cloud config", () => {
    configMocks.durable = {
      cloud: {
        apiKey: "persisted-production-key",
        baseUrl: "https://api.eliza.app/api/v1",
      },
    };
    configMocks.effective = {
      cloud: {
        apiKey: "staging-key",
        baseUrl: "https://api-staging.eliza.app/api/v1",
      },
    };
    process.env.ELIZAOS_CLOUD_API_KEY = "ambient-production-key";
    delete process.env.ELIZAOS_CLOUD_BASE_URL;

    expect(resolveFinancesCloudManagedClientConfig()).toEqual({
      configured: true,
      apiKey: "staging-key",
      apiBaseUrl: "https://api-staging.eliza.app/api/v1",
      siteUrl: "https://cloud-staging.eliza.app",
    });
  });

  it("does not revive Cloud clients from late process.env pollution in staging-default", () => {
    process.env.ELIZA_DEV_SOURCE = "1";
    process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "staging-default";
    process.env.ELIZA_DEV_CLOUD_TARGET = "staging";
    process.env.ELIZAOS_CLOUD_BASE_URL = "https://api-staging.eliza.app/api/v1";
    delete process.env.ELIZAOS_CLOUD_API_KEY;
    resetDevCloudEnvAuthorityForTests();
    captureDevCloudEnvAuthoritySnapshot();

    process.env.ELIZAOS_CLOUD_API_KEY = "late-production-key";
    process.env.ELIZAOS_CLOUD_BASE_URL = "https://api.eliza.app/api/v1";
    configMocks.effective = {
      cloud: {
        apiKey: "",
        baseUrl: "https://api-staging.eliza.app/api/v1",
      },
    };

    expect(resolveFinancesCloudManagedClientConfig()).toEqual({
      configured: false,
      apiKey: null,
      apiBaseUrl: "https://api-staging.eliza.app/api/v1",
      siteUrl: "https://cloud-staging.eliza.app",
    });
  });
});
