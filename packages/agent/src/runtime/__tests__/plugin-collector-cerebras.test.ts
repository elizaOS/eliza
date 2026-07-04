/**
 * Unit coverage for collectPluginNames: a CEREBRAS_API_KEY in the environment
 * selects the OpenAI-compatible plugin. Deterministic env-driven collection —
 * env is snapshotted/restored, no plugin modules are loaded.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ElizaConfig } from "../../config/config";
import { collectPluginNames } from "../plugin-collector";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

function minimalConfig(): ElizaConfig {
  return {} as ElizaConfig;
}

describe("Cerebras plugin collection", () => {
  it("loads the OpenAI-compatible plugin from CEREBRAS_API_KEY", () => {
    process.env.CEREBRAS_API_KEY = "test-cerebras-api-key";
    delete process.env.OPENAI_API_KEY;

    const plugins = collectPluginNames(minimalConfig());

    expect(plugins.has("@elizaos/plugin-openai")).toBe(true);
  });
});
