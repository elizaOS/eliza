import type { IAgentRuntime } from "@elizaos/core";
import {
  captureDevCloudEnvAuthoritySnapshot,
  resetDevCloudEnvAuthorityForTests,
} from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initRPCProviderManager } from "../../rpc-providers";

const ENV_KEYS = [
  "ELIZA_DEV_SOURCE",
  "ELIZA_DEV_CLOUD_ENV_AUTHORITY",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_BASE_URL",
] as const;
let savedEnv: Record<string, string | undefined>;

function runtime(
  settings: Record<string, string | undefined> = {},
  characterSecret?: string
): IAgentRuntime {
  return {
    character: characterSecret ? { secrets: { ELIZAOS_CLOUD_API_KEY: characterSecret } } : {},
    getSetting: (key: string) => settings[key],
  } as unknown as IAgentRuntime;
}

beforeEach(() => {
  resetDevCloudEnvAuthorityForTests();
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetDevCloudEnvAuthorityForTests();
});

describe("Eliza Cloud RPC development authority", () => {
  it.each(["staging-default", "offline"] as const)(
    "%s ignores late env, runtime, and character production credentials",
    (authority) => {
      process.env.ELIZA_DEV_SOURCE = "1";
      process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = authority;
      process.env.ELIZAOS_CLOUD_BASE_URL = "https://api-staging.eliza.app/api/v1";
      process.env.ELIZAOS_CLOUD_API_KEY = "";
      expect(captureDevCloudEnvAuthoritySnapshot()).not.toBeNull();

      process.env.ELIZAOS_CLOUD_BASE_URL = "https://api.eliza.app/api/v1";
      process.env.ELIZAOS_CLOUD_API_KEY = "late-production-env-key";
      const manager = initRPCProviderManager(
        runtime(
          {
            ELIZAOS_CLOUD_API_KEY: "persisted-runtime-key",
            ELIZAOS_CLOUD_BASE_URL: "https://api.eliza.app/api/v1",
          },
          "persisted-character-key"
        )
      );

      expect(manager.getConfiguredProviders()).not.toContain("elizacloud");
      expect(manager.resolveForChain("mainnet")).toBeNull();
    }
  );

  it("uses only the frozen explicit-staging tuple after late production pollution", () => {
    process.env.ELIZA_DEV_SOURCE = "1";
    process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "staging-explicit";
    process.env.ELIZAOS_CLOUD_BASE_URL = "https://api-staging.eliza.app/api/v1";
    process.env.ELIZAOS_CLOUD_API_KEY = "staging-launch-key";
    expect(captureDevCloudEnvAuthoritySnapshot()).not.toBeNull();

    process.env.ELIZAOS_CLOUD_BASE_URL = "https://api.eliza.app/api/v1";
    process.env.ELIZAOS_CLOUD_API_KEY = "late-production-env-key";
    const manager = initRPCProviderManager(
      runtime(
        {
          ELIZAOS_CLOUD_API_KEY: "persisted-runtime-key",
          ELIZAOS_CLOUD_BASE_URL: "https://api.eliza.app/api/v1",
        },
        "persisted-character-key"
      )
    );

    expect(manager.getConfiguredProviders()).toContain("elizacloud");
    expect(manager.resolveForChain("mainnet")).toEqual({
      providerName: "elizacloud",
      rpcUrl: "https://api-staging.eliza.app/api/v1/proxy/evm-rpc/mainnet",
      headers: { Authorization: "Bearer staging-launch-key" },
    });
  });

  it("preserves runtime Cloud RPC configuration without authority", () => {
    const manager = initRPCProviderManager(
      runtime({
        ELIZAOS_CLOUD_API_KEY: "legacy-runtime-key",
        ELIZAOS_CLOUD_BASE_URL: "https://legacy.example/api/v1",
      })
    );

    expect(manager.resolveForChain("base")).toMatchObject({
      providerName: "elizacloud",
      rpcUrl: "https://legacy.example/api/v1/proxy/evm-rpc/base",
      headers: { Authorization: "Bearer legacy-runtime-key" },
    });
  });
});
