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

  it("returns no results for non-positive or non-finite topK values", async () => {
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

    await expect(viewSearchIndex.search("query", runtime, -1)).resolves.toEqual(
      [],
    );
    await expect(
      viewSearchIndex.search("query", runtime, Number.POSITIVE_INFINITY),
    ).resolves.toEqual([]);
  });
});
