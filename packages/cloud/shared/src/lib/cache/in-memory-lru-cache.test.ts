/**
 * Pins the eviction and TTL contract of `InMemoryLRUCache`, the shared
 * backing store behind a dozen cloud/shared consumers (steward auth, content
 * moderation, inference admission, model catalog, character/entity-settings
 * caches): two-phase eviction (expired sweep first, then insertion-order trim
 * to 75% of capacity), true-LRU `get()` promotion, strict `>` TTL boundaries,
 * and `deleteByPrefix` start-anchoring.
 *
 * Deterministic harness: time-sensitive tests freeze `Date.now` via
 * `withFrozenClock` (restored in `finally`; no timer APIs involved), so
 * boundary expectations never race real time.
 */

import { describe, expect, test } from "bun:test";
import { InMemoryLRUCache } from "./in-memory-lru-cache";

// Expiry uses strict `Date.now() > expiresAt`, so an entry is live through
// the end of its expiry millisecond. Freezing the clock makes the boundary
// deterministic instead of racing real time. `advanceMs` is cumulative.
const withFrozenClock = (fn: (advanceMs: (ms: number) => void) => void) => {
  const realNow = Date.now;
  const start = realNow();
  let offset = 0;
  try {
    Date.now = () => start;
    fn((ms) => {
      offset += ms;
      Date.now = () => start + offset;
    });
  } finally {
    Date.now = realNow;
  }
};

describe("get / set round-trip", () => {
  test("stores and returns values", () => {
    const cache = new InMemoryLRUCache<string>(10, 60_000);
    cache.set("a", "alpha");
    cache.set("b", "beta");
    expect(cache.get("a")).toBe("alpha");
    expect(cache.get("b")).toBe("beta");
  });

  test("returns null for a missing key", () => {
    const cache = new InMemoryLRUCache<string>(10, 60_000);
    expect(cache.get("nope")).toBeNull();
  });

  test("set overwrites an existing key with the new value", () => {
    const cache = new InMemoryLRUCache<number>(10, 60_000);
    cache.set("k", 1);
    cache.set("k", 2);
    expect(cache.get("k")).toBe(2);
  });

  test("holds arbitrary value shapes (objects by reference)", () => {
    const cache = new InMemoryLRUCache<{ n: number }>(10, 60_000);
    const value = { n: 7 };
    cache.set("k", value);
    expect(cache.get("k")).toBe(value);
  });
});

describe("TTL expiry", () => {
  test("an entry is readable at the exact expiry millisecond (strict > boundary)", () => {
    withFrozenClock((advanceMs) => {
      const cache = new InMemoryLRUCache<string>(10, 1_000);
      cache.set("k", "v");
      expect(cache.get("k")).toBe("v");
      advanceMs(1_000); // exactly at expiresAt, not past it
      expect(cache.get("k")).toBe("v");
    });
  });

  test("an entry past its TTL reads as null and is purged", () => {
    withFrozenClock((advanceMs) => {
      const cache = new InMemoryLRUCache<string>(10, 1_000);
      cache.set("k", "v");
      advanceMs(1_001);
      expect(cache.get("k")).toBeNull();
    });
  });

  test("a fresh entry with a long TTL is readable", () => {
    const cache = new InMemoryLRUCache<string>(10, 60_000);
    cache.set("k", "v");
    expect(cache.get("k")).toBe("v");
  });

  test("a get that observes expiry physically removes the entry", () => {
    withFrozenClock((advanceMs) => {
      const cache = new InMemoryLRUCache<string>(10, 1_000);
      cache.set("k", "v");
      advanceMs(2_000);
      expect(cache.get("k")).toBeNull(); // purged on read
      // Rewind the clock: the entry was physically deleted by the
      // expiry-observing get, so it cannot come back — proving the
      // deletion, not just the clock position, caused the miss.
      advanceMs(-2_000);
      expect(cache.get("k")).toBeNull();
    });
  });

  test("set after expiry re-inserts with a fresh TTL window", () => {
    withFrozenClock((advanceMs) => {
      const cache = new InMemoryLRUCache<string>(10, 1_000);
      cache.set("k", "old");
      advanceMs(2_000);
      expect(cache.get("k")).toBeNull();
      cache.set("k", "new"); // fresh expiresAt = now + 1000
      expect(cache.get("k")).toBe("new");
    });
  });
});

describe("LRU recency on get", () => {
  test("get promotes an entry so it survives eviction over never-re-read peers", () => {
    const cache = new InMemoryLRUCache<string>(3, 60_000);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");
    // Promote "a": it is now the most recently used; "b" is the oldest.
    expect(cache.get("a")).toBe("1");
    // Inserting a 4th key trips capacity (size >= maxSize). Eviction
    // trims to floor(3 * 0.75) = 2 survivors: the oldest entry ("b")
    // is evicted, keeping "c" and promoted "a". Then "d" is inserted.
    cache.set("d", "4");
    expect(cache.get("b")).toBeNull();
    expect(cache.get("c")).toBe("3");
    expect(cache.get("a")).toBe("1");
    expect(cache.get("d")).toBe("4");
  });

  test("insertion order alone (no gets) evicts the oldest first", () => {
    const cache = new InMemoryLRUCache<string>(3, 60_000);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");
    cache.set("d", "4");
    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).toBe("2");
    expect(cache.get("c")).toBe("3");
    expect(cache.get("d")).toBe("4");
  });
});

describe("capacity eviction", () => {
  test("eviction kicks in at size >= maxSize, not after exceeding it", () => {
    const cache = new InMemoryLRUCache<string>(2, 60_000);
    cache.set("a", "1");
    cache.set("b", "2");
    // Cache is at capacity; the next set must first evict "a".
    cache.set("c", "3");
    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).toBe("2");
    expect(cache.get("c")).toBe("3");
  });

  test("eviction trims to 75% of capacity, not just one entry", () => {
    const cache = new InMemoryLRUCache<string>(8, 60_000);
    for (let i = 0; i < 8; i++) {
      cache.set(`k${i}`, String(i));
    }
    // Size hits 8 >= 8: purge leaves floor(8 * 0.75) = 6 survivors —
    // the 6 most recent insertions k2..k7.
    cache.set("k8", "8");
    expect(cache.get("k0")).toBeNull();
    expect(cache.get("k1")).toBeNull();
    for (let i = 2; i <= 8; i++) {
      expect(cache.get(`k${i}`)).toBe(String(i));
    }
  });

  test("overwriting an existing key at capacity re-inserts it as the newest entry", () => {
    const cache = new InMemoryLRUCache<string>(3, 60_000);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");
    // set() runs evict() whenever size >= maxSize — including overwrites.
    // The trim removes toRemove = 3 - floor(3*0.75) = 1 entry from the
    // front ("a" itself), then the overwritten key is appended as the
    // newest: order becomes [b, c, a]. No intermediate gets — get()
    // promotes and would reorder the map before the proof.
    cache.set("a", "9");
    cache.set("d", "4"); // trims the front ("b"): order [c, a, d]
    cache.set("e", "5"); // trims the next front: "c" — NOT "a"
    // If the overwrite had left "a" in the middle ([b, a, c]), the second
    // trim would have dropped "a" here instead of "c".
    expect(cache.get("a")).toBe("9");
    expect(cache.get("b")).toBeNull();
    expect(cache.get("c")).toBeNull();
    expect(cache.get("d")).toBe("4");
    expect(cache.get("e")).toBe("5");
  });

  test("overwriting an entry below capacity preserves its insertion position", () => {
    const cache = new InMemoryLRUCache<string>(4, 60_000);
    cache.set("old", "1");
    cache.set("mid", "2");
    cache.set("new", "3"); // size 3 < 4: no eviction on the overwrite below
    cache.set("old", "refreshed"); // plain Map.set keeps "old" at the front
    // Fill to capacity, then one more insert trips the trim (toRemove =
    // 4 - 3 = 1): the front entry is dropped. If the overwrite had
    // delete-and-reinserted "old" like get() does, the front would be
    // "mid" instead — this pins that set() does NOT promote recency.
    cache.set("x", "x");
    cache.set("y", "y");
    expect(cache.get("old")).toBeNull(); // front position made it the trim victim
    expect(cache.get("mid")).toBe("2");
    expect(cache.get("new")).toBe("3");
    expect(cache.get("x")).toBe("x");
    expect(cache.get("y")).toBe("y");
  });

  test("an expired purge spares a live entry that the 75% trim would sacrifice", () => {
    withFrozenClock((advanceMs) => {
      // Construction: "L" is the OLDEST Map position but LIVE — a
      // set() overwrite refreshes its TTL in place (plain Map.set on
      // an existing key keeps its position, unlike get()'s
      // delete-and-reinsert promotion). The newer-inserted "z1" is
      // expired. Inserting "d" at capacity must purge z1 (expired)
      // and spare live "L"; without the expired purge the 75% trim
      // would compute victims from raw insertion order and delete
      // the LIVE "L" from the front.
      const cache = new InMemoryLRUCache<string>(3, 1_000);
      cache.set("L", "stale"); // t0, expires t0+1000
      advanceMs(500);
      cache.set("z1", "zombie"); // t500, expires t1500
      advanceMs(300); // t800, size 2 < 3 so no eviction on overwrite
      cache.set("L", "refreshed"); // expires t1800, still Map-position 0
      advanceMs(300); // t1100
      cache.set("z2", "live-newest"); // expires t2100; order [L, z1, z2]
      advanceMs(500); // t1600: z1 expired (t1500), L live (t1800), z2 live
      cache.set("d", "4"); // trips capacity
      expect(cache.get("L")).toBe("refreshed"); // live front entry spared by the purge
      expect(cache.get("z1")).toBeNull(); // expired
      expect(cache.get("z2")).toBe("live-newest");
      expect(cache.get("d")).toBe("4");
    });
  });

  test("a fully-expired cache is physically emptied by the next insert's eviction sweep", () => {
    withFrozenClock((advanceMs) => {
      const cache = new InMemoryLRUCache<string>(3, 1_000);
      cache.set("a", "1");
      cache.set("b", "2");
      cache.set("c", "3");
      advanceMs(2_000); // all three expire without being read
      cache.set("d", "4"); // trips capacity: the expired sweep removes a, b, c
      // Rewind the clock to before the old entries' expiry. Had the sweep
      // merely left the expired entries in place, they would read back as
      // live values now — their absence proves physical deletion.
      advanceMs(-2_000);
      expect(cache.get("a")).toBeNull();
      expect(cache.get("b")).toBeNull();
      expect(cache.get("c")).toBeNull();
      expect(cache.get("d")).toBe("4"); // inserted after the rewind point: still live
    });
  });

  test("an entry at its exact expiry millisecond is NOT purged by the evict sweep (strict >)", () => {
    withFrozenClock((advanceMs) => {
      const cache = new InMemoryLRUCache<string>(3, 1_000);
      cache.set("a", "1"); // expires at t0+1000
      advanceMs(500);
      cache.set("b", "2"); // expires at t0+1500
      advanceMs(500); // now exactly t0+1000: "a" is AT its boundary, not past it
      cache.set("c", "3"); // expires at t0+2000
      expect(cache.get("a")).toBe("1"); // still live at the boundary; promotes "a" to MRU
      cache.set("d", "4"); // trips capacity: purge spares "a" (strict >), trim then drops "b"
      expect(cache.get("a")).toBe("1"); // survived: boundary entry is live, and MRU
      expect(cache.get("b")).toBeNull(); // the live-but-oldest entry is the 75% trim victim
      expect(cache.get("c")).toBe("3");
      expect(cache.get("d")).toBe("4");
    });
  });
});

describe("delete / deleteByPrefix / clear", () => {
  test("delete removes a single key", () => {
    const cache = new InMemoryLRUCache<string>(10, 60_000);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.delete("a");
    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).toBe("2");
  });

  test("delete of a missing key leaves other entries intact", () => {
    const cache = new InMemoryLRUCache<string>(10, 60_000);
    cache.set("a", "1");
    cache.delete("never-there");
    expect(cache.get("a")).toBe("1");
  });

  test("deleteByPrefix removes only matching keys", () => {
    const cache = new InMemoryLRUCache<string>(10, 60_000);
    cache.set("user:1", "a");
    cache.set("user:2", "b");
    cache.set("org:1", "c");
    cache.set("user-list", "d"); // shares the "user" stem but not the "user:" prefix
    cache.deleteByPrefix("user:");
    expect(cache.get("user:1")).toBeNull();
    expect(cache.get("user:2")).toBeNull();
    expect(cache.get("org:1")).toBe("c");
    expect(cache.get("user-list")).toBe("d");
  });

  test("deleteByPrefix anchors at the start, not anywhere in the key", () => {
    const cache = new InMemoryLRUCache<string>(10, 60_000);
    cache.set("config:user:1", "a"); // contains the prefix mid-key
    cache.set("user:1", "b");
    cache.deleteByPrefix("user:");
    expect(cache.get("config:user:1")).toBe("a"); // untouched: prefix is not at position 0
    expect(cache.get("user:1")).toBeNull();
  });

  test("deleteByPrefix with a prefix no key shares is a no-op", () => {
    const cache = new InMemoryLRUCache<string>(10, 60_000);
    cache.set("a", "1");
    cache.deleteByPrefix("zzz:");
    expect(cache.get("a")).toBe("1");
  });

  test("clear empties everything", () => {
    const cache = new InMemoryLRUCache<string>(10, 60_000);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.clear();
    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).toBeNull();
  });

  test("a cleared cache still accepts new writes", () => {
    const cache = new InMemoryLRUCache<string>(1, 60_000);
    cache.set("a", "1");
    cache.clear();
    cache.set("b", "2");
    expect(cache.get("b")).toBe("2");
  });
});
