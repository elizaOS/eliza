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

  it("leaves the default (non-lean) desktop set carrying the full surfaces", () => {
    // No ELIZA_PLUGIN_SET → default CORE_PLUGINS seed on desktop.
    const names = collectPluginNames(emptyConfig);
    expect(names.has("@elizaos/plugin-shell")).toBe(true);
    expect(names.has("@elizaos/plugin-coding-tools")).toBe(true);
    expect(names.has("@elizaos/plugin-browser")).toBe(true);
  });
});
