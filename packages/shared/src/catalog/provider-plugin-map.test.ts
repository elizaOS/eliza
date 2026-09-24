/** Preserves the published provider environment-key contract in the generated registry artifact. */
import { describe, expect, it } from "vitest";
import providerPluginMap from "./provider-plugin-map.json" with {
  type: "json",
};

const expectedProviderPluginMap = {
  ANTHROPIC_API_KEY: "@elizaos/plugin-anthropic",
  CEREBRAS_API_KEY: "@elizaos/plugin-openai",
  ELIZAOS_CLOUD_API_KEY: "@elizaos/plugin-elizacloud",
  ELIZAOS_CLOUD_ENABLED: "@elizaos/plugin-elizacloud",
  NEARAI_API_KEY: "@elizaos/plugin-nearai",
  OPENAI_API_KEY: "@elizaos/plugin-openai",
};

describe("provider plugin map generation", () => {
  it("keeps the provider env contract in the generated artifact", () => {
    expect(providerPluginMap).toEqual(expectedProviderPluginMap);
  });
});
