/**
 * Unit coverage for collectPluginNames: a NEARAI_API_KEY in the environment
 * selects the first-party NEAR AI plugin. Deterministic env-driven collection —
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

describe("NEAR AI plugin collection", () => {
  it("loads the first-party NEAR AI plugin from NEARAI_API_KEY", () => {
    process.env.NEARAI_API_KEY = "test-key";

    const plugins = collectPluginNames(minimalConfig());

    expect(plugins.has("@elizaos/plugin-nearai")).toBe(true);
  });
});
