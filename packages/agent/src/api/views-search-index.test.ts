/**
 * Exercises the view search index's result-count contract with deterministic
 * embedding responses, including invalid caller-supplied limits.
 */
import { createMockRuntime } from "@elizaos/core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { viewSearchIndex } from "./views-search-index.ts";

const runtime = createMockRuntime();
Object.defineProperty(runtime, "useModel", {
  value: vi.fn(async () => [1, 0]),
});

describe("ViewSearchIndex search limits", () => {
  afterEach(() => {
    viewSearchIndex.clear();
  });

  it("returns no results for invalid topK values", async () => {
    for (let index = 0; index < 3; index += 1) {
      await viewSearchIndex.indexView(
        {
          id: `view-${index}`,
          viewType: "gui",
          pluginName: "@test/views-search",
          label: `View ${index}`,
          description: "Searchable view",
          tags: [],
          hasHeroImage: false,
          available: true,
          loadedAt: 0,
          platform: "web",
        },
        runtime,
      );
    }

    for (const topK of [
      0,
      -1,
      0.5,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      await expect(
        viewSearchIndex.search("query", runtime, topK),
        `topK=${String(topK)}`,
      ).resolves.toEqual([]);
    }
  });

  it("returns ranked results for a valid topK, bounded to the requested count", async () => {
    for (let index = 0; index < 3; index += 1) {
      await viewSearchIndex.indexView(
        {
          id: `view-${index}`,
          viewType: "gui",
          pluginName: "@test/views-search",
          label: `View ${index}`,
          description: "Searchable view",
          tags: [],
          hasHeroImage: false,
          available: true,
          loadedAt: 0,
          platform: "web",
        },
        runtime,
      );
    }

    const all = await viewSearchIndex.search("query", runtime, 10);
    expect(all).toHaveLength(3);
    expect(all.map((r) => r.viewId).sort()).toEqual([
      "view-0",
      "view-1",
      "view-2",
    ]);

    const limited = await viewSearchIndex.search("query", runtime, 2);
    expect(limited).toHaveLength(2);
  });
});

describe("ViewSearchIndex ranking determinism", () => {
  afterEach(() => {
    viewSearchIndex.clear();
  });

  it("ranks an unscoreable view last and breaks ties by view id", async () => {
    // A corrupted stored embedding makes cosine similarity NaN, and two
    // identical embeddings tie — both cases must still produce a total order.
    const embeddings: Record<string, number[]> = {
      "Z View": [1, 0],
      "A View": [1, 0],
      "Corrupt View": [Number.NaN, Number.NaN],
    };
    const rankingRuntime = createMockRuntime();
    Object.defineProperty(rankingRuntime, "useModel", {
      value: vi.fn(async (_type: unknown, params: { text: string }) => {
        for (const [label, embedding] of Object.entries(embeddings)) {
          if (params.text.startsWith(label)) return embedding;
        }
        return [1, 0];
      }),
    });

    // Indexed worst-first so a comparator that returns NaN or 0 for these
    // pairs leaves the array in exactly this (wrong) order.
    for (const [index, label] of [
      "Corrupt View",
      "Z View",
      "A View",
    ].entries()) {
      await viewSearchIndex.indexView(
        {
          id: label.split(" ")[0].toLowerCase(),
          viewType: "gui",
          pluginName: "@test/views-search",
          label,
          description: "",
          tags: [],
          hasHeroImage: false,
          available: true,
          loadedAt: index,
          platform: "web",
        },
        rankingRuntime,
      );
    }

    const ranked = await viewSearchIndex.search("query", rankingRuntime, 10);
    expect(ranked.map((entry) => entry.viewId)).toEqual(["a", "z", "corrupt"]);
    expect(Number.isNaN(ranked[2].score)).toBe(true);
  });
});
