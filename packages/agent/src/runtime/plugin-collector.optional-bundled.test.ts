/**
 * Optional core plugins are listed in OPTIONAL_CORE_PLUGINS and require
 * explicit configuration to load. Built-in capabilities (trust,
 * secrets (SECRETS service), plugin-manager) have been moved to core and are no longer
 * in this list.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ElizaConfig } from "../config/types.js";
import {
  CORE_PLUGINS,
  ELIZAOS_ANDROID_CORE_PLUGINS,
  OPTIONAL_CORE_PLUGINS,
} from "./core-plugins.js";
import { collectPluginNames } from "./plugin-collector.js";

/** A sample of optional plugins to verify gating behavior. */
const SAMPLE_OPTIONAL = [
  "@elizaos/plugin-pdf",
  "@elizaos/plugin-obsidian",
  "@elizaos/plugin-cli",
  "@elizaos/plugin-discord",
] as const;

describe("optional core plugins (require explicit opt-in)", () => {
  const prevCloudKey = process.env.ELIZAOS_CLOUD_API_KEY;
  const prevCloudEnabled = process.env.ELIZAOS_CLOUD_ENABLED;
  const prevOpenAiKey = process.env.OPENAI_API_KEY;
  const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
  const prevOllamaBaseUrl = process.env.OLLAMA_BASE_URL;
  const prevElizaLocalLlama = process.env.ELIZA_LOCAL_LLAMA;
  const prevElizaPlatform = process.env.ELIZA_PLATFORM;

  beforeEach(() => {
    delete process.env.ELIZAOS_CLOUD_API_KEY;
    delete process.env.ELIZAOS_CLOUD_ENABLED;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OLLAMA_BASE_URL;
    delete process.env.ELIZA_LOCAL_LLAMA;
    delete process.env.ELIZA_PLATFORM;
  });

  afterEach(() => {
    if (prevCloudKey !== undefined) {
      process.env.ELIZAOS_CLOUD_API_KEY = prevCloudKey;
    } else {
      delete process.env.ELIZAOS_CLOUD_API_KEY;
    }
    if (prevCloudEnabled !== undefined) {
      process.env.ELIZAOS_CLOUD_ENABLED = prevCloudEnabled;
    } else {
      delete process.env.ELIZAOS_CLOUD_ENABLED;
    }
    if (prevOpenAiKey !== undefined) {
      process.env.OPENAI_API_KEY = prevOpenAiKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
    if (prevAnthropicKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
    if (prevOllamaBaseUrl !== undefined) {
      process.env.OLLAMA_BASE_URL = prevOllamaBaseUrl;
    } else {
      delete process.env.OLLAMA_BASE_URL;
    }
    if (prevElizaLocalLlama !== undefined) {
      process.env.ELIZA_LOCAL_LLAMA = prevElizaLocalLlama;
    } else {
      delete process.env.ELIZA_LOCAL_LLAMA;
    }
    if (prevElizaPlatform !== undefined) {
      process.env.ELIZA_PLATFORM = prevElizaPlatform;
    } else {
      delete process.env.ELIZA_PLATFORM;
    }
  });

  it("sample optional plugins are in OPTIONAL_CORE_PLUGINS but not CORE_PLUGINS", () => {
    for (const pkg of SAMPLE_OPTIONAL) {
      expect(OPTIONAL_CORE_PLUGINS).toContain(pkg);
    }
    for (const pkg of SAMPLE_OPTIONAL) {
      expect(CORE_PLUGINS).not.toContain(pkg);
    }
  });

  it("does not load optional plugins with minimal config", () => {
    const names = collectPluginNames({
      cloud: { enabled: false },
      plugins: {},
    } as ElizaConfig);
    for (const pkg of SAMPLE_OPTIONAL) {
      expect(names.has(pkg)).toBe(false);
    }
  });

  it("loads optional plugins when listed in plugins.allow", () => {
    const names = collectPluginNames({
      cloud: { enabled: false },
      plugins: {
        allow: [...SAMPLE_OPTIONAL],
      },
    } as ElizaConfig);
    for (const pkg of SAMPLE_OPTIONAL) {
      expect(names.has(pkg)).toBe(true);
    }
  });

  it("loads optional plugins only when plugins.entries has enabled: true", () => {
    const names = collectPluginNames({
      cloud: { enabled: false },
      plugins: {
        entries: {
          pdf: {},
          obsidian: { enabled: true },
          cli: { enabled: false },
          discord: { enabled: true },
        },
      },
    } as ElizaConfig);
    // Empty entry object should not enable
    expect(names.has("@elizaos/plugin-pdf")).toBe(false);
    // Explicitly enabled optional core
    expect(names.has("@elizaos/plugin-obsidian")).toBe(true);
    // Explicitly disabled
    expect(names.has("@elizaos/plugin-cli")).toBe(false);
    // Explicitly enabled
    expect(names.has("@elizaos/plugin-discord")).toBe(true);
  });

  it("respects plugins.entries enabled: false even when in allow list", () => {
    const names = collectPluginNames({
      cloud: { enabled: false },
      plugins: {
        allow: ["@elizaos/plugin-discord"],
        entries: {
          discord: { enabled: false },
        },
      },
    } as ElizaConfig);
    expect(names.has("@elizaos/plugin-discord")).toBe(false);
  });

  it("respects connector plugin enabled: false even when connector config and allow list are present", () => {
    const names = collectPluginNames({
      cloud: { enabled: false },
      connectors: {
        whatsapp: {
          authDir: "/tmp/eliza-test-whatsapp-auth",
          enabled: false,
        },
      },
      plugins: {
        allow: ["whatsapp", "@elizaos/plugin-whatsapp"],
        entries: {
          whatsapp: { enabled: false },
        },
      },
    } as ElizaConfig);

    expect(names.has("@elizaos/plugin-whatsapp")).toBe(false);
  });

  it("local inference mode blocks remote model providers while keeping local providers", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.OLLAMA_BASE_URL = "http://localhost:11434";

    const names = collectPluginNames({
      cloud: { enabled: false, inferenceMode: "local" },
      plugins: {
        allow: ["@elizaos/plugin-openai"],
      },
    } as ElizaConfig);

    expect(names.has("@elizaos/plugin-elizacloud")).toBe(false);
    expect(names.has("@elizaos/plugin-openai")).toBe(false);
    expect(names.has("@elizaos/plugin-ollama")).toBe(true);
  });

  it("ELIZA_LOCAL_LLAMA=1 keeps API-key cloud providers loaded alongside local", () => {
    // The local handler registers at priority -1 so cloud wins when configured.
    // Stripping remote providers from the load set would prevent users from
    // ever routing a slot to Anthropic/OpenAI on AOSP / on-device builds.
    process.env.ELIZA_LOCAL_LLAMA = "1";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.OPENAI_API_KEY = "sk-test";

    const names = collectPluginNames({
      plugins: {},
    } as ElizaConfig);

    expect(names.has("@elizaos/plugin-anthropic")).toBe(true);
    expect(names.has("@elizaos/plugin-openai")).toBe(true);
  });

  it("ELIZA_LOCAL_LLAMA=1 keeps subscription plugins loaded (openai-codex needs plugin-openai)", () => {
    // openai-codex subscription routes through plugin-openai (modelProvider
    // mapping in SUBSCRIPTION_PROVIDER_MAP), so the plugin must stay loaded
    // for the subscription to be usable.
    process.env.ELIZA_LOCAL_LLAMA = "1";
    process.env.OPENAI_API_KEY = "sk-test";

    const names = collectPluginNames({
      agents: {
        defaults: { subscriptionProvider: "openai-codex" },
      },
      plugins: {},
    } as ElizaConfig);

    expect(names.has("@elizaos/plugin-openai")).toBe(true);
  });

  it("ELIZA_LOCAL_LLAMA=1 still respects legacy config-driven local-only mode", () => {
    // When the operator opts into local-only via config (cloud.inferenceMode),
    // the existing precedence path strips cloud regardless of ELIZA_LOCAL_LLAMA.
    process.env.ELIZA_LOCAL_LLAMA = "1";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.OLLAMA_BASE_URL = "http://localhost:11434";

    const names = collectPluginNames({
      cloud: { enabled: false, inferenceMode: "local" },
      plugins: {},
    } as ElizaConfig);

    expect(names.has("@elizaos/plugin-anthropic")).toBe(false);
    expect(names.has("@elizaos/plugin-elizacloud")).toBe(false);
    expect(names.has("@elizaos/plugin-ollama")).toBe(true);
  });

  it("ELIZA_LOCAL_LLAMA unset leaves remote providers alone", () => {
    delete process.env.ELIZA_LOCAL_LLAMA;
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";

    const names = collectPluginNames({
      plugins: {},
    } as ElizaConfig);

    expect(names.has("@elizaos/plugin-anthropic")).toBe(true);
  });

  it("does not load privileged system app plugins on stock Android", () => {
    process.env.ELIZA_PLATFORM = "android";
    delete process.env.ELIZA_LOCAL_LLAMA;

    const names = collectPluginNames({
      plugins: {},
    } as ElizaConfig);

    for (const pluginName of ELIZAOS_ANDROID_CORE_PLUGINS) {
      expect(names.has(pluginName)).toBe(false);
    }
  });

  it("loads privileged system app plugins only for the ElizaOS Android runtime", () => {
    process.env.ELIZA_PLATFORM = "android";
    process.env.ELIZA_LOCAL_LLAMA = "1";

    const names = collectPluginNames({
      plugins: {},
    } as ElizaConfig);

    for (const pluginName of ELIZAOS_ANDROID_CORE_PLUGINS) {
      expect(names.has(pluginName)).toBe(true);
    }
  });
});
