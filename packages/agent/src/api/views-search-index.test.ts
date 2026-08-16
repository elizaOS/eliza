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
