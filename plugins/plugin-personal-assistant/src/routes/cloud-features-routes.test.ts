/**
 * Error-path tests for the Cloud features proxy (`fetchCloudFeatures`).
 *
 * Guards the #12182 fast-fail conversion: a 200 response whose body is not
 * valid JSON is an upstream contract violation and must surface as an error, not
 * fabricate a "synced, zero features" success. Uses a stubbed `globalThis.fetch`
 * (no live Cloud) — the parse boundary under test is deterministic.
 */

import type { AgentRuntime } from "@elizaos/core";
import {
  resetDevCloudEnvAuthorityForTests,
  resolveDevCloudEnvAuthority,
} from "@elizaos/shared";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  type CloudFeaturesRouteState,
  fetchCloudFeatures,
} from "./cloud-features-routes.js";

const BASE_STATE: CloudFeaturesRouteState = {
  config: {
    cloud: { apiKey: "test-cloud-key", baseUrl: "https://cloud.example.com" },
  },
  runtime: null,
};

let originalFetch: typeof globalThis.fetch;
let originalElizaDev: string | undefined;
const AUTHORITY_ENV_KEYS = [
  "ELIZA_DEV_SOURCE",
  "ELIZA_DEV_CLOUD_ENV_AUTHORITY",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_BASE_URL",
] as const;
const originalAuthorityEnv = Object.fromEntries(
  AUTHORITY_ENV_KEYS.map((key) => [key, process.env[key]]),
);

function cloudAuthRuntime(apiKey: string): AgentRuntime {
  return {
    getService: () => ({
      isAuthenticated: () => true,
      getApiKey: () => apiKey,
    }),
    getSetting: () => "runtime-setting-production-key",
    character: {
      secrets: { ELIZAOS_CLOUD_API_KEY: "runtime-secret-production-key" },
    },
  } as unknown as AgentRuntime;
}

function stubFetch(
  response: Partial<Response> & { json?: () => Promise<unknown> },
) {
  const mock = vi.fn(async () => response as unknown as Response);
  globalThis.fetch = mock as unknown as typeof globalThis.fetch;
  return mock;
}

beforeAll(() => {
  originalFetch = globalThis.fetch;
  // Bypass validateCloudBaseUrl's DNS resolution for the public test host.
  originalElizaDev = process.env.ELIZA_DEV;
  process.env.ELIZA_DEV = "1";
});

beforeEach(() => {
  resetDevCloudEnvAuthorityForTests();
  for (const key of AUTHORITY_ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of AUTHORITY_ENV_KEYS) {
    const value = originalAuthorityEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetDevCloudEnvAuthorityForTests();
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  if (originalElizaDev === undefined) delete process.env.ELIZA_DEV;
  else process.env.ELIZA_DEV = originalElizaDev;
});

describe("fetchCloudFeatures", () => {
  it("surfaces an unparseable 200 body as an error instead of zero features", async () => {
    stubFetch({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON at position 0");
      },
    });

    const result = await fetchCloudFeatures(BASE_STATE);

    expect(result.status).toBe(502);
    expect(result.error).toMatch(/not valid JSON/i);
    expect(result.rows).toHaveLength(0);
  });

  it("returns parsed rows with no error when the 200 body is valid JSON", async () => {
    stubFetch({
      ok: true,
      status: 200,
      json: async () => ({
        features: [{ featureKey: "not_a_real_feature", enabled: true }],
      }),
    });

    const result = await fetchCloudFeatures(BASE_STATE);

    expect(result.status).toBe(200);
    expect(result.error).toBeNull();
    // Unknown feature keys are dropped by parseCloudFeatures; the point is that
    // a well-formed body is NOT treated as an error (no over-removal).
    expect(Array.isArray(result.rows)).toBe(true);
  });

  it("treats a genuinely empty but valid feature list as success, not an error", async () => {
    stubFetch({
      ok: true,
      status: 200,
      json: async () => ({ features: [] }),
    });

    const result = await fetchCloudFeatures(BASE_STATE);

    expect(result.status).toBe(200);
    expect(result.error).toBeNull();
    expect(result.rows).toHaveLength(0);
  });

  it.each(["staging-default", "offline"] as const)(
    "performs no Cloud fetch under blocked %s authority despite runtime auth",
    async (authority) => {
      process.env.ELIZA_DEV_SOURCE = "1";
      process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = authority;
      process.env.ELIZAOS_CLOUD_API_KEY = "";
      process.env.ELIZAOS_CLOUD_BASE_URL =
        "https://api-staging.eliza.app/api/v1";
      expect(resolveDevCloudEnvAuthority()).toBe(authority);
      process.env.ELIZAOS_CLOUD_API_KEY = "late-production-key";
      process.env.ELIZAOS_CLOUD_BASE_URL = "https://api.eliza.app/api/v1";
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

      const result = await fetchCloudFeatures({
        config: {
          cloud: {
            apiKey: "persisted-production-key",
            baseUrl: "https://api.eliza.app/api/v1",
          },
        },
        runtime: cloudAuthRuntime("runtime-auth-production-key"),
      });

      expect(result.status).toBe(401);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "staging-explicit",
      "https://api-staging.eliza.app/api/v1",
      "https://cloud-staging.eliza.app/api/v1/features",
    ],
    [
      "self-hosted",
      "https://cloud.internal.example/api/v1",
      "https://cloud.internal.example/api/v1/features",
    ],
  ] as const)(
    "uses the frozen key and base for %s despite runtime and late env pollution",
    async (authority, launchBaseUrl, expectedUrl) => {
      process.env.ELIZA_DEV_SOURCE = "1";
      process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = authority;
      process.env.ELIZAOS_CLOUD_API_KEY = "launcher-key";
      process.env.ELIZAOS_CLOUD_BASE_URL = launchBaseUrl;
      expect(resolveDevCloudEnvAuthority()).toBe(authority);
      process.env.ELIZAOS_CLOUD_API_KEY = "late-production-key";
      process.env.ELIZAOS_CLOUD_BASE_URL = "https://api.eliza.app/api/v1";
      const fetchMock = stubFetch({
        ok: true,
        status: 200,
        json: async () => ({ features: [] }),
      });

      const result = await fetchCloudFeatures({
        config: {
          cloud: {
            apiKey: "persisted-production-key",
            baseUrl: "https://api.eliza.app/api/v1",
          },
        },
        runtime: cloudAuthRuntime("runtime-auth-production-key"),
      });

      expect(result.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(expectedUrl);
      expect((init.headers as Record<string, string>).Authorization).toBe(
        "Bearer launcher-key",
      );
    },
  );
});
