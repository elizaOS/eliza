import { resolveElizaCloudTopology } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ElizaConfig } from "../config/config.ts";
import {
  applyCloudConfigToEnv,
  applyProvisionedCloudRuntimeDefaults,
  shouldStartThinCloudRuntime,
} from "./eliza.ts";

// applyCloudConfigToEnv is the #8769 source change: a cloud-provisioned container
// MUST use cloud (1536-dim) embeddings, never plugin-local-inference's 384-dim
// gte-small — otherwise every memory insert is dropped on a dimension mismatch.
// This was previously uncovered.
const ENV_KEYS = [
  "ELIZA_CLOUD_PROVISIONED",
  "ELIZAOS_CLOUD_USE_INFERENCE",
  "ELIZAOS_CLOUD_USE_EMBEDDINGS",
  "ELIZAOS_CLOUD_USE_TTS",
  "ELIZAOS_CLOUD_USE_MEDIA",
  "ELIZAOS_CLOUD_USE_RPC",
  "ELIZAOS_CLOUD_ENABLED",
  "ELIZA_CLOUD_EMBEDDINGS_DISABLED",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_BASE_URL",
  "ELIZA_CLOUD_AGENT_ID",
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("applyCloudConfigToEnv cloud-container embeddings (#8769)", () => {
  it("a cloud-provisioned container uses cloud embeddings and clears the disabled flag", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    // A stale disabled flag must be cleared, not left to suppress cloud embeddings.
    process.env.ELIZA_CLOUD_EMBEDDINGS_DISABLED = "true";

    applyCloudConfigToEnv({} as ElizaConfig);

    expect(process.env.ELIZAOS_CLOUD_USE_EMBEDDINGS).toBe("true");
    expect(process.env.ELIZA_CLOUD_EMBEDDINGS_DISABLED).toBeUndefined();
    // Cloud inference is likewise forced on for a provisioned container.
    expect(process.env.ELIZAOS_CLOUD_USE_INFERENCE).toBe("true");
  });

  it("repairs provisioned cloud topology when the in-memory config lost canonical routing", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    process.env.ELIZAOS_CLOUD_API_KEY = "cloud-key";
    process.env.ELIZAOS_CLOUD_BASE_URL = "https://api.elizacloud.ai/api/v1";
    process.env.ELIZA_CLOUD_AGENT_ID = "agent-123";
    const config = {
      cloud: { enabled: true },
    } as ElizaConfig;

    applyProvisionedCloudRuntimeDefaults(config);

    expect(config.cloud?.apiKey).toBe("cloud-key");
    expect(config.cloud?.agentId).toBe("agent-123");
    expect(config.deploymentTarget).toEqual({
      runtime: "cloud",
      provider: "elizacloud",
    });
    expect(config.serviceRouting?.llmText).toMatchObject({
      backend: "elizacloud",
      transport: "cloud-proxy",
    });
    const topology = resolveElizaCloudTopology(
      config as Record<string, unknown>,
    );
    expect(topology.runtime).toBe("cloud");
    expect(topology.services.inference).toBe(true);
  });

  it("uses thin cloud runtime only outside provisioned cloud containers", () => {
    const config = {
      deploymentTarget: { runtime: "cloud", provider: "elizacloud" },
      cloud: { enabled: true, apiKey: "cloud-key", agentId: "agent-123" },
    } as ElizaConfig;

    expect(shouldStartThinCloudRuntime(config)).toBe(true);

    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    expect(shouldStartThinCloudRuntime(config)).toBe(false);
  });

  it("is a no-op when neither cloud config nor ELIZA_CLOUD_PROVISIONED is present", () => {
    // No cloud + not a container → the function returns early and must not
    // touch any cloud-usage env (so a local-only agent isn't flipped to cloud).
    applyCloudConfigToEnv({} as ElizaConfig);

    expect(process.env.ELIZAOS_CLOUD_USE_EMBEDDINGS).toBeUndefined();
    expect(process.env.ELIZAOS_CLOUD_USE_INFERENCE).toBeUndefined();
    expect(process.env.ELIZAOS_CLOUD_ENABLED).toBeUndefined();
  });
});
