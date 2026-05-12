import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ELIGIBLE_MODEL_IDS,
  ELIZA_1_TIER_IDS,
  FIRST_RUN_DEFAULT_MODEL_ID,
  findCatalogModel,
  MODEL_CATALOG,
} from "./catalog";
import {
  filterSettingsDefaultLocalModels,
  isSettingsDefaultLocalModel,
} from "./catalog-policy";
import {
  getLocalModelSearchProvider,
  listLocalModelSearchProviders,
  searchLocalModelProvider,
} from "./custom-search";
import { recommendForFirstRun } from "./recommendation";
import { localInferenceService } from "./service";
import type { CatalogModel } from "./types";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function catalogFixture(overrides: Partial<CatalogModel>): CatalogModel {
  const base = MODEL_CATALOG.find((model) =>
    isSettingsDefaultLocalModel(model),
  );
  if (!base) throw new Error("missing Eliza-1 fixture");
  return {
    ...base,
    companionModelIds: undefined,
    runtime: undefined,
    sourceModel: undefined,
    ...overrides,
  };
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
});

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
      expect(model?.displayName).toMatch(/^(?:Eliza-1\b|eliza-1-)/);
      expect(model?.blurb).toMatch(/^(?:Eliza-1\b|eliza-1-)/);
      expect(`${model?.displayName} ${model?.blurb}`).not.toMatch(
        /\b(?:Qwen|Llama)\b/i,
      );
    }
  });

  it("does not expose hidden companion entries in the hub", () => {
    const visible = localInferenceService.getCatalog();
    expect(visible.some((model) => model.category === "drafter")).toBe(false);
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
    // Size tiers: 0.8B/2B = 32k, 4B/9B = 64k, 27B = 128k,
    // 27B-256k = 256k, 27B-1m = 1M. The catalog records the largest
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
        `tokenizer mismatch: target ${entry.id} (${entry.tokenizerFamily}) != drafter ${drafterId} (${drafter?.tokenizerFamily})`,
      ).toBe(drafter?.tokenizerFamily);
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

  it("filters injected non-Eliza and hidden entries out of settings defaults", () => {
    const eliza = catalogFixture({});
    const nonEliza = catalogFixture({
      id: "qwen-custom-7b",
      displayName: "Qwen custom 7B",
      hfRepo: "Qwen/Qwen-custom-7B-GGUF",
      ggufFile: "qwen-custom-7b.gguf",
    });
    const hiddenEliza = catalogFixture({
      id: "eliza-1-2b-drafter",
      hiddenFromCatalog: true,
      runtimeRole: "dflash-drafter",
    });

    expect(isSettingsDefaultLocalModel(eliza)).toBe(true);
    expect(isSettingsDefaultLocalModel(nonEliza)).toBe(false);
    expect(isSettingsDefaultLocalModel(hiddenEliza)).toBe(false);
    expect(
      filterSettingsDefaultLocalModels([nonEliza, hiddenEliza, eliza]).map(
        (model) => model.id,
      ),
    ).toEqual([eliza.id]);
  });
});

describe("local model custom search providers", () => {
  it("registers Hugging Face and ModelScope as explicit providers", () => {
    expect(
      listLocalModelSearchProviders().map((provider) => provider.id),
    ).toEqual(["huggingface", "modelscope"]);
    expect(getLocalModelSearchProvider("huggingface").downloadSupported).toBe(
      true,
    );
    expect(getLocalModelSearchProvider("modelscope")).toMatchObject({
      searchSupported: true,
      downloadSupported: true,
    });
  });

  it("wraps ModelScope GGUF results as downloadable explicit search results", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (
        url ===
        "https://www.modelscope.cn/api/v1/models/acme/test-model/repo/files?Revision=master&Recursive=true"
      ) {
        return jsonResponse({
          Code: 200,
          Data: {
            Files: [{ Path: "test-model-q4_k_m.gguf", Size: 512 }],
          },
        });
      }
      return new Response("not found", { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const response = await searchLocalModelProvider(
      "modelscope",
      "acme/test-model",
      1,
    );

    expect(response.results).toHaveLength(1);
    expect(response.results[0]).toMatchObject({
      providerId: "modelscope",
      download: { supported: true },
    });
    expect(response.results[0]?.model.id).toMatch(/^modelscope:/);
  });

  it("wraps Hugging Face GGUF results as downloadable explicit search results", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("https://huggingface.co/api/models?")) {
        return jsonResponse([{ id: "Qwen/Qwen3.5-0.8B-GGUF" }]);
      }
      if (
        url === "https://huggingface.co/api/models/Qwen%2FQwen3.5-0.8B-GGUF"
      ) {
        return jsonResponse({
          id: "Qwen/Qwen3.5-0.8B-GGUF",
          tags: ["gguf"],
          siblings: [{ rfilename: "qwen3.5-0.8b-q4_k_m.gguf", size: 512 }],
          pipeline_tag: "text-generation",
        });
      }
      return new Response("not found", { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const response = await searchLocalModelProvider("huggingface", "qwen", 1);

    expect(response.results).toHaveLength(1);
    expect(response.results[0]).toMatchObject({
      providerId: "huggingface",
      download: { supported: true },
    });
    expect(response.results[0]?.model.id).toMatch(/^hf:/);
  });
});
