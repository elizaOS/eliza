/**
 * Proves the worker-lifetime inference app cache contract: the LRU-backed
 * get/set surface for app rows, the 30s TTL expiry, the 100-entry capacity
 * bound (expired-first, then least-recently-used eviction), and the per-app
 * hydration-generation fence that lets callers detect a stale in-flight read.
 * The module is exercised directly with real clock control via `bun:test`'s
 * `setSystemTime`; no mocks are needed — the module owns no collaborators
 * beyond the LRU instance and the generation map.
 */

import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type { App } from "../../db/repositories/apps";
import {
  getAppByIdHydrationGeneration,
  getInferenceAppById,
  invalidateInferenceAppByIdState,
  setInferenceAppById,
} from "./inference-app-memory-cache";

let appSequence = 0;

/** Minimal structural App fixture — the cache is value-agnostic beyond identity. */
function app(overrides: Partial<App> = {}): App {
  const id = `app-${++appSequence}`;
  return {
    id,
    name: `name-${id}`,
    slug: `slug-${id}`,
    organization_id: "org-1",
    created_by_user_id: "user-1",
    app_url: `https://${id}.example`,
    monetization_enabled: false,
    review_status: "approved",
    ...overrides,
  } as App;
}

/** Unique per-test app ids keep the module-level singletons isolated per test. */
let idSequence = 0;
function appId(): string {
  idSequence += 1;
  return `cache-test-${idSequence}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The cache and generation map are module-level singletons shared across
 * tests. Capacity/eviction tests need a deterministic starting population, so
 * they freeze the clock at a fresh point 60s past every prior entry's TTL:
 * all earlier entries (real-clock and fake-clock alike, TTL 30s) are already
 * expired, and the capacity-triggered eviction pass during the test's fill
 * purges them, so the test starts with a known population.
 */
let fakeClock = Date.now() + 1_000_000;
function startWithEmptyCache(): number {
  fakeClock += 60_000;
  const now = fakeClock;
  setSystemTime(new Date(now));
  return now;
}

afterEach(() => {
  setSystemTime(null);
});

describe("getInferenceAppById / setInferenceAppById", () => {
  test("miss returns null before any set", () => {
    expect(getInferenceAppById(appId())).toBeNull();
  });

  test("set then get returns the cached row", () => {
    const id = appId();
    const row = app({ id });
    setInferenceAppById(id, row);
    expect(getInferenceAppById(id)).toEqual(row);
  });

  test("set overwrites a prior row for the same id", () => {
    const id = appId();
    setInferenceAppById(id, app({ id, name: "first" }));
    const second = app({ id, name: "second" });
    setInferenceAppById(id, second);
    expect(getInferenceAppById(id)).toEqual(second);
    expect(getInferenceAppById(id)?.name).toBe("second");
  });

  test("entries expire after the 30s TTL", () => {
    const id = appId();
    setInferenceAppById(id, app({ id }));
    setSystemTime(new Date(Date.now() + 30_001));
    expect(getInferenceAppById(id)).toBeNull();
  });

  test("a read just inside the TTL window still hits (29,999ms)", () => {
    // Pins the useful half of the TTL boundary — the entry is served through
    // the full 30s window — without pinning whether the exact millisecond of
    // expiry is inclusive or exclusive (an implementation choice).
    const id = appId();
    const row = app({ id });
    setInferenceAppById(id, row);
    setSystemTime(new Date(Date.now() + 29_999));
    expect(getInferenceAppById(id)).toEqual(row);
  });

  test("a get refreshes recency: a touched entry survives LRU eviction", () => {
    startWithEmptyCache();
    // Fill to the 100 cap, touch the OLDEST entry, then insert one more —
    // eviction reclaims the 25% oldest slice, so the touched entry (now most
    // recent) must survive while untouched cold entries evict in its place.
    const touched = appId();
    const others = Array.from({ length: 99 }, () => appId());
    setInferenceAppById(touched, app({ id: touched })); // insertion order: touched oldest
    for (const id of others) setInferenceAppById(id, app({ id }));
    expect(getInferenceAppById(touched)).not.toBeNull(); // the touch: recency refreshed
    const cold = appId();
    setInferenceAppById(cold, app({ id: cold })); // 101st insert triggers eviction
    expect(getInferenceAppById(touched)).not.toBeNull();
    expect(getInferenceAppById(cold)).not.toBeNull();
    expect(getInferenceAppById(others[0])).toBeNull(); // untouched oldest was the victim
    let present = 0;
    for (const id of [touched, cold, ...others]) {
      if (getInferenceAppById(id) !== null) present += 1;
    }
    expect(present).toBe(76); // 100 live + newcomer - 25 evicted
  });

  test("ids partition: sibling ids never cross-contaminate", () => {
    const a = appId();
    const b = appId();
    setInferenceAppById(a, app({ id: a }));
    expect(getInferenceAppById(b)).toBeNull();
    setInferenceAppById(b, app({ id: b }));
    expect(getInferenceAppById(a)?.id).toBe(a);
    expect(getInferenceAppById(b)?.id).toBe(b);
  });
});

describe("invalidateInferenceAppByIdState", () => {
  test("removes the cached row so the next read misses", () => {
    const id = appId();
    setInferenceAppById(id, app({ id }));
    expect(getInferenceAppById(id)).not.toBeNull();
    invalidateInferenceAppByIdState(id);
    expect(getInferenceAppById(id)).toBeNull();
  });

  test("bumps the hydration generation for that id only", () => {
    const a = appId();
    const b = appId();
    const genA0 = getAppByIdHydrationGeneration(a);
    invalidateInferenceAppByIdState(a);
    expect(getAppByIdHydrationGeneration(a)).toBe(genA0 + 1);
    expect(getAppByIdHydrationGeneration(b)).toBe(0);
  });

  test("generation is monotonic across repeated invalidations", () => {
    const id = appId();
    const before = getAppByIdHydrationGeneration(id);
    invalidateInferenceAppByIdState(id);
    invalidateInferenceAppByIdState(id);
    invalidateInferenceAppByIdState(id);
    expect(getAppByIdHydrationGeneration(id)).toBe(before + 3);
  });

  test("invalidate on a never-set id is a safe no-op for reads", () => {
    const id = appId();
    expect(() => invalidateInferenceAppByIdState(id)).not.toThrow();
    expect(getInferenceAppById(id)).toBeNull();
  });

  test("set does NOT bump the generation (publication is not invalidation)", () => {
    const id = appId();
    const before = getAppByIdHydrationGeneration(id);
    setInferenceAppById(id, app({ id }));
    expect(getAppByIdHydrationGeneration(id)).toBe(before);
  });

  test("invalidate after set both clears the row and bumps the generation", () => {
    const id = appId();
    const before = getAppByIdHydrationGeneration(id);
    setInferenceAppById(id, app({ id }));
    invalidateInferenceAppByIdState(id);
    expect(getInferenceAppById(id)).toBeNull();
    expect(getAppByIdHydrationGeneration(id)).toBe(before + 1);
  });

  test("generations are per-id: invalidating one id leaves a sibling's untouched", () => {
    const a = appId();
    const b = appId();
    setInferenceAppById(a, app({ id: a }));
    setInferenceAppById(b, app({ id: b }));
    const genB = getAppByIdHydrationGeneration(b);
    invalidateInferenceAppByIdState(a);
    expect(getAppByIdHydrationGeneration(b)).toBe(genB);
    expect(getInferenceAppById(b)).not.toBeNull();
  });
});

describe("capacity bound", () => {
  test("at capacity, an insert reclaims the oldest 25% slice (75% retention policy)", () => {
    startWithEmptyCache();
    const first = appId();
    const ids = [first, ...Array.from({ length: 99 }, () => appId())];
    for (const id of ids) setInferenceAppById(id, app({ id }));
    const newcomer = appId();
    setInferenceAppById(newcomer, app({ id: newcomer }));
    // Eviction downsizes to 75% of the 100 cap: the 25 oldest-inserted ids go,
    // first (inserted earliest, never touched again) among them.
    expect(getInferenceAppById(first)).toBeNull();
    expect(getInferenceAppById(newcomer)).not.toBeNull();
    expect(getInferenceAppById(ids[24])).toBeNull(); // 25th oldest — still evicted
    expect(getInferenceAppById(ids[25])).not.toBeNull(); // 26th oldest — retained
    let present = 0;
    for (const id of [...ids, newcomer]) {
      if (getInferenceAppById(id) !== null) present += 1;
    }
    expect(present).toBe(76); // 75 retained + the newcomer
  });

  test("expired entries are reclaimed before live LRU eviction", () => {
    const t0 = startWithEmptyCache();
    // 25 soon-to-expire entries, inserted FIRST so they sit at the LRU front.
    const expiring = Array.from({ length: 25 }, () => appId());
    for (const id of expiring) setInferenceAppById(id, app({ id }));
    // Advance 20s, then insert 75 live entries. The first 25 now have 10s of
    // TTL left; the live 75 have a full 30s.
    setSystemTime(new Date(t0 + 20_000));
    const live = Array.from({ length: 75 }, () => appId());
    for (const id of live) setInferenceAppById(id, app({ id }));
    expect(getInferenceAppById(live[0])).not.toBeNull(); // 100 entries at capacity
    // Touch every expiring entry so it becomes MOST-recently-used: after they
    // expire, pure-LRU fallback would evict the 25 oldest LIVE entries instead
    // of reclaiming the expired ones — this construction distinguishes the
    // expired-first ordering from plain LRU eviction.
    for (const id of expiring) expect(getInferenceAppById(id)).not.toBeNull();
    // Cross the 30s TTL of the first batch (t0 + 30_001) while the live 75
    // still have ~10s left, then insert the 101st entry to trigger eviction.
    setSystemTime(new Date(t0 + 30_001));
    const newcomer = appId();
    setInferenceAppById(newcomer, app({ id: newcomer }));
    expect(getInferenceAppById(newcomer)).not.toBeNull();
    // All 75 live entries survive: the eviction pass reclaimed the 25 expired
    // entries (most-recently-used!) instead of live rows.
    for (const id of live) expect(getInferenceAppById(id)).not.toBeNull();
    // ...and the expired entries are gone.
    for (const id of expiring) expect(getInferenceAppById(id)).toBeNull();
  });
});
