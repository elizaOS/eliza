/**
 * Unit tests for `EagerContextBuilder` (C3 — eager provider context split).
 *
 * Invariants under test:
 *   1. `prebuildDeterministic` runs on speech-start and caches the result.
 *   2. `complete()` uses the cached deterministic part without rebuilding.
 *   3. A stale cache (> staleCutoffMs) triggers a rebuild inside `complete()`.
 *   4. Concurrent `prebuildDeterministic` calls collapse into one build.
 *   5. `invalidate()` clears the cache so the next `complete()` rebuilds.
 *   6. `mergeContext` assembles systemText + history in the correct order.
 */

import { describe, expect, it, vi } from "vitest";
import {
  EagerContextBuilder,
  mergeContext,
  type ContextPartial,
} from "../eager-context-builder";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePartial(label: string): ContextPartial {
  return {
    systemBlocks: [`[${label}-system]`],
    historyBlocks: [{ role: "assistant", content: `[${label}-history]` }],
    meta: { label },
  };
}

function makeBuilder(
  opts: {
    detCallCount?: { n: number };
    msgCallCount?: { n: number };
    staleCutoffMs?: number;
    now?: () => number;
  } = {},
) {
  const detCalls = opts.detCallCount ?? { n: 0 };
  const msgCalls = opts.msgCallCount ?? { n: 0 };

  const builder = new EagerContextBuilder({
    buildDeterministic: async () => {
      detCalls.n += 1;
      return makePartial("det");
    },
    buildMessageDependent: async (msg: string) => {
      msgCalls.n += 1;
      return {
        systemBlocks: [],
        historyBlocks: [{ role: "user", content: msg }],
      };
    },
    staleCutoffMs: opts.staleCutoffMs ?? 30_000,
    now: opts.now,
  });

  return { builder, detCalls, msgCalls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EagerContextBuilder", () => {
  it("prebuildDeterministic runs once and caches the result", async () => {
    const detCalls = { n: 0 };
    const { builder } = makeBuilder({ detCallCount: detCalls });

    // Trigger prebuild.
    builder.prebuildDeterministic();
    // Wait for the internal promise to settle.
    await new Promise((r) => setTimeout(r, 10));
    expect(detCalls.n).toBe(1);
    expect(builder.isStale()).toBe(false);
  });

  it("complete() uses the cached deterministic part without rebuilding", async () => {
    const detCalls = { n: 0 };
    const { builder } = makeBuilder({ detCallCount: detCalls });

    builder.prebuildDeterministic();
    await new Promise((r) => setTimeout(r, 10));
    expect(detCalls.n).toBe(1);

    const ctx = await builder.complete("hello world");
    // No rebuild — still only one deterministic call.
    expect(detCalls.n).toBe(1);
    expect(ctx.deterministicWasStale).toBe(false);
    // Deterministic system block is present.
    expect(ctx.systemText).toContain("[det-system]");
    // User message is last history entry.
    expect(ctx.history.at(-1)).toEqual({ role: "user", content: "hello world" });
  });

  it("complete() rebuilds when the cache is stale (> staleCutoffMs)", async () => {
    let fakeNow = 0;
    const detCalls = { n: 0 };
    const { builder } = makeBuilder({
      detCallCount: detCalls,
      staleCutoffMs: 1_000,
      now: () => fakeNow,
    });

    builder.prebuildDeterministic();
    await new Promise((r) => setTimeout(r, 10));
    expect(detCalls.n).toBe(1);

    // Advance fake clock past staleness threshold.
    fakeNow = 1_001;
    expect(builder.isStale()).toBe(true);

    const ctx = await builder.complete("stale message");
    // Should have rebuilt.
    expect(detCalls.n).toBe(2);
    // deterministicWasStale is true because there WAS a cached value that was stale.
    expect(ctx.deterministicWasStale).toBe(true);
  });

  it("complete() without any prebuild rebuilds and marks deterministicWasStale=false (never built)", async () => {
    const detCalls = { n: 0 };
    const { builder } = makeBuilder({ detCallCount: detCalls });

    // No prebuild at all.
    const ctx = await builder.complete("first message");
    // Built inline.
    expect(detCalls.n).toBe(1);
    // Never built before → not stale, just absent.
    expect(ctx.deterministicWasStale).toBe(false);
  });

  it("concurrent prebuildDeterministic calls collapse into a single build", async () => {
    const detCalls = { n: 0 };
    const { builder } = makeBuilder({ detCallCount: detCalls });

    // Fire three times without awaiting.
    builder.prebuildDeterministic();
    builder.prebuildDeterministic();
    builder.prebuildDeterministic();
    await new Promise((r) => setTimeout(r, 20));

    // Only one build should have run.
    expect(detCalls.n).toBe(1);
  });

  it("invalidate() clears the cache so the next complete() rebuilds", async () => {
    const detCalls = { n: 0 };
    const { builder } = makeBuilder({ detCallCount: detCalls });

    builder.prebuildDeterministic();
    await new Promise((r) => setTimeout(r, 10));
    expect(detCalls.n).toBe(1);

    builder.invalidate();
    expect(builder.isStale()).toBe(true);

    await builder.complete("fresh message");
    expect(detCalls.n).toBe(2);
  });

  it("complete() awaits an in-flight prebuild before merging", async () => {
    let resolveDetBuild!: (v: ContextPartial) => void;
    const slowDet = new Promise<ContextPartial>((res) => {
      resolveDetBuild = res;
    });

    let detCallCount = 0;
    const builder = new EagerContextBuilder({
      buildDeterministic: async () => {
        detCallCount += 1;
        return slowDet;
      },
      buildMessageDependent: async (msg: string) => ({
        systemBlocks: [],
        historyBlocks: [{ role: "user" as const, content: msg }],
      }),
    });

    // Start prebuild (won't finish until we resolve `slowDet`).
    builder.prebuildDeterministic();

    // complete() should wait for the prebuild.
    const completePromise = builder.complete("concurrent user message");
    // Let the microtask queue drain without resolving the build.
    await new Promise((r) => setTimeout(r, 5));

    // Resolve the prebuild.
    resolveDetBuild(makePartial("slow-det"));

    const ctx = await completePromise;
    // Only one deterministic build ran.
    expect(detCallCount).toBe(1);
    expect(ctx.systemText).toContain("[slow-det-system]");
  });
});

// ---------------------------------------------------------------------------
// mergeContext
// ---------------------------------------------------------------------------

describe("mergeContext", () => {
  it("joins system blocks with double-newline (det before msg-dep)", () => {
    const det: ContextPartial = {
      systemBlocks: ["SYSTEM_A", "SYSTEM_B"],
      historyBlocks: [{ role: "assistant", content: "HIST_A" }],
    };
    const msgDep: ContextPartial = {
      systemBlocks: ["SYSTEM_C"],
      historyBlocks: [{ role: "user", content: "USER_MSG" }],
    };
    const ts = {
      deterministicBuiltAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z",
      deterministicWasStale: false,
    };
    const full = mergeContext(det, msgDep, ts);
    expect(full.systemText).toBe("SYSTEM_A\n\nSYSTEM_B\n\nSYSTEM_C");
    expect(full.history).toEqual([
      { role: "assistant", content: "HIST_A" },
      { role: "user", content: "USER_MSG" },
    ]);
    expect(full.deterministicWasStale).toBe(false);
  });

  it("handles empty system blocks gracefully", () => {
    const det: ContextPartial = { systemBlocks: [], historyBlocks: [] };
    const msgDep: ContextPartial = {
      systemBlocks: [],
      historyBlocks: [{ role: "user", content: "only user" }],
    };
    const full = mergeContext(det, msgDep, {
      deterministicBuiltAt: "",
      completedAt: "",
      deterministicWasStale: false,
    });
    expect(full.systemText).toBe("");
    expect(full.history).toEqual([{ role: "user", content: "only user" }]);
  });

  it("filters out empty string blocks from systemText", () => {
    const det: ContextPartial = { systemBlocks: ["", "REAL"], historyBlocks: [] };
    const msgDep: ContextPartial = { systemBlocks: [""], historyBlocks: [] };
    const full = mergeContext(det, msgDep, {
      deterministicBuiltAt: "",
      completedAt: "",
      deterministicWasStale: false,
    });
    expect(full.systemText).toBe("REAL");
  });
});
