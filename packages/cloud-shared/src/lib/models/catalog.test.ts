import { describe, expect, test } from "bun:test";
import {
  annotateCatalogModel,
  BITROUTER_RECOMMENDED_TEXT_MODEL,
  CEREBRAS_DEFAULT_TEXT_LARGE_MODEL,
  CEREBRAS_DEFAULT_TEXT_SMALL_MODEL,
  type CatalogModel,
  FALLBACK_TEXT_SELECTOR_MODELS,
  STATIC_TEXT_CATALOG_MODELS,
} from "./catalog";

/**
 * #8426 — recommend the healthy Cerebras defaults, never the 503-flaky
 * `openai/gpt-oss-120b:nitro` gateway model. The :nitro id is still REACHABLE
 * (BYOK/gateway callers can name it) but must never carry the `recommended`
 * badge, or new users default onto the flaky path. The export's name still says
 * RECOMMENDED, so these are the regression guards against a maintainer being
 * lured into re-adding it.
 */
describe("#8426 text catalog recommendation invariants", () => {
  const byId = (id: string): CatalogModel | undefined =>
    STATIC_TEXT_CATALOG_MODELS.find((m) => m.id === id);

  test("the two healthy Cerebras defaults are recommended", () => {
    const small = byId(CEREBRAS_DEFAULT_TEXT_SMALL_MODEL); // gpt-oss-120b
    const large = byId(CEREBRAS_DEFAULT_TEXT_LARGE_MODEL); // zai-glm-4.7
    expect(small?.recommended).toBe(true);
    expect(small?.tags).toContain("recommended");
    expect(large?.recommended).toBe(true);
    expect(large?.tags).toContain("recommended");
  });

  test("the flaky :nitro gateway model is reachable but NOT recommended", () => {
    expect(BITROUTER_RECOMMENDED_TEXT_MODEL).toContain(":nitro");
    const nitro = byId(BITROUTER_RECOMMENDED_TEXT_MODEL);
    expect(nitro).toBeDefined(); // still selectable for BYOK/gateway callers...
    expect(nitro?.recommended).not.toBe(true); // ...but never badged recommended
    expect(nitro?.tags ?? []).not.toContain("recommended");
  });

  test("annotateCatalogModel never re-badges :nitro as recommended (the name is a trap)", () => {
    const annotated = annotateCatalogModel({
      id: BITROUTER_RECOMMENDED_TEXT_MODEL,
      object: "model",
      created: 0,
      owned_by: "openai",
      type: "language",
    });
    expect(annotated.recommended).not.toBe(true);
    expect(annotated.tags ?? []).not.toContain("recommended");
  });

  test("annotateCatalogModel DOES badge the Cerebras default ids by id alone", () => {
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

  test("the selector list ranks the two Cerebras defaults first (no :nitro at the top)", () => {
    const topTwo = FALLBACK_TEXT_SELECTOR_MODELS.slice(0, 2).map((m) => m.id);
    expect(topTwo).toContain(CEREBRAS_DEFAULT_TEXT_SMALL_MODEL);
    expect(topTwo).toContain(CEREBRAS_DEFAULT_TEXT_LARGE_MODEL);
    expect(topTwo).not.toContain(BITROUTER_RECOMMENDED_TEXT_MODEL);
  });
});
