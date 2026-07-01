/**
 * Co-residency eviction-telemetry test (#8809).
 *
 * Run: bun test packages/benchmarks/memperf/co-residency.test.ts
 *
 * Proves the harness's central claim: under the scripted co-residency sequence
 * (load text → load vision → load voice → force pressure) the REAL MemoryArbiter
 * emits eviction telemetry the harness counts. This is the AC the harness wires
 * ("emits ... eviction count" + "fail on regression"), exercised with synthetic
 * SIZED loaders so it is CI-safe (no models, no FFI) yet drives the genuine
 * `evictToFit` fit-path and the pressure path — not a stub.
 */

import { describe, expect, it } from "bun:test";

import { MemoryArbiter } from "@elizaos/plugin-local-inference/services";
import type {
  ArbiterCapability,
  ArbiterEvent,
} from "@elizaos/plugin-local-inference/services/memory-arbiter";
import { capacitorPressureSource } from "@elizaos/plugin-local-inference/services/memory-pressure";
import { SharedResourceRegistry } from "@elizaos/plugin-local-inference/services/voice/shared-resources";

function makeArbiter(budgetMb: number) {
  const events: ArbiterEvent[] = [];
  const pressure = capacitorPressureSource();
  const arbiter = new MemoryArbiter({
    registry: new SharedResourceRegistry(),
    pressureSource: pressure,
    budgetMb: () => budgetMb,
  });
  const off = arbiter.onEvent((e) => events.push(e));
  arbiter.start();
  return { arbiter, pressure, events, off };
}

const SIZES: Record<ArbiterCapability, number> = {
  text: 1200,
  embedding: 300,
  "vision-describe": 600,
  "image-gen": 1100,
  transcribe: 250,
};

function registerSized(arbiter: MemoryArbiter) {
  for (const cap of Object.keys(SIZES) as ArbiterCapability[]) {
    arbiter.registerCapability({
      capability: cap,
      estimatedMb: SIZES[cap],
      load: async () => ({ cap }),
      unload: async () => {},
      run: async () => ({}),
    });
  }
}

describe("memperf co-residency eviction telemetry", () => {
  it("LRU fit-path evicts the coldest evictable resident when a load exceeds budget", async () => {
    // Budget fits text (1200) but the 600 MB vision pushes total over 1000 only
    // after a second non-text load; size the budget so the fit path must drop
    // the LRU evictable role. text is pinned (never evicted).
    const { arbiter, events, off } = makeArbiter(1500);
    registerSized(arbiter);
    try {
      // text(1200) resident, refcount 0 after release → pinned regardless.
      await (await arbiter.acquire("text", "t")).release();
      // vision(600): 1200+600=1800 > 1500 → fit-path must evict something
      // evictable. text is pinned, so... nothing else is resident yet; the
      // fit path is best-effort and proceeds. Now vision is resident.
      await (await arbiter.acquire("vision-describe", "v")).release();
      // transcribe(250): residents text(1200)+vision(600)=1800, +250=2050 > 1500
      // → fit-path evicts the LRU evictable (vision) before loading.
      await (await arbiter.acquire("transcribe", "a")).release();

      const fitEvictions = events.filter(
        (e) => e.type === "eviction" && e.reason === "fit",
      );
      expect(fitEvictions.length).toBeGreaterThanOrEqual(1);
      // The pinned text target is never the eviction victim.
      for (const e of events) {
        if (e.type === "eviction") expect(e.capability).not.toBe("text");
      }
    } finally {
      off();
      await arbiter.shutdown();
    }
  });

  it("critical pressure evicts every non-text resident and emits eviction telemetry", async () => {
    const { arbiter, pressure, events, off } = makeArbiter(100_000); // huge → no fit evictions
    registerSized(arbiter);
    try {
      await (await arbiter.acquire("text", "t")).release();
      await (await arbiter.acquire("vision-describe", "v")).release();
      await (await arbiter.acquire("transcribe", "a")).release();

      // No fit evictions on a huge budget — all three are co-resident.
      expect(events.filter((e) => e.type === "eviction").length).toBe(0);

      pressure.dispatch("critical", 64);
      await new Promise((r) => setTimeout(r, 20));

      const evicted = events.filter((e) => e.type === "eviction");
      // vision + transcribe evicted under critical; text survives.
      expect(evicted.length).toBe(2);
      const caps = evicted
        .map((e) => (e.type === "eviction" ? e.capability : ""))
        .sort();
      expect(caps).toEqual(["transcribe", "vision-describe"]);
      expect(
        events.some(
          (e) => e.type === "memory_pressure" && e.level === "critical",
        ),
      ).toBe(true);
    } finally {
      off();
      await arbiter.shutdown();
    }
  });

  it("acquire refuses non-text capabilities under critical pressure (budget gate is real)", async () => {
    const { arbiter, pressure, off } = makeArbiter(100_000);
    registerSized(arbiter);
    try {
      pressure.dispatch("critical", 32);
      await new Promise((r) => setTimeout(r, 10));
      await expect(arbiter.acquire("vision-describe", "v")).rejects.toThrow(
        /critical/i,
      );
      // text must still load — losing it bricks the agent.
      const h = await arbiter.acquire("text", "t");
      expect(h.capability).toBe("text");
      await h.release();
    } finally {
      off();
      await arbiter.shutdown();
    }
  });
});
