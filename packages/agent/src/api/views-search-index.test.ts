/**
 * Exercises the view search index's result-count contract with deterministic
 * embedding responses, including invalid caller-supplied limits.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { createMockRuntime } from "@elizaos/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginViewInstallation,
  commitViewInstallation,
  revokeViewInstallation,
} from "./view-installations.ts";
import type { ViewRegistryEntry } from "./view-registry-types.ts";
import { getViewSearchIndex } from "./views-search-index.ts";

async function indexView(view: ViewRegistryEntry, owner: IAgentRuntime) {
  // Independent declared owners let fixtures install views one at a time.
  const pluginName = `fixture-${view.id}`;
  const lease = beginViewInstallation(owner, pluginName);
  const [entry] = commitViewInstallation(owner, lease, [
    { ...view, pluginName },
  ]);
  await getViewSearchIndex(owner).indexView(entry);
  return lease;
}

const runtime = createMockRuntime();
const viewSearchIndex = getViewSearchIndex(runtime);
Object.defineProperty(runtime, "useModel", {
  value: vi.fn(async () => [1, 0]),
});

describe("ViewSearchIndex search limits", () => {
  afterEach(() => {
    viewSearchIndex.clear();
  });

  it("returns no results for invalid topK values", async () => {
    for (let index = 0; index < 3; index += 1) {
      await indexView(
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
        viewSearchIndex.search("query", topK),
        `topK=${String(topK)}`,
      ).resolves.toEqual([]);
    }
  });

  it("returns ranked results for a valid topK, bounded to the requested count", async () => {
    for (let index = 0; index < 3; index += 1) {
      await indexView(
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

    const all = await viewSearchIndex.search("query", 10);
    expect(all).toHaveLength(3);
    expect(all.map((r) => r.viewId).sort()).toEqual([
      "view-0",
      "view-1",
      "view-2",
    ]);

    const limited = await viewSearchIndex.search("query", 2);
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
      await indexView(
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

    const ranked = await getViewSearchIndex(rankingRuntime).search("query", 10);
    expect(ranked.map((entry) => entry.viewId)).toEqual(["a", "z", "corrupt"]);
    expect(Number.isNaN(ranked[2].score)).toBe(true);
  });
});

it("does not return revoked entries or revive them during query embedding", async () => {
  const owner = createMockRuntime();
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  Object.defineProperty(owner, "useModel", {
    value: vi.fn(async (_type: unknown, params: { text: string }) => {
      if (params.text === "query") await barrier;
      return [1, 0];
    }),
  });
  const lease = await indexView(
    {
      id: "notes",
      label: "Notes",
      viewType: "gui",
      pluginName: "unused",
      hasHeroImage: false,
      available: true,
      loadedAt: 0,
      platform: "web",
    },
    owner,
  );
  const pending = getViewSearchIndex(owner).search("query");
  revokeViewInstallation(owner, lease);
  release();
  await expect(pending).resolves.toEqual([]);
});
