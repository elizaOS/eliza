import { describe, expect, it } from "vitest";
import {
  buildHuggingFaceResolveUrl,
  DEFAULT_ELIGIBLE_MODEL_IDS,
  ELIZA_1_RELEASE_TIER_IDS,
  ELIZA_1_TIER_IDS,
  FIRST_RUN_DEFAULT_MODEL_ID,
  findCatalogModel,
  MODEL_CATALOG,
} from "./catalog";
import { recommendForFirstRun } from "./recommendation";
import { localInferenceService } from "./service";

describe("local inference catalog", () => {
  it("ships exactly the visible Eliza-1 tiers", () => {
    const visible = MODEL_CATALOG.filter((m) => !m.hiddenFromCatalog);
    expect(visible.map((m) => m.id).sort()).toEqual(
      [...ELIZA_1_RELEASE_TIER_IDS].sort(),
    );
  });

  it("uses the Qwen3.5 0.8B / 2B / 4B text source tiers, not stale Qwen3 small-tier sources", () => {
    expect(ELIZA_1_TIER_IDS.slice(0, 3)).toEqual([
      "eliza-1-0_8b",
      "eliza-1-2b",
      "eliza-1-4b",
    ]);
    expect(FIRST_RUN_DEFAULT_MODEL_ID).toBe("eliza-1-2b");
    const serializedCatalog = JSON.stringify(MODEL_CATALOG);
    expect(serializedCatalog).toContain("Qwen/Qwen3.5-0.8B");
    expect(serializedCatalog).toContain("Qwen/Qwen3.5-2B");
    expect(serializedCatalog).toContain("Qwen/Qwen3.5-4B");
    const staleSmallTierId = "eliza-1-0_" + "6b";
    const staleMobileTierId = "eliza-1-1_" + "7b";
    const staleQwen3Small = "Qwen/Qwen3-0" + "\\.6B";
    const staleQwen3Mobile = "Qwen/Qwen3-1" + "\\.7B";
    const staleQwen35Small = "Qwen/Qwen3\\.5-0" + "\\.6B";
    const staleQwen35Mobile = "Qwen/Qwen3\\.5-1" + "\\.7B";
    expect(serializedCatalog).not.toMatch(
      new RegExp(
        [
          staleSmallTierId,
          staleMobileTierId,
          staleQwen3Small,
          staleQwen3Mobile,
          staleQwen35Small,
          staleQwen35Mobile,
        ].join("|"),
      ),
    );
    for (const model of MODEL_CATALOG) {
      expect(model.tokenizerFamily).toBe("qwen35");
    }
  });

  it("marks ONLY the current Qwen3.5 Eliza-1 release tiers as default-eligible", () => {
    expect([...DEFAULT_ELIGIBLE_MODEL_IDS].sort()).toEqual(
      [...ELIZA_1_RELEASE_TIER_IDS].sort(),
    );
    for (const id of ELIZA_1_RELEASE_TIER_IDS) {
      expect(DEFAULT_ELIGIBLE_MODEL_IDS.has(id), `${id} not eligible`).toBe(
        true,
      );
    }
    for (const id of ELIZA_1_TIER_IDS) {
      if ((ELIZA_1_RELEASE_TIER_IDS as readonly string[]).includes(id))
        continue;
      expect(
        DEFAULT_ELIGIBLE_MODEL_IDS.has(id),
        `${id} should not be eligible`,
      ).toBe(false);
    }
    for (const model of MODEL_CATALOG.filter((m) => !m.hiddenFromCatalog)) {
      expect(model.id.startsWith("eliza-1-")).toBe(true);
    }
  });

  it("uses eliza-1 size ids as user-facing display names", () => {
    for (const id of ELIZA_1_TIER_IDS) {
      const model = findCatalogModel(id);
      expect(model, `${id} missing`).toBeTruthy();
      expect(model?.displayName).toMatch(/^(?:Eliza-1\b|eliza-1-)/);
      expect(model?.blurb).toMatch(/^(?:Eliza-1\b|eliza-1-)/);
      expect(`${model?.displayName} ${model?.blurb}`).not.toMatch(
        /\b(?:Qwen|Llama)\b/i,
      );
    }
  });

  it("uses the single elizaos HuggingFace bundle repo for every visible tier", () => {
    for (const model of MODEL_CATALOG.filter((m) => !m.hiddenFromCatalog)) {
      expect(model.hfRepo).toBe("elizaos/eliza-1");
      expect(model.hfPathPrefix).toBe(
        `bundles/${model.id.replace("eliza-1-", "")}`,
      );
      expect(model.ggufFile).not.toMatch(/^bundles\//);
      expect(buildHuggingFaceResolveUrl(model)).toContain(model.ggufFile);
      expect(buildHuggingFaceResolveUrl(model)).toContain(
        `/elizaos/eliza-1/resolve/main/${model.hfPathPrefix}/`,
      );
      expect(model.quantization?.defaultVariantId).toBe("q4_k_m");
      expect(model.quantization?.variants.map((v) => v.id)).toEqual([
        "q4_k_m",
        "q6_k",
        "q8_0",
      ]);
    }
  });

  it("does not expose hidden companion entries in the hub", () => {
    const visible = localInferenceService.getCatalog();
    expect(visible.some((model) => model.category === "drafter")).toBe(false);
  });

  it("keeps the visible model hub focused on Eliza-1 only", () => {
    const visible = localInferenceService.getCatalog();
    expect(visible.map((model) => model.id).sort()).toEqual(
      [...ELIZA_1_RELEASE_TIER_IDS].sort(),
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
    // Size tiers: 0.8B / 2B = 32k, 4B/9B = 64k, 27B = 128k,
    // 27B-256k = 256k. The catalog records the largest
    // ctx the bundle's manifest will advertise for each tier.
    const expected: Record<string, number> = {
      "eliza-1-0_8b": 32768,
      "eliza-1-2b": 32768,
      "eliza-1-4b": 65536,
      "eliza-1-9b": 65536,
      "eliza-1-27b": 131072,
      "eliza-1-27b-256k": 262144,
      "eliza-1-27b-1m": 1_048_576,
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

  it("DFlash pairs share a tokenizer family when present", () => {
    const dflashEntries = MODEL_CATALOG.filter((m) => m.runtime?.dflash);
    for (const entry of dflashEntries) {
      const drafterId = entry.runtime?.dflash?.drafterModelId;
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
        drafter?.tokenizerFamily,
        `drafter ${drafterId} missing tokenizerFamily`,
      ).toBeDefined();
      expect(
        entry.tokenizerFamily,
        `tokenizer mismatch: target ${entry.id} (${entry.tokenizerFamily}) ≠ drafter ${drafterId} (${drafter?.tokenizerFamily})`,
      ).toBe(drafter?.tokenizerFamily);
    }
  });

  it("declares the mandatory local runtime contract for every default tier", () => {
    const baseKernels = [
      "dflash",
      "turbo3",
      "turbo4",
      "qjl_full",
      "polarquant",
    ];
    for (const id of ELIZA_1_RELEASE_TIER_IDS) {
      const model = findCatalogModel(id);
      expect(model?.runtime?.preferredBackend, `${id} backend`).toBe(
        "llama-server",
      );
      expect(model?.runtime?.dflash?.drafterModelId, `${id} drafter`).toBe(
        `${id}-drafter`,
      );
      expect(model?.companionModelIds, `${id} companions`).toContain(
        `${id}-drafter`,
      );
      for (const kernel of baseKernels) {
        expect(
          model?.runtime?.optimizations?.requiresKernel,
          `${id} kernel ${kernel}`,
        ).toContain(kernel);
      }
      if ((model?.contextLength ?? 0) >= 65536) {
        expect(model?.runtime?.optimizations?.requiresKernel).toContain(
          "turbo3_tcq",
        );
      }
    }
  });

  it("keeps drafter companions hidden and non-default", () => {
    const drafters = MODEL_CATALOG.filter(
      (m) => m.runtimeRole === "dflash-drafter",
    );
    expect(drafters.length).toBe(ELIZA_1_TIER_IDS.length);
    for (const drafter of drafters) {
      expect(drafter.hiddenFromCatalog).toBe(true);
      expect(DEFAULT_ELIGIBLE_MODEL_IDS.has(drafter.id)).toBe(false);
      expect(drafter.companionForModelId).toBeTruthy();
      expect(drafter.tokenizerFamily).toBe("qwen35");
    }
  });

  it("keeps future large placeholders hidden and out of upstream Qwen provenance", () => {
    const model = findCatalogModel("eliza-1-27b-1m");
    expect(model?.hiddenFromCatalog).toBe(true);
    expect(DEFAULT_ELIGIBLE_MODEL_IDS.has("eliza-1-27b-1m")).toBe(false);
    expect(model?.sourceModel?.finetuned).toBe(false);
    const components = model?.sourceModel?.components;
    expect(components?.text?.repo).toBe("elizaos/eliza-1");
    expect(components?.vision?.repo).toBe("elizaos/eliza-1");
    expect(JSON.stringify(model)).not.toMatch(/Qwen\/Qwen3(?:\.6)?/);
  });

  it("does not leak implementation-family names in visible catalog copy", () => {
    const banned = /\b(?:qwen|llama|turboquant|qjl|polarquant|dflash)\b/i;
    for (const model of MODEL_CATALOG.filter((m) => !m.hiddenFromCatalog)) {
      expect(model.displayName).not.toMatch(banned);
      expect(model.quant).not.toMatch(banned);
      expect(model.blurb).not.toMatch(banned);
    }
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

  it("keeps external HF search-shaped ids custom-only", () => {
    const externalId = "hf:some-org/custom-model::model.Q4_K_M.gguf";
    expect(DEFAULT_ELIGIBLE_MODEL_IDS.has(externalId)).toBe(false);
    expect(externalId.startsWith("eliza-1-")).toBe(false);
  });

  it("FIRST_RUN_DEFAULT_MODEL_ID resolves to a default-eligible Eliza-1 tier", () => {
    const defaultModel = findCatalogModel(FIRST_RUN_DEFAULT_MODEL_ID);
    expect(defaultModel, `${FIRST_RUN_DEFAULT_MODEL_ID} missing`).toBeTruthy();
    expect(DEFAULT_ELIGIBLE_MODEL_IDS.has(FIRST_RUN_DEFAULT_MODEL_ID)).toBe(
      true,
    );
    expect(defaultModel?.runtimeRole).not.toBe("dflash-drafter");
  });

  it("recommendForFirstRun resolves to a default-eligible Eliza-1 tier", () => {
    const picked = recommendForFirstRun();
    expect(picked).not.toBeNull();
    if (!picked) throw new Error("missing first-run recommendation");
    expect(picked.id).toBe(FIRST_RUN_DEFAULT_MODEL_ID);
    expect(DEFAULT_ELIGIBLE_MODEL_IDS.has(picked.id)).toBe(true);
    expect(picked.displayName).toMatch(/^(?:Eliza-1\b|eliza-1-)/);
  });
});
