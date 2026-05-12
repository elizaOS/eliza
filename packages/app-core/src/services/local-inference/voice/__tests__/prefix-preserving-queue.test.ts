/**
 * Tests for `PrefixPreservingQueue` — prefix-preserving TTS barge-in rollback.
 *
 * Core invariant: given a divergencePoint N, after `rollbackAt(N)`:
 *   - chunks with tokenRange[1] <= N  are RETAINED
 *   - chunks with tokenRange[0] >  N  are DROPPED
 *   - chunks that straddle N           are RETAINED (best-effort, phrase granularity)
 */

import { describe, expect, it } from "vitest";
import {
  PrefixPreservingQueue,
  type TaggedAudioChunk,
} from "../prefix-preserving-queue";

function chunk(
  start: number,
  end: number,
  durationMs = 50,
): TaggedAudioChunk {
  const pcm = new Float32Array(Math.ceil((durationMs / 1000) * 24_000));
  return { pcm, tokenRange: [start, end], durationMs };
}

describe("PrefixPreservingQueue — basic queue operations", () => {
  it("starts empty", () => {
    const q = new PrefixPreservingQueue();
    expect(q.size).toBe(0);
    expect(q.snapshot()).toHaveLength(0);
  });

  it("size tracks enqueued chunks", () => {
    const q = new PrefixPreservingQueue();
    q.enqueue(chunk(0, 2));
    expect(q.size).toBe(1);
    q.enqueue(chunk(3, 5));
    expect(q.size).toBe(2);
  });

  it("clear() empties the queue and returns all chunks", () => {
    const q = new PrefixPreservingQueue();
    const c1 = chunk(0, 2);
    const c2 = chunk(3, 5);
    q.enqueue(c1);
    q.enqueue(c2);
    const cleared = q.clear();
    expect(cleared).toHaveLength(2);
    expect(cleared[0]).toBe(c1);
    expect(cleared[1]).toBe(c2);
    expect(q.size).toBe(0);
  });

  it("snapshot() does not mutate the queue", () => {
    const q = new PrefixPreservingQueue();
    q.enqueue(chunk(0, 4));
    const snap = q.snapshot();
    expect(snap).toHaveLength(1);
    expect(q.size).toBe(1);
  });
});

describe("PrefixPreservingQueue — rollbackAt", () => {
  it("retains chunks whose tokenRange[1] <= divergencePoint", () => {
    const q = new PrefixPreservingQueue();
    const c0 = chunk(0, 3); // end=3, fully before N=5
    const c1 = chunk(4, 5); // end=5, exactly at N=5
    q.enqueue(c0);
    q.enqueue(c1);
    const result = q.rollbackAt(5);
    expect(result.retained).toContain(c0);
    expect(result.retained).toContain(c1);
    expect(result.dropped).toHaveLength(0);
    expect(result.straddled).toHaveLength(0);
  });

  it("drops chunks whose tokenRange[0] > divergencePoint", () => {
    const q = new PrefixPreservingQueue();
    const c0 = chunk(0, 3);  // retained
    const c1 = chunk(6, 10); // start=6 > N=5 → dropped
    q.enqueue(c0);
    q.enqueue(c1);
    const result = q.rollbackAt(5);
    expect(result.retained).toContain(c0);
    expect(result.dropped).toContain(c1);
    expect(result.straddled).toHaveLength(0);
  });

  it("keeps straddling chunks (start<=N, end>N) and records them separately", () => {
    const q = new PrefixPreservingQueue();
    const c0 = chunk(0, 2);  // fully before N=4 → retained
    const c1 = chunk(3, 7);  // straddles N=4 (start=3<=4, end=7>4) → retained+straddled
    const c2 = chunk(8, 12); // fully after N=4 → dropped
    q.enqueue(c0);
    q.enqueue(c1);
    q.enqueue(c2);
    const result = q.rollbackAt(4);
    expect(result.retained).toContain(c0);
    expect(result.retained).toContain(c1);
    expect(result.straddled).toContain(c1);
    expect(result.dropped).toContain(c2);
    expect(result.straddled).not.toContain(c0);
  });

  it("clears the queue after rollback", () => {
    const q = new PrefixPreservingQueue();
    q.enqueue(chunk(0, 3));
    q.enqueue(chunk(4, 8));
    q.rollbackAt(5);
    expect(q.size).toBe(0);
  });

  it("empty queue returns empty result", () => {
    const q = new PrefixPreservingQueue();
    const result = q.rollbackAt(10);
    expect(result.retained).toHaveLength(0);
    expect(result.dropped).toHaveLength(0);
    expect(result.straddled).toHaveLength(0);
    expect(result.retainedDurationMs).toBe(0);
    expect(result.droppedDurationMs).toBe(0);
  });

  it("divergencePoint=0 retains only chunks ending at 0, drops the rest", () => {
    const q = new PrefixPreservingQueue();
    const c0 = chunk(0, 0, 20); // end=0, retained
    const c1 = chunk(1, 5, 40); // start=1 > 0, dropped
    q.enqueue(c0);
    q.enqueue(c1);
    const result = q.rollbackAt(0);
    expect(result.retained).toContain(c0);
    expect(result.dropped).toContain(c1);
  });

  it("sums durations correctly", () => {
    const q = new PrefixPreservingQueue();
    q.enqueue(chunk(0, 2, 100)); // retained
    q.enqueue(chunk(3, 5, 80));  // retained
    q.enqueue(chunk(6, 9, 60));  // dropped
    const result = q.rollbackAt(5);
    expect(result.retainedDurationMs).toBe(180);
    expect(result.droppedDurationMs).toBe(60);
  });

  it("all chunks retained when divergencePoint is very large", () => {
    const q = new PrefixPreservingQueue();
    q.enqueue(chunk(0, 5));
    q.enqueue(chunk(6, 10));
    q.enqueue(chunk(11, 20));
    const result = q.rollbackAt(999);
    expect(result.retained).toHaveLength(3);
    expect(result.dropped).toHaveLength(0);
  });

  it("all chunks dropped when divergencePoint is -1", () => {
    const q = new PrefixPreservingQueue();
    q.enqueue(chunk(0, 5));
    q.enqueue(chunk(6, 10));
    const result = q.rollbackAt(-1);
    // tokenRange[0]=0 > -1 → both dropped
    expect(result.retained).toHaveLength(0);
    expect(result.dropped).toHaveLength(2);
  });

  it("multiple rollbacks each clear the queue independently", () => {
    const q = new PrefixPreservingQueue();
    q.enqueue(chunk(0, 3));
    q.enqueue(chunk(4, 7));
    const r1 = q.rollbackAt(5);
    expect(r1.retained).toHaveLength(2); // both at or straddle N=5
    expect(q.size).toBe(0);

    // Second rollback with fresh chunks.
    q.enqueue(chunk(0, 2));
    q.enqueue(chunk(10, 15));
    const r2 = q.rollbackAt(8);
    expect(r2.retained).toHaveLength(1);
    expect(r2.dropped).toHaveLength(1);
  });
});

describe("PrefixPreservingQueue — token-range boundary conditions", () => {
  it("chunk ending exactly at N is retained (boundary inclusive)", () => {
    const q = new PrefixPreservingQueue();
    const c = chunk(3, 7);
    q.enqueue(c);
    const result = q.rollbackAt(7);
    expect(result.retained).toContain(c);
    expect(result.dropped).toHaveLength(0);
  });

  it("chunk starting exactly at N+1 is dropped (post-divergence)", () => {
    const q = new PrefixPreservingQueue();
    const c = chunk(8, 12);
    q.enqueue(c);
    const result = q.rollbackAt(7);
    expect(result.dropped).toContain(c);
    expect(result.retained).toHaveLength(0);
  });

  it("single-token chunk at exactly N is retained", () => {
    const q = new PrefixPreservingQueue();
    const c = chunk(5, 5);
    q.enqueue(c);
    expect(q.rollbackAt(5).retained).toContain(c);
  });

  it("single-token chunk one past N is dropped", () => {
    const q = new PrefixPreservingQueue();
    const c = chunk(6, 6);
    q.enqueue(c);
    expect(q.rollbackAt(5).dropped).toContain(c);
  });
});
