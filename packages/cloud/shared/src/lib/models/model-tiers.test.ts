import { describe, expect, test } from "bun:test";
import { CEREBRAS_DEFAULT_TEXT_LARGE_MODEL, CEREBRAS_DEFAULT_TEXT_SMALL_MODEL } from "./catalog";
import { MODEL_TIERS, resolveModel } from "./model-tiers";

/**
 * #8426 — the new-user PRO tier default must resolve to a healthy Cerebras id,
 * never the 503-flaky `openai/gpt-oss-120b:nitro` gateway path. (Guards the
 * default; the MODEL_TIER_PRO_ID env override is resolved at module load.)
 */
describe("#8426 model-tier PRO default", () => {
  test("pro resolves to the Cerebras default and is flagged recommended", () => {
    expect(MODEL_TIERS.pro.modelId).toBe(CEREBRAS_DEFAULT_TEXT_SMALL_MODEL); // gpt-oss-120b
    expect(MODEL_TIERS.pro.provider).toBe("cerebras");
    expect(MODEL_TIERS.pro.recommended).toBe(true);
  });

  test("resolveModel keeps Cerebras-native bare ids on Cerebras for billing", () => {
    expect(resolveModel("pro")).toMatchObject({
      modelId: CEREBRAS_DEFAULT_TEXT_SMALL_MODEL,
      provider: "cerebras",
    });
    expect(resolveModel(CEREBRAS_DEFAULT_TEXT_SMALL_MODEL)).toMatchObject({
      modelId: CEREBRAS_DEFAULT_TEXT_SMALL_MODEL,
      provider: "cerebras",
    });
    expect(resolveModel(CEREBRAS_DEFAULT_TEXT_LARGE_MODEL)).toMatchObject({
      modelId: CEREBRAS_DEFAULT_TEXT_LARGE_MODEL,
      provider: "cerebras",
    });
  });

  test("no model tier defaults onto a :nitro gateway id", () => {
    for (const tier of Object.values(MODEL_TIERS)) {
      expect(tier.modelId).not.toContain("nitro");
    }
  });
});
