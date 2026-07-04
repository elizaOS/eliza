/**
 * Verifies pruneOldestTracked.
 * Deterministic unit test of pure helpers; no runtime, no live model.
 */
import { describe, expect, it } from "vitest";
import { pruneOldestTracked } from "../../src/services/sub-agent-router.js";

// Regression for the #11028 audit: the router's per-session tracking
// collections (parentAgentBuffers / parentAgentDispatchCounts /
// verifyRetryHandedOffSessions) accrued one entry per session and were only
// cleared in stop(), leaking over a long orchestrator uptime. handleEvent now
// caps each via pruneOldestTracked.
describe("pruneOldestTracked", () => {
  it("evicts the oldest entries of a Map down to the cap", () => {
    const m = new Map<string, number>();
    for (let i = 0; i < 300; i++) m.set(`s${i}`, i);
    pruneOldestTracked(m, 256);
    expect(m.size).toBe(256);
    // Oldest (s0..s43) evicted; newest retained.
    expect(m.has("s0")).toBe(false);
    expect(m.has("s43")).toBe(false);
    expect(m.has("s44")).toBe(true);
    expect(m.has("s299")).toBe(true);
  });

  it("evicts the oldest entries of a Set down to the cap", () => {
    const s = new Set<string>();
    for (let i = 0; i < 300; i++) s.add(`h${i}`);
    pruneOldestTracked(s, 256);
    expect(s.size).toBe(256);
    expect(s.has("h0")).toBe(false);
    expect(s.has("h299")).toBe(true);
  });

  it("is a no-op at or below the cap", () => {
    const m = new Map<string, number>([["a", 1]]);
    pruneOldestTracked(m, 256);
    expect(m.size).toBe(1);
  });

  it("prunes the exact excess in one pass (no under-pruning)", () => {
    const m = new Map<string, number>();
    for (let i = 0; i < 500; i++) m.set(`k${i}`, i);
    pruneOldestTracked(m, 100);
    expect(m.size).toBe(100);
  });
});
