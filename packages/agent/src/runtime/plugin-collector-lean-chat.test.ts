/**
 * Covers collectPluginNames() under the lean-chat plugin set (#8434): the
 * minimal conversational seed is kept while heavy coding/browser/orchestrator/
 * local-inference/wallet/workflow surfaces are force-dropped even when config
 * allow-lists or env request them, and elizacloud stays for a cloud agent.
 * Deterministic — env-driven over an in-memory ElizaConfig, no live model.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ElizaConfig } from "../config/config.ts";
import { collectPluginNames } from "./plugin-collector.ts";

// Lean chat (ELIZA_PLUGIN_SET=lean-chat) is for dedicated, off-mobile cloud
// chat agents: it seeds the minimal LEAN_CHAT_PLUGINS set and force-drops the
// heavy coding/automation surfaces (#8434). Browser stays off until ready.
const ENV_KEYS = [
  "ELIZA_PLATFORM",
  "ELIZA_PLUGIN_SET",
  "ELIZA_AGENT_ORCHESTRATOR",
  "ELIZA_LOCAL_LLAMA",
  "ELIZA_BUILD_VARIANT",
  "ELIZAOS_CLOUD_ENABLED",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZA_CLOUD_PROVISIONED",
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

const HEAVY = [
  "@elizaos/plugin-shell",
  "@elizaos/plugin-coding-tools",
  "@elizaos/plugin-browser",
  "agent-orchestrator",
  "@elizaos/plugin-agent-orchestrator",
  "@elizaos/plugin-gitpathologist",
];

describe("collectPluginNames lean-chat plugin set (#8434)", () => {
  it("seeds the lean chat set and excludes heavy/coding/browser surfaces", () => {
    process.env.ELIZA_PLUGIN_SET = "lean-chat";
    const names = collectPluginNames(emptyConfig);

    // Lean chat keeps the conversational essentials.
    expect(names.has("@elizaos/plugin-sql")).toBe(true);
    expect(names.has("@elizaos/plugin-app-control")).toBe(true);
    expect(names.has("@elizaos/plugin-commands")).toBe(true);
    expect(names.has("@elizaos/plugin-agent-skills")).toBe(true);

    // ...and drops every heavy surface, including browser (off until ready).
    for (const heavy of HEAVY) {
      expect(names.has(heavy)).toBe(false);
    }
  });

  it("force-excludes the orchestrator even when ELIZA_AGENT_ORCHESTRATOR=1", () => {
    process.env.ELIZA_PLUGIN_SET = "lean-chat";
    process.env.ELIZA_AGENT_ORCHESTRATOR = "1";
    const names = collectPluginNames(emptyConfig);
    expect(names.has("agent-orchestrator")).toBe(false);
    expect(names.has("@elizaos/plugin-agent-orchestrator")).toBe(false);
  });

  it("force-excludes heavy plugins even when a config allow-list requests them", () => {
    process.env.ELIZA_PLUGIN_SET = "lean-chat";
    const config: ElizaConfig = {
      plugins: {
        allow: ["shell", "coding-tools", "browser"],
        entries: {
          shell: { enabled: true },
          "coding-tools": { enabled: true },
          browser: { enabled: true },
        },
      },
      features: { shell: true, codingTools: true, browser: true },
    } as ElizaConfig;
    const names = collectPluginNames(config);
    expect(names.has("@elizaos/plugin-shell")).toBe(false);
    expect(names.has("@elizaos/plugin-coding-tools")).toBe(false);
    expect(names.has("@elizaos/plugin-browser")).toBe(false);
  });

  it("force-excludes the perf-critical local-inference/wallet/workflow surfaces (#8769/#8434)", () => {
    // These three are in LEAN_CHAT_EXCLUDED_PLUGINS for cold-start + the
    // 384/1536 embedding-dim reasons; a regression re-adding any of them would
    // regress lean cold-start and (local-inference) re-introduce the dim
    // mismatch. The existing tests only cover shell/coding/browser/orchestrator.
    process.env.ELIZA_PLUGIN_SET = "lean-chat";
    const names = collectPluginNames(emptyConfig);
    expect(names.has("@elizaos/plugin-local-inference")).toBe(false);
    expect(names.has("@elizaos/plugin-wallet")).toBe(false);
    expect(names.has("@elizaos/plugin-workflow")).toBe(false);
  });

  it("keeps plugin-elizacloud for a lean CLOUD agent (cloud serves models + 1536 embeddings)", () => {
    // A lean dedicated cloud agent drops local-inference but MUST keep
    // elizacloud — that is the inference + 1536-embedding provider for the
    // cloud chat path. Dropping both would leave the agent with no model.
    process.env.ELIZA_PLUGIN_SET = "lean-chat";
    process.env.ELIZAOS_CLOUD_ENABLED = "true";
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    const names = collectPluginNames(emptyConfig);
    expect(names.has("@elizaos/plugin-elizacloud")).toBe(true);
    expect(names.has("@elizaos/plugin-local-inference")).toBe(false);
  });

  it("leaves the default (non-lean) desktop set carrying the full surfaces", () => {
    // No ELIZA_PLUGIN_SET → default CORE_PLUGINS seed on desktop.
    const names = collectPluginNames(emptyConfig);
    expect(names.has("@elizaos/plugin-shell")).toBe(true);
    expect(names.has("@elizaos/plugin-coding-tools")).toBe(true);
    expect(names.has("@elizaos/plugin-browser")).toBe(true);
  });
});
