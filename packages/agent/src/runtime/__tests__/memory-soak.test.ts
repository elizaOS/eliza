/**
 * Unit coverage for the runSoak leak-slope harness: it must flag a genuinely
 * leaking workload (retained allocations) as unbounded heap growth and report a
 * drop-everything workload as far flatter. Runs the real harness against live
 * heap allocations with forced GC between samples — no mocks.
 */
import { describe, expect, it } from "vitest";

import { runSoak } from "../memory-soak.ts";

const ITERATIONS = 15;
const OBJECTS_PER_CHUNK = 100_000;

/**
 * Allocate ~several MB of live heap as an array of small objects. Objects (not
 * `Buffer`s, not large flat strings) reliably move `heapUsed`, so heap-slope
 * assertions are meaningful and non-flaky here.
 */
function allocateHeapChunk(): Array<{ v: number }> {
  const chunk = new Array<{ v: number }>(OBJECTS_PER_CHUNK);
  for (let k = 0; k < OBJECTS_PER_CHUNK; k += 1) chunk[k] = { v: k };
  return chunk;
}

describe("runSoak (leak-slope harness)", () => {
  it("flags a genuinely leaking workload as unbounded heap growth", async () => {
    const retained: Array<Array<{ v: number }>> = [];
    const result = await runSoak({
      iterations: ITERATIONS,
      workload: () => {
        retained.push(allocateHeapChunk()); // never released → real leak
      },
    });

    // Tens of MB of unmistakable growth and a clear positive slope (forced GC
    // before each sample → heapUsed reflects only the retained, leaked objects).
    expect(result.growthMb).toBeGreaterThan(20);
    expect(result.slopeMbPerIter).toBeGreaterThan(0.5);
    expect(result.peakHeapMb).toBeGreaterThanOrEqual(result.baselineHeapMb);
    expect(retained).toHaveLength(ITERATIONS);
  });

  it("reports a non-leaking workload as far flatter than the leaking one", async () => {
    const leaked: Array<Array<{ v: number }>> = [];
    const leaking = await runSoak({
      iterations: ITERATIONS,
      workload: () => {
        leaked.push(allocateHeapChunk());
      },
    });

    let sink = 0;
    const steady = await runSoak({
      iterations: ITERATIONS,
      workload: () => {
        // Allocate, touch, and drop — nothing is retained across iterations.
        const chunk = allocateHeapChunk();
        sink += chunk.length;
      },
    });
    expect(sink).toBeGreaterThan(0);

    // The harness must clearly separate a leak from steady state: the dropped-
    // allocation run grows far less than the retained-allocation run.
    expect(steady.growthMb).toBeLessThan(leaking.growthMb * 0.5);
    expect(steady.slopeMbPerIter).toBeLessThan(leaking.slopeMbPerIter);
  });
});
