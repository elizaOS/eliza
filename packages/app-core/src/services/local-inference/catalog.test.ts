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

  it("declares contextLength on every entry whose blurb claims a long window", () => {
    // Catches the regression class this test exists to prevent: a blurb
    // saying "128k window" but no `contextLength` on the entry, so the
    // loader silently uses the default (8k or 4k).
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

  it("sets contextLength on the canonical 128k catalog entries", () => {
    // Per the porting plan + task brief: these are the entries that
    // legitimately advertise a 128k+ ceiling and must declare it
    // programmatically, not just in marketing prose.
    const expected = {
      "eliza-1-2b": 131072,
      "eliza-1-9b": 131072,
      "eliza-1-27b": 131072,
      "qwen3.5-4b-dflash": 131072,
      "qwen3.5-9b-dflash": 131072,
      "qwen3.6-27b-dflash": 131072,
      "bonsai-8b-1bit": 131072,
      "bonsai-8b-1bit-dflash": 131072,
    } as const;
    for (const [id, expectedLength] of Object.entries(expected)) {
      const model = findCatalogModel(id);
      expect(model, `${id} missing from catalog`).toBeTruthy();
      expect(model?.contextLength, `${id} contextLength mismatch`).toBe(
        expectedLength,
      );
    }
  });

  it("sets a tokenizerFamily on every chat/code/reasoning entry", () => {
    // tokenizerFamily is required for DFlash drafter pair guards and for
    // any future code that needs to make tokenizer-aware decisions. Drafter
    // entries inherit their family from the target model's family.
    const offenders: string[] = [];
    for (const model of MODEL_CATALOG) {
      if (!model.tokenizerFamily) {
        offenders.push(model.id);
      }
    }
    expect(offenders).toEqual([]);
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

  it("every chat/code/reasoning entry uses TBQ KV cache or DFlash (eliza-1 placeholders excepted)", () => {
    // Hard rule: we ONLY ship Milady-optimized paths. Non-drafter entries
    // must either declare a DFlash spec-decode block or a TurboQuant KV
    // cache type. eliza-1-* are placeholders for upcoming optimized
    // weights and are exempt until those tunes ship.
    const offenders: string[] = [];
    for (const model of MODEL_CATALOG) {
      if (model.runtimeRole === "dflash-drafter") continue;
      if (ELIZA_1_PLACEHOLDER_IDS.has(model.id)) continue;
      const dflash = model.runtime?.dflash !== undefined;
      const typeK = model.runtime?.kvCache?.typeK?.toLowerCase() ?? "";
      const typeV = model.runtime?.kvCache?.typeV?.toLowerCase() ?? "";
      const tbqK = typeK.startsWith("tbq") || typeK.startsWith("turbo");
      const tbqV = typeV.startsWith("tbq") || typeV.startsWith("turbo");
      const tbq = tbqK || tbqV;
      if (!dflash && !tbq) {
        offenders.push(
          `${model.id} has no DFlash block and no TBQ KV cache (typeK=${typeK || "<none>"}, typeV=${typeV || "<none>"})`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  it("FIRST_RUN_DEFAULT_MODEL_ID resolves to a TBQ/DFlash entry", () => {
    const defaultModel = findCatalogModel(FIRST_RUN_DEFAULT_MODEL_ID);
    expect(defaultModel, `${FIRST_RUN_DEFAULT_MODEL_ID} missing`).toBeTruthy();
    expect(defaultModel?.runtime?.dflash).toBeDefined();
    expect(defaultModel?.runtimeRole).not.toBe("dflash-drafter");
  });

  it("recommendForFirstRun resolves to a Milady-shippable model", () => {
    const picked = recommendForFirstRun();
    expect(picked).not.toBeNull();
    expect(picked!.id).toBe(FIRST_RUN_DEFAULT_MODEL_ID);
    expect(picked!.runtime?.dflash).toBeDefined();
    // Defensive: even with a stripped catalog, the function must not
    // return a generic GGUF without a DFlash block.
    expect(ELIZA_1_PLACEHOLDER_IDS.has(picked!.id)).toBe(false);
  });
});
