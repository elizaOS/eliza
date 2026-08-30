/**
 * Unit coverage for cloud-provisioned runtime configuration in eliza.ts:
 * applyCloudConfigToEnv wiring cloud embeddings/inference into the environment
 * (#8769), provisioned-container topology resolution (#9887), and the guard
 * that prevents stale vault/config keys from clobbering live cloud settings
 * (#11038). Asserts env mutations directly; no live cloud calls.
 */
import { type IAgentRuntime, logger } from "@elizaos/core";
import { registerTextInferenceModels } from "@elizaos/plugin-elizacloud";
import { resolveElizaCloudTopology } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ElizaConfig } from "../config/config.ts";
import {
  captureDevCloudEnvAuthority,
  createDevCloudConfigAuthorityView,
  createDevCloudRuntimeSettingsAuthorityOverlay,
  DEV_CLOUD_ENV_AUTHORITY_KEY,
  type DEV_CLOUD_ENV_OWNED_KEYS,
  DEV_CLOUD_ENV_RESTORE_KEYS,
  mergeDevCloudConfigAuthorityMutation,
  resetDevCloudEnvAuthorityForTests,
  resolveDevCloudEnvAuthority,
} from "../config/dev-cloud-env-authority.ts";
import {
  applyCloudConfigToEnv,
  cloudApiKeyFingerprint,
  ensureProvisionedCloudContainerConfig,
  hydrateConfigEnvForBoot,
  resolveConfigEnvVaultRefsForBoot,
  resolveEmbeddingProviderPluginName,
  resolveRuntimeProviderName,
  shouldStartElizaCloudThinClient,
} from "./eliza.ts";
import {
  _resetAgentHostBridge,
  defaultAgentHostBridge,
  setAgentHostBridge,
} from "./host-bridge.ts";
import { collectPluginNames } from "./plugin-collector.ts";

// applyCloudConfigToEnv keeps inference cloud-routed for provisioned containers,
// while embeddings stay on the explicitly selected provider so the runtime does
// not silently steal the recall hot path.
const ENV_KEYS: readonly string[] = [
  ...DEV_CLOUD_ENV_RESTORE_KEYS,
  "ELIZA_DEV_SOURCE",
  DEV_CLOUD_ENV_AUTHORITY_KEY,
  "ELIZA_DESKTOP_PACKAGED_RUNTIME",
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
  "CEREBRAS_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_SMALL_MODEL",
  "OPENAI_LARGE_MODEL",
  "NANO_MODEL",
  "SMALL_MODEL",
  "MEDIUM_MODEL",
  "LARGE_MODEL",
  "MEGA_MODEL",
];

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  resetDevCloudEnvAuthorityForTests();
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  _resetAgentHostBridge();
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetDevCloudEnvAuthorityForTests();
});

function hostilePersistedCloudConfig(): ElizaConfig {
  const cloudRoute = {
    backend: "elizacloud",
    transport: "cloud-proxy",
    accountId: "elizacloud",
  } as const;
  return {
    cloud: {
      enabled: true,
      provider: "elizacloud",
      runtime: "cloud",
      inferenceMode: "cloud",
      services: {
        inference: true,
        tts: true,
        media: true,
        embeddings: true,
        rpc: true,
      },
      apiKey: "persisted-production-key",
      serviceKey: "persisted-production-service-key",
      baseUrl: "https://api.eliza.app/api/v1",
      agentId: "persisted-production-agent",
    },
    deploymentTarget: { runtime: "cloud", provider: "elizacloud" },
    linkedAccounts: {
      elizacloud: { status: "linked", source: "api-key" },
    },
    serviceRouting: {
      llmText: { ...cloudRoute },
      tts: { ...cloudRoute },
      media: { ...cloudRoute },
      embeddings: { ...cloudRoute },
      rpc: { ...cloudRoute },
    },
    env: {
      ELIZAOS_CLOUD_API_KEY: "persisted-top-level-key",
      ELIZAOS_CLOUD_BASE_URL: "https://api.eliza.app/api/v1",
      ELIZAOS_CLOUD_EMBEDDING_API_KEY: "persisted-embedding-key",
      ELIZAOS_CLOUD_EMBEDDING_URL: "https://api.eliza.app/api/v1/embeddings",
      ELIZA_CLOUD_API_BASE_URL: "https://api.eliza.app/api/v1",
      ELIZA_CLOUD_AUTH_TOKEN: "persisted-cloud-auth-token",
      SMALL_MODEL: "persisted-direct-small-model",
      vars: {
        ELIZAOS_CLOUD_API_KEY: "persisted-nested-key",
        ELIZAOS_CLOUD_BASE_URL: "https://api.eliza.app/api/v1",
        ELIZAOS_CLOUD_ENABLED: "true",
        ELIZAOS_CLOUD_USE_INFERENCE: "true",
      },
    },
    plugins: {
      allow: ["elizacloud"],
      entries: { elizacloud: { enabled: true } },
    },
    agents: {
      list: [
        {
          name: "Persisted Agent",
          settings: {
            ELIZAOS_CLOUD_API_KEY: "persisted-agent-production-key",
            ELIZAOS_CLOUD_BASE_URL: "https://api.eliza.app/api/v1",
            KEEP_AGENT_SETTING: "preserved",
            secrets: {
              ELIZAOS_CLOUD_SERVICE_KEY:
                "persisted-agent-production-service-key",
              KEEP_AGENT_SECRET: "preserved",
            },
          },
        },
      ],
    },
  } as unknown as ElizaConfig;
}

function setDevCloudAuthority(
  authority:
    | "staging-default"
    | "staging-explicit"
    | "production"
    | "offline"
    | "self-hosted",
  values: Partial<Record<(typeof DEV_CLOUD_ENV_OWNED_KEYS)[number], string>>,
): void {
  for (const key of DEV_CLOUD_ENV_RESTORE_KEYS) delete process.env[key];
  process.env.ELIZA_DEV_SOURCE = "1";
  process.env[DEV_CLOUD_ENV_AUTHORITY_KEY] = authority;
  for (const [key, value] of Object.entries(values)) {
    process.env[key] = value;
  }
}

function snapshotOwnedDevCloudEnv(): Record<string, string | undefined> {
  return Object.fromEntries(
    DEV_CLOUD_ENV_RESTORE_KEYS.map((key) => [key, process.env[key]]),
  );
}

describe("launcher-owned local development Cloud policy", () => {
  it("builds a non-persisted default-staging runtime view", () => {
    setDevCloudAuthority("staging-default", {
      ELIZAOS_CLOUD_BASE_URL: "https://api-staging.eliza.app/api/v1",
      ELIZAOS_CLOUD_API_KEY: "",
      ELIZAOS_CLOUD_ENABLED: "",
      ELIZA_CLOUD_PROVISIONED: "",
      ELIZA_CLOUD_AGENT_ID: "",
      ELIZAOS_CLOUD_USE_INFERENCE: "",
    });
    const persisted = hostilePersistedCloudConfig();
    const original = structuredClone(persisted);

    const view = createDevCloudConfigAuthorityView(persisted);

    expect(view).not.toBe(persisted);
    expect(persisted).toEqual(original);
    expect(view.deploymentTarget).toEqual({ runtime: "local" });
    expect(view.linkedAccounts?.elizacloud).toBeUndefined();
    expect(view.serviceRouting).toBeUndefined();
    expect(view.cloud).toMatchObject({
      enabled: false,
      baseUrl: "https://api-staging.eliza.app/api/v1",
    });
    expect(view.cloud?.apiKey).toBe("");
    expect((view.cloud as Record<string, unknown>)?.serviceKey).toBeUndefined();
    expect(view.cloud?.agentId).toBeUndefined();
    expect(view.env?.ELIZAOS_CLOUD_API_KEY).toBeUndefined();
    expect(view.env?.vars?.ELIZAOS_CLOUD_API_KEY).toBeUndefined();
    expect(view.env?.ELIZAOS_CLOUD_EMBEDDING_API_KEY).toBeUndefined();
    expect(view.env?.ELIZAOS_CLOUD_EMBEDDING_URL).toBeUndefined();
    expect(view.env?.ELIZA_CLOUD_API_BASE_URL).toBeUndefined();
    expect(view.env?.ELIZA_CLOUD_AUTH_TOKEN).toBeUndefined();
    expect(view.env?.SMALL_MODEL).toBe("persisted-direct-small-model");
    const agentSettings = view.agents?.list?.[0]?.settings as
      | Record<string, unknown>
      | undefined;
    expect(agentSettings?.ELIZAOS_CLOUD_API_KEY).toBeUndefined();
    expect(agentSettings?.ELIZAOS_CLOUD_BASE_URL).toBeUndefined();
    expect(agentSettings?.KEEP_AGENT_SETTING).toBe("preserved");
    expect(
      (agentSettings?.secrets as Record<string, unknown> | undefined)
        ?.ELIZAOS_CLOUD_SERVICE_KEY,
    ).toBeUndefined();
    expect(
      (agentSettings?.secrets as Record<string, unknown> | undefined)
        ?.KEEP_AGENT_SECRET,
    ).toBe("preserved");
    expect(shouldStartElizaCloudThinClient(view)).toBe(false);
    expect(shouldStartElizaCloudThinClient(persisted)).toBe(true);
  });

  it("keeps the frozen launch tuple after later process-env pollution", () => {
    setDevCloudAuthority("staging-default", {
      ELIZAOS_CLOUD_BASE_URL: "https://api-staging.eliza.app/api/v1",
      ELIZAOS_CLOUD_API_KEY: "",
      ELIZAOS_CLOUD_SERVICE_KEY: "",
    });
    createDevCloudConfigAuthorityView(hostilePersistedCloudConfig());

    process.env.ELIZA_DEV_SOURCE = "0";
    process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "production";
    process.env.ELIZA_DEV_CLOUD_TARGET = "production";
    process.env.ELIZAOS_CLOUD_BASE_URL = "https://api.eliza.app/api/v1";
    process.env.ELIZAOS_CLOUD_API_KEY = "late-production-key";
    process.env.ELIZAOS_CLOUD_SERVICE_KEY = "late-production-service-key";
    const config = hostilePersistedCloudConfig();
    applyCloudConfigToEnv(config);

    expect(config.cloud).toMatchObject({
      enabled: false,
      baseUrl: "https://api-staging.eliza.app/api/v1",
      apiKey: "",
    });
    expect(process.env.ELIZAOS_CLOUD_BASE_URL).toBe(
      "https://api-staging.eliza.app/api/v1",
    );
    expect(process.env.ELIZAOS_CLOUD_API_KEY).toBe("");
    expect(process.env.ELIZAOS_CLOUD_SERVICE_KEY).toBe("");
    expect(process.env.ELIZA_DEV_SOURCE).toBe("1");
    expect(process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY).toBe("staging-default");
    expect(process.env.ELIZA_DEV_CLOUD_TARGET).toBeUndefined();
  });

  it("projects exact launch values over DB-backed runtime settings", () => {
    setDevCloudAuthority("staging-default", {
      ELIZAOS_CLOUD_BASE_URL: "https://api-staging.eliza.app/api/v1",
      ELIZAOS_CLOUD_API_KEY: "",
    });

    const overlay = createDevCloudRuntimeSettingsAuthorityOverlay();

    expect(overlay).toMatchObject({
      ELIZAOS_CLOUD_BASE_URL: "https://api-staging.eliza.app/api/v1",
      ELIZAOS_CLOUD_API_KEY: "",
      ELIZAOS_CLOUD_SERVICE_KEY: "",
      ELIZA_CLOUD_SERVICE_KEY: "",
      ELIZA_CLOUD_WRITE_BASE_URL: "",
      ELIZA_CLOUD_URL: "",
    });
  });

  it("preserves direct non-text capability routes while removing stale Cloud routes", () => {
    setDevCloudAuthority("staging-default", {
      ELIZAOS_CLOUD_BASE_URL: "https://api-staging.eliza.app/api/v1",
      ELIZAOS_CLOUD_API_KEY: "",
    });
    const persisted = hostilePersistedCloudConfig();
    persisted.serviceRouting = {
      ...persisted.serviceRouting,
      embeddings: { backend: "openai", transport: "direct" },
      tts: { backend: "elevenlabs", transport: "direct" },
    };

    const view = createDevCloudConfigAuthorityView(persisted);

    expect(view.serviceRouting?.llmText).toBeUndefined();
    expect(view.serviceRouting?.embeddings).toMatchObject({
      backend: "openai",
      transport: "direct",
    });
    expect(view.serviceRouting?.tts).toMatchObject({
      backend: "elevenlabs",
      transport: "direct",
    });
    expect(view.env?.SMALL_MODEL).toBe("persisted-direct-small-model");
  });

  it("applies only route mutations back onto the untouched durable config", () => {
    setDevCloudAuthority("staging-default", {
      ELIZAOS_CLOUD_BASE_URL: "https://api-staging.eliza.app/api/v1",
      ELIZAOS_CLOUD_API_KEY: "",
    });
    const durable = hostilePersistedCloudConfig();
    const before = createDevCloudConfigAuthorityView(durable);
    const after = structuredClone(before);
    after.wallet = {
      ...(after.wallet ?? {}),
      cloud: {
        ...(after.wallet?.cloud ?? {}),
        evm: { address: "0x1234567890123456789012345678901234567890" },
      },
    };

    const merged = mergeDevCloudConfigAuthorityMutation(durable, before, after);

    expect(merged.cloud).toEqual(durable.cloud);
    expect(merged.deploymentTarget).toEqual(durable.deploymentTarget);
    expect(merged.wallet?.cloud?.evm?.address).toBe(
      "0x1234567890123456789012345678901234567890",
    );
  });

  it.each(["staging-default", "offline"] as const)(
    "%s cannot be reactivated by persisted config or plugin entries",
    (authority) => {
      setDevCloudAuthority(authority, {
        ELIZAOS_CLOUD_BASE_URL: "https://api-staging.eliza.app/api/v1",
        ELIZAOS_CLOUD_API_KEY: "",
        ELIZAOS_CLOUD_ENABLED: "",
        ELIZA_CLOUD_PROVISIONED: "",
        ELIZA_CLOUD_AGENT_ID: "",
        ELIZAOS_CLOUD_USE_INFERENCE: "",
        ELIZAOS_CLOUD_USE_TTS: "",
        ELIZAOS_CLOUD_USE_STT: "",
        ELIZAOS_CLOUD_USE_MEDIA: "",
        ELIZAOS_CLOUD_USE_EMBEDDINGS: "",
        ELIZAOS_CLOUD_USE_RPC: "",
      });
      const frozen = captureDevCloudEnvAuthority();
      expect(frozen).not.toBeNull();
      const expectedEnv = Object.fromEntries(
        DEV_CLOUD_ENV_RESTORE_KEYS.map((key) => [key, frozen?.values[key]]),
      );
      const config = hostilePersistedCloudConfig();

      applyCloudConfigToEnv(config);

      expect(snapshotOwnedDevCloudEnv()).toEqual(expectedEnv);
      expect(config.cloud).toMatchObject({
        enabled: false,
        baseUrl: "https://api-staging.eliza.app/api/v1",
      });
      expect(config.cloud?.apiKey).toBe("");
      expect(config.serviceRouting).toBeUndefined();
      expect(
        collectPluginNames(config, undefined, [
          "@elizaos/plugin-elizacloud",
        ]).has("@elizaos/plugin-elizacloud"),
      ).toBe(false);
    },
  );

  it.each(["staging-default", "offline"] as const)(
    "%s ignores late container and Cloud activation pollution across all surfaces",
    (authority) => {
      setDevCloudAuthority(authority, {
        ELIZAOS_CLOUD_BASE_URL: "https://api-staging.eliza.app/api/v1",
        ELIZAOS_CLOUD_API_KEY: "",
        ELIZAOS_CLOUD_ENABLED: "",
        ELIZA_CLOUD_PROVISIONED: "",
        ELIZAOS_CLOUD_USE_INFERENCE: "",
        ELIZAOS_CLOUD_USE_EMBEDDINGS: "",
      });
      captureDevCloudEnvAuthority();

      process.env.ELIZAOS_CLOUD_API_KEY = "late-production-key";
      process.env.ELIZAOS_CLOUD_ENABLED = "true";
      process.env.ELIZA_CLOUD_PROVISIONED = "1";
      process.env.ELIZAOS_CLOUD_USE_INFERENCE = "true";
      process.env.ELIZAOS_CLOUD_USE_EMBEDDINGS = "true";

      const names = collectPluginNames(
        hostilePersistedCloudConfig(),
        undefined,
        ["@elizaos/plugin-elizacloud"],
      );

      expect(names.has("@elizaos/plugin-elizacloud")).toBe(false);
      expect(names.has("agent-orchestrator")).toBe(false);
      expect(names.has("@elizaos/plugin-pty")).toBe(false);
      expect(names.has("@elizaos/plugin-cli-inference")).toBe(false);
      expect(names.has("@elizaos/plugin-local-inference")).toBe(true);
    },
  );

  it.each([
    ["staging-explicit", "https://api-staging.eliza.app/api/v1"],
    ["self-hosted", "https://api.private.example/api/v1"],
  ] as const)(
    "%s keeps the frozen capability-only plugin set after late activation pollution",
    (authority, baseUrl) => {
      setDevCloudAuthority(authority, {
        ELIZAOS_CLOUD_BASE_URL: baseUrl,
        ELIZAOS_CLOUD_API_KEY: "launcher-key",
        ELIZAOS_CLOUD_ENABLED: "true",
        ELIZA_CLOUD_PROVISIONED: "",
        ELIZAOS_CLOUD_USE_INFERENCE: "false",
      });
      process.env.OPENAI_API_KEY = "direct-provider-key";
      captureDevCloudEnvAuthority();

      process.env.ELIZAOS_CLOUD_API_KEY = "late-production-key";
      process.env.ELIZA_CLOUD_PROVISIONED = "1";
      process.env.ELIZAOS_CLOUD_USE_INFERENCE = "true";

      const names = collectPluginNames(
        hostilePersistedCloudConfig(),
        undefined,
        ["@elizaos/plugin-openai"],
      );

      expect(names.has("@elizaos/plugin-elizacloud")).toBe(true);
      expect(names.has("@elizaos/plugin-openai")).toBe(true);
      expect(names.has("agent-orchestrator")).toBe(false);
      expect(names.has("@elizaos/plugin-pty")).toBe(false);
      expect(names.has("@elizaos/plugin-cli-inference")).toBe(false);
    },
  );

  it.each([
    [
      "staging-explicit",
      "https://api-staging.eliza.app/api/v1",
      "staging-launch-key",
      "staging-agent",
    ],
    [
      "production",
      "https://api.eliza.app/api/v1",
      "production-launch-key",
      "production-agent",
    ],
    [
      "self-hosted",
      "https://api.private.example/api/v1",
      "private-launch-key",
      "private-agent",
    ],
  ] as const)(
    "%s keeps only launch-time Cloud identity and matches inference ownership",
    (authority, baseUrl, apiKey, agentId) => {
      setDevCloudAuthority(authority, {
        ELIZAOS_CLOUD_BASE_URL: baseUrl,
        ELIZAOS_CLOUD_API_KEY: apiKey,
        ELIZAOS_CLOUD_ENABLED: "true",
        ELIZA_CLOUD_AGENT_ID: agentId,
      });
      process.env.OPENAI_API_KEY = "direct-provider-key";
      const frozen = captureDevCloudEnvAuthority();
      expect(frozen).not.toBeNull();
      const expectedEnv = Object.fromEntries(
        DEV_CLOUD_ENV_RESTORE_KEYS.map((key) => [key, frozen?.values[key]]),
      );
      const config = hostilePersistedCloudConfig();

      applyCloudConfigToEnv(config);

      expect(snapshotOwnedDevCloudEnv()).toEqual(expectedEnv);
      expect(config.cloud).toMatchObject({
        enabled: true,
        baseUrl,
        apiKey,
        agentId,
      });
      expect(config.serviceRouting).toBeUndefined();
      const names = collectPluginNames(config, undefined, [
        "@elizaos/plugin-openai",
      ]);
      expect(names.has("@elizaos/plugin-elizacloud")).toBe(true);
      // plugin-elizacloud owns text when USE_INFERENCE is unset; direct model
      // providers must not be left loaded under a higher-priority Cloud brain.
      expect(names.has("@elizaos/plugin-openai")).toBe(false);
    },
  );

  it("keeps direct providers when explicit Cloud is capability-only", () => {
    setDevCloudAuthority("staging-explicit", {
      ELIZAOS_CLOUD_BASE_URL: "https://api-staging.eliza.app/api/v1",
      ELIZAOS_CLOUD_API_KEY: "staging-launch-key",
      ELIZAOS_CLOUD_USE_INFERENCE: "false",
    });
    process.env.OPENAI_API_KEY = "direct-provider-key";

    const names = collectPluginNames(hostilePersistedCloudConfig(), undefined, [
      "@elizaos/plugin-openai",
    ]);

    expect(names.has("@elizaos/plugin-elizacloud")).toBe(true);
    expect(names.has("@elizaos/plugin-openai")).toBe(true);
  });

  it("keeps an explicit direct text route unless launch policy selects Cloud inference", () => {
    setDevCloudAuthority("staging-explicit", {
      ELIZAOS_CLOUD_BASE_URL: "https://api-staging.eliza.app/api/v1",
      ELIZAOS_CLOUD_API_KEY: "staging-launch-key",
      ELIZAOS_CLOUD_USE_INFERENCE: "",
    });
    process.env.OPENAI_API_KEY = "direct-provider-key";
    const config = hostilePersistedCloudConfig();
    config.serviceRouting = {
      llmText: { backend: "openai", transport: "direct" },
      embeddings: { backend: "openai", transport: "direct" },
    };

    const view = createDevCloudConfigAuthorityView(config);
    const names = collectPluginNames(view, undefined, [
      "@elizaos/plugin-openai",
    ]);
    const settings = createDevCloudRuntimeSettingsAuthorityOverlay(
      process.env,
      view,
    );
    const registered: string[] = [];
    registerTextInferenceModels({
      getSetting: (key: string) => settings[key],
      registerModel: (modelType: string) => registered.push(modelType),
    } as unknown as IAgentRuntime);

    expect(view.serviceRouting?.llmText?.backend).toBe("openai");
    expect(names.has("@elizaos/plugin-elizacloud")).toBe(true);
    expect(names.has("@elizaos/plugin-openai")).toBe(true);
    expect(settings.ELIZAOS_CLOUD_USE_INFERENCE).toBe("false");
    expect(registered).toEqual([]);
  });

  it("lets explicit Cloud inference replace direct text but retains direct embeddings", () => {
    setDevCloudAuthority("staging-explicit", {
      ELIZAOS_CLOUD_BASE_URL: "https://api-staging.eliza.app/api/v1",
      ELIZAOS_CLOUD_API_KEY: "staging-launch-key",
      ELIZAOS_CLOUD_USE_INFERENCE: "on",
    });
    process.env.OPENAI_API_KEY = "direct-provider-key";
    const config = hostilePersistedCloudConfig();
    config.serviceRouting = {
      llmText: { backend: "openai", transport: "direct" },
      embeddings: { backend: "openai", transport: "direct" },
    };

    const view = createDevCloudConfigAuthorityView(config);
    const names = collectPluginNames(view, undefined, [
      "@elizaos/plugin-openai",
    ]);
    const settings = createDevCloudRuntimeSettingsAuthorityOverlay(
      process.env,
      view,
    );
    const registered: string[] = [];
    registerTextInferenceModels({
      getSetting: (key: string) => settings[key],
      registerModel: (modelType: string) => registered.push(modelType),
    } as unknown as IAgentRuntime);

    expect(view.serviceRouting?.llmText).toBeUndefined();
    expect(view.serviceRouting?.embeddings?.backend).toBe("openai");
    expect(names.has("@elizaos/plugin-elizacloud")).toBe(true);
    expect(names.has("@elizaos/plugin-openai")).toBe(true);
    expect(settings.ELIZAOS_CLOUD_USE_INFERENCE).toBe("on");
    expect(registered.length).toBeGreaterThan(0);
  });

  it("does not load Cloud from an enabled flag without a usable launch credential", () => {
    setDevCloudAuthority("staging-explicit", {
      ELIZAOS_CLOUD_BASE_URL: "https://api-staging.eliza.app/api/v1",
      ELIZAOS_CLOUD_API_KEY: "",
      ELIZAOS_CLOUD_ENABLED: "true",
    });
    process.env.OPENAI_API_KEY = "direct-provider-key";

    const view = createDevCloudConfigAuthorityView(
      hostilePersistedCloudConfig(),
    );
    const names = collectPluginNames(view, undefined, [
      "@elizaos/plugin-openai",
    ]);

    expect(view.cloud?.enabled).toBe(false);
    expect(names.has("@elizaos/plugin-elizacloud")).toBe(false);
    expect(names.has("@elizaos/plugin-openai")).toBe(true);
  });

  it.each([
    "[REDACTED]",
    "vault://ELIZAOS_CLOUD_API_KEY",
    "VAULT://ELIZAOS_CLOUD_API_KEY",
  ])(
    "does not activate explicit Cloud from an unusable %s credential",
    (apiKey) => {
      setDevCloudAuthority("production", {
        ELIZAOS_CLOUD_BASE_URL: "https://api.eliza.app/api/v1",
        ELIZAOS_CLOUD_API_KEY: apiKey,
      });

      const view = createDevCloudConfigAuthorityView(
        hostilePersistedCloudConfig(),
      );

      expect(view.cloud?.enabled).toBe(false);
      expect(view.cloud?.apiKey).toBe("");
      expect(collectPluginNames(view).has("@elizaos/plugin-elizacloud")).toBe(
        false,
      );
    },
  );

  it("does not activate production authority from a staging-specific credential", () => {
    setDevCloudAuthority("production", {
      ELIZAOS_CLOUD_BASE_URL: "https://api.eliza.app/api/v1",
      ELIZA_DEV_CLOUD_API_KEY: "staging-specific-key",
    });

    const view = createDevCloudConfigAuthorityView(
      hostilePersistedCloudConfig(),
    );

    expect(view.cloud?.enabled).toBe(false);
    expect(view.cloud?.apiKey).toBe("");
    expect(collectPluginNames(view).has("@elizaos/plugin-elizacloud")).toBe(
      false,
    );
  });

  it.each([
    ["staging-explicit", "https://api-staging.eliza.app/api/v1"],
    ["self-hosted", "https://api.private.example/api/v1"],
  ] as const)(
    "%s authority may consume its target-scoped development credential",
    (authority, baseUrl) => {
      setDevCloudAuthority(authority, {
        ELIZAOS_CLOUD_BASE_URL: baseUrl,
        ELIZA_DEV_CLOUD_API_KEY: "target-scoped-key",
      });

      const view = createDevCloudConfigAuthorityView(
        hostilePersistedCloudConfig(),
      );

      expect(view.cloud).toMatchObject({
        enabled: true,
        apiKey: "target-scoped-key",
        baseUrl,
      });
    },
  );

  it("does not activate a packaged runtime from a staging-specific credential", () => {
    setDevCloudAuthority("staging-explicit", {
      ELIZAOS_CLOUD_BASE_URL: "https://api-staging.eliza.app/api/v1",
      ELIZA_DEV_CLOUD_API_KEY: "staging-specific-key",
    });
    process.env.ELIZA_DESKTOP_PACKAGED_RUNTIME = "1";

    const view = createDevCloudConfigAuthorityView(
      hostilePersistedCloudConfig(),
    );

    expect(view.cloud?.enabled).toBe(false);
    expect(view.cloud?.apiKey).toBe("");
    expect(collectPluginNames(view).has("@elizaos/plugin-elizacloud")).toBe(
      false,
    );
  });

  it("ignores an authority marker that was not stamped by a dev launcher", () => {
    process.env[DEV_CLOUD_ENV_AUTHORITY_KEY] = "staging-default";
    process.env.ELIZAOS_CLOUD_BASE_URL = "https://api-staging.eliza.app/api/v1";
    const config = hostilePersistedCloudConfig();

    applyCloudConfigToEnv(config);

    expect(config.cloud?.apiKey).toBe("persisted-production-key");
    expect(process.env.ELIZAOS_CLOUD_API_KEY).toBe("persisted-production-key");
    expect(process.env.ELIZAOS_CLOUD_BASE_URL).toBe(
      "https://api.eliza.app/api/v1",
    );
  });

  it("cannot hydrate forged launcher authority from persisted config env", () => {
    const targetEnv: NodeJS.ProcessEnv = {};
    hydrateConfigEnvForBoot(
      {
        env: {
          ELIZA_DEV_SOURCE: "1",
          ELIZA_DEV_CLOUD_ENV_AUTHORITY: "staging-default",
          vars: {
            ELIZA_DEV_CLOUD_TARGET: "production",
            ELIZAOS_CLOUD_API_KEY: "persisted-production-key",
            OPENAI_API_KEY: "preserved-direct-provider-key",
          },
        },
      },
      targetEnv,
    );

    expect(targetEnv.ELIZA_DEV_SOURCE).toBeUndefined();
    expect(targetEnv.ELIZA_DEV_CLOUD_ENV_AUTHORITY).toBeUndefined();
    expect(targetEnv.ELIZA_DEV_CLOUD_TARGET).toBeUndefined();
    expect(targetEnv.ELIZAOS_CLOUD_API_KEY).toBeUndefined();
    expect(targetEnv.OPENAI_API_KEY).toBe("preserved-direct-provider-key");
    expect(resolveDevCloudEnvAuthority(targetEnv)).toBeNull();
  });
});

describe("applyCloudConfigToEnv cloud-container embeddings (#8769)", () => {
  it("defaults app-hosted embeddings to local and clears the disabled flag", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    // A stale disabled flag must be cleared, not left to poison a later explicit
    // cloud embedding opt-in.
    process.env.ELIZA_CLOUD_EMBEDDINGS_DISABLED = "true";

    applyCloudConfigToEnv({} as ElizaConfig);

    expect(process.env.ELIZAOS_CLOUD_USE_EMBEDDINGS).toBe("false");
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

describe("unsigned Cloud inference fallback (#20045)", () => {
  it("keeps Cloud chat handlers unregistered until a credential can serve them", () => {
    const config: ElizaConfig = {
      serviceRouting: {
        llmText: {
          backend: "elizacloud",
          transport: "cloud-proxy",
        },
      },
    } as ElizaConfig;

    applyCloudConfigToEnv(config);

    const registered: string[] = [];
    const runtime = {
      getSetting: (key: string) => process.env[key],
      registerModel: (modelType: string) => registered.push(modelType),
    } as unknown as IAgentRuntime;
    registerTextInferenceModels(runtime);

    expect(process.env.ELIZAOS_CLOUD_API_KEY).toBeUndefined();
    expect(process.env.ELIZAOS_CLOUD_USE_INFERENCE).toBe("false");
    expect(process.env.ELIZAOS_CLOUD_ENABLED).toBe("true");
    expect(registered).toEqual([]);
  });

  it("enables Cloud inference when config.env provides the usable credential", () => {
    const config: ElizaConfig = {
      serviceRouting: {
        llmText: {
          backend: "elizacloud",
          transport: "cloud-proxy",
        },
      },
      env: { vars: { ELIZAOS_CLOUD_API_KEY: "cloud-test" } },
    } as ElizaConfig;

    applyCloudConfigToEnv(config);

    expect(process.env.ELIZAOS_CLOUD_API_KEY).toBe("cloud-test");
    expect(process.env.ELIZAOS_CLOUD_USE_INFERENCE).toBe("true");
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

  it("preserves an explicit managed local-Docker Cerebras text route", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    process.env.ELIZAOS_CLOUD_USE_INFERENCE = "false";
    process.env.CEREBRAS_API_KEY = "csk-test";
    process.env.OPENAI_SMALL_MODEL = "gemma-4-31b";
    process.env.OPENAI_LARGE_MODEL = "gemma-4-31b";

    const config: ElizaConfig = {
      cloud: { apiKey: "cloud-test", agentId: "agent-test" },
    } as ElizaConfig;

    expect(ensureProvisionedCloudContainerConfig(config)).toBe(true);
    expect(config.deploymentTarget).toEqual({
      runtime: "local",
    });
    expect(config.serviceRouting?.llmText).toEqual({
      backend: "cerebras",
      transport: "direct",
      smallModel: "gemma-4-31b",
      largeModel: "gemma-4-31b",
    });
    expect(
      resolveElizaCloudTopology(config as Record<string, unknown>).services
        .inference,
    ).toBe(false);
    expect(collectPluginNames(config).has("@elizaos/plugin-openai")).toBe(true);
    expect(collectPluginNames(config).has("@elizaos/plugin-elizacloud")).toBe(
      true,
    );

    applyCloudConfigToEnv(config);
    expect(process.env.ELIZAOS_CLOUD_USE_INFERENCE).toBe("false");
    expect(config.deploymentTarget).toEqual({
      runtime: "local",
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

  it("disables cloud embeddings when canonical routing omits the capability", () => {
    process.env.ELIZAOS_CLOUD_USE_EMBEDDINGS = "true";
    const config: ElizaConfig = {
      cloud: { enabled: true, apiKey: "cloud-test" },
      serviceRouting: {
        media: { backend: "elizacloud", transport: "cloud-proxy" },
      },
    } as ElizaConfig;

    applyCloudConfigToEnv(config);

    expect(process.env.ELIZAOS_CLOUD_USE_EMBEDDINGS).toBe("false");
  });

  it("lets an explicit cloud embedding route override a stale false flag", () => {
    process.env.ELIZAOS_CLOUD_USE_EMBEDDINGS = "false";
    const config: ElizaConfig = {
      cloud: { enabled: true, apiKey: "cloud-test" },
      serviceRouting: {
        embeddings: { backend: "elizacloud", transport: "cloud-proxy" },
      },
    } as ElizaConfig;

    applyCloudConfigToEnv(config);

    expect(process.env.ELIZAOS_CLOUD_USE_EMBEDDINGS).toBe("true");
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

  it("honors canonical capability routes without a legacy cloud block", () => {
    process.env.ELIZAOS_CLOUD_API_KEY = "env-key";
    process.env.ELIZAOS_CLOUD_BASE_URL = "https://staging.example.test/api/v1";

    const config: ElizaConfig = {
      deploymentTarget: {
        runtime: "cloud",
        provider: "elizacloud",
      },
      serviceRouting: {
        llmText: {
          backend: "cerebras",
          transport: "direct",
        },
        media: {
          backend: "elizacloud",
          transport: "cloud-proxy",
        },
        embeddings: {
          backend: "local-inference",
          transport: "direct",
        },
      },
    } as ElizaConfig;

    applyCloudConfigToEnv(config);

    expect(process.env.ELIZAOS_CLOUD_USE_INFERENCE).toBe("false");
    expect(process.env.ELIZAOS_CLOUD_USE_MEDIA).toBe("true");
    expect(process.env.ELIZAOS_CLOUD_USE_EMBEDDINGS).toBe("false");
    expect(process.env.ELIZAOS_CLOUD_ENABLED).toBeUndefined();
    expect(process.env.ELIZAOS_CLOUD_API_KEY).toBe("env-key");
    expect(process.env.ELIZAOS_CLOUD_BASE_URL).toBe(
      "https://staging.example.test/api/v1",
    );
  });

  it("hydrates canonical Cloud credentials from config.env without a legacy cloud block", () => {
    const config: ElizaConfig = {
      deploymentTarget: {
        runtime: "cloud",
        provider: "elizacloud",
      },
      serviceRouting: {
        llmText: {
          backend: "cerebras",
          transport: "direct",
        },
        media: {
          backend: "elizacloud",
          transport: "cloud-proxy",
        },
      },
      env: {
        vars: {
          ELIZAOS_CLOUD_API_KEY: "config-env-key",
          ELIZAOS_CLOUD_BASE_URL: "https://config.example.test/api/v1",
        },
      },
    } as ElizaConfig;

    applyCloudConfigToEnv(config);

    expect(process.env.ELIZAOS_CLOUD_API_KEY).toBe("config-env-key");
    expect(process.env.ELIZAOS_CLOUD_BASE_URL).toBe(
      "https://config.example.test/api/v1",
    );
    expect(process.env.ELIZAOS_CLOUD_USE_INFERENCE).toBe("false");
    expect(process.env.ELIZAOS_CLOUD_USE_MEDIA).toBe("true");
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

  it("never projects unresolved vault references as cloud credentials", () => {
    const config: ElizaConfig = {
      cloud: { enabled: true, apiKey: "vault://ELIZAOS_CLOUD_API_KEY" },
      serviceRouting: {
        media: { backend: "elizacloud", transport: "cloud-proxy" },
      },
      env: {
        vars: { ELIZAOS_CLOUD_API_KEY: "vault://ELIZAOS_CLOUD_API_KEY" },
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

describe("canonical route to runtime provider identity", () => {
  it("maps Cerebras through the OpenAI plugin's runtime registration name", () => {
    const config = {
      serviceRouting: {
        llmText: { backend: "cerebras", transport: "direct" },
        embeddings: { backend: "openai", transport: "direct" },
      },
    } as ElizaConfig;
    const resolved = [
      {
        name: "@elizaos/plugin-openai",
        plugin: { name: "openai", description: "test" },
      },
    ];

    expect(resolveRuntimeProviderName(resolved, "@elizaos/plugin-openai")).toBe(
      "openai",
    );
    expect(resolveEmbeddingProviderPluginName(config)).toBe(
      "@elizaos/plugin-openai",
    );
  });

  it("resolves vault-backed cloud credentials before the cloud projection is reapplied", async () => {
    const config = {
      cloud: {
        enabled: true,
        apiKey: "vault://providers.elizacloud.api-key",
      },
      env: {
        vars: {
          ELIZAOS_CLOUD_API_KEY: "vault://providers.elizacloud.api-key",
        },
      },
    } as ElizaConfig;
    setAgentHostBridge({
      ...defaultAgentHostBridge,
      sharedVault: () => ({
        ...defaultAgentHostBridge.sharedVault(),
        has: (key: string) =>
          Promise.resolve(key === "providers.elizacloud.api-key"),
        get: (key: string) =>
          Promise.resolve(
            key === "providers.elizacloud.api-key" ? "resolved-cloud-key" : "",
          ),
      }),
    });

    applyCloudConfigToEnv(config);
    expect(process.env.ELIZAOS_CLOUD_API_KEY).toBeUndefined();

    await resolveConfigEnvVaultRefsForBoot(config);
    applyCloudConfigToEnv(config);

    expect(config.env?.vars?.ELIZAOS_CLOUD_API_KEY).toBe("resolved-cloud-key");
    expect(process.env.ELIZAOS_CLOUD_API_KEY).toBe("resolved-cloud-key");
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
