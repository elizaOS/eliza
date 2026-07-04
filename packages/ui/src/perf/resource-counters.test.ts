/**
 * Unit coverage for the live resource counters (snapshot/total). In-memory, no
 * runtime.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetResourceCountersForTests,
  snapshotResourceCounters,
  totalLiveResources,
  trackMedia,
  trackSubscription,
  trackTimer,
  viewsWithLiveResources,
} from "./resource-counters";

beforeEach(() => __resetResourceCountersForTests());
afterEach(() => __resetResourceCountersForTests());

describe("resource-counters — per-view live resource accounting", () => {
  it("counts and releases subscriptions/timers/media", () => {
    const disposeSub = trackSubscription("calendar");
    const disposeTimer = trackTimer("calendar");
    const disposeGl = trackMedia("calendar", "webgl");

    let snap = snapshotResourceCounters("calendar");
    expect(snap.activeSubscriptions).toBe(1);
    expect(snap.pendingTimers).toBe(1);
    expect(snap.heavyResources.webgl).toBe(1);
    expect(totalLiveResources(snap)).toBe(3);

    disposeSub();
    disposeTimer();
    disposeGl();
    snap = snapshotResourceCounters("calendar");
    expect(totalLiveResources(snap)).toBe(0);
  });

  it("is idempotent on double-dispose (StrictMode-safe)", () => {
    const dispose = trackSubscription("v");
    dispose();
    dispose();
    dispose();
    expect(snapshotResourceCounters("v").activeSubscriptions).toBe(0);
  });

  it("scopes counters per view id", () => {
    trackSubscription("a");
    trackSubscription("a");
    trackSubscription("b");
    expect(snapshotResourceCounters("a").activeSubscriptions).toBe(2);
    expect(snapshotResourceCounters("b").activeSubscriptions).toBe(1);
    expect(viewsWithLiveResources().sort()).toEqual(["a", "b"]);
  });

  it("CATCHES A LEAK: a never-disposed subscription stays counted after 'unmount'", () => {
    // Simulate a well-behaved view: acquire then release on unmount.
    const dispose = trackSubscription("good-view");
    dispose(); // unmount cleanup ran
    expect(totalLiveResources(snapshotResourceCounters("good-view"))).toBe(0);

    // Simulate a LEAKY view: acquires a listener but its cleanup never disposes.
    trackSubscription("leaky-view"); // disposer dropped on the floor
    // After "unmount" the counter is still > 0 — the leak is visible.
    expect(
      totalLiveResources(snapshotResourceCounters("leaky-view")),
    ).toBeGreaterThan(0);
    expect(viewsWithLiveResources()).toContain("leaky-view");
    expect(viewsWithLiveResources()).not.toContain("good-view");
  });

  it("accumulates a leak across repeated mount/unmount cycles", () => {
    // A view re-mounted 5x, each mount leaking one listener.
    for (let i = 0; i < 5; i += 1) {
      trackSubscription("repeat-leak"); // never disposed
    }
    expect(snapshotResourceCounters("repeat-leak").activeSubscriptions).toBe(5);
  });
});
