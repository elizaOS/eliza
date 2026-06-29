import { resolveElizaCloudTopology } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ElizaConfig } from "../config/config.ts";
import {
  applyCloudConfigToEnv,
  ensureProvisionedCloudContainerConfig,
  shouldStartElizaCloudThinClient,
} from "./eliza.ts";
import { collectPluginNames } from "./plugin-collector.ts";

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
  "ELIZAOS_CLOUD_SMALL_MODEL",
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

  it("is a no-op when neither cloud config nor ELIZA_CLOUD_PROVISIONED is present", () => {
    // No cloud + not a container → the function returns early and must not
    // touch any cloud-usage env (so a local-only agent isn't flipped to cloud).
    applyCloudConfigToEnv({} as ElizaConfig);

    expect(process.env.ELIZAOS_CLOUD_USE_EMBEDDINGS).toBeUndefined();
    expect(process.env.ELIZAOS_CLOUD_USE_INFERENCE).toBeUndefined();
    expect(process.env.ELIZAOS_CLOUD_ENABLED).toBeUndefined();
  });
});

describe("provisioned cloud container topology (#9887)", () => {
  it("repairs a cloud-provisioned config that lost canonical routing fields", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    process.env.ELIZAOS_CLOUD_SMALL_MODEL = "small-test";

    const config: ElizaConfig = {
      cloud: {
        enabled: true,
        apiKey: "cloud-test",
        baseUrl: "https://cloud.example/api",
        agentId: "agent-test",
      },
    } as ElizaConfig;

    const changed = ensureProvisionedCloudContainerConfig(config);
    const topology = resolveElizaCloudTopology(
      config as Record<string, unknown>,
    );

    expect(changed).toBe(true);
    expect(config.deploymentTarget).toEqual({
      runtime: "cloud",
      provider: "elizacloud",
    });
    expect(topology.runtime).toBe("cloud");
    expect(topology.services.inference).toBe(true);
    expect(config.serviceRouting?.llmText).toMatchObject({
      backend: "elizacloud",
      transport: "cloud-proxy",
      smallModel: "small-test",
    });
  });

  it("repairs topology from config.env when container env has only the provisioned marker", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";

    const config: ElizaConfig = {
      env: {
        vars: {
          ELIZAOS_CLOUD_API_KEY: "cloud-test",
          ELIZAOS_CLOUD_BASE_URL: "https://cloud.example/api",
          ELIZA_CLOUD_AGENT_ID: "agent-test",
          ELIZAOS_CLOUD_SMALL_MODEL: "small-from-config-env",
        },
      },
    } as ElizaConfig;

    const changed = ensureProvisionedCloudContainerConfig(config);
    const topology = resolveElizaCloudTopology(
      config as Record<string, unknown>,
    );

    expect(changed).toBe(true);
    expect(config.cloud).toMatchObject({
      enabled: true,
      apiKey: "cloud-test",
      baseUrl: "https://cloud.example/api",
      agentId: "agent-test",
    });
    expect(config.deploymentTarget).toEqual({
      runtime: "cloud",
      provider: "elizacloud",
    });
    expect(topology.runtime).toBe("cloud");
    expect(topology.services.inference).toBe(true);
    expect(config.serviceRouting?.llmText).toMatchObject({
      backend: "elizacloud",
      transport: "cloud-proxy",
      smallModel: "small-from-config-env",
    });
  });

  it("uses a real config.env cloud key when config.cloud carries the redacted placeholder", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";

    const config: ElizaConfig = {
      cloud: {
        enabled: true,
        apiKey: "[REDACTED]",
        agentId: "agent-test",
      },
      env: {
        vars: {
          ELIZAOS_CLOUD_API_KEY: "cloud-test",
        },
      },
    } as ElizaConfig;

    const changed = ensureProvisionedCloudContainerConfig(config);

    expect(changed).toBe(true);
    expect(config.cloud?.apiKey).toBe("cloud-test");
    expect(
      resolveElizaCloudTopology(config as Record<string, unknown>).services
        .inference,
    ).toBe(true);
  });

  it("forces cloud inference env from repaired managed-container topology", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";

    const config: ElizaConfig = {
      cloud: {
        enabled: true,
        apiKey: "cloud-test",
        agentId: "agent-test",
      },
    } as ElizaConfig;

    applyCloudConfigToEnv(config);

    expect(
      resolveElizaCloudTopology(config as Record<string, unknown>).services
        .inference,
    ).toBe(true);
    expect(process.env.ELIZAOS_CLOUD_USE_INFERENCE).toBe("true");
    expect(process.env.ELIZAOS_CLOUD_ENABLED).toBe("true");
  });

  it("keeps repaired managed containers off local-inference fallback", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";

    const config: ElizaConfig = {
      cloud: {
        enabled: true,
        apiKey: "cloud-test",
        agentId: "agent-test",
      },
    } as ElizaConfig;

    applyCloudConfigToEnv(config);
    const names = collectPluginNames(config);

    expect(names.has("@elizaos/plugin-elizacloud")).toBe(true);
    expect(names.has("@elizaos/plugin-local-inference")).toBe(false);
  });

  it("keeps managed cloud containers on the full runtime, not the thin client", () => {
    const config: ElizaConfig = {
      deploymentTarget: {
        runtime: "cloud",
        provider: "elizacloud",
      },
      cloud: {
        enabled: true,
        apiKey: "cloud-test",
        agentId: "agent-test",
      },
    } as ElizaConfig;

    expect(shouldStartElizaCloudThinClient(config)).toBe(true);

    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    expect(shouldStartElizaCloudThinClient(config)).toBe(false);
  });
});
