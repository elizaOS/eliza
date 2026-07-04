/**
 * Unit coverage for the model catalog: tier ids, eligible defaults, lookup, and
 * first-run recommendation. Pure data, no downloads.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ELIGIBLE_MODEL_IDS,
  ELIZA_1_TIER_IDS,
  FIRST_RUN_DEFAULT_MODEL_ID,
  findCatalogModel,
  MODEL_CATALOG,
} from "./catalog";
import { recommendForFirstRun } from "./recommendation";
import { localInferenceService } from "./service";

const EXPECTED_ELIZA_1_DISPLAY_NAMES: Record<string, string> = {
  "eliza-1-2b": "eliza-1-2B",
  "eliza-1-4b": "eliza-1-4B",
  "eliza-1-9b": "eliza-1-9B",
  "eliza-1-27b": "eliza-1-27B",
  "eliza-1-27b-256k": "eliza-1-27B-256k",
};

describe("local inference catalog", () => {
  it("ships exactly the Eliza-1 size tiers", () => {
    expect(
      MODEL_CATALOG.filter((m) => !m.hiddenFromCatalog)
        .map((m) => m.id)
        .sort(),
    ).toEqual([...ELIZA_1_TIER_IDS].sort());
  });

  it("marks ONLY the Eliza-1 size tiers as default-eligible", () => {
    expect([...DEFAULT_ELIGIBLE_MODEL_IDS].sort()).toEqual(
      [...ELIZA_1_TIER_IDS].sort(),
    );
    for (const id of ELIZA_1_TIER_IDS) {
      expect(DEFAULT_ELIGIBLE_MODEL_IDS.has(id), `${id} not eligible`).toBe(
        true,
      );
    }
    for (const model of MODEL_CATALOG.filter((m) => !m.hiddenFromCatalog)) {
      expect(model.id.startsWith("eliza-1-")).toBe(true);
    }
  });

  it("uses eliza-1 size ids as user-facing display names", () => {
    for (const id of ELIZA_1_TIER_IDS) {
      const model = findCatalogModel(id);
      expect(model, `${id} missing`).toBeTruthy();
      expect(model?.displayName).toBe(EXPECTED_ELIZA_1_DISPLAY_NAMES[id]);
      expect(model?.blurb).toMatch(
        new RegExp(`^${EXPECTED_ELIZA_1_DISPLAY_NAMES[id]}\\b`),
      );
      expect(`${model?.displayName} ${model?.blurb}`).not.toMatch(
        /\b(?:Qwen|Llama)\b/i,
      );
    }
  });

  it("does not expose hidden companion entries in the hub", () => {
    const visible = localInferenceService.getCatalog();
    const visibleIds = new Set(visible.map((model) => model.id));
    const hiddenCompanionIds = MODEL_CATALOG.filter(
      (model) => model.hiddenFromCatalog || model.runtimeRole === "mtp-drafter",
    ).map((model) => model.id);
    expect(hiddenCompanionIds.filter((id) => visibleIds.has(id))).toEqual([]);
    expect(visible.flatMap((model) => model.companionModelIds ?? [])).toEqual(
      [],
    );
  });

  it("keeps the visible model hub focused on Eliza-1 only", () => {
    const visible = localInferenceService.getCatalog();
    expect(visible.map((model) => model.id).sort()).toEqual(
      [...ELIZA_1_TIER_IDS].sort(),
    );
    expect(
      visible.filter((model) => DEFAULT_ELIGIBLE_MODEL_IDS.has(model.id))
        .length,
    ).toBe(visible.length);
  });

  it("declares contextLength on every entry whose blurb claims a long window", () => {
    const longContextRegex =
      /\b(?:128k|256k|long.*context|long-context|128 ?k tokens?)\b/i;
    const offenders: string[] = [];
    for (const model of MODEL_CATALOG) {
      if (!longContextRegex.test(model.blurb)) continue;
      if (
        typeof model.contextLength !== "number" ||
        model.contextLength < 65536
      ) {
        offenders.push(
          `${model.id} claims long context in blurb but contextLength=${String(model.contextLength)}`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  it("sets contextLength on every Eliza-1 tier per the tier matrix", () => {
    const expected: Record<string, number> = {
      "eliza-1-2b": 131072,
      "eliza-1-4b": 131072,
      "eliza-1-9b": 131072,
      "eliza-1-27b": 131072,
      "eliza-1-27b-256k": 262144,
    };
    for (const [id, expectedLength] of Object.entries(expected)) {
      const model = findCatalogModel(id);
      expect(model, `${id} missing from catalog`).toBeTruthy();
      expect(model?.contextLength, `${id} contextLength mismatch`).toBe(
        expectedLength,
      );
    }
  });

  it("sets a tokenizerFamily on every chat/code/reasoning entry", () => {
    const offenders: string[] = [];
    for (const model of MODEL_CATALOG) {
      if (!model.tokenizerFamily) {
        offenders.push(model.id);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("does not publish external drafter companion entries", () => {
    const drafters = MODEL_CATALOG.filter(
      (model) => model.runtimeRole === "mtp-drafter",
    );
    expect(drafters).toEqual([]);
  });

  it("does not ship non-Eliza local model entries", () => {
    const offenders: string[] = [];
    for (const model of MODEL_CATALOG) {
      if (!model.id.startsWith("eliza-1-")) {
        offenders.push(model.id);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("FIRST_RUN_DEFAULT_MODEL_ID resolves to a default-eligible Eliza-1 tier", () => {
    const defaultModel = findCatalogModel(FIRST_RUN_DEFAULT_MODEL_ID);
    expect(defaultModel, `${FIRST_RUN_DEFAULT_MODEL_ID} missing`).toBeTruthy();
    expect(DEFAULT_ELIGIBLE_MODEL_IDS.has(FIRST_RUN_DEFAULT_MODEL_ID)).toBe(
      true,
    );
    expect(defaultModel?.runtimeRole).not.toBe("mtp-drafter");
  });

  it("recommendForFirstRun resolves to a default-eligible Eliza-1 tier", () => {
    const picked = recommendForFirstRun();
    expect(picked).not.toBeNull();
    if (!picked) throw new Error("missing first-run recommendation");
    expect(picked.id).toBe(FIRST_RUN_DEFAULT_MODEL_ID);
    expect(DEFAULT_ELIGIBLE_MODEL_IDS.has(picked.id)).toBe(true);
    expect(picked.displayName).toBe(
      EXPECTED_ELIZA_1_DISPLAY_NAMES[FIRST_RUN_DEFAULT_MODEL_ID],
    );
  });
});
