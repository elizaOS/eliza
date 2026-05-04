import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_CONTEXT_WINDOW,
  DEFAULT_MODEL_MAX_TOKENS,
  normalizeModelMetadataInConfig,
  resolveModelTokenMetadata,
} from "./model-metadata.js";
import type { ElizaConfig, ModelDefinitionConfig } from "./types.js";

const completeModel = (
  overrides: Partial<ModelDefinitionConfig> & { id: string; name?: string },
): ModelDefinitionConfig => ({
  id: overrides.id,
  name: overrides.name ?? overrides.id,
  reasoning: overrides.reasoning ?? false,
  input: overrides.input ?? ["text"],
  cost: overrides.cost ?? {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  contextWindow: overrides.contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW,
  maxTokens: overrides.maxTokens ?? DEFAULT_MODEL_MAX_TOKENS,
  ...(overrides.api ? { api: overrides.api } : {}),
  ...(overrides.headers ? { headers: overrides.headers } : {}),
  ...(overrides.compat ? { compat: overrides.compat } : {}),
});

describe("model metadata", () => {
  it("normalizes optional model fields into required runtime metadata", () => {
    const config = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [
              {
                id: "tiny-model",
                name: "Tiny Model",
              },
            ],
          },
        },
      },
    } as ElizaConfig;

    normalizeModelMetadataInConfig(config);

    const model = config.models?.providers?.openai?.models[0];
    expect(model).toMatchObject({
      id: "tiny-model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: DEFAULT_MODEL_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MODEL_MAX_TOKENS,
    });
  });

  it("uses bedrock discovery token defaults for bedrock-discovered models", () => {
    const config = {
      models: {
        bedrockDiscovery: {
          defaultContextWindow: 32_000,
          defaultMaxTokens: 4_096,
        },
        providers: {
          bedrock: {
            baseUrl: "bedrock",
            models: [
              {
                id: "anthropic.claude-test",
                name: "Claude Test",
              },
            ],
          },
        },
      },
    } as ElizaConfig;

    normalizeModelMetadataInConfig(config);

    const model = config.models?.providers?.bedrock?.models[0];
    expect(model?.contextWindow).toBe(32_000);
    expect(model?.maxTokens).toBe(4_096);
  });

  it("resolves configured metadata by provider-qualified or bare model id", () => {
    const config = {
      models: {
        providers: {
          test: {
            baseUrl: "http://localhost",
            models: [
              completeModel({
                id: "tiny-model",
                contextWindow: 512,
                maxTokens: 128,
              }),
            ],
          },
        },
      },
    } as ElizaConfig;

    expect(resolveModelTokenMetadata(config, "test/tiny-model")).toMatchObject({
      providerId: "test",
      modelId: "tiny-model",
      contextWindow: 512,
      maxTokens: 128,
      source: "model-config",
    });
    expect(resolveModelTokenMetadata(config, "tiny-model")).toMatchObject({
      providerId: "test",
      source: "model-config",
    });
  });

  it("falls back to agent default context tokens before runtime defaults", () => {
    const config = {
      agents: {
        defaults: {
          contextTokens: 2_048,
        },
      },
    } as ElizaConfig;

    expect(resolveModelTokenMetadata(config, "missing")).toMatchObject({
      modelId: "missing",
      contextWindow: 2_048,
      maxTokens: DEFAULT_MODEL_MAX_TOKENS,
      source: "agent-defaults",
    });
  });
});
