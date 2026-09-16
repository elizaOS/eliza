/**
 * Pins SDK request construction to the immutable local-development Cloud tuple.
 *
 * These are outbound regressions: late runtime/process pollution must neither
 * redirect a launch-authorized credential nor activate an intentionally
 * unauthenticated staging-default/offline process.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { resetDevCloudEnvAuthorityForTests } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getApiKey, resolveCloudSdkAuthorityTuple } from "../../src/utils/config";
import { createCloudApiClient, createElizaCloudClient } from "../../src/utils/sdk-client";

const ENV_KEYS = [
  "ELIZA_DEV_SOURCE",
  "ELIZA_DEV_CLOUD_ENV_AUTHORITY",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_BASE_URL",
  "ELIZAOS_CLOUD_EMBEDDING_API_KEY",
  "ELIZAOS_CLOUD_EMBEDDING_URL",
] as const;

const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
  (typeof ENV_KEYS)[number],
  string | undefined
>;

function makeRuntime(settings: Record<string, string | undefined>): IAgentRuntime {
  return {
    getSetting: (key: string) => settings[key],
  } as unknown as IAgentRuntime;
}

function captureFetch(): Request[] {
  const calls: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Request(input as RequestInfo, init));
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    })
  );
  return calls;
}

function setLaunchAuthority(authority: string, baseUrl: string, apiKey: string): void {
  process.env.ELIZA_DEV_SOURCE = "1";
  process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = authority;
  process.env.ELIZAOS_CLOUD_BASE_URL = baseUrl;
  process.env.ELIZAOS_CLOUD_API_KEY = apiKey;
}

describe("Cloud SDK development authority", () => {
  beforeEach(() => {
    resetDevCloudEnvAuthorityForTests();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const key of ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetDevCloudEnvAuthorityForTests();
  });

  it.each([
    {
      authority: "staging-explicit",
      launchBase: "https://api-staging.eliza.app/api/v1",
    },
    {
      authority: "production",
      launchBase: "https://api.eliza.app/api/v1",
    },
    {
      authority: "self-hosted",
      launchBase: "https://self-hosted.example/api/v1",
    },
  ])(
    "keeps the $authority launcher base and key after late pollution",
    async ({ authority, launchBase }) => {
      const calls = captureFetch();
      const settings: Record<string, string | undefined> = {};
      const runtime = makeRuntime(settings);
      setLaunchAuthority(authority, launchBase, "launch-key");

      expect(resolveCloudSdkAuthorityTuple(runtime)).toMatchObject({
        authority,
        apiBaseUrl: launchBase,
        apiKey: "launch-key",
        outboundAllowed: true,
      });

      process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "production";
      process.env.ELIZAOS_CLOUD_BASE_URL = "https://late-attacker.example/api/v1";
      process.env.ELIZAOS_CLOUD_API_KEY = "late-process-key";
      settings.ELIZAOS_CLOUD_BASE_URL = "https://late-runtime.example/api/v1";
      settings.ELIZAOS_CLOUD_API_KEY = "late-runtime-key";

      await createCloudApiClient(runtime).requestRaw("GET", "/models");
      await createElizaCloudClient(runtime).v1.requestRaw("GET", "/models");

      expect(calls).toHaveLength(2);
      for (const request of calls) {
        expect(request.url).toBe(`${launchBase}/models`);
        expect(request.headers.get("Authorization")).toBe("Bearer launch-key");
      }
    }
  );

  it("keeps the complete launcher embedding tuple after late pollution", async () => {
    const calls = captureFetch();
    const settings: Record<string, string | undefined> = {};
    const runtime = makeRuntime(settings);
    setLaunchAuthority(
      "self-hosted",
      "https://launch-general.example/api/v1",
      "launch-general-key"
    );
    process.env.ELIZAOS_CLOUD_EMBEDDING_URL = "https://launch-embedding.example/api/v1";
    process.env.ELIZAOS_CLOUD_EMBEDDING_API_KEY = "launch-embedding-key";

    expect(resolveCloudSdkAuthorityTuple(runtime, true).apiKey).toBe("launch-embedding-key");

    process.env.ELIZAOS_CLOUD_EMBEDDING_URL = "https://late-process.example/api/v1";
    process.env.ELIZAOS_CLOUD_EMBEDDING_API_KEY = "late-process-key";
    settings.ELIZAOS_CLOUD_EMBEDDING_URL = "https://late-runtime.example/api/v1";
    settings.ELIZAOS_CLOUD_EMBEDDING_API_KEY = "late-runtime-key";

    await createCloudApiClient(runtime, true).requestRaw("GET", "/models");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://launch-embedding.example/api/v1/models");
    expect(calls[0].headers.get("Authorization")).toBe("Bearer launch-embedding-key");
  });

  it.each(["staging-default", "offline"])(
    "keeps %s credential-free and prevents SDK requests after late pollution",
    (authority) => {
      const calls = captureFetch();
      const settings: Record<string, string | undefined> = {};
      const runtime = makeRuntime(settings);
      setLaunchAuthority(authority, "https://api-staging.eliza.app/api/v1", "must-be-scrubbed");

      expect(resolveCloudSdkAuthorityTuple(runtime)).toMatchObject({
        authority,
        apiKey: undefined,
        outboundAllowed: false,
      });

      process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "production";
      process.env.ELIZAOS_CLOUD_BASE_URL = "https://late-attacker.example/api/v1";
      process.env.ELIZAOS_CLOUD_API_KEY = "late-process-key";
      settings.ELIZAOS_CLOUD_BASE_URL = "https://late-runtime.example/api/v1";
      settings.ELIZAOS_CLOUD_API_KEY = "late-runtime-key";

      expect(getApiKey(runtime)).toBeUndefined();
      expect(() => createCloudApiClient(runtime)).toThrowError(
        expect.objectContaining({
          code: "ELIZA_CLOUD_DEV_AUTHORITY_OUTBOUND_BLOCKED",
          context: { authority },
        })
      );
      expect(() => createElizaCloudClient(runtime)).toThrowError(
        expect.objectContaining({
          code: "ELIZA_CLOUD_DEV_AUTHORITY_OUTBOUND_BLOCKED",
          context: { authority },
        })
      );
      expect(calls).toHaveLength(0);
    }
  );

  it("preserves runtime base and key behavior without launcher authority", async () => {
    const calls = captureFetch();
    const runtime = makeRuntime({
      ELIZAOS_CLOUD_BASE_URL: "https://legacy-runtime.example/api/v1",
      ELIZAOS_CLOUD_API_KEY: "legacy-runtime-key",
    });

    await createElizaCloudClient(runtime).v1.requestRaw("GET", "/models");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://legacy-runtime.example/api/v1/models");
    expect(calls[0].headers.get("Authorization")).toBe("Bearer legacy-runtime-key");
  });
});
