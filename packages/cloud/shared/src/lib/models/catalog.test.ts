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
