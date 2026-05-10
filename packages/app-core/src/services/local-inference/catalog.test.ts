import { describe, expect, it } from "vitest";
import { findCatalogModel, MODEL_CATALOG } from "./catalog";
import { localInferenceService } from "./service";

describe("local inference catalog", () => {
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
    // Catches the regression class this task exists to prevent: a blurb
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
      "qwen2.5-coder-7b": 131072,
      "qwen2.5-coder-14b": 131072,
      "deepseek-r1-distill-qwen-32b": 131072,
      "eliza-1-9b": 131072,
      "eliza-1-27b": 131072,
      "qwen3.5-4b-dflash": 131072,
      "qwen3.5-9b-dflash": 131072,
      "qwen3.6-27b-dflash": 131072,
      "llama-3.1-8b": 131072,
      "llama-3.2-1b": 131072,
      "llama-3.2-3b": 131072,
      "bonsai-8b-1bit": 131072,
      "qwen3-coder-30b-awq-q4": 262144,
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
});
