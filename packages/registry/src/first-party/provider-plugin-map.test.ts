/**
 * Guards the generated provider→plugin env-key map: the contract is preserved in
 * the built artifact, keys are derived only from explicit config markers, and
 * duplicate env-key claims across plugins are rejected.
 */
import { describe, expect, it } from "vitest";
import { collectProviderPluginMap } from "./generate";
import providerPluginMap from "./provider-plugin-map.json" with {
  type: "json",
};
import type { RegistryEntry } from "./schema";

const expectedProviderPluginMap = {
  AIGATEWAY_API_KEY: "@elizaos/plugin-vercel-ai-gateway",
  AI_GATEWAY_API_KEY: "@elizaos/plugin-vercel-ai-gateway",
  ANTHROPIC_API_KEY: "@elizaos/plugin-anthropic",
  CEREBRAS_API_KEY: "@elizaos/plugin-openai",
  ELIZAOS_CLOUD_API_KEY: "@elizaos/plugin-elizacloud",
  ELIZAOS_CLOUD_ENABLED: "@elizaos/plugin-elizacloud",
  ELIZA_CHAT_VIA_CLI: "@elizaos/plugin-cli-inference",
  GEMINI_API_KEY: "@elizaos/plugin-google-genai",
  GOOGLE_API_KEY: "@elizaos/plugin-google-genai",
  GOOGLE_GENERATIVE_AI_API_KEY: "@elizaos/plugin-google-genai",
  GROQ_API_KEY: "@elizaos/plugin-groq",
  NEARAI_API_KEY: "@elizaos/plugin-nearai",
  OLLAMA_BASE_URL: "@elizaos/plugin-ollama",
  OPENAI_API_KEY: "@elizaos/plugin-openai",
  OPENROUTER_API_KEY: "@elizaos/plugin-openrouter",
  XAI_API_KEY: "@elizaos/plugin-xai",
  ZAI_API_KEY: "@elizaos/plugin-zai",
  Z_AI_API_KEY: "@elizaos/plugin-zai",
};

function providerEntry(
  id: string,
  npmName: string,
  envKey: string,
): RegistryEntry {
  return {
    id,
    name: id,
    npmName,
    source: "bundled",
    tags: ["ai-provider"],
    config: {
      [envKey]: {
        type: "secret",
        required: false,
        sensitive: true,
        autoEnableProvider: true,
      },
    },
    render: {
      visible: true,
      pinTo: [],
      style: "card",
      group: "models",
      actions: [],
    },
    resources: {},
    dependsOn: [],
    channels: [],
    kind: "plugin",
    subtype: "ai-provider",
  };
}

describe("provider plugin map generation", () => {
  it("keeps the provider env contract in the generated artifact", () => {
    expect(providerPluginMap).toEqual(expectedProviderPluginMap);
  });

  it("derives provider env keys only from explicit config markers", () => {
    expect(
      collectProviderPluginMap([
        providerEntry("marked", "@elizaos/plugin-marked", "MARKED_API_KEY"),
        {
          ...providerEntry(
            "unmarked",
            "@elizaos/plugin-unmarked",
            "UNMARKED_API_KEY",
          ),
          config: {
            UNMARKED_API_KEY: {
              type: "secret",
              required: false,
              sensitive: true,
            },
          },
        },
      ]),
    ).toEqual({ MARKED_API_KEY: "@elizaos/plugin-marked" });
  });

  it("rejects duplicate provider env-key claims", () => {
    expect(() =>
      collectProviderPluginMap([
        providerEntry("one", "@elizaos/plugin-one", "DUPLICATE_API_KEY"),
        providerEntry("two", "@elizaos/plugin-two", "DUPLICATE_API_KEY"),
      ]),
    ).toThrow(
      'provider env key "DUPLICATE_API_KEY" claimed by both @elizaos/plugin-one and @elizaos/plugin-two',
    );
  });
});
