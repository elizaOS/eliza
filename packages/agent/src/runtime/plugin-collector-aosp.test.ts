import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ElizaConfig } from "../config/config.ts";
import { collectPluginNames } from "./plugin-collector.ts";

const ENV_KEYS = [
  "ELIZA_PLATFORM",
  "ELIZA_LOCAL_LLAMA",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_ENABLED",
  "ELIZA_DISABLE_LOCAL_EMBEDDINGS",
  "ELIZA_CLOUD_PROVISIONED",
  "MILADY_BUILD_VARIANT",
  "ELIZA_BUILD_VARIANT",
  "ELIZA_AGENT_ORCHESTRATOR",
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

const emptyConfig: ElizaConfig = {} as ElizaConfig;

describe("collectPluginNames AOSP terminal plugins", () => {
  it("includes shell + coding-tools + orchestrator on AOSP (android + ELIZA_LOCAL_LLAMA=1)", () => {
    process.env.ELIZA_PLATFORM = "android";
    process.env.ELIZA_LOCAL_LLAMA = "1";
    const names = collectPluginNames(emptyConfig);
    expect(names.has("@elizaos/plugin-shell")).toBe(true);
    expect(names.has("@elizaos/plugin-coding-tools")).toBe(true);
    expect(names.has("agent-orchestrator")).toBe(true);
  });

  it("excludes shell + coding-tools + orchestrator on stock Android (no ELIZA_LOCAL_LLAMA)", () => {
    process.env.ELIZA_PLATFORM = "android";
    const names = collectPluginNames(emptyConfig);
    expect(names.has("@elizaos/plugin-shell")).toBe(false);
    expect(names.has("@elizaos/plugin-coding-tools")).toBe(false);
    expect(names.has("agent-orchestrator")).toBe(false);
  });

  it("excludes shell + coding-tools + orchestrator on iOS", () => {
    process.env.ELIZA_PLATFORM = "ios";
    const names = collectPluginNames(emptyConfig);
    expect(names.has("@elizaos/plugin-shell")).toBe(false);
    expect(names.has("@elizaos/plugin-coding-tools")).toBe(false);
    expect(names.has("agent-orchestrator")).toBe(false);
  });

  it("includes ELIZAOS_ANDROID_CORE_PLUGINS alongside terminal plugins on AOSP", () => {
    process.env.ELIZA_PLATFORM = "android";
    process.env.ELIZA_LOCAL_LLAMA = "1";
    const names = collectPluginNames(emptyConfig);
    expect(names.has("@elizaos/app-wifi")).toBe(true);
    expect(names.has("@elizaos/app-contacts")).toBe(true);
    expect(names.has("@elizaos/app-phone")).toBe(true);
  });

  it("respects features.shellEnabled=false on AOSP — removes plugin-shell, keeps coding-tools", () => {
    process.env.ELIZA_PLATFORM = "android";
    process.env.ELIZA_LOCAL_LLAMA = "1";
    const config: ElizaConfig = {
      features: { shellEnabled: false },
    } as ElizaConfig;
    const names = collectPluginNames(config);
    expect(names.has("@elizaos/plugin-shell")).toBe(false);
    expect(names.has("@elizaos/plugin-coding-tools")).toBe(true);
  });

  it("removes local execution plugins from store desktop builds even when config asks for them", () => {
    process.env.MILADY_BUILD_VARIANT = "store";
    process.env.ELIZA_AGENT_ORCHESTRATOR = "1";
    const config: ElizaConfig = {
      features: { codingTools: true },
      plugins: {
        allow: ["coding-tools", "shell"],
        entries: {
          "coding-tools": { enabled: true },
          shell: { enabled: true },
        },
      },
    } as ElizaConfig;
    const names = collectPluginNames(config);
    expect(names.has("@elizaos/plugin-shell")).toBe(false);
    expect(names.has("@elizaos/plugin-coding-tools")).toBe(false);
    expect(names.has("agent-orchestrator")).toBe(false);
    expect(names.has("@elizaos/plugin-agent-orchestrator")).toBe(false);
  });
});
