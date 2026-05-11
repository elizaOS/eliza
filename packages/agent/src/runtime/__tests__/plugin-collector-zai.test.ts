import type { ElizaConfig } from "../../config/config";
import {
  collectPluginNames,
  resolvePluginPackageAlias,
} from "../plugin-collector";
import { afterEach, describe, expect, it } from "vitest";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

function minimalConfig(): ElizaConfig {
  return {} as ElizaConfig;
}

describe("z.ai plugin collection", () => {
  it("normalizes legacy external z.ai package references", () => {
    expect(resolvePluginPackageAlias("@homunculuslabs/plugin-zai")).toBe("@elizaos/plugin-zai");
  });

  it("loads the first-party z.ai plugin from canonical ZAI_API_KEY", () => {
    process.env.ZAI_API_KEY = "test-key";
    delete process.env.Z_AI_API_KEY;

    const plugins = collectPluginNames(minimalConfig());

    expect(plugins.has("@elizaos/plugin-zai")).toBe(true);
    expect(plugins.has("@homunculuslabs/plugin-zai")).toBe(false);
  });

  it("loads the first-party z.ai plugin from legacy Z_AI_API_KEY", () => {
    delete process.env.ZAI_API_KEY;
    process.env.Z_AI_API_KEY = "test-key";

    const plugins = collectPluginNames(minimalConfig());

    expect(plugins.has("@elizaos/plugin-zai")).toBe(true);
    expect(plugins.has("@homunculuslabs/plugin-zai")).toBe(false);
  });
});
