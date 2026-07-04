/**
 * Last-write-wins guard of the shared resource cache: a newer write
 * (`invalidate` after a delete, `setCached` from an optimistic `mutate()`)
 * must supersede any revalidation already in flight — the in-flight response
 * was fetched before the write and committing it would resurrect deleted data
 * or roll back the user's change. Pure in-memory store, no harness.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetResourceCache,
  getCached,
  invalidate,
  revalidate,
  setCached,
} from "./resource-cache";

afterEach(() => {
  __resetResourceCache();
});

describe("invalidate() vs in-flight revalidation", () => {
  it("a stale in-flight fetch cannot resurrect an invalidated key", async () => {
    const key = "supersede:invalidate:resurrect";
    setCached(key, "server-v1");
    let resolveFetch: (v: string) => void = () => {};
    const slow = revalidate<string>(
      key,
      () => new Promise<string>((r) => (resolveFetch = r)),
    );

    // The item is deleted (mutation) → the cache slot is dropped.
    invalidate(key);
    expect(getCached(key)).toBeUndefined();

    // The pre-deletion response lands afterwards — it must NOT commit.
    resolveFetch("pre-delete-data");
    await slow;
    expect(getCached(key)).toBeUndefined();
  });

  it("a revalidate after invalidate issues a fresh request instead of de-duping onto the pre-invalidation one", async () => {
    const key = "supersede:invalidate:dedup";
    let resolveStale: (v: string) => void = () => {};
    void revalidate<string>(
      key,
      () => new Promise<string>((r) => (resolveStale = r)),
    );

    invalidate(key);

    const freshFetcher = vi.fn(async () => "fresh");
    const got = await revalidate<string>(key, freshFetcher);
    resolveStale("stale");

    expect(freshFetcher).toHaveBeenCalledTimes(1);
    expect(got).toBe("fresh");
    // Let the stale promise settle too — the fresh value must survive it.
    await Promise.resolve();
    expect(getCached(key)?.data).toBe("fresh");
  });
});

describe("setCached() vs in-flight revalidation", () => {
  it("a stale in-flight fetch cannot clobber a newer direct write (the mutate() path)", async () => {
    const key = "supersede:mutate:clobber";
    setCached(key, "server-v1");
    let resolveFetch: (v: string) => void = () => {};
    const slow = revalidate<string>(
      key,
      () => new Promise<string>((r) => (resolveFetch = r)),
    );

    // Optimistic write lands AFTER the fetch started (e.g. following a POST).
    setCached(key, "user-v2");
    expect(getCached(key)?.data).toBe("user-v2");

    // The response fetched before the write resolves late — it must be dropped.
    resolveFetch("server-v1");
    await slow;
    expect(getCached(key)?.data).toBe("user-v2");
  });

  it("an equal-payload refresh does not supersede the in-flight request", async () => {
    // The #9141 freshness-refresh path (same payload, new timestamp) is not a
    // data write — an in-flight revalidation may still commit its result.
    const key = "supersede:equal:noop";
    setCached(key, { v: 1 });
    let resolveFetch: (v: { v: number }) => void = () => {};
    const slow = revalidate<{ v: number }>(
      key,
      () => new Promise<{ v: number }>((r) => (resolveFetch = r)),
    );

    setCached(key, { v: 1 }); // deep-equal → freshness refresh only
    resolveFetch({ v: 2 });
    await slow;
    expect(getCached(key)?.data).toEqual({ v: 2 });
  });
});
