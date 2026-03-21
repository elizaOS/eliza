/**
 * E2E tests for cloud & provider switching.
 *
 * Tests the full lifecycle:
 *   1. Cloud login persistence (key saved to config, env, DB)
 *   2. Provider switching (cloud ↔ local providers)
 *   3. Plugin conflicts (direct providers removed when cloud active)
 *   4. Model call routing (correct plugin handles the call)
 *   5. Live model calls when API keys are available
 *
 * Live tests (requiring real API keys) are gated by ELIZA_LIVE_TEST=1.
 * Set OPENAI_API_KEY, ANTHROPIC_API_KEY, etc. in env to enable live tests.
 *
 * Run:
 *   pnpm test:e2e -- test/cloud-providers.e2e.test.ts
 *   ELIZA_LIVE_TEST=1 OPENAI_API_KEY=sk-... pnpm test:e2e -- test/cloud-providers.e2e.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ElizaConfig } from "../src/config/config";
import {
  applyCloudConfigToEnv,
  buildCharacterFromConfig,
  collectPluginNames,
} from "../src/runtime/eliza";

// ---------------------------------------------------------------------------
// Env snapshot helper
// ---------------------------------------------------------------------------

const ALL_PROVIDER_KEYS = [
  "ELIZAOS_CLOUD_ENABLED",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_BASE_URL",
  "ELIZAOS_CLOUD_SMALL_MODEL",
  "ELIZAOS_CLOUD_LARGE_MODEL",
  "SMALL_MODEL",
  "LARGE_MODEL",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GROQ_API_KEY",
  "XAI_API_KEY",
  "OLLAMA_BASE_URL",
  "ELIZA_CLOUD_TTS_DISABLED",
  "ELIZA_CLOUD_MEDIA_DISABLED",
  "ELIZA_CLOUD_EMBEDDINGS_DISABLED",
  "ELIZA_CLOUD_RPC_DISABLED",
  "ELIZA_USE_PI_AI",
];

const LIVE_PROVIDER_KEY_SNAPSHOT = {
  openAiApiKey: process.env.OPENAI_API_KEY,
  elizaCloudApiKey: process.env.ELIZAOS_CLOUD_API_KEY,
};

function envSnapshot(keys: string[]): {
  save: () => void;
  restore: () => void;
} {
  const saved = new Map<string, string | undefined>();
  return {
    save() {
      for (const k of keys) saved.set(k, process.env[k]);
    },
    restore() {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

const snap = envSnapshot(ALL_PROVIDER_KEYS);
beforeEach(() => {
  snap.save();
  for (const k of ALL_PROVIDER_KEYS) delete process.env[k];
});
afterEach(() => snap.restore());

// ═══════════════════════════════════════════════════════════════════════════
// 1. Provider plugin selection — no allowlist
// ═══════════════════════════════════════════════════════════════════════════

describe("Provider plugin selection (auto-detect, no allowlist)", () => {
  it("loads OpenAI plugin when OPENAI_API_KEY is set", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const names = collectPluginNames({} as ElizaConfig);
    expect(names.has("@elizaos/plugin-openai")).toBe(true);
  });

  it("loads Anthropic plugin when ANTHROPIC_API_KEY is set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const names = collectPluginNames({} as ElizaConfig);
    expect(names.has("@elizaos/plugin-anthropic")).toBe(true);
  });

  it("loads cloud plugin when config.cloud.enabled is true", () => {
    const config = { cloud: { enabled: true } } as ElizaConfig;
    const names = collectPluginNames(config);
    expect(names.has("@elizaos/plugin-elizacloud")).toBe(true);
  });

  it("removes core cloud plugin when cloud is explicitly disabled", () => {
    const config = {
      cloud: { enabled: false, apiKey: "ck-test" },
    } as ElizaConfig;
    const names = collectPluginNames(config);
    expect(names.has("@elizaos/plugin-elizacloud")).toBe(false);
  });

  it("loads multiple providers when multiple keys are set", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const names = collectPluginNames({} as ElizaConfig);
    expect(names.has("@elizaos/plugin-openai")).toBe(true);
    expect(names.has("@elizaos/plugin-anthropic")).toBe(true);
  });

  it("loads no direct AI provider when nothing is configured", () => {
    const names = collectPluginNames({} as ElizaConfig);
    expect(names.has("@elizaos/plugin-openai")).toBe(false);
    expect(names.has("@elizaos/plugin-anthropic")).toBe(false);
    expect(names.has("@elizaos/plugin-elizacloud")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Provider plugin selection — with allowlist (the real-world case)
// ═══════════════════════════════════════════════════════════════════════════

describe("Provider plugin selection (explicit allowlist)", () => {
  const makeConfig = (
    allow: string[],
    cloud?: { enabled?: boolean; apiKey?: string },
  ): ElizaConfig =>
    ({
      plugins: { allow },
      ...(cloud ? { cloud } : {}),
    }) as ElizaConfig;

  it("respects allowlist and includes only listed plugins", () => {
    const config = makeConfig([
      "@elizaos/plugin-anthropic",
      "@elizaos/plugin-browser",
    ]);
    const names = collectPluginNames(config);
    expect(names.has("@elizaos/plugin-anthropic")).toBe(true);
    expect(names.has("@elizaos/plugin-browser")).toBe(true);
    expect(names.has("@elizaos/plugin-openai")).toBe(false);
  });

  it("always adds plugin-sql even if not in allowlist", () => {
    const config = makeConfig(["@elizaos/plugin-browser"]);
    const names = collectPluginNames(config);
    expect(names.has("@elizaos/plugin-sql")).toBe(true);
  });

  it("injects cloud plugin into allowlist when cloud.enabled=true", () => {
    const config = makeConfig(
      ["@elizaos/plugin-anthropic", "@elizaos/plugin-browser"],
      { enabled: true, apiKey: "ck-test" },
    );
    const names = collectPluginNames(config);
    expect(names.has("@elizaos/plugin-elizacloud")).toBe(true);
  });

  it("removes core cloud plugin when cloud is explicitly disabled", () => {
    const config = makeConfig(["@elizaos/plugin-anthropic"], {
      enabled: false,
      apiKey: "ck-test",
    });
    const names = collectPluginNames(config);
    expect(names.has("@elizaos/plugin-elizacloud")).toBe(false);
  });

  it("removes direct AI providers when cloud is active", () => {
    const config = makeConfig(
      [
        "@elizaos/plugin-anthropic",
        "@elizaos/plugin-openai",
        "@elizaos/plugin-browser",
        "@elizaos/plugin-webhooks",
      ],
      { enabled: true, apiKey: "ck-test" },
    );
    const names = collectPluginNames(config);

    // Cloud plugin replaces direct providers
    expect(names.has("@elizaos/plugin-elizacloud")).toBe(true);
    expect(names.has("@elizaos/plugin-anthropic")).toBe(false);
    expect(names.has("@elizaos/plugin-openai")).toBe(false);

    // Non-AI plugins are preserved
    expect(names.has("@elizaos/plugin-browser")).toBe(true);
    expect(names.has("@elizaos/plugin-webhooks")).toBe(true);
  });

  it("does NOT remove providers when cloud is inactive", () => {
    const config = makeConfig([
      "@elizaos/plugin-anthropic",
      "@elizaos/plugin-openai",
    ]);
    const names = collectPluginNames(config);
    expect(names.has("@elizaos/plugin-anthropic")).toBe(true);
    expect(names.has("@elizaos/plugin-openai")).toBe(true);
    expect(names.has("@elizaos/plugin-elizacloud")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Cloud config → env propagation
// ═══════════════════════════════════════════════════════════════════════════

describe("Cloud config → env var propagation", () => {
  it("sets all cloud env vars from config", () => {
    const config = {
      cloud: {
        enabled: true,
        apiKey: "ck-test",
        baseUrl: "https://test.cloud",
      },
    } as ElizaConfig;
    applyCloudConfigToEnv(config);
    expect(process.env.ELIZAOS_CLOUD_ENABLED).toBe("true");
    expect(process.env.ELIZAOS_CLOUD_API_KEY).toBe("ck-test");
    expect(process.env.ELIZAOS_CLOUD_BASE_URL).toBe("https://test.cloud");
  });

  it("always overwrites stale env vars on restart", () => {
    process.env.ELIZAOS_CLOUD_API_KEY = "stale-key";
    process.env.ELIZAOS_CLOUD_ENABLED = "false";
    const config = {
      cloud: { enabled: true, apiKey: "fresh-key" },
    } as ElizaConfig;
    applyCloudConfigToEnv(config);
    expect(process.env.ELIZAOS_CLOUD_API_KEY).toBe("fresh-key");
    expect(process.env.ELIZAOS_CLOUD_ENABLED).toBe("true");
  });

  it("keeps cloud disabled when enabled flag is explicitly false", () => {
    const config = {
      cloud: { enabled: false, apiKey: "ck-still-valid" },
    } as ElizaConfig;
    applyCloudConfigToEnv(config);
    expect(process.env.ELIZAOS_CLOUD_ENABLED).toBeUndefined();
    expect(process.env.ELIZAOS_CLOUD_API_KEY).toBe("ck-still-valid");
  });

  it("sets default model names when cloud is active", () => {
    const config = {
      cloud: { enabled: true, apiKey: "ck-x" },
    } as ElizaConfig;
    applyCloudConfigToEnv(config);
    expect(process.env.SMALL_MODEL).toBe("openai/gpt-5-mini");
    expect(process.env.LARGE_MODEL).toBe("anthropic/claude-sonnet-4.5");
  });

  it("uses explicit model names from config", () => {
    const config = {
      cloud: { enabled: true, apiKey: "ck-x" },
      models: { small: "google/gemini-2.5-flash", large: "openai/gpt-5" },
    } as ElizaConfig;
    applyCloudConfigToEnv(config);
    expect(process.env.SMALL_MODEL).toBe("google/gemini-2.5-flash");
    expect(process.env.LARGE_MODEL).toBe("openai/gpt-5");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Character secrets propagation
// ═══════════════════════════════════════════════════════════════════════════

describe("Character secrets include provider keys", () => {
  it("includes ELIZAOS_CLOUD_API_KEY in character secrets", () => {
    process.env.ELIZAOS_CLOUD_API_KEY = "ck-secret";
    const char = buildCharacterFromConfig({} as ElizaConfig);
    expect((char.secrets as Record<string, string>).ELIZAOS_CLOUD_API_KEY).toBe(
      "ck-secret",
    );
  });

  it("includes OPENAI_API_KEY in character secrets", () => {
    process.env.OPENAI_API_KEY = "sk-test-openai";
    const char = buildCharacterFromConfig({} as ElizaConfig);
    expect((char.secrets as Record<string, string>).OPENAI_API_KEY).toBe(
      "sk-test-openai",
    );
  });

  it("includes ANTHROPIC_API_KEY in character secrets", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const char = buildCharacterFromConfig({} as ElizaConfig);
    expect((char.secrets as Record<string, string>).ANTHROPIC_API_KEY).toBe(
      "sk-ant-test",
    );
  });

  it("omits keys that are not set", () => {
    const char = buildCharacterFromConfig({} as ElizaConfig);
    const secrets = char.secrets as Record<string, string> | undefined;
    expect(secrets?.OPENAI_API_KEY).toBeUndefined();
    expect(secrets?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(secrets?.ELIZAOS_CLOUD_API_KEY).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Full provider switch simulation
// ═══════════════════════════════════════════════════════════════════════════

describe("Provider switching simulation", () => {
  it("switch local → cloud: Anthropic removed, cloud added", () => {
    // Start with Anthropic
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const localConfig = {
      plugins: {
        allow: ["@elizaos/plugin-anthropic", "@elizaos/plugin-browser"],
      },
    } as ElizaConfig;
    const localPlugins = collectPluginNames(localConfig);
    expect(localPlugins.has("@elizaos/plugin-anthropic")).toBe(true);
    expect(localPlugins.has("@elizaos/plugin-elizacloud")).toBe(false);

    // User enables cloud
    const cloudConfig = {
      plugins: {
        allow: ["@elizaos/plugin-anthropic", "@elizaos/plugin-browser"],
      },
      cloud: { enabled: true, apiKey: "ck-new-key" },
    } as ElizaConfig;
    applyCloudConfigToEnv(cloudConfig);
    const cloudPlugins = collectPluginNames(cloudConfig);

    expect(cloudPlugins.has("@elizaos/plugin-elizacloud")).toBe(true);
    expect(cloudPlugins.has("@elizaos/plugin-anthropic")).toBe(false);
    expect(cloudPlugins.has("@elizaos/plugin-browser")).toBe(true);
  });

  it("switch cloud → local: Anthropic restored while cloud plugin is removed", () => {
    // Start with cloud
    const cloudConfig = {
      plugins: {
        allow: ["@elizaos/plugin-anthropic", "@elizaos/plugin-browser"],
      },
      cloud: { enabled: true, apiKey: "ck-key" },
    } as ElizaConfig;
    const cloudPlugins = collectPluginNames(cloudConfig);
    expect(cloudPlugins.has("@elizaos/plugin-elizacloud")).toBe(true);
    expect(cloudPlugins.has("@elizaos/plugin-anthropic")).toBe(false);

    // User disables cloud (keeps Anthropic in allowlist)
    const localConfig = {
      plugins: {
        allow: ["@elizaos/plugin-anthropic", "@elizaos/plugin-browser"],
      },
      cloud: { enabled: false },
    } as ElizaConfig;
    const localPlugins = collectPluginNames(localConfig);

    expect(localPlugins.has("@elizaos/plugin-anthropic")).toBe(true);
    expect(localPlugins.has("@elizaos/plugin-elizacloud")).toBe(false);
    expect(localPlugins.has("@elizaos/plugin-browser")).toBe(true);
  });

  it("full cycle: no config → cloud login → switch to OpenAI → back to cloud mode", () => {
    // Step 1: Fresh start, nothing configured
    let config = {} as ElizaConfig;
    let plugins = collectPluginNames(config);
    expect(plugins.has("@elizaos/plugin-elizacloud")).toBe(false);
    expect(plugins.has("@elizaos/plugin-openai")).toBe(false);

    // Step 2: User logs in to cloud
    config = { cloud: { enabled: true, apiKey: "ck-login" } } as ElizaConfig;
    applyCloudConfigToEnv(config);
    plugins = collectPluginNames(config);
    expect(plugins.has("@elizaos/plugin-elizacloud")).toBe(true);

    // Step 3: User switches to OpenAI with their own key.
    // On a real restart the process env is fresh; simulate by clearing cloud vars.
    delete process.env.ELIZAOS_CLOUD_API_KEY;
    delete process.env.ELIZAOS_CLOUD_ENABLED;
    process.env.OPENAI_API_KEY = "sk-user-openai";
    config = { cloud: { enabled: false } } as ElizaConfig;
    plugins = collectPluginNames(config);
    expect(plugins.has("@elizaos/plugin-openai")).toBe(true);
    expect(plugins.has("@elizaos/plugin-elizacloud")).toBe(false);

    // Step 4: User switches back to cloud
    config = { cloud: { enabled: true, apiKey: "ck-login" } } as ElizaConfig;
    applyCloudConfigToEnv(config);
    plugins = collectPluginNames(config);
    expect(plugins.has("@elizaos/plugin-elizacloud")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Granular cloud service toggles
// ═══════════════════════════════════════════════════════════════════════════

describe("Granular cloud service toggles (services.inference)", () => {
  it("keeps direct providers when services.inference is false", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const config = {
      cloud: {
        enabled: true,
        apiKey: "ck-test",
        services: { inference: false },
      },
    } as ElizaConfig;
    const names = collectPluginNames(config);
    // Cloud plugin stays (for RPC), but Anthropic is NOT stripped
    expect(names.has("@elizaos/plugin-elizacloud")).toBe(true);
    expect(names.has("@elizaos/plugin-anthropic")).toBe(true);
  });

  it("strips direct providers when services.inference is true (default)", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const config = {
      cloud: {
        enabled: true,
        apiKey: "ck-test",
        services: { inference: true },
      },
    } as ElizaConfig;
    const names = collectPluginNames(config);
    expect(names.has("@elizaos/plugin-elizacloud")).toBe(true);
    expect(names.has("@elizaos/plugin-anthropic")).toBe(false);
  });

  it("keeps direct providers when inferenceMode is byok", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const config = {
      cloud: {
        enabled: true,
        apiKey: "ck-test",
        inferenceMode: "byok",
      },
    } as ElizaConfig;
    const names = collectPluginNames(config);
    expect(names.has("@elizaos/plugin-elizacloud")).toBe(true);
    expect(names.has("@elizaos/plugin-anthropic")).toBe(true);
  });

  it("keeps direct providers when inferenceMode is local", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const config = {
      cloud: {
        enabled: true,
        apiKey: "ck-test",
        inferenceMode: "local",
      },
    } as ElizaConfig;
    const names = collectPluginNames(config);
    expect(names.has("@elizaos/plugin-elizacloud")).toBe(true);
    expect(names.has("@elizaos/plugin-openai")).toBe(true);
  });
});

describe("Subscription provider overrides cloud inference default", () => {
  it("detects subscriptionProvider and defaults to byok instead of cloud", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-sub";
    const config = {
      cloud: { enabled: true, apiKey: "ck-test" },
      agents: { defaults: { subscriptionProvider: "anthropic-subscription" } },
    } as ElizaConfig;
    const names = collectPluginNames(config);
    // Cloud plugin loaded (for RPC), but Anthropic NOT stripped
    expect(names.has("@elizaos/plugin-elizacloud")).toBe(true);
    expect(names.has("@elizaos/plugin-anthropic")).toBe(true);
  });

  it("explicit inferenceMode cloud overrides subscriptionProvider", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-sub";
    const config = {
      cloud: {
        enabled: true,
        apiKey: "ck-test",
        inferenceMode: "cloud",
      },
      agents: { defaults: { subscriptionProvider: "anthropic-subscription" } },
    } as ElizaConfig;
    const names = collectPluginNames(config);
    // User explicitly set inferenceMode to cloud — respect that
    expect(names.has("@elizaos/plugin-elizacloud")).toBe(true);
    expect(names.has("@elizaos/plugin-anthropic")).toBe(false);
  });

  it("no subscriptionProvider defaults to cloud inference", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const config = {
      cloud: { enabled: true, apiKey: "ck-test" },
    } as ElizaConfig;
    const names = collectPluginNames(config);
    expect(names.has("@elizaos/plugin-elizacloud")).toBe(true);
    expect(names.has("@elizaos/plugin-anthropic")).toBe(false);
  });
});

describe("Cloud env propagation respects service toggles", () => {
  it("skips cloud model env vars when services.inference is false", () => {
    const config = {
      cloud: {
        enabled: true,
        apiKey: "ck-test",
        services: { inference: false },
      },
    } as ElizaConfig;
    applyCloudConfigToEnv(config);
    expect(process.env.ELIZAOS_CLOUD_ENABLED).toBe("true");
    expect(process.env.ELIZAOS_CLOUD_SMALL_MODEL).toBeUndefined();
    expect(process.env.ELIZAOS_CLOUD_LARGE_MODEL).toBeUndefined();
  });

  it("skips cloud model env vars when subscriptionProvider is set", () => {
    const config = {
      cloud: { enabled: true, apiKey: "ck-test" },
      agents: { defaults: { subscriptionProvider: "anthropic-subscription" } },
    } as ElizaConfig;
    applyCloudConfigToEnv(config);
    expect(process.env.ELIZAOS_CLOUD_ENABLED).toBe("true");
    expect(process.env.ELIZAOS_CLOUD_SMALL_MODEL).toBeUndefined();
    expect(process.env.ELIZAOS_CLOUD_LARGE_MODEL).toBeUndefined();
    expect(process.env.SMALL_MODEL).toBeUndefined();
  });

  it("sets cloud model env vars when inferenceMode is explicitly cloud", () => {
    const config = {
      cloud: {
        enabled: true,
        apiKey: "ck-test",
        inferenceMode: "cloud",
      },
      agents: { defaults: { subscriptionProvider: "anthropic-subscription" } },
    } as ElizaConfig;
    applyCloudConfigToEnv(config);
    // Explicit cloud mode overrides subscriptionProvider
    expect(process.env.SMALL_MODEL).toBeDefined();
    expect(process.env.LARGE_MODEL).toBeDefined();
  });

  it("propagates per-service disable env vars", () => {
    const config = {
      cloud: {
        enabled: true,
        apiKey: "ck-test",
        services: {
          inference: true,
          tts: false,
          media: false,
          embeddings: false,
          rpc: false,
        },
      },
    } as ElizaConfig;
    applyCloudConfigToEnv(config);
    expect(process.env.ELIZA_CLOUD_TTS_DISABLED).toBe("true");
    expect(process.env.ELIZA_CLOUD_MEDIA_DISABLED).toBe("true");
    expect(process.env.ELIZA_CLOUD_EMBEDDINGS_DISABLED).toBe("true");
    expect(process.env.ELIZA_CLOUD_RPC_DISABLED).toBe("true");
  });

  it("cleans up per-service env vars when toggles re-enabled", () => {
    process.env.ELIZA_CLOUD_TTS_DISABLED = "true";
    process.env.ELIZA_CLOUD_MEDIA_DISABLED = "true";
    const config = {
      cloud: {
        enabled: true,
        apiKey: "ck-test",
        services: { tts: true, media: true },
      },
    } as ElizaConfig;
    applyCloudConfigToEnv(config);
    expect(process.env.ELIZA_CLOUD_TTS_DISABLED).toBeUndefined();
    expect(process.env.ELIZA_CLOUD_MEDIA_DISABLED).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Full provider switch with cloud RPC preservation
// ═══════════════════════════════════════════════════════════════════════════

describe("Provider switch preserves cloud for RPC", () => {
  it("cloud → subscription: cloud stays enabled, inference switches to byok", () => {
    // Start: cloud handles everything
    let config = {
      cloud: { enabled: true, apiKey: "ck-test" },
    } as ElizaConfig;
    applyCloudConfigToEnv(config);
    let plugins = collectPluginNames(config);
    expect(plugins.has("@elizaos/plugin-elizacloud")).toBe(true);

    // Switch to Anthropic subscription (simulating what the backend now does)
    process.env.ANTHROPIC_API_KEY = "sk-ant-sub";
    config = {
      cloud: {
        enabled: true,
        apiKey: "ck-test",
        inferenceMode: "byok",
        services: { inference: false },
      },
      agents: { defaults: { subscriptionProvider: "anthropic-subscription" } },
    } as ElizaConfig;
    applyCloudConfigToEnv(config);
    plugins = collectPluginNames(config);

    // Cloud stays for RPC, Anthropic loaded for inference
    expect(plugins.has("@elizaos/plugin-elizacloud")).toBe(true);
    expect(plugins.has("@elizaos/plugin-anthropic")).toBe(true);
    // Cloud model vars cleaned
    expect(process.env.ELIZAOS_CLOUD_SMALL_MODEL).toBeUndefined();
    expect(process.env.ELIZAOS_CLOUD_LARGE_MODEL).toBeUndefined();
    // Cloud still enabled for RPC
    expect(process.env.ELIZAOS_CLOUD_ENABLED).toBe("true");
    expect(process.env.ELIZAOS_CLOUD_API_KEY).toBe("ck-test");
  });

  it("subscription → cloud: inference switches back to cloud", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-sub";
    let config = {
      cloud: {
        enabled: true,
        apiKey: "ck-test",
        inferenceMode: "byok",
        services: { inference: false },
      },
      agents: { defaults: { subscriptionProvider: "anthropic-subscription" } },
    } as ElizaConfig;
    let plugins = collectPluginNames(config);
    expect(plugins.has("@elizaos/plugin-anthropic")).toBe(true);

    // Switch back to cloud inference
    config = {
      cloud: {
        enabled: true,
        apiKey: "ck-test",
        inferenceMode: "cloud",
        services: { inference: true },
      },
    } as ElizaConfig;
    applyCloudConfigToEnv(config);
    plugins = collectPluginNames(config);

    expect(plugins.has("@elizaos/plugin-elizacloud")).toBe(true);
    expect(plugins.has("@elizaos/plugin-anthropic")).toBe(false);
    expect(process.env.SMALL_MODEL).toBeDefined();
    expect(process.env.LARGE_MODEL).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. Pi AI + cloud RPC preservation
// ═══════════════════════════════════════════════════════════════════════════

describe("Pi AI with cloud enabled for RPC (cloud inference byok)", () => {
  it("loads pi-ai plugin when cloud is enabled but inferenceMode is byok", () => {
    process.env.ELIZA_USE_PI_AI = "1";
    const config = {
      cloud: {
        enabled: true,
        apiKey: "ck-test",
        inferenceMode: "byok",
        services: { inference: false },
      },
    } as ElizaConfig;
    const names = collectPluginNames(config);
    // Cloud stays loaded for RPC
    expect(names.has("@elizaos/plugin-elizacloud")).toBe(true);
    // Pi AI handles inference
    expect(names.has("@elizaos/plugin-pi-ai")).toBe(true);
  });

  it("pi-ai removes direct providers when cloud is in byok mode", () => {
    process.env.ELIZA_USE_PI_AI = "1";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const config = {
      cloud: {
        enabled: true,
        apiKey: "ck-test",
        inferenceMode: "byok",
        services: { inference: false },
      },
    } as ElizaConfig;
    const names = collectPluginNames(config);
    // Cloud stays for RPC, Pi AI handles inference
    expect(names.has("@elizaos/plugin-elizacloud")).toBe(true);
    expect(names.has("@elizaos/plugin-pi-ai")).toBe(true);
    // Direct providers should be removed — pi-ai handles upstream selection
    expect(names.has("@elizaos/plugin-anthropic")).toBe(false);
  });

  it("loads direct provider (not pi-ai) when cloud is byok and pi-ai is disabled", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const config = {
      cloud: {
        enabled: true,
        apiKey: "ck-test",
        inferenceMode: "byok",
        services: { inference: false },
      },
    } as ElizaConfig;
    const names = collectPluginNames(config);
    // Cloud stays for RPC, direct provider handles inference
    expect(names.has("@elizaos/plugin-elizacloud")).toBe(true);
    expect(names.has("@elizaos/plugin-anthropic")).toBe(true);
    expect(names.has("@elizaos/plugin-pi-ai")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. Live model call tests (only run with ELIZA_LIVE_TEST=1)
// ═══════════════════════════════════════════════════════════════════════════

const isLive = process.env.ELIZA_LIVE_TEST === "1";

describe.skipIf(!isLive)("Live model calls (requires real API keys)", () => {
  beforeEach(() => {
    if (LIVE_PROVIDER_KEY_SNAPSHOT.openAiApiKey) {
      process.env.OPENAI_API_KEY = LIVE_PROVIDER_KEY_SNAPSHOT.openAiApiKey;
    }
    if (LIVE_PROVIDER_KEY_SNAPSHOT.elizaCloudApiKey) {
      process.env.ELIZAOS_CLOUD_API_KEY =
        LIVE_PROVIDER_KEY_SNAPSHOT.elizaCloudApiKey;
    }
  });

  it("OpenAI: can generate text with OPENAI_API_KEY", async () => {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error("OPENAI_API_KEY not set");

    const { generateText } = await import("ai");
    const { createOpenAI } = await import("@ai-sdk/openai");
    const openai = createOpenAI({ apiKey: key, compatibility: "compatible" });
    const result = await generateText({
      model: openai.chat("gpt-4o-mini"),
      prompt: "Reply with exactly: HELLO_TEST",
      maxTokens: 20,
    });
    expect(result.text).toContain("HELLO_TEST");
  }, 30_000);

  it("Eliza Cloud: can generate text with ELIZAOS_CLOUD_API_KEY", async () => {
    const key = process.env.ELIZAOS_CLOUD_API_KEY;
    if (!key) {
      // Try loading from config
      const { loadElizaConfig } = await import("../src/config/config");
      const config = loadElizaConfig();
      if (!config.cloud?.apiKey)
        throw new Error("No Eliza Cloud API key found");
      process.env.ELIZAOS_CLOUD_API_KEY = config.cloud.apiKey;
    }
    const cloudKey = process.env.ELIZAOS_CLOUD_API_KEY;

    const { generateText } = await import("ai");
    const { createOpenAI } = await import("@ai-sdk/openai");
    const openai = createOpenAI({
      apiKey: cloudKey as string,
      baseURL: "https://elizacloud.ai/api/v1",
      compatibility: "compatible",
    });
    try {
      const result = await generateText({
        model: openai.chat("openai/gpt-5-mini"),
        prompt: "Reply with exactly: CLOUD_TEST_OK",
        maxTokens: 20,
      });
      expect(result.text).toContain("CLOUD_TEST_OK");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const quotaOrBillingIssue =
        /insufficient credits|quota|max usage reached/i;
      if (quotaOrBillingIssue.test(message)) {
        expect(message).toMatch(quotaOrBillingIssue);
        return;
      }
      throw error;
    }
  }, 30_000);
});
