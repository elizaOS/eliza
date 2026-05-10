import { describe, expect, it } from "vitest";
import {
  ELIZA_1_PLACEHOLDER_IDS,
  findCatalogModel,
  FIRST_RUN_DEFAULT_MODEL_ID,
  MODEL_CATALOG,
} from "./catalog";
import { recommendForFirstRun } from "./recommendation";
import { localInferenceService } from "./service";

describe("local inference catalog", () => {
  it("ships exactly the 12 Milady-shippable entries", () => {
    expect(MODEL_CATALOG.map((m) => m.id).sort()).toEqual(
      [
        "bonsai-8b-1bit",
        "bonsai-8b-1bit-dflash",
        "bonsai-8b-dflash-drafter",
        "eliza-1-2b",
        "eliza-1-9b",
        "eliza-1-27b",
        "qwen3.5-4b-dflash",
        "qwen3.5-4b-dflash-drafter-q4",
        "qwen3.5-9b-dflash",
        "qwen3.5-9b-dflash-drafter-q4",
        "qwen3.6-27b-dflash",
        "qwen3.6-27b-dflash-drafter-q8",
      ].sort(),
    );
  });

  it("every chat/code/reasoning entry uses TBQ KV cache or DFlash (eliza-1 placeholders excepted)", () => {
    const offenders: string[] = [];
    for (const model of MODEL_CATALOG) {
      if (model.runtimeRole === "dflash-drafter") continue;
      if (ELIZA_1_PLACEHOLDER_IDS.has(model.id)) continue;
      const dflash = model.runtime?.dflash !== undefined;
      const typeK = model.runtime?.kvCache?.typeK?.toLowerCase() ?? "";
      const typeV = model.runtime?.kvCache?.typeV?.toLowerCase() ?? "";
      const tbqK = typeK.startsWith("tbq") || typeK.startsWith("turbo");
      const tbqV = typeV.startsWith("tbq") || typeV.startsWith("turbo");
      if (!dflash && !tbqK && !tbqV) {
        offenders.push(model.id);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("FIRST_RUN_DEFAULT_MODEL_ID resolves to a TBQ/DFlash entry", () => {
    const defaultModel = findCatalogModel(FIRST_RUN_DEFAULT_MODEL_ID);
    expect(defaultModel).toBeTruthy();
    expect(defaultModel?.runtime?.dflash).toBeDefined();
  });

  it("recommendForFirstRun resolves to a Milady-shippable model", () => {
    const picked = recommendForFirstRun();
    expect(picked).not.toBeNull();
    expect(picked!.id).toBe(FIRST_RUN_DEFAULT_MODEL_ID);
    expect(picked!.runtime?.dflash).toBeDefined();
  });

  it("keeps DFlash drafter companions installable but hidden from the hub", () => {
    const visible = localInferenceService.getCatalog();
    expect(visible.some((model) => model.category === "drafter")).toBe(false);
    expect(
      MODEL_CATALOG.some(
        (model) => model.id === "qwen3.5-4b-dflash-drafter-q4",
      ),
    ).toBe(true);
    expect(
      findCatalogModel("qwen3.5-4b-dflash-drafter-q4")?.hiddenFromCatalog,
    ).toBe(true);
  });

  it("wires Qwen DFlash targets to their hidden drafter companions", () => {
    for (const id of [
      "qwen3.5-4b-dflash",
      "qwen3.5-9b-dflash",
      "qwen3.6-27b-dflash",
    ]) {
      const model = findCatalogModel(id);
      expect(model?.runtime?.preferredBackend).toBe("llama-server");
      const drafterId = model?.runtime?.dflash?.drafterModelId;
      expect(drafterId).toBeTruthy();
      expect(model?.companionModelIds).toContain(drafterId);
      const drafter = findCatalogModel(String(drafterId));
      expect(drafter?.runtimeRole).toBe("dflash-drafter");
      expect(drafter?.companionForModelId).toBe(id);
    }
  });

  it("DFlash pairs share a tokenizer family", () => {
    const dflashEntries = MODEL_CATALOG.filter((m) => m.runtime?.dflash);
    expect(dflashEntries.length).toBeGreaterThan(0);
    for (const entry of dflashEntries) {
      const drafterId = entry.runtime!.dflash!.drafterModelId;
      const drafter = MODEL_CATALOG.find((m) => m.id === drafterId);
      expect(
        drafter,
        `drafter ${drafterId} of ${entry.id} not found in catalog`,
      ).toBeDefined();
      expect(
        entry.tokenizerFamily,
        `target ${entry.id} missing tokenizerFamily`,
      ).toBeDefined();
      expect(
        drafter!.tokenizerFamily,
        `drafter ${drafterId} missing tokenizerFamily`,
      ).toBeDefined();
      expect(
        entry.tokenizerFamily,
        `tokenizer mismatch: target ${entry.id} (${entry.tokenizerFamily}) ≠ drafter ${drafterId} (${drafter!.tokenizerFamily})`,
      ).toBe(drafter!.tokenizerFamily);
    }
  });
});
