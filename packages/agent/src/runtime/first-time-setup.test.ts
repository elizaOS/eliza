import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ElizaConfig } from "../config/config.js";
import {
  applyFirstTimeSetupTopology,
  bindCloudProvider,
} from "./first-time-setup";

describe("applyFirstTimeSetupTopology", () => {
  it("defaults cloud services on when cloud runtime uses a direct provider", () => {
    expect(
      applyFirstTimeSetupTopology({} as never, {
        isCloudRuntime: true,
        selectedProviderId: "openai",
        cloudOnboardingResult: {
          apiKey: "cloud-key",
          baseUrl: "https://elizacloud.ai",
          agentId: "agent-123",
        },
      }),
    ).toMatchObject({
      deploymentTarget: {
        runtime: "cloud",
        provider: "elizacloud",
      },
      linkedAccounts: {
        elizacloud: {
          status: "linked",
          source: "oauth",
        },
      },
      serviceRouting: {
        llmText: {
          backend: "openai",
          transport: "direct",
        },
        tts: {
          backend: "elizacloud",
          transport: "cloud-proxy",
          accountId: "elizacloud",
        },
        media: {
          backend: "elizacloud",
          transport: "cloud-proxy",
          accountId: "elizacloud",
        },
        embeddings: {
          backend: "elizacloud",
          transport: "cloud-proxy",
          accountId: "elizacloud",
        },
        rpc: {
          backend: "elizacloud",
          transport: "cloud-proxy",
          accountId: "elizacloud",
        },
      },
      cloud: {
        apiKey: "cloud-key",
        baseUrl: "https://elizacloud.ai",
        agentId: "agent-123",
      },
    });
  });

  it("defaults all cloud services on when local runtime uses Eliza Cloud inference", () => {
    expect(
      applyFirstTimeSetupTopology({} as never, {
        isCloudRuntime: false,
        selectedProviderId: "elizacloud",
        cloudOnboardingResult: {
          apiKey: "cloud-key",
          baseUrl: "https://elizacloud.ai",
          agentId: undefined,
        },
      }),
    ).toMatchObject({
      deploymentTarget: {
        runtime: "local",
      },
      linkedAccounts: {
        elizacloud: {
          status: "linked",
          source: "oauth",
        },
      },
      serviceRouting: {
        llmText: {
          backend: "elizacloud",
          transport: "cloud-proxy",
          accountId: "elizacloud",
        },
        tts: {
          backend: "elizacloud",
          transport: "cloud-proxy",
          accountId: "elizacloud",
        },
        media: {
          backend: "elizacloud",
          transport: "cloud-proxy",
          accountId: "elizacloud",
        },
        embeddings: {
          backend: "elizacloud",
          transport: "cloud-proxy",
          accountId: "elizacloud",
        },
        rpc: {
          backend: "elizacloud",
          transport: "cloud-proxy",
          accountId: "elizacloud",
        },
      },
    });
  });

  it("defaults non-text cloud services on even before cloud runtime picks a chat provider", () => {
    expect(
      applyFirstTimeSetupTopology({} as never, {
        isCloudRuntime: true,
        cloudOnboardingResult: {
          apiKey: "cloud-key",
          baseUrl: "https://elizacloud.ai",
          agentId: "agent-123",
        },
      }),
    ).toMatchObject({
      deploymentTarget: {
        runtime: "cloud",
        provider: "elizacloud",
      },
      serviceRouting: {
        tts: {
          backend: "elizacloud",
          transport: "cloud-proxy",
          accountId: "elizacloud",
        },
        media: {
          backend: "elizacloud",
          transport: "cloud-proxy",
          accountId: "elizacloud",
        },
        embeddings: {
          backend: "elizacloud",
          transport: "cloud-proxy",
          accountId: "elizacloud",
        },
        rpc: {
          backend: "elizacloud",
          transport: "cloud-proxy",
          accountId: "elizacloud",
        },
      },
    });
  });
});

describe("bindCloudProvider", () => {
  let stateDir: string;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "milady-bind-cloud-"));
    process.env.MILADY_STATE_DIR = stateDir;
    delete process.env.MILADY_CLOUD_EVM_ADDRESS;
    delete process.env.MILADY_CLOUD_SOLANA_ADDRESS;
    delete process.env.WALLET_SOURCE_EVM;
    delete process.env.WALLET_SOURCE_SOLANA;
    delete process.env.ENABLE_CLOUD_WALLET;
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  });

  function buildConfig(
    cloud: Record<string, unknown> | undefined,
  ): ElizaConfig {
    const base: Record<string, unknown> = {};
    if (cloud !== undefined) {
      base.wallet = { cloud };
    }
    return base as ElizaConfig;
  }

  it("is a no-op when ENABLE_CLOUD_WALLET is off", async () => {
    await bindCloudProvider(buildConfig({ evm: { address: "0xabc" } }));
    expect(process.env.WALLET_SOURCE_EVM).toBeUndefined();

    const filePath = path.join(stateDir, "config.env");
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes WALLET_SOURCE_* to config.env when flag on + cloud bound", async () => {
    process.env.ENABLE_CLOUD_WALLET = "1";
    await bindCloudProvider(
      buildConfig({
        evm: { walletAddress: "0xabc" },
        solana: { walletAddress: "So1abc" },
      }),
    );
    expect(process.env.MILADY_CLOUD_EVM_ADDRESS).toBe("0xabc");
    expect(process.env.MILADY_CLOUD_SOLANA_ADDRESS).toBe("So1abc");
    expect(process.env.WALLET_SOURCE_EVM).toBe("cloud");
    expect(process.env.WALLET_SOURCE_SOLANA).toBe("cloud");

    const raw = await fs.readFile(path.join(stateDir, "config.env"), "utf8");
    expect(raw).toContain("MILADY_CLOUD_EVM_ADDRESS=0xabc");
    expect(raw).toContain("MILADY_CLOUD_SOLANA_ADDRESS=So1abc");
    expect(raw).toContain("WALLET_SOURCE_EVM=cloud");
    expect(raw).toContain("WALLET_SOURCE_SOLANA=cloud");
  });

  it("writes nothing when flag on but cloud cache is empty", async () => {
    process.env.ENABLE_CLOUD_WALLET = "1";
    await bindCloudProvider(buildConfig(undefined));
    expect(process.env.WALLET_SOURCE_EVM).toBeUndefined();
    expect(process.env.WALLET_SOURCE_SOLANA).toBeUndefined();

    const filePath = path.join(stateDir, "config.env");
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("only writes the chain present in the cache", async () => {
    process.env.ENABLE_CLOUD_WALLET = "1";
    await bindCloudProvider(buildConfig({ evm: { walletAddress: "0xabc" } }));
    expect(process.env.MILADY_CLOUD_EVM_ADDRESS).toBe("0xabc");
    expect(process.env.MILADY_CLOUD_SOLANA_ADDRESS).toBeUndefined();
    expect(process.env.WALLET_SOURCE_EVM).toBe("cloud");
    expect(process.env.WALLET_SOURCE_SOLANA).toBeUndefined();
  });

  it("skips writes when env is already bound to cloud (idempotent)", async () => {
    process.env.ENABLE_CLOUD_WALLET = "1";
    process.env.MILADY_CLOUD_EVM_ADDRESS = "0xabc";
    process.env.WALLET_SOURCE_EVM = "cloud";
    await bindCloudProvider(buildConfig({ evm: { walletAddress: "0xabc" } }));

    // No file created because no persistConfigEnv call happened.
    const filePath = path.join(stateDir, "config.env");
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("respects user-selected local primary and does not override on restart", async () => {
    process.env.ENABLE_CLOUD_WALLET = "1";

    // Config with cloud descriptors AND user's explicit choice to use local
    const config = buildConfig({
      evm: { walletAddress: "0xabc" },
    }) as ElizaConfig & {
      wallet?: {
        primary?: { evm?: string; solana?: string | null };
      };
    };
    config.wallet = config.wallet || {};
    config.wallet.primary = { evm: "local", solana: null };

    await bindCloudProvider(config);

    // Should NOT bind to cloud because user explicitly set it to local
    expect(process.env.WALLET_SOURCE_EVM).toBeUndefined();

    const filePath = path.join(stateDir, "config.env");
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
