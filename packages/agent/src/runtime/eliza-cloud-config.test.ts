/**
 * Unit coverage for cloud-provisioned runtime configuration in eliza.ts:
 * applyCloudConfigToEnv wiring cloud embeddings/inference into the environment
 * (#8769), provisioned-container topology resolution (#9887), and the guard
 * that prevents stale vault/config keys from clobbering live cloud settings
 * (#11038). Asserts env mutations directly; no live cloud calls.
 */
import { logger } from "@elizaos/core";
import { resolveElizaCloudTopology } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ElizaConfig } from "../config/config.ts";
import {
  applyCloudConfigToEnv,
  cloudApiKeyFingerprint,
  ensureProvisionedCloudContainerConfig,
  shouldStartElizaCloudThinClient,
} from "./eliza.ts";
import { collectPluginNames } from "./plugin-collector.ts";

// applyCloudConfigToEnv (#8769): a cloud-provisioned container MUST use cloud
// (1536-dim) embeddings, never plugin-local-inference's 384-dim gte-small —
// otherwise every memory insert is dropped on a dimension mismatch.
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
  "EMBEDDING_BASE_URL",
  "EMBEDDING_API_KEY",
  "EMBEDDING_MODEL",
  "EMBEDDING_DIMENSIONS",
  "ELIZAOS_CLOUD_BASE_URL",
  "ELIZA_CLOUD_AGENT_ID",
  "ELIZAOS_CLOUD_NANO_MODEL",
  "ELIZAOS_CLOUD_SMALL_MODEL",
  "ELIZAOS_CLOUD_MEDIUM_MODEL",
  "ELIZAOS_CLOUD_LARGE_MODEL",
  "ELIZAOS_CLOUD_MEGA_MODEL",
  "ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL",
  "ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL",
  "ELIZAOS_CLOUD_ACTION_PLANNER_MODEL",
  "ELIZAOS_CLOUD_PLANNER_MODEL",
  "NANO_MODEL",
  "SMALL_MODEL",
  "MEDIUM_MODEL",
  "LARGE_MODEL",
  "MEGA_MODEL",
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  vi.restoreAllMocks();
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

  it("honors BYO embedding ownership from config.env in a cloud-provisioned container", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";

    applyCloudConfigToEnv({
      env: {
        vars: {
          ELIZAOS_CLOUD_USE_EMBEDDINGS: "false",
          EMBEDDING_BASE_URL: "http://172.17.0.1:11434/v1",
          EMBEDDING_API_KEY: "ollama",
        },
      },
    } as ElizaConfig);

    expect(process.env.ELIZAOS_CLOUD_USE_EMBEDDINGS).toBe("false");
    expect(process.env.ELIZAOS_CLOUD_USE_INFERENCE).toBe("true");
  });

  it("lets an explicit BYO embedding endpoint own embeddings in a cloud-provisioned container", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    process.env.ELIZAOS_CLOUD_USE_EMBEDDINGS = "false";
    process.env.EMBEDDING_BASE_URL = "http://172.17.0.1:11434/v1";
    process.env.EMBEDDING_API_KEY = "ollama";
    process.env.EMBEDDING_MODEL = "nomic-embed-text";
    process.env.EMBEDDING_DIMENSIONS = "768";

    applyCloudConfigToEnv({} as ElizaConfig);

    expect(process.env.ELIZAOS_CLOUD_USE_EMBEDDINGS).toBe("false");
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

  it("does not synthesize cloud embedding routing when config.env selects BYO embeddings", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";

    const config: ElizaConfig = {
      cloud: {
        enabled: true,
        apiKey: "cloud-test",
        agentId: "agent-test",
      },
      env: {
        vars: {
          ELIZAOS_CLOUD_USE_EMBEDDINGS: "false",
          EMBEDDING_BASE_URL: "http://172.17.0.1:11434/v1",
          EMBEDDING_API_KEY: "ollama",
        },
      },
    } as ElizaConfig;

    ensureProvisionedCloudContainerConfig(config);

    expect(config.serviceRouting?.llmText).toMatchObject({
      backend: "elizacloud",
      transport: "cloud-proxy",
    });
    expect(config.serviceRouting?.embeddings).toBeUndefined();
  });

  it("does not synthesize cloud embedding routing when BYO embeddings are explicitly selected", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    process.env.ELIZAOS_CLOUD_USE_EMBEDDINGS = "false";
    process.env.EMBEDDING_BASE_URL = "http://172.17.0.1:11434/v1";
    process.env.EMBEDDING_API_KEY = "ollama";

    const config: ElizaConfig = {
      cloud: {
        enabled: true,
        apiKey: "cloud-test",
        agentId: "agent-test",
      },
    } as ElizaConfig;

    ensureProvisionedCloudContainerConfig(config);

    expect(config.serviceRouting?.llmText).toMatchObject({
      backend: "elizacloud",
      transport: "cloud-proxy",
    });
    expect(config.serviceRouting?.embeddings).toBeUndefined();
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

  it("preserves the worker-written managed cloud config shape from #9887", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    const infoSpy = vi
      .spyOn(logger, "info")
      .mockImplementation(() => undefined);

    const config: ElizaConfig = {
      logging: { level: "info" },
      deploymentTarget: {
        runtime: "cloud",
        provider: "elizacloud",
      },
      linkedAccounts: {
        elizacloud: {
          status: "linked",
          source: "api-key",
        },
      },
      serviceRouting: {
        llmText: {
          backend: "elizacloud",
          transport: "cloud-proxy",
          smallModel: "gemma-4-31b",
          largeModel: "gemma-4-31b",
        },
        embeddings: {
          backend: "elizacloud",
          transport: "cloud-proxy",
        },
      },
      cloud: {
        enabled: true,
        apiKey: "cloud-test",
        baseUrl: "https://api.elizacloud.ai/api/v1",
        agentId: "agent-test",
      },
    } as ElizaConfig;

    const changed = ensureProvisionedCloudContainerConfig(config);
    applyCloudConfigToEnv(config);
    const topology = resolveElizaCloudTopology(
      config as Record<string, unknown>,
    );
    const names = collectPluginNames(config);

    expect(changed).toBe(false);
    expect(topology.runtime).toBe("cloud");
    expect(topology.services.inference).toBe(true);
    expect(process.env.ELIZAOS_CLOUD_USE_INFERENCE).toBe("true");
    expect(process.env.SMALL_MODEL).toBe("gemma-4-31b");
    expect(process.env.LARGE_MODEL).toBe("gemma-4-31b");
    expect(names.has("@elizaos/plugin-elizacloud")).toBe(true);
    expect(names.has("@elizaos/plugin-local-inference")).toBe(false);
    expect(infoSpy).toHaveBeenCalledWith(
      "[eliza][cloud-topology] provisioned=true changed=false -> runtime=cloud inference=true",
    );
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

  it("fills missing model pins from config.env when cloud routing already exists", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";

    const config: ElizaConfig = {
      cloud: {
        enabled: true,
        apiKey: "cloud-test",
        agentId: "agent-test",
      },
      deploymentTarget: {
        runtime: "cloud",
        provider: "elizacloud",
      },
      serviceRouting: {
        llmText: {
          backend: "elizacloud",
          transport: "cloud-proxy",
        },
      },
      env: {
        vars: {
          ELIZAOS_CLOUD_SMALL_MODEL: "small-from-config-env",
          ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL: "response-from-config-env",
        },
      },
    } as ElizaConfig;

    const changed = ensureProvisionedCloudContainerConfig(config);

    expect(changed).toBe(true);
    expect(config.serviceRouting?.llmText).toMatchObject({
      backend: "elizacloud",
      transport: "cloud-proxy",
      smallModel: "small-from-config-env",
      responseHandlerModel: "response-from-config-env",
    });

    applyCloudConfigToEnv(config);
    expect(process.env.ELIZAOS_CLOUD_SMALL_MODEL).toBe("small-from-config-env");
    expect(process.env.ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL).toBe(
      "response-from-config-env",
    );
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

  it("keeps effective model pins when managed topology is already canonical", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    process.env.ELIZAOS_CLOUD_LARGE_MODEL = "large-from-env";

    const config: ElizaConfig = {
      deploymentTarget: {
        runtime: "cloud",
        provider: "elizacloud",
      },
      serviceRouting: {
        llmText: {
          backend: "elizacloud",
          transport: "cloud-proxy",
        },
      },
      cloud: {
        enabled: true,
        apiKey: "cloud-test",
        agentId: "agent-test",
      },
      env: {
        vars: {
          ELIZAOS_CLOUD_SMALL_MODEL: "small-from-config-env",
          ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL: "responder-from-config-env",
        },
      },
    } as ElizaConfig;

    applyCloudConfigToEnv(config);

    expect(process.env.ELIZAOS_CLOUD_SMALL_MODEL).toBe("small-from-config-env");
    expect(process.env.SMALL_MODEL).toBe("small-from-config-env");
    expect(process.env.ELIZAOS_CLOUD_LARGE_MODEL).toBe("large-from-env");
    expect(process.env.LARGE_MODEL).toBe("large-from-env");
    expect(process.env.ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL).toBe(
      "responder-from-config-env",
    );
    expect(process.env.ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL).toBe(
      "responder-from-config-env",
    );
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

  it("marks inference explicitly OFF while loading the plugin for media (#10819)", () => {
    // Capability-only topology: an external provider owns the text brain,
    // media is cloud-routed. The plugin must load with the credential intact
    // and an EXPLICIT inference denial, so image generation works without the
    // cloud stealing the chat-brain slots.
    const config: ElizaConfig = {
      cloud: {
        enabled: true,
        apiKey: "cloud-test",
        agentId: "agent-test",
      },
      serviceRouting: {
        media: {
          backend: "elizacloud",
          transport: "cloud-proxy",
        },
      },
    } as ElizaConfig;

    const topology = resolveElizaCloudTopology(
      config as Record<string, unknown>,
    );
    expect(topology.services.inference).toBe(false);
    expect(topology.services.media).toBe(true);
    expect(topology.shouldLoadPlugin).toBe(true);

    applyCloudConfigToEnv(config);

    // Tri-state contract with plugin-elizacloud's registerTextInferenceModels:
    // explicit "false" (not unset) → skip chat-brain handlers, keep IMAGE/TTS.
    expect(process.env.ELIZAOS_CLOUD_USE_INFERENCE).toBe("false");
    expect(process.env.ELIZAOS_CLOUD_USE_MEDIA).toBe("true");
    // The credential survives for the selected capabilities…
    expect(process.env.ELIZAOS_CLOUD_API_KEY).toBe("cloud-test");
    // …without flipping the inference-coupled ENABLED flag.
    expect(process.env.ELIZAOS_CLOUD_ENABLED).toBeUndefined();
  });

  it("keeps an env-provided key when config carries none but cloud services are selected (#10819)", () => {
    process.env.ELIZAOS_CLOUD_API_KEY = "env-key";
    const config: ElizaConfig = {
      cloud: { enabled: true, agentId: "agent-test" },
      serviceRouting: {
        media: { backend: "elizacloud", transport: "cloud-proxy" },
      },
    } as ElizaConfig;

    applyCloudConfigToEnv(config);

    expect(process.env.ELIZAOS_CLOUD_API_KEY).toBe("env-key");
    expect(process.env.ELIZAOS_CLOUD_USE_INFERENCE).toBe("false");
  });

  it("still scrubs a leaked [REDACTED] placeholder from the env (#10819)", () => {
    process.env.ELIZAOS_CLOUD_API_KEY = "[REDACTED]";
    const config: ElizaConfig = {
      cloud: { enabled: true, agentId: "agent-test" },
      serviceRouting: {
        media: { backend: "elizacloud", transport: "cloud-proxy" },
      },
    } as ElizaConfig;

    applyCloudConfigToEnv(config);

    expect(process.env.ELIZAOS_CLOUD_API_KEY).toBeUndefined();
  });

  it("still clears a stale env key when cloud is disabled with no service selected", () => {
    // BYOK / disconnected hygiene must survive the capability-only change:
    // cloud present-but-disabled and nothing routed → full env cleanse, so a
    // leftover key can never zombie-load cloud behavior.
    process.env.ELIZAOS_CLOUD_API_KEY = "stale-key";
    const config: ElizaConfig = {
      cloud: { enabled: false, apiKey: "stale-key" },
    } as ElizaConfig;

    applyCloudConfigToEnv(config);

    expect(process.env.ELIZAOS_CLOUD_API_KEY).toBeUndefined();
    expect(process.env.ELIZAOS_CLOUD_USE_INFERENCE).toBeUndefined();
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

describe("stale vault/config key clobber guard (#11038)", () => {
  const cloudConfig = (apiKey: string): ElizaConfig =>
    ({
      cloud: {
        enabled: true,
        apiKey,
        connection: { provider: "eliza-cloud" },
      },
    }) as unknown as ElizaConfig;

  it("warns with fingerprints when the config key differs from a non-empty env key (config still wins)", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    process.env.ELIZAOS_CLOUD_API_KEY =
      "eliza_real_key_0123456789012345678901234567890123456789012345678901234567890123";
    const placeholder = "eliza_test_placeholder_0123456";

    applyCloudConfigToEnv(cloudConfig(placeholder));

    // The config/vault value wins (documented behavior)…
    expect(process.env.ELIZAOS_CLOUD_API_KEY).toBe(placeholder);
    // …but the override is loudly fingerprinted so 401s are diagnosable.
    const msg = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(msg).toContain("differs from process.env.ELIZAOS_CLOUD_API_KEY");
    // Fingerprints of both keys (first-6 + computed length), never the secret.
    expect(msg).toContain(`eliza_…(len ${placeholder.length})`);
    expect(msg).toContain("(len 79)");
    expect(msg).toContain("#11038");
    // Never the full secret.
    expect(msg).not.toContain("0123456789012345678901234567890123456789");
    warn.mockRestore();
  });

  it("does not warn when config and env agree", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    process.env.ELIZAOS_CLOUD_API_KEY =
      "eliza_same_key_012345678901234567890123456789";
    applyCloudConfigToEnv(
      cloudConfig("eliza_same_key_012345678901234567890123456789"),
    );
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes("differs from")),
    ).toBe(false);
    warn.mockRestore();
  });

  it("does not warn when there is no env key to clobber", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    delete process.env.ELIZAOS_CLOUD_API_KEY;
    applyCloudConfigToEnv(cloudConfig("eliza_fresh_key_01234567890123456789"));
    expect(process.env.ELIZAOS_CLOUD_API_KEY).toBe(
      "eliza_fresh_key_01234567890123456789",
    );
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes("differs from")),
    ).toBe(false);
    warn.mockRestore();
  });

  it("fingerprints keys without leaking them", () => {
    expect(cloudApiKeyFingerprint(undefined)).toBe("(none)");
    expect(cloudApiKeyFingerprint("  ")).toBe("(none)");
    expect(cloudApiKeyFingerprint("eliza_abcdef123456")).toBe(
      "eliza_…(len 18)",
    );
  });
});
