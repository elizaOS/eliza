/**
 * Behavioral coverage for model-definition normalization and per-model token
 * metadata resolution. Drives the real module: no mocks. Deterministic.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_CONTEXT_WINDOW,
  DEFAULT_MODEL_MAX_TOKENS,
  normalizeModelDefinitionConfig,
  normalizeModelMetadataInConfig,
  resolveModelTokenMetadata,
} from "./model-metadata.ts";
import type {
  ElizaConfig,
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "./types.ts";

function definition(
  partial: Partial<ModelDefinitionConfig> & { id: string },
): ModelDefinitionConfig {
  return {
    name: partial.id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_MODEL_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MODEL_MAX_TOKENS,
    ...partial,
    id: partial.id,
  };
}

function provider(models: ModelDefinitionConfig[]): ModelProviderConfig {
  return {
    baseUrl: "https://example.invalid",
    models,
  };
}

function configOf(
  providers: Record<string, ModelProviderConfig>,
  extras?: {
    bedrockDiscovery?: NonNullable<ElizaConfig["models"]>["bedrockDiscovery"];
    contextTokens?: number;
  },
): ElizaConfig {
  const config: ElizaConfig = {
    models: {
      providers,
      ...(extras?.bedrockDiscovery
        ? { bedrockDiscovery: extras.bedrockDiscovery }
        : {}),
    },
  };
  if (extras?.contextTokens !== undefined) {
    config.agents = { defaults: { contextTokens: extras.contextTokens } };
  }
  return config;
}

describe("model-metadata defaults", () => {
  it("exposes the documented runtime fallbacks", () => {
    expect(DEFAULT_MODEL_CONTEXT_WINDOW).toBe(128_000);
    expect(DEFAULT_MODEL_MAX_TOKENS).toBe(8_192);
  });
});

describe("normalizeModelDefinitionConfig", () => {
  it("fills every required field from an id-only partial", () => {
    const result = normalizeModelDefinitionConfig({ id: "gpt-4" });
    expect(result).toEqual({
      id: "gpt-4",
      name: "gpt-4",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: DEFAULT_MODEL_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MODEL_MAX_TOKENS,
    });
  });

  it("keeps a non-empty name and falls back to id for blank or non-string names", () => {
    expect(normalizeModelDefinitionConfig({ id: "m", name: "Opus" }).name).toBe(
      "Opus",
    );
    expect(
      normalizeModelDefinitionConfig({ id: "m", name: "  padded  " }).name,
    ).toBe("  padded  ");
    expect(normalizeModelDefinitionConfig({ id: "m", name: "" }).name).toBe(
      "m",
    );
    expect(normalizeModelDefinitionConfig({ id: "m", name: "   " }).name).toBe(
      "m",
    );
    expect(
      normalizeModelDefinitionConfig({
        id: "m",
        name: 12 as unknown as string,
      }).name,
    ).toBe("m");
  });

  it("coerces reasoning through Boolean()", () => {
    expect(normalizeModelDefinitionConfig({ id: "m" }).reasoning).toBe(false);
    expect(
      normalizeModelDefinitionConfig({ id: "m", reasoning: false }).reasoning,
    ).toBe(false);
    expect(
      normalizeModelDefinitionConfig({ id: "m", reasoning: true }).reasoning,
    ).toBe(true);
  });

  it("prefers the model's positive contextWindow, then defaults, then the runtime fallback", () => {
    expect(
      normalizeModelDefinitionConfig({ id: "m", contextWindow: 32_000 })
        .contextWindow,
    ).toBe(32_000);
    expect(
      normalizeModelDefinitionConfig(
        { id: "m", contextWindow: 0 },
        { contextWindow: 64_000 },
      ).contextWindow,
    ).toBe(64_000);
    expect(
      normalizeModelDefinitionConfig(
        { id: "m", contextWindow: -1 },
        { contextWindow: 0 },
      ).contextWindow,
    ).toBe(DEFAULT_MODEL_CONTEXT_WINDOW);
    expect(
      normalizeModelDefinitionConfig({ id: "m", contextWindow: 4096.9 })
        .contextWindow,
    ).toBe(4096);
    expect(
      normalizeModelDefinitionConfig({
        id: "m",
        contextWindow: Number.POSITIVE_INFINITY,
      }).contextWindow,
    ).toBe(DEFAULT_MODEL_CONTEXT_WINDOW);
    expect(
      normalizeModelDefinitionConfig({ id: "m", contextWindow: Number.NaN })
        .contextWindow,
    ).toBe(DEFAULT_MODEL_CONTEXT_WINDOW);
  });

  it("prefers the model's positive maxTokens, then defaults, then the runtime fallback", () => {
    expect(
      normalizeModelDefinitionConfig({ id: "m", maxTokens: 1024 }).maxTokens,
    ).toBe(1024);
    expect(
      normalizeModelDefinitionConfig(
        { id: "m", maxTokens: 0 },
        { maxTokens: 2048 },
      ).maxTokens,
    ).toBe(2048);
    expect(
      normalizeModelDefinitionConfig({ id: "m" }, { maxTokens: Number.NaN })
        .maxTokens,
    ).toBe(DEFAULT_MODEL_MAX_TOKENS);
    expect(
      normalizeModelDefinitionConfig({ id: "m", maxTokens: 512.8 }).maxTokens,
    ).toBe(512);
  });

  it("keeps only text/image modalities and defaults when the list is empty or invalid", () => {
    expect(normalizeModelDefinitionConfig({ id: "m" }).input).toEqual(["text"]);
    expect(
      normalizeModelDefinitionConfig({
        id: "m",
        input: "text" as unknown as ModelDefinitionConfig["input"],
      }).input,
    ).toEqual(["text"]);
    expect(
      normalizeModelDefinitionConfig({
        id: "m",
        input: [],
      }).input,
    ).toEqual(["text"]);
    expect(
      normalizeModelDefinitionConfig({
        id: "m",
        input: ["audio", "video"] as unknown as ModelDefinitionConfig["input"],
      }).input,
    ).toEqual(["text"]);
    expect(
      normalizeModelDefinitionConfig({
        id: "m",
        input: [
          "image",
          "audio",
          "text",
        ] as unknown as ModelDefinitionConfig["input"],
      }).input,
    ).toEqual(["image", "text"]);
    expect(
      normalizeModelDefinitionConfig({
        id: "m",
        input: ["text", "text", "image"],
      }).input,
    ).toEqual(["text", "text", "image"]);
  });

  it("does not share the default input array across calls", () => {
    const first = normalizeModelDefinitionConfig({ id: "a" });
    first.input.push("image");
    expect(normalizeModelDefinitionConfig({ id: "b" }).input).toEqual(["text"]);
  });

  it("normalizes cost, treating non-objects, negatives, and non-finite values as zero", () => {
    expect(normalizeModelDefinitionConfig({ id: "m" }).cost).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(
      normalizeModelDefinitionConfig({
        id: "m",
        cost: null as unknown as ModelDefinitionConfig["cost"],
      }).cost,
    ).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(
      normalizeModelDefinitionConfig({
        id: "m",
        cost: [1, 2] as unknown as ModelDefinitionConfig["cost"],
      }).cost,
    ).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(
      normalizeModelDefinitionConfig({
        id: "m",
        cost: {
          input: 1.5,
          output: 0,
          cacheRead: -3,
          cacheWrite: Number.POSITIVE_INFINITY,
        },
      }).cost,
    ).toEqual({
      input: 1.5,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(
      normalizeModelDefinitionConfig({
        id: "m",
        cost: {
          input: Number.NaN,
          output: 2,
          cacheRead: 3,
          cacheWrite: 4,
        },
      }).cost,
    ).toEqual({
      input: 0,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
    });
  });

  it("preserves extra model fields through the spread", () => {
    const result = normalizeModelDefinitionConfig({
      id: "m",
      api: "openai-completions",
      headers: { "x-test": "1" },
      compat: { maxTokensField: "max_tokens" },
    });
    expect(result.api).toBe("openai-completions");
    expect(result.headers).toEqual({ "x-test": "1" });
    expect(result.compat).toEqual({ maxTokensField: "max_tokens" });
  });
});

describe("normalizeModelMetadataInConfig", () => {
  it("is a no-op when models or providers are missing", () => {
    const empty: ElizaConfig = {};
    normalizeModelMetadataInConfig(empty);
    expect(empty).toEqual({});

    const noProviders: ElizaConfig = { models: {} };
    normalizeModelMetadataInConfig(noProviders);
    expect(noProviders.models).toEqual({});
  });

  it("is a no-op on an empty providers record", () => {
    const config: ElizaConfig = { models: { providers: {} } };
    normalizeModelMetadataInConfig(config);
    expect(config.models?.providers).toEqual({});
  });

  it("normalizes every model in place, including an empty models list", () => {
    const config = configOf({
      openai: provider([
        definition({ id: "gpt-4", name: "", contextWindow: 0, maxTokens: -1 }),
      ]),
      empty: provider([]),
    });
    normalizeModelMetadataInConfig(config);
    const openai = config.models?.providers?.openai.models[0];
    expect(openai?.name).toBe("gpt-4");
    expect(openai?.contextWindow).toBe(DEFAULT_MODEL_CONTEXT_WINDOW);
    expect(openai?.maxTokens).toBe(DEFAULT_MODEL_MAX_TOKENS);
    expect(config.models?.providers?.empty.models).toEqual([]);
  });

  it("applies bedrockDiscovery defaults only to the bedrock provider", () => {
    const config = configOf(
      {
        bedrock: provider([
          definition({ id: "titan", contextWindow: 0, maxTokens: 0 }),
        ]),
        openai: provider([
          definition({ id: "gpt-4", contextWindow: 0, maxTokens: 0 }),
        ]),
      },
      {
        bedrockDiscovery: {
          defaultContextWindow: 200_000,
          defaultMaxTokens: 4_096,
        },
      },
    );
    normalizeModelMetadataInConfig(config);
    expect(config.models?.providers?.bedrock.models[0]?.contextWindow).toBe(
      200_000,
    );
    expect(config.models?.providers?.bedrock.models[0]?.maxTokens).toBe(4_096);
    expect(config.models?.providers?.openai.models[0]?.contextWindow).toBe(
      DEFAULT_MODEL_CONTEXT_WINDOW,
    );
    expect(config.models?.providers?.openai.models[0]?.maxTokens).toBe(
      DEFAULT_MODEL_MAX_TOKENS,
    );
  });

  it("does not let bedrockDiscovery override a model's own positive token fields", () => {
    const config = configOf(
      {
        bedrock: provider([
          definition({ id: "titan", contextWindow: 50_000, maxTokens: 1_024 }),
        ]),
      },
      {
        bedrockDiscovery: {
          defaultContextWindow: 200_000,
          defaultMaxTokens: 4_096,
        },
      },
    );
    normalizeModelMetadataInConfig(config);
    expect(config.models?.providers?.bedrock.models[0]?.contextWindow).toBe(
      50_000,
    );
    expect(config.models?.providers?.bedrock.models[0]?.maxTokens).toBe(1_024);
  });

  it("ignores invalid bedrockDiscovery defaults and does not leak them to other providers", () => {
    const config = configOf(
      {
        bedrock: provider([definition({ id: "titan" })]),
        openai: provider([definition({ id: "gpt-4" })]),
      },
      {
        bedrockDiscovery: {
          defaultContextWindow: 0,
          defaultMaxTokens: -8,
        },
      },
    );
    normalizeModelMetadataInConfig(config);
    expect(config.models?.providers?.bedrock.models[0]?.contextWindow).toBe(
      DEFAULT_MODEL_CONTEXT_WINDOW,
    );
    expect(config.models?.providers?.openai.models[0]?.contextWindow).toBe(
      DEFAULT_MODEL_CONTEXT_WINDOW,
    );
  });
});

describe("resolveModelTokenMetadata", () => {
  it("returns runtime defaults when config, model id, or providers are missing", () => {
    expect(resolveModelTokenMetadata()).toEqual({
      modelId: "runtime-default",
      contextWindow: DEFAULT_MODEL_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MODEL_MAX_TOKENS,
      source: "runtime-default",
    });
    expect(resolveModelTokenMetadata({}, "gpt-4")).toEqual({
      modelId: "gpt-4",
      contextWindow: DEFAULT_MODEL_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MODEL_MAX_TOKENS,
      source: "runtime-default",
    });
    expect(resolveModelTokenMetadata(configOf({}), "gpt-4").source).toBe(
      "runtime-default",
    );
    expect(
      resolveModelTokenMetadata(configOf({ openai: provider([]) }), "gpt-4")
        .source,
    ).toBe("runtime-default");
  });

  it("treats a blank or whitespace-only model id as missing", () => {
    const cfg = configOf({
      openai: provider([definition({ id: "gpt-4", contextWindow: 32_000 })]),
    });
    expect(resolveModelTokenMetadata(cfg, "").source).toBe("runtime-default");
    expect(resolveModelTokenMetadata(cfg, "   ").source).toBe(
      "runtime-default",
    );
    expect(resolveModelTokenMetadata(cfg, undefined).modelId).toBe(
      "runtime-default",
    );
  });

  it("matches a configured model by id, ignoring case and surrounding whitespace", () => {
    const cfg = configOf({
      openai: provider([
        definition({
          id: "GPT-4",
          contextWindow: 32_000,
          maxTokens: 4_096,
        }),
      ]),
    });
    expect(resolveModelTokenMetadata(cfg, "  gpt-4  ")).toEqual({
      modelId: "GPT-4",
      providerId: "openai",
      contextWindow: 32_000,
      maxTokens: 4_096,
      source: "model-config",
    });
  });

  it("matches provider/model, provider/suffix, and bare suffix keys", () => {
    const cfg = configOf({
      OpenAI: provider([
        definition({
          id: "org/gpt-4",
          contextWindow: 10_000,
          maxTokens: 111,
        }),
      ]),
    });
    expect(resolveModelTokenMetadata(cfg, "org/gpt-4").source).toBe(
      "model-config",
    );
    expect(resolveModelTokenMetadata(cfg, "openai/org/gpt-4").modelId).toBe(
      "org/gpt-4",
    );
    expect(resolveModelTokenMetadata(cfg, "openai/gpt-4").contextWindow).toBe(
      10_000,
    );
    expect(resolveModelTokenMetadata(cfg, "gpt-4").providerId).toBe("OpenAI");
  });

  it("returns the first provider and first model that match in enumeration order", () => {
    const cfg = configOf({
      first: provider([
        definition({ id: "shared", contextWindow: 1_000, maxTokens: 10 }),
        definition({ id: "other", contextWindow: 2_000, maxTokens: 20 }),
      ]),
      second: provider([
        definition({ id: "shared", contextWindow: 9_000, maxTokens: 90 }),
      ]),
    });
    expect(resolveModelTokenMetadata(cfg, "shared")).toEqual({
      modelId: "shared",
      providerId: "first",
      contextWindow: 1_000,
      maxTokens: 10,
      source: "model-config",
    });
  });

  it("falls back to runtime token defaults when a matched model has invalid windows", () => {
    const cfg = configOf({
      openai: provider([
        definition({
          id: "gpt-4",
          contextWindow: 0,
          maxTokens: Number.NaN,
        }),
      ]),
    });
    expect(resolveModelTokenMetadata(cfg, "gpt-4")).toEqual({
      modelId: "gpt-4",
      providerId: "openai",
      contextWindow: DEFAULT_MODEL_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MODEL_MAX_TOKENS,
      source: "model-config",
    });
  });

  it("uses agent-defaults contextTokens when no model config matches", () => {
    const cfg = configOf(
      {
        openai: provider([definition({ id: "gpt-4", contextWindow: 32_000 })]),
      },
      { contextTokens: 64_000 },
    );
    expect(resolveModelTokenMetadata(cfg, "missing-model")).toEqual({
      modelId: "missing-model",
      contextWindow: 64_000,
      maxTokens: DEFAULT_MODEL_MAX_TOKENS,
      source: "agent-defaults",
    });
    expect(resolveModelTokenMetadata(cfg, "  claude  ").modelId).toBe("claude");
    expect(resolveModelTokenMetadata(cfg).modelId).toBe("runtime-default");
  });

  it("ignores non-positive agent-defaults contextTokens and uses runtime defaults", () => {
    expect(
      resolveModelTokenMetadata(configOf({}, { contextTokens: 0 }), "gpt-4")
        .source,
    ).toBe("runtime-default");
    expect(
      resolveModelTokenMetadata(configOf({}, { contextTokens: -5 }), "gpt-4")
        .source,
    ).toBe("runtime-default");
  });

  it("prefers a matching model-config entry over agent-defaults", () => {
    const cfg = configOf(
      {
        openai: provider([
          definition({ id: "gpt-4", contextWindow: 8_000, maxTokens: 256 }),
        ]),
      },
      { contextTokens: 64_000 },
    );
    expect(resolveModelTokenMetadata(cfg, "gpt-4")).toEqual({
      modelId: "gpt-4",
      providerId: "openai",
      contextWindow: 8_000,
      maxTokens: 256,
      source: "model-config",
    });
  });

  it("does not attach providerId on agent-defaults or runtime-default results", () => {
    expect(
      resolveModelTokenMetadata(configOf({}, { contextTokens: 4_000 }), "x"),
    ).not.toHaveProperty("providerId");
    expect(resolveModelTokenMetadata(undefined, "x")).not.toHaveProperty(
      "providerId",
    );
  });
});
