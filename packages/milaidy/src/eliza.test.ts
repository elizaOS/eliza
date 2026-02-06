/**
 * Unit tests for eliza.ts pure functions.
 *
 * Tests config → plugin resolution, channel secret propagation,
 * cloud config propagation, character building, and model resolution
 * WITHOUT starting a runtime.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { MilaidyConfig } from "./config/config.js";
import {
  collectPluginNames,
  applyChannelSecretsToEnv,
  applyCloudConfigToEnv,
  buildCharacterFromConfig,
  resolvePrimaryModel,
} from "./eliza.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Save and restore a set of env keys around each test. */
function envSnapshot(keys: string[]): { save: () => void; restore: () => void } {
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

// ---------------------------------------------------------------------------
// collectPluginNames
// ---------------------------------------------------------------------------

describe("collectPluginNames", () => {
  const envKeys = [
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GROQ_API_KEY", "GOOGLE_API_KEY",
    "XAI_API_KEY", "OPENROUTER_API_KEY", "OLLAMA_BASE_URL",
    "ELIZAOS_CLOUD_API_KEY", "ELIZAOS_CLOUD_ENABLED",
  ];
  const snap = envSnapshot(envKeys);
  beforeEach(() => { snap.save(); for (const k of envKeys) delete process.env[k]; });
  afterEach(() => snap.restore());

  it("includes all core plugins for an empty config", () => {
    const names = collectPluginNames({} as MilaidyConfig);
    expect(names.has("@elizaos/plugin-sql")).toBe(true);
    expect(names.has("@elizaos/plugin-agent-skills")).toBe(true);
    expect(names.has("@elizaos/plugin-directives")).toBe(true);
    expect(names.has("@elizaos/plugin-commands")).toBe(true);
    expect(names.has("@elizaos/plugin-shell")).toBe(true);
    expect(names.has("@elizaos/plugin-personality")).toBe(true);
    expect(names.has("@elizaos/plugin-experience")).toBe(true);
    expect(names.has("@elizaos/plugin-form")).toBe(true);
  });

  it("adds model-provider plugins when env keys are present", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    process.env.OPENAI_API_KEY = "sk-test";
    const names = collectPluginNames({} as MilaidyConfig);
    expect(names.has("@elizaos/plugin-anthropic")).toBe(true);
    expect(names.has("@elizaos/plugin-openai")).toBe(true);
    expect(names.has("@elizaos/plugin-groq")).toBe(false);
  });

  it("adds channel plugins when config.channels is populated", () => {
    const config = { channels: { telegram: { botToken: "tok" }, discord: { token: "tok" } } } as MilaidyConfig;
    const names = collectPluginNames(config);
    expect(names.has("@elizaos/plugin-telegram")).toBe(true);
    expect(names.has("@elizaos/plugin-discord")).toBe(true);
    expect(names.has("@elizaos/plugin-slack")).toBe(false);
  });

  it("does not add channel plugins for empty channel configs", () => {
    const config = { channels: { telegram: null } } as unknown as MilaidyConfig;
    const names = collectPluginNames(config);
    expect(names.has("@elizaos/plugin-telegram")).toBe(false);
  });

  it("adds ElizaCloud plugin when cloud is enabled in config", () => {
    const config = { cloud: { enabled: true } } as MilaidyConfig;
    const names = collectPluginNames(config);
    expect(names.has("@elizaos/plugin-elizacloud")).toBe(true);
  });

  it("adds ElizaCloud plugin when env key is present", () => {
    process.env.ELIZAOS_CLOUD_API_KEY = "ck-test";
    const names = collectPluginNames({} as MilaidyConfig);
    expect(names.has("@elizaos/plugin-elizacloud")).toBe(true);
  });

  it("respects feature flags in config.features", () => {
    // OPTIONAL_PLUGIN_MAP is empty, so features won't add anything currently.
    // But the function should not crash on arbitrary features.
    const config = { features: { someFeature: true, another: { enabled: false } } } as unknown as MilaidyConfig;
    expect(() => collectPluginNames(config)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// applyChannelSecretsToEnv
// ---------------------------------------------------------------------------

describe("applyChannelSecretsToEnv", () => {
  const envKeys = [
    "DISCORD_BOT_TOKEN", "TELEGRAM_BOT_TOKEN",
    "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_USER_TOKEN",
    "SIGNAL_ACCOUNT",
    "MSTEAMS_APP_ID", "MSTEAMS_APP_PASSWORD",
    "MATTERMOST_BOT_TOKEN", "MATTERMOST_BASE_URL",
    "GOOGLE_CHAT_SERVICE_ACCOUNT_KEY",
  ];
  const snap = envSnapshot(envKeys);
  beforeEach(() => { snap.save(); for (const k of envKeys) delete process.env[k]; });
  afterEach(() => snap.restore());

  it("copies Discord token from config to env", () => {
    const config = { channels: { discord: { token: "discord-tok-123" } } } as MilaidyConfig;
    applyChannelSecretsToEnv(config);
    expect(process.env.DISCORD_BOT_TOKEN).toBe("discord-tok-123");
  });

  it("copies Telegram botToken from config to env", () => {
    const config = { channels: { telegram: { botToken: "tg-tok-456" } } } as MilaidyConfig;
    applyChannelSecretsToEnv(config);
    expect(process.env.TELEGRAM_BOT_TOKEN).toBe("tg-tok-456");
  });

  it("copies all Slack tokens from config to env", () => {
    const config = {
      channels: { slack: { botToken: "xoxb-1", appToken: "xapp-1", userToken: "xoxp-1" } },
    } as MilaidyConfig;
    applyChannelSecretsToEnv(config);
    expect(process.env.SLACK_BOT_TOKEN).toBe("xoxb-1");
    expect(process.env.SLACK_APP_TOKEN).toBe("xapp-1");
    expect(process.env.SLACK_USER_TOKEN).toBe("xoxp-1");
  });

  it("does not overwrite existing env values", () => {
    process.env.TELEGRAM_BOT_TOKEN = "already-set";
    const config = { channels: { telegram: { botToken: "new-tok" } } } as MilaidyConfig;
    applyChannelSecretsToEnv(config);
    expect(process.env.TELEGRAM_BOT_TOKEN).toBe("already-set");
  });

  it("skips empty or whitespace-only values", () => {
    const config = { channels: { discord: { token: "  " } } } as MilaidyConfig;
    applyChannelSecretsToEnv(config);
    expect(process.env.DISCORD_BOT_TOKEN).toBeUndefined();
  });

  it("handles missing channels gracefully", () => {
    expect(() => applyChannelSecretsToEnv({} as MilaidyConfig)).not.toThrow();
  });

  it("handles unknown channel names gracefully", () => {
    const config = { channels: { unknownChannel: { token: "tok" } } } as unknown as MilaidyConfig;
    expect(() => applyChannelSecretsToEnv(config)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// applyCloudConfigToEnv
// ---------------------------------------------------------------------------

describe("applyCloudConfigToEnv", () => {
  const envKeys = ["ELIZAOS_CLOUD_ENABLED", "ELIZAOS_CLOUD_API_KEY", "ELIZAOS_CLOUD_BASE_URL"];
  const snap = envSnapshot(envKeys);
  beforeEach(() => { snap.save(); for (const k of envKeys) delete process.env[k]; });
  afterEach(() => snap.restore());

  it("sets cloud env vars from config", () => {
    const config = { cloud: { enabled: true, apiKey: "ck-123", baseUrl: "https://cloud.test" } } as MilaidyConfig;
    applyCloudConfigToEnv(config);
    expect(process.env.ELIZAOS_CLOUD_ENABLED).toBe("true");
    expect(process.env.ELIZAOS_CLOUD_API_KEY).toBe("ck-123");
    expect(process.env.ELIZAOS_CLOUD_BASE_URL).toBe("https://cloud.test");
  });

  it("does not overwrite existing env values", () => {
    process.env.ELIZAOS_CLOUD_API_KEY = "existing";
    const config = { cloud: { apiKey: "new-key" } } as MilaidyConfig;
    applyCloudConfigToEnv(config);
    expect(process.env.ELIZAOS_CLOUD_API_KEY).toBe("existing");
  });

  it("handles missing cloud config gracefully", () => {
    expect(() => applyCloudConfigToEnv({} as MilaidyConfig)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// buildCharacterFromConfig
// ---------------------------------------------------------------------------

describe("buildCharacterFromConfig", () => {
  const envKeys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"];
  const snap = envSnapshot(envKeys);
  beforeEach(() => { snap.save(); for (const k of envKeys) delete process.env[k]; });
  afterEach(() => snap.restore());

  it("uses agent name from config.agent", () => {
    const config = { agent: { name: "Sakuya" } } as MilaidyConfig;
    const char = buildCharacterFromConfig(config);
    expect(char.name).toBe("Sakuya");
  });

  it("falls back to config.ui.assistant.name", () => {
    const config = { ui: { assistant: { name: "Reimu" } } } as unknown as MilaidyConfig;
    const char = buildCharacterFromConfig(config);
    expect(char.name).toBe("Reimu");
  });

  it("defaults to 'Milaidy' when no name is configured", () => {
    const char = buildCharacterFromConfig({} as MilaidyConfig);
    expect(char.name).toBe("Milaidy");
  });

  it("collects API keys from process.env as secrets", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.OPENAI_API_KEY = "sk-oai-test";
    const char = buildCharacterFromConfig({} as MilaidyConfig);
    expect(char.secrets?.ANTHROPIC_API_KEY).toBe("sk-ant-test");
    expect(char.secrets?.OPENAI_API_KEY).toBe("sk-oai-test");
  });

  it("excludes empty or whitespace-only env values from secrets", () => {
    process.env.ANTHROPIC_API_KEY = "  ";
    const char = buildCharacterFromConfig({} as MilaidyConfig);
    expect(char.secrets?.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("uses agent bio from config", () => {
    const config = { agent: { name: "Test", bio: "Custom bio text." } } as MilaidyConfig;
    const char = buildCharacterFromConfig(config);
    const bioText = Array.isArray(char.bio) ? char.bio.join(" ") : char.bio;
    expect(bioText).toContain("Custom bio text");
  });

  it("uses system prompt from config", () => {
    const config = { agent: { name: "Test", system_prompt: "You are a pirate." } } as MilaidyConfig;
    const char = buildCharacterFromConfig(config);
    expect(char.system).toBe("You are a pirate.");
  });
});

// ---------------------------------------------------------------------------
// resolvePrimaryModel
// ---------------------------------------------------------------------------

describe("resolvePrimaryModel", () => {
  it("returns undefined when no model config exists", () => {
    expect(resolvePrimaryModel({} as MilaidyConfig)).toBeUndefined();
  });

  it("returns undefined when agents.defaults.model is missing", () => {
    const config = { agents: { defaults: {} } } as MilaidyConfig;
    expect(resolvePrimaryModel(config)).toBeUndefined();
  });

  it("returns the primary model when configured", () => {
    const config = { agents: { defaults: { model: { primary: "gpt-5" } } } } as MilaidyConfig;
    expect(resolvePrimaryModel(config)).toBe("gpt-5");
  });

  it("returns undefined when model has no primary", () => {
    const config = { agents: { defaults: { model: { fallbacks: ["gpt-5-mini"] } } } } as unknown as MilaidyConfig;
    expect(resolvePrimaryModel(config)).toBeUndefined();
  });
});
