/**
 * Direct tests for ViewSearchIndex topK validation.
 *
 * Issue #20486: ViewSearchIndex.search previously passed topK directly to
 * Array.slice without validation, causing negative values to use slice's
 * negative-index semantics instead of returning an empty result.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { viewSearchIndex } from "./views-search-index.ts";
import type { IAgentRuntime } from "@elizaos/core";

describe("ViewSearchIndex topK validation", () => {
  beforeEach(() => {
    viewSearchIndex.clear();
  });

  it("returns empty array for negative topK", async () => {
    // Index 3 views
    const mockRuntime = {
      useModel: async () => [0.1, 0.2, 0.3],
    } as unknown as IAgentRuntime;

    await viewSearchIndex.indexView(
      { id: "v0", label: "View 0", viewType: "gui" } as any,
      mockRuntime,
    );
    await viewSearchIndex.indexView(
      { id: "v1", label: "View 1", viewType: "gui" } as any,
      mockRuntime,
    );
    await viewSearchIndex.indexView(
      { id: "v2", label: "View 2", viewType: "gui" } as any,
      mockRuntime,
    );

    // topK = -1 should return empty array, not use negative slice semantics
    const results = await viewSearchIndex.search("test", mockRuntime, -1);
    expect(results).toEqual([]);
  });

  it("returns empty array for Number.POSITIVE_INFINITY topK", async () => {
    const mockRuntime = {
      useModel: async () => [0.1, 0.2, 0.3],
    } as unknown as IAgentRuntime;

    await viewSearchIndex.indexView(
      { id: "v0", label: "View 0", viewType: "gui" } as any,
      mockRuntime,
    );

    // topK = Infinity should return empty array, not all entries
    const results = await viewSearchIndex.search(
      "test",
      mockRuntime,
      Number.POSITIVE_INFINITY,
    );
    expect(results).toEqual([]);
  });

  it("returns empty array for NaN topK", async () => {
    const mockRuntime = {
      useModel: async () => [0.1, 0.2, 0.3],
    } as unknown as IAgentRuntime;

    await viewSearchIndex.indexView(
      { id: "v0", label: "View 0", viewType: "gui" } as any,
      mockRuntime,
    );

    const results = await viewSearchIndex.search("test", mockRuntime, NaN);
    expect(results).toEqual([]);
  });

  it("returns empty array for zero topK", async () => {
    const mockRuntime = {
      useModel: async () => [0.1, 0.2, 0.3],
    } as unknown as IAgentRuntime;

    await viewSearchIndex.indexView(
      { id: "v0", label: "View 0", viewType: "gui" } as any,
      mockRuntime,
    );

    const results = await viewSearchIndex.search("test", mockRuntime, 0);
    expect(results).toEqual([]);
  });

  it("returns correct results for positive finite topK", async () => {
    const mockRuntime = {
      useModel: async () => [0.1, 0.2, 0.3],
    } as unknown as IAgentRuntime;

    await viewSearchIndex.indexView(
      { id: "v0", label: "View 0", viewType: "gui" } as any,
      mockRuntime,
    );
    await viewSearchIndex.indexView(
      { id: "v1", label: "View 1", viewType: "gui" } as any,
      mockRuntime,
    );
    await viewSearchIndex.indexView(
      { id: "v2", label: "View 2", viewType: "gui" } as any,
      mockRuntime,
    );

    // topK = 2 should return exactly 2 results
    const results = await viewSearchIndex.search("test", mockRuntime, 2);
    expect(results).toHaveLength(2);
  });
});
