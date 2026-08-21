// Exercises catalog behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "bun:test";
import {
  annotateCatalogModel,
  BITROUTER_NITRO_TEXT_MODEL,
  type CatalogModel,
  CEREBRAS_DEFAULT_TEXT_MODEL,
  CEREBRAS_DEFAULT_TEXT_SMALL_MODEL,
  FALLBACK_TEXT_SELECTOR_MODELS,
  STATIC_TEXT_CATALOG_MODELS,
  toSelectorModel,
} from "./catalog";

/**
 * #8426 — recommend the healthy Cerebras defaults, never the 503-flaky
 * `openai/gpt-oss-120b:nitro` gateway model. The :nitro id is still REACHABLE
 * (BYOK/gateway callers can name it) but must never carry the `recommended`
 * badge, or new users default onto the flaky path. The id constant is named
 * BITROUTER_NITRO_TEXT_MODEL (it is the nitro gateway id, NOT a recommended
 * one); these are the regression guards against a maintainer re-adding it to
 * the recommended set.
 */
describe("#8426 text catalog recommendation invariants", () => {
  const byId = (id: string): CatalogModel | undefined =>
    STATIC_TEXT_CATALOG_MODELS.find((m) => m.id === id);

  test("the healthy Cerebras default is recommended", () => {
    const model = byId(CEREBRAS_DEFAULT_TEXT_MODEL);
    expect(model?.recommended).toBe(true);
    expect(model?.tags).toContain("recommended");
  });

  test("the flaky :nitro gateway model is reachable but NOT recommended", () => {
    expect(BITROUTER_NITRO_TEXT_MODEL).toContain(":nitro");
    const nitro = byId(BITROUTER_NITRO_TEXT_MODEL);
    expect(nitro).toBeDefined(); // still selectable for BYOK/gateway callers...
    expect(nitro?.recommended).not.toBe(true); // ...but never badged recommended
    expect(nitro?.tags ?? []).not.toContain("recommended");
  });

  test("annotateCatalogModel never re-badges :nitro as recommended", () => {
    const annotated = annotateCatalogModel({
      id: BITROUTER_NITRO_TEXT_MODEL,
      object: "model",
      created: 0,
      owned_by: "openai",
      type: "language",
    });
    expect(annotated.recommended).not.toBe(true);
    expect(annotated.tags ?? []).not.toContain("recommended");
  });

  test("annotateCatalogModel DOES badge the Cerebras default id by id alone", () => {
    const annotated = annotateCatalogModel({
      id: CEREBRAS_DEFAULT_TEXT_SMALL_MODEL,
      object: "model",
      created: 0,
      owned_by: "cerebras",
      type: "language",
    });
    expect(annotated.recommended).toBe(true);
    expect(annotated.tags).toContain("recommended");
  });

  test("the selector list ranks the Cerebras default first (no :nitro at the top)", () => {
    const top = FALLBACK_TEXT_SELECTOR_MODELS[0];
    expect(top?.id).toBe(CEREBRAS_DEFAULT_TEXT_MODEL);
    expect(top?.id).not.toBe(BITROUTER_NITRO_TEXT_MODEL);
  });
});

describe("MiniMax static catalog", () => {
  test("generates the complete flagship M3 selector entry", () => {
    const modelId = "minimax/minimax-m3";
    const catalogModel = STATIC_TEXT_CATALOG_MODELS.find((model) => model.id === modelId);
    const selectorModel = FALLBACK_TEXT_SELECTOR_MODELS.find((model) => model.modelId === modelId);

    expect(catalogModel?.description).toBe("Flagship long-context agentic coding model");
    expect(selectorModel).toEqual({
      id: modelId,
      modelId,
      provider: "minimax",
      name: "Minimax M3",
      description: "Flagship long-context agentic coding model",
    });
  });

  test("does not derive a mini tier from the provider prefix", () => {
    const selectorModel = toSelectorModel({
      id: "minimax/agent-base",
      object: "model",
      created: 0,
      owned_by: "minimax",
    });

    expect(selectorModel.description).toBe("General-purpose language model");
  });

  test("keeps the mini heuristic for model names that explicitly use it", () => {
    const selectorModel = toSelectorModel({
      id: "minimax/agent-mini",
      object: "model",
      created: 0,
      owned_by: "minimax",
    });

    expect(selectorModel.description).toBe("Faster, lower-cost option");
  });
});

describe("OpenAI o-series selector metadata", () => {
  test.each(["openai/o3", "openai/o3-pro", "openai/o4-mini"])(
    "keeps %s in the reasoning family before generic variant heuristics",
    (modelId) => {
      const catalogModel = STATIC_TEXT_CATALOG_MODELS.find((model) => model.id === modelId);
      const selectorModel = FALLBACK_TEXT_SELECTOR_MODELS.find(
        (model) => model.modelId === modelId,
      );

      expect(catalogModel?.description).toBe("Reasoning-focused model");
      expect(selectorModel?.description).toBe("Reasoning-focused model");
    },
  );

  test("does not apply OpenAI o-series precedence to MiniMax or true mini models", () => {
    const expectedDescriptions = new Map([
      ["minimax/minimax-m3", "Flagship long-context agentic coding model"],
      ["openai/gpt-5-mini", "Faster, lower-cost option"],
    ]);

    for (const [modelId, description] of expectedDescriptions) {
      const catalogModel = STATIC_TEXT_CATALOG_MODELS.find((model) => model.id === modelId);
      const selectorModel = FALLBACK_TEXT_SELECTOR_MODELS.find(
        (model) => model.modelId === modelId,
      );

      expect(catalogModel?.description).toBe(description);
      expect(selectorModel?.description).toBe(description);
    }
  });
});

describe("Anthropic selector names", () => {
  test("title-cases the model id without an identity replacement", () => {
    const selectorModel = toSelectorModel({
      id: "anthropic/claude-sonnet-4-5",
      object: "model",
      created: 0,
      owned_by: "anthropic",
    });

    expect(selectorModel.name).toBe("Claude Sonnet 4 5");
  });
});
