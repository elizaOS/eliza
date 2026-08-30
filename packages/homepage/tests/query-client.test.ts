/**
 * Tests the createQueryClient factory defaults and instance independence behind the embedded public surfaces.
 */

import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { createQueryClient } from "../src/lib/query-client";

describe("createQueryClient", () => {
  test("returns a real TanStack QueryClient instance", () => {
    expect(createQueryClient()).toBeInstanceOf(QueryClient);
  });

  test("returns a fresh client with an independent cache on every call", () => {
    const first = createQueryClient();
    const second = createQueryClient();
    expect(first).not.toBe(second);

    first.setQueryData(["solo"], "first-client-only");
    expect(first.getQueryData(["solo"])).toBe("first-client-only");
    expect(second.getQueryData(["solo"])).toBeUndefined();
    expect(second.getQueryCache().getAll()).toEqual([]);
  });

  test("applies the shared query defaults", () => {
    const client = createQueryClient();
    expect(client.getDefaultOptions()).toEqual({
      queries: {
        staleTime: 60_000,
        gcTime: 300_000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: 0 },
    });
  });

  test("disables retries for mutations", () => {
    const client = createQueryClient();
    expect(client.getDefaultOptions().mutations?.retry).toBe(0);
  });

  test("registers no per-key query overrides on a fresh client", () => {
    const client = createQueryClient();
    expect(client.getQueryDefaults(["agents"])).toEqual({});
  });

  test("starts with empty query and mutation caches", () => {
    const client = createQueryClient();
    expect(client.getQueryCache().getAll()).toEqual([]);
    expect(client.getMutationCache().getAll()).toEqual([]);
  });

  test("keeps written query data readable until the cache is cleared", () => {
    const client = createQueryClient();
    client.setQueryData<{ count: number }>(["leaderboard"], { count: 7 });
    expect(client.getQueryData(["leaderboard"])).toEqual({ count: 7 });
    const state = client.getQueryState(["leaderboard"]);
    expect(state?.dataUpdatedAt).toBeGreaterThan(0);
    expect(state?.isInvalidated).toBe(false);

    client.clear();
    expect(client.getQueryData(["leaderboard"])).toBeUndefined();
    expect(client.getQueryCache().getAll()).toEqual([]);
  });
});
