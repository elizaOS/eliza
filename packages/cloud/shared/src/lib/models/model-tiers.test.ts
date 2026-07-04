// Exercises model tiers behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_IMAGE_MODEL_ID,
  SUPPORTED_IMAGE_MODEL_IDS,
} from "../services/ai-pricing-definitions";
import { CEREBRAS_DEFAULT_TEXT_MODEL } from "./catalog";
import {
  ADDITIONAL_IMAGE_MODELS,
  DEFAULT_IMAGE_MODEL,
  IMAGE_MODELS,
  IMAGE_TIERS,
  MODEL_TIERS,
  resolveModel,
} from "./model-tiers";

/**
 * #8426 — the new-user PRO tier default must resolve to a healthy Cerebras id,
 * never the 503-flaky `openai/gpt-oss-120b:nitro` gateway path. (Guards the
 * default; the MODEL_TIER_PRO_ID env override is resolved at module load.)
 */
describe("#8426 model-tier PRO default", () => {
  test("pro resolves to the Cerebras default and is flagged recommended", () => {
    expect(MODEL_TIERS.pro.modelId).toBe(CEREBRAS_DEFAULT_TEXT_MODEL);
    expect(MODEL_TIERS.pro.provider).toBe("cerebras");
    expect(MODEL_TIERS.pro.recommended).toBe(true);
  });

  test("resolveModel keeps Cerebras-native bare ids on Cerebras for billing", () => {
    expect(resolveModel("pro")).toMatchObject({
      modelId: CEREBRAS_DEFAULT_TEXT_MODEL,
      provider: "cerebras",
    });
    expect(resolveModel(CEREBRAS_DEFAULT_TEXT_MODEL)).toMatchObject({
      modelId: CEREBRAS_DEFAULT_TEXT_MODEL,
      provider: "cerebras",
    });
    expect(resolveModel("gpt-oss-120b")).toMatchObject({
      modelId: "gpt-oss-120b",
      provider: "cerebras",
    });
    expect(resolveModel("zai-glm-4.7")).toMatchObject({
      modelId: "zai-glm-4.7",
      provider: "cerebras",
    });
  });

  test("no model tier defaults onto a :nitro gateway id", () => {
    for (const tier of Object.values(MODEL_TIERS)) {
      expect(tier.modelId).not.toContain("nitro");
    }
  });
});

/**
 * #11005 — every model the image tier menu (and the runtime default) offers
 * MUST be a SUPPORTED_IMAGE_MODELS entry: /v1/generate-image 400s unknown ids
 * and 500s unpriced ones at cost estimation, before dispatch. The old menu
 * listed six BitRouter-billed models with no image:generation pricing row —
 * every selection 500'd "Pricing unavailable".
 */
describe("#11005 image tier menu", () => {
  test("every tier-menu image model is a supported (priced) catalog entry", () => {
    for (const model of [...IMAGE_MODELS, ...ADDITIONAL_IMAGE_MODELS]) {
      expect(SUPPORTED_IMAGE_MODEL_IDS).toContain(model.modelId);
    }
  });

  test("every image tier points at a supported catalog entry", () => {
    expect(IMAGE_TIERS.map((tier) => tier.id).sort()).toEqual(["fast", "pro", "ultra"]);
    for (const tier of IMAGE_TIERS) {
      expect(SUPPORTED_IMAGE_MODEL_IDS).toContain(tier.model.modelId);
    }
  });

  test("the tier-menu default matches the canonical default image model", () => {
    expect(DEFAULT_IMAGE_MODEL.modelId).toBe(DEFAULT_IMAGE_MODEL_ID);
  });

  test("no removed bitrouter image model survives in the menu", () => {
    const removed = new Set([
      "google/gemini-2.5-flash-image",
      "google/gemini-3-pro-image-preview",
      "google/gemini-3.1-flash-image-preview",
      "openai/gpt-5.4-image-2",
      "openai/gpt-5-image-mini",
      "openai/gpt-5-image",
    ]);
    for (const model of [...IMAGE_MODELS, ...ADDITIONAL_IMAGE_MODELS]) {
      expect(removed.has(model.modelId)).toBe(false);
    }
  });
});
