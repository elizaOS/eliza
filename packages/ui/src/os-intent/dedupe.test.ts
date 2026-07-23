/**
 * Idempotency-store unit tests: exactly-once recording, TTL expiry/prune, and the
 * snapshot→seed round-trip that lets a restored/crashed-then-reopened session skip
 * launches its predecessor already handled. Deterministic; injected clock, no I/O.
 */
import { describe, expect, it } from "vitest";
import { IntentDedupeStore } from "./dedupe";

describe("IntentDedupeStore", () => {
  it("reports an unrecorded id as absent", () => {
    const store = new IntentDedupeStore();
    expect(store.has("a", 0)).toBe(false);
    expect(store.firstAppliedAt("a", 0)).toBeNull();
  });

  it("records an id and reports it applied", () => {
    const store = new IntentDedupeStore();
    store.record("a", 100);
    expect(store.has("a", 200)).toBe(true);
    expect(store.firstAppliedAt("a", 200)).toBe(100);
    expect(store.size).toBe(1);
  });

  it("keeps the FIRST applied time so a redelivery cannot advance the TTL", () => {
    const store = new IntentDedupeStore({ ttlMs: 1000 });
    store.record("a", 100);
    store.record("a", 900); // redelivery — must not move the timestamp
    expect(store.firstAppliedAt("a", 950)).toBe(100);
    // At now=1200 the record is 1100ms old (> ttl) and expires, though the second
    // record call was only 300ms ago — proving the first time is authoritative.
    expect(store.has("a", 1200)).toBe(false);
  });

  it("expires a record past its TTL and treats a reused id as fresh", () => {
    const store = new IntentDedupeStore({ ttlMs: 500 });
    store.record("a", 0);
    expect(store.has("a", 400)).toBe(true);
    expect(store.has("a", 600)).toBe(false); // expired
    expect(store.size).toBe(0); // reading dropped it
  });

  it("prune() drops only expired records and returns the count", () => {
    const store = new IntentDedupeStore({ ttlMs: 100 });
    store.record("old", 0);
    store.record("new", 90);
    expect(store.prune(150)).toBe(1); // only "old" is >100ms
    expect(store.has("new", 150)).toBe(true);
    expect(store.has("old", 150)).toBe(false);
  });

  it("snapshot()→seed rehydrates applied ids (restored session dedupes)", () => {
    const first = new IntentDedupeStore();
    first.record("launch-1", 1000);
    first.record("launch-2", 1000);
    const snapshot = first.snapshot(1000);

    // A brand-new store (a session restored after a crash) seeded with the snapshot.
    const restored = new IntentDedupeStore({ seed: snapshot });
    expect(restored.has("launch-1", 1000)).toBe(true);
    expect(restored.has("launch-2", 1000)).toBe(true);
    expect(restored.has("launch-3", 1000)).toBe(false);
  });

  it("snapshot() omits expired records so a stale seed does not pin memory", () => {
    const store = new IntentDedupeStore({ ttlMs: 100 });
    store.record("old", 0);
    store.record("fresh", 90);
    expect(store.snapshot(150).map((r) => r.intentId)).toEqual(["fresh"]);
  });
});
