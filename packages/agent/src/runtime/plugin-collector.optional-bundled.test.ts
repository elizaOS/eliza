/**
 * Optional core plugins are listed in OPTIONAL_CORE_PLUGINS and require
 * explicit configuration to load. Built-in capabilities (trust,
 * secrets-manager, plugin-manager) have been moved to core and are no longer
 * in this list.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ElizaConfig } from "../config/types.js";
import { CORE_PLUGINS, OPTIONAL_CORE_PLUGINS } from "./core-plugins.js";
import { collectPluginNames } from "./plugin-collector.js";

/** A sample of optional plugins to verify gating behavior. */
const SAMPLE_OPTIONAL = [
  "@elizaos/plugin-pdf",
  "@elizaos/plugin-cli",
  "@elizaos/plugin-discord",
] as const;

describe("optional core plugins (require explicit opt-in)", () => {
  const prevCloudKey = process.env.ELIZAOS_CLOUD_API_KEY;
  const prevCloudEnabled = process.env.ELIZAOS_CLOUD_ENABLED;
  const prevOpenAiKey = process.env.OPENAI_API_KEY;
  const prevOllamaBaseUrl = process.env.OLLAMA_BASE_URL;

  beforeEach(() => {
    delete process.env.ELIZAOS_CLOUD_API_KEY;
    delete process.env.ELIZAOS_CLOUD_ENABLED;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OLLAMA_BASE_URL;
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
    if (prevOllamaBaseUrl !== undefined) {
      process.env.OLLAMA_BASE_URL = prevOllamaBaseUrl;
    } else {
      delete process.env.OLLAMA_BASE_URL;
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
          cli: { enabled: false },
          discord: { enabled: true },
        },
      },
    } as ElizaConfig);
    // Empty entry object should not enable
    expect(names.has("@elizaos/plugin-pdf")).toBe(false);
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
          authDir: "/tmp/milady-test-whatsapp-auth",
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
});
