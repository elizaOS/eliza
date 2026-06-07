/**
 * Catalog-time variant indexing: BitRouter lists models under snapshot ids
 * (e.g. `google/gemini-2.0-flash-001`) but clients send the unsuffixed
 * canonical id. The ingest now emits a low-priority duplicate row under the
 * stripped base id so lookups for the canonical id resolve without
 * maintaining a hand-curated alias map.
 */

import { describe, expect, test } from "bun:test";
import {
  buildBitRouterPreparedEntries,
  canonicalModelId,
  chooseBestCandidatePricingEntry,
  expandPricingCatalogModelCandidates,
  inferProviderFromCanonicalModel,
  stripVersionedSnapshotSuffix,
} from "@/lib/services/ai-pricing";
import { fetchBitRouterCatalogEntries } from "@/lib/services/ai-pricing/providers/bitrouter";

describe("stripVersionedSnapshotSuffix — dated and labelled suffixes", () => {
  test("strips compact 8-digit date suffix", () => {
    expect(
      stripVersionedSnapshotSuffix("anthropic/claude-3-5-haiku-20241022"),
    ).toBe("anthropic/claude-3-5-haiku");
  });

  test("strips ISO date suffix", () => {
    expect(stripVersionedSnapshotSuffix("openai/gpt-4o-2024-11-20")).toBe(
      "openai/gpt-4o",
    );
    expect(stripVersionedSnapshotSuffix("openai/gpt-4o-2024-08-06")).toBe(
      "openai/gpt-4o",
    );
  });

  test("strips -latest label", () => {
    expect(stripVersionedSnapshotSuffix("anthropic/claude-haiku-latest")).toBe(
      "anthropic/claude-haiku",
    );
  });

  test("strips -preview label", () => {
    expect(stripVersionedSnapshotSuffix("openai/gpt-4o-search-preview")).toBe(
      "openai/gpt-4o-search",
    );
  });

  test("strips -beta label", () => {
    expect(stripVersionedSnapshotSuffix("openai/o1-beta")).toBe("openai/o1");
  });

  test("dated suffix bypasses the 2-segment safety check for short bases", () => {
    expect(stripVersionedSnapshotSuffix("openai/o1-2024-12-17")).toBe(
      "openai/o1",
    );
  });
});

describe("stripVersionedSnapshotSuffix — numeric snapshot suffixes", () => {
  test("strips -001 numeric snapshot", () => {
    expect(stripVersionedSnapshotSuffix("google/gemini-2.0-flash-001")).toBe(
      "google/gemini-2.0-flash",
    );
    expect(
      stripVersionedSnapshotSuffix("google/gemini-2.0-flash-lite-001"),
    ).toBe("google/gemini-2.0-flash-lite");
  });

  test("strips multi-digit numeric snapshot when two+ segments remain", () => {
    expect(stripVersionedSnapshotSuffix("vendor/family-name-1234")).toBe(
      "vendor/family-name",
    );
    expect(stripVersionedSnapshotSuffix("vendor/family-name-99")).toBe(
      "vendor/family-name",
    );
  });

  test("does NOT strip when result would collapse to one segment after slash", () => {
    expect(stripVersionedSnapshotSuffix("openai/gpt-4")).toBeNull();
    expect(stripVersionedSnapshotSuffix("vendor/model-1234")).toBeNull();
  });
});

describe("stripVersionedSnapshotSuffix — must-not-strip cases", () => {
  test("returns null when no suffix pattern matches", () => {
    expect(stripVersionedSnapshotSuffix("openai/gpt-4o-mini")).toBeNull();
    expect(
      stripVersionedSnapshotSuffix("anthropic/claude-3-5-haiku"),
    ).toBeNull();
    expect(stripVersionedSnapshotSuffix("google/gemini-2.5-flash")).toBeNull();
    expect(stripVersionedSnapshotSuffix("openai/gpt-4o")).toBeNull();
  });

  test("returns null when stripping would empty the id", () => {
    expect(stripVersionedSnapshotSuffix("001")).toBeNull();
    expect(stripVersionedSnapshotSuffix("latest")).toBeNull();
  });

  test("returns null when stripping would leave just a provider prefix", () => {
    expect(stripVersionedSnapshotSuffix("openai/123")).toBeNull();
    expect(stripVersionedSnapshotSuffix("anthropic/latest")).toBeNull();
  });

  test("returns null for ids without dash-version markers", () => {
    expect(stripVersionedSnapshotSuffix("openai")).toBeNull();
    expect(stripVersionedSnapshotSuffix("anthropic/")).toBeNull();
  });

  test("does NOT treat a non-date 8-digit run id as a date suffix", () => {
    // A vendor suffix like -99000001 must not be silently stripped as a
    // compact date. Year-anchoring the compact-date pattern is what blocks
    // this: only -19YYMMDD / -20YYMMDD shapes are accepted as dates.
    expect(
      stripVersionedSnapshotSuffix("vendor/family-name-99000001"),
    ).toBeNull();
  });

  test("accepts realistic compact-date suffixes for both 19xx and 20xx years", () => {
    expect(stripVersionedSnapshotSuffix("vendor/model-family-19991231")).toBe(
      "vendor/model-family",
    );
    expect(stripVersionedSnapshotSuffix("vendor/model-family-20240605")).toBe(
      "vendor/model-family",
    );
  });
});

describe("buildBitRouterPreparedEntries — exact + stripped variants", () => {
  test("emits both exact and stripped rows for prompt and completion", () => {
    const entries = buildBitRouterPreparedEntries({
      id: "google/gemini-2.0-flash-001",
      architecture: {
        modality: "text->text",
        input_modalities: ["text"],
        output_modalities: ["text"],
      },
      pricing: { prompt: "0.0000001", completion: "0.0000004" },
    });

    const inputEntries = entries.filter((e) => e.chargeType === "input");
    const outputEntries = entries.filter((e) => e.chargeType === "output");

    expect(inputEntries).toHaveLength(2);
    expect(outputEntries).toHaveLength(2);

    const exactInput = inputEntries.find(
      (e) => e.model === "google/gemini-2.0-flash-001",
    );
    const strippedInput = inputEntries.find(
      (e) => e.model === "google/gemini-2.0-flash",
    );
    expect(exactInput?.priority).toBeUndefined();
    expect(strippedInput?.priority).toBe(-1);
    expect(exactInput?.unitPrice).toBe(strippedInput?.unitPrice);

    const exactOutput = outputEntries.find(
      (e) => e.model === "google/gemini-2.0-flash-001",
    );
    const strippedOutput = outputEntries.find(
      (e) => e.model === "google/gemini-2.0-flash",
    );
    expect(exactOutput?.priority).toBeUndefined();
    expect(strippedOutput?.priority).toBe(-1);
    expect(exactOutput?.unitPrice).toBe(strippedOutput?.unitPrice);
  });

  test("emits only exact rows when no suffix can be stripped", () => {
    const entries = buildBitRouterPreparedEntries({
      id: "openai/gpt-4o-mini",
      architecture: { modality: "text->text" },
      pricing: { prompt: "0.00000015", completion: "0.0000006" },
    });

    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.model === "openai/gpt-4o-mini")).toBe(true);
    expect(entries.every((e) => e.priority === undefined)).toBe(true);
  });

  test("propagates provider, productFamily, billingSource on stripped row", () => {
    const entries = buildBitRouterPreparedEntries({
      id: "anthropic/claude-3-5-haiku-20241022",
      architecture: { modality: "text->text" },
      pricing: { prompt: "0.0000008" },
    });

    const stripped = entries.find(
      (e) => e.model === "anthropic/claude-3-5-haiku",
    );
    expect(stripped?.model).toBe("anthropic/claude-3-5-haiku");
    expect(stripped?.priority).toBe(-1);
    expect(stripped?.provider).toBe("anthropic");
    expect(stripped?.productFamily).toBe("language");
    expect(stripped?.billingSource).toBe("bitrouter");
    expect(stripped?.sourceKind).toBe("bitrouter_catalog");
  });

  test("does not emit stripped row when prices are missing", () => {
    const entries = buildBitRouterPreparedEntries({
      id: "google/gemini-2.0-flash-001",
      architecture: { modality: "text->text" },
      pricing: {},
    });

    expect(entries).toHaveLength(0);
  });

  test("emits stripped row only for the priced direction (input-only)", () => {
    const entries = buildBitRouterPreparedEntries({
      id: "google/gemini-2.0-flash-001",
      architecture: { modality: "text->text" },
      pricing: { prompt: "0.0000001" },
    });

    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.chargeType === "input")).toBe(true);
    expect(
      entries.find((e) => e.model === "google/gemini-2.0-flash")?.priority,
    ).toBe(-1);
  });
});

describe("forced provider route pricing ids", () => {
  test("keeps forced route ids canonical before slash-prefixed aliases", () => {
    expect(
      canonicalModelId("openrouter:openai/gpt-oss-120b", "openrouter"),
    ).toBe("openrouter:openai/gpt-oss-120b");
    expect(canonicalModelId("cerebras:gpt-oss-120b", "cerebras")).toBe(
      "cerebras:gpt-oss-120b",
    );
  });

  test("infers provider from forced route prefixes", () => {
    expect(
      inferProviderFromCanonicalModel("openrouter:openai/gpt-oss-120b"),
    ).toBe("openrouter");
    expect(inferProviderFromCanonicalModel("cerebras:zai-glm-4.7")).toBe(
      "cerebras",
    );
  });

  test("uses underlying catalog id as an alias for OpenRouter forced routes", () => {
    expect(
      expandPricingCatalogModelCandidates("openrouter:openai/gpt-oss-120b"),
    ).toContain("openai/gpt-oss-120b");
  });

  test("adds synthetic Cerebras pricing rows to the BitRouter catalog", async () => {
    const previousApiKey = process.env.BITROUTER_API_KEY;
    const previousFetch = globalThis.fetch;
    process.env.BITROUTER_API_KEY = "test-bitrouter-key";
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          data: [],
        }),
        { status: 200 },
      );

    try {
      const entries = await fetchBitRouterCatalogEntries();
      const gptInput = entries.find(
        (entry) =>
          entry.model === "cerebras:gpt-oss-120b" &&
          entry.chargeType === "input",
      );
      const gptOutput = entries.find(
        (entry) =>
          entry.model === "cerebras:gpt-oss-120b" &&
          entry.chargeType === "output",
      );
      const glmInput = entries.find(
        (entry) =>
          entry.model === "cerebras:zai-glm-4.7" &&
          entry.chargeType === "input",
      );
      const glmOutput = entries.find(
        (entry) =>
          entry.model === "cerebras:zai-glm-4.7" &&
          entry.chargeType === "output",
      );

      expect(gptInput?.provider).toBe("cerebras");
      expect(gptInput?.unitPrice).toBe(0.00000035);
      expect(gptOutput?.unitPrice).toBe(0.00000075);
      expect(glmInput?.unitPrice).toBe(0.00000225);
      expect(glmOutput?.unitPrice).toBe(0.00000275);
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.BITROUTER_API_KEY;
      } else {
        process.env.BITROUTER_API_KEY = previousApiKey;
      }
      globalThis.fetch = previousFetch;
    }
  });

  test("adds a synthetic openai/gpt-oss-120b row so :nitro / :free variants resolve", async () => {
    // Default cloud TEXT_SMALL model is `openai/gpt-oss-120b:nitro`
    // (packages/core/src/contracts/service-routing.ts). BitRouter's catalog
    // doesn't currently return a priced row for the base id, so without this
    // forced entry every credit-debiting chat request 500s with
    // "Pricing unavailable for language:input openai/gpt-oss-120b". The
    // variant stripper in candidate-selection collapses :nitro / :free onto
    // the base, so one base entry covers every variant.
    const previousApiKey = process.env.BITROUTER_API_KEY;
    const previousFetch = globalThis.fetch;
    process.env.BITROUTER_API_KEY = "test-bitrouter-key";
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200 });

    try {
      const entries = await fetchBitRouterCatalogEntries();
      const input = entries.find(
        (entry) =>
          entry.model === "openai/gpt-oss-120b" && entry.chargeType === "input",
      );
      const output = entries.find(
        (entry) =>
          entry.model === "openai/gpt-oss-120b" &&
          entry.chargeType === "output",
      );

      expect(input?.provider).toBe("openai");
      expect(input?.productFamily).toBe("language");
      expect(input?.unitPrice).toBe(0.0000001);
      expect(output?.unitPrice).toBe(0.0000005);
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.BITROUTER_API_KEY;
      } else {
        process.env.BITROUTER_API_KEY = previousApiKey;
      }
      globalThis.fetch = previousFetch;
    }
  });
});

describe("chooseBestCandidatePricingEntry — tie-break when stripped variants conflict", () => {
  function buildCandidate(snapshotId: string, unitPrice: number) {
    return {
      entry: {
        billingSource: "bitrouter" as const,
        provider: "google",
        model: "google/gemini-2.0-flash",
        productFamily: "language" as const,
        chargeType: "input",
        unit: "token" as const,
        unitPrice,
        sourceKind: "bitrouter_catalog",
        sourceUrl: "https://api.bitrouter.ai/v1/models",
        priority: -1,
        metadata: { snapshotId },
      },
      modelId: "google/gemini-2.0-flash",
      logicalProvider: "google",
    };
  }

  test("picks the higher unitPrice when two stripped snapshots collide", () => {
    // Two snapshots strip to the same canonical id but list different
    // prices. Without the unitPrice tie-break the winner is decided by input
    // ordering, which is non-deterministic across catalog fetches and DB
    // result orderings. Conservative billing: the higher price wins.
    const cheap = buildCandidate("google/gemini-2.0-flash-001", 0.0000001);
    const expensive = buildCandidate("google/gemini-2.0-flash-002", 0.00000015);

    const cheapFirst = chooseBestCandidatePricingEntry(
      [cheap, expensive],
      {},
      "google/gemini-2.0-flash",
    );
    expect(cheapFirst?.entry.unitPrice).toBe(0.00000015);

    const expensiveFirst = chooseBestCandidatePricingEntry(
      [expensive, cheap],
      {},
      "google/gemini-2.0-flash",
    );
    expect(expensiveFirst?.entry.unitPrice).toBe(0.00000015);
  });

  test("returns deterministic winner when both prices are equal", () => {
    // Equal prices: localeCompare on modelId is the final tie-break, but
    // since both rows share the same stripped modelId we still need a
    // stable answer. The function must return a non-null match either way.
    const a = buildCandidate("google/gemini-2.0-flash-001", 0.0000001);
    const b = buildCandidate("google/gemini-2.0-flash-002", 0.0000001);

    const winner = chooseBestCandidatePricingEntry(
      [a, b],
      {},
      "google/gemini-2.0-flash",
    );
    expect(winner?.entry.model).toBe("google/gemini-2.0-flash");
    expect(winner?.entry.unitPrice).toBe(0.0000001);
  });
});
