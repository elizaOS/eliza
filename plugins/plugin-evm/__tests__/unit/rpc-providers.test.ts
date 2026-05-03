import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import { initRPCProviderManager, validateRPCProviderConfig } from "../../rpc-providers";

function createRuntime(
  settings: Record<string, string | undefined> = {},
  evmChains: string[] = ["mainnet", "base", "bsc"],
  secrets: Record<string, string | undefined> = {}
): IAgentRuntime {
  return {
    getSetting(key: string): string | undefined {
      return settings[key];
    },
    character: {
      secrets,
      settings: {
        chains: {
          evm: evmChains,
        },
      },
    },
  } as IAgentRuntime;
}

describe("rpc providers", () => {
  const originalCloudApiKey = process.env.ELIZAOS_CLOUD_API_KEY;
  const originalCloudBaseUrl = process.env.ELIZAOS_CLOUD_BASE_URL;

  afterEach(() => {
    if (originalCloudApiKey === undefined) {
      delete process.env.ELIZAOS_CLOUD_API_KEY;
    } else {
      process.env.ELIZAOS_CLOUD_API_KEY = originalCloudApiKey;
    }

    if (originalCloudBaseUrl === undefined) {
      delete process.env.ELIZAOS_CLOUD_BASE_URL;
    } else {
      process.env.ELIZAOS_CLOUD_BASE_URL = originalCloudBaseUrl;
    }
  });

  it("uses Eliza Cloud RPC when a cloud login key is available", () => {
    const runtime = createRuntime({
      ELIZAOS_CLOUD_API_KEY: "eliza_test_key",
      ELIZAOS_CLOUD_BASE_URL: "https://cloud.example.test/api/v1",
    });

    const validation = validateRPCProviderConfig(runtime);
    expect(validation).toEqual({
      valid: true,
      providers: ["elizacloud"],
      warnings: [],
    });

    const resolved = initRPCProviderManager(runtime).resolveForChain("mainnet");
    expect(resolved).toEqual({
      providerName: "elizacloud",
      rpcUrl: "https://cloud.example.test/api/v1/proxy/evm-rpc/mainnet",
      headers: {
        Authorization: "Bearer eliza_test_key",
      },
    });
  });

  it("uses Eliza Cloud RPC when the login key is stored in character secrets", () => {
    const runtime = createRuntime({}, ["mainnet"], {
      ELIZAOS_CLOUD_API_KEY: "eliza_secret_key",
    });

    const validation = validateRPCProviderConfig(runtime);
    expect(validation).toEqual({
      valid: true,
      providers: ["elizacloud"],
      warnings: [],
    });

    const resolved = initRPCProviderManager(runtime).resolveForChain("mainnet");
    expect(resolved).toEqual({
      providerName: "elizacloud",
      rpcUrl: "https://www.elizacloud.ai/api/v1/proxy/evm-rpc/mainnet",
      headers: {
        Authorization: "Bearer eliza_secret_key",
      },
    });
  });

  it("keeps explicit per-chain RPC URLs ahead of Eliza Cloud", () => {
    const runtime = createRuntime({
      ELIZAOS_CLOUD_API_KEY: "eliza_test_key",
      ETHEREUM_PROVIDER_MAINNET: "https://rpc.example.test",
    });

    const resolved = initRPCProviderManager(runtime).resolveForChain("mainnet");
    expect(resolved).toEqual({
      providerName: "alchemy",
      rpcUrl: "https://rpc.example.test",
      headers: {},
    });
  });

  it("warns only when neither managed nor per-chain RPC is configured", () => {
    const validation = validateRPCProviderConfig(createRuntime());
    expect(validation.valid).toBe(false);
    expect(validation.providers).toEqual([]);
    expect(validation.warnings).toHaveLength(1);
    expect(validation.warnings[0]).toContain("ELIZAOS_CLOUD_API_KEY from an Eliza Cloud login");
  });
});
