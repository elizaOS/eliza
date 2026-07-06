// Drift guard for the two filesystem GPU job queues that intentionally coexist
// (see state.ts's header for the layering rationale): this package's TS analyzer
// queue and the compose-level plain-node OpenAI-request queue at
// docker/certification/queue-lib.mjs (#14549). Their job SHAPES differ by design
// (analyzerId+analysisPath vs model+request), but the pure filesystem-queue
// kernel they share — the four dir names, the backpressure cap + drain window,
// FIFO claim order, id generation, and the unreachable→drain→reset state machine
// — MUST stay byte-identical, or the two queues silently diverge (the review's
// permanent-drain-latch bug was exactly such a divergence). This test imports
// BOTH real modules and asserts the shared kernel agrees; a physically shared
// runtime module is deliberately avoided (a workspace-TS import is fragile in
// the ro-mounted plain-node container, and a docker-owned import is wrong for a
// published package), so this contract test is the mechanical anti-drift check.

import { describe, expect, it } from "vitest";
// The container queue lives outside this package; a test-only relative import is
// safe (tests run in the full checkout) where a runtime import would not be.
import * as docker from "../../../../docker/certification/queue-lib.mjs";
import {
  claimOrder,
  createWorkerState,
  DEFAULT_LIMITS,
  decideEnqueue,
  makeJobId,
  onServiceOk,
  onServiceUnreachable,
  QUEUE_DIRS,
  shouldDrain,
} from "./state.ts";

describe("queue kernel parity with docker/certification/queue-lib.mjs", () => {
  it("agrees on the four queue directory names and their order", () => {
    expect([...QUEUE_DIRS]).toEqual([...docker.QUEUE_DIRS]);
  });

  it("agrees on the shared backpressure + drain limits", () => {
    // Only the shared kernel keys are contracted; the per-job wall-clock ceiling
    // is intentionally per-queue (jobTimeoutMs=180s analyzer vs
    // requestTimeoutMs=300s http proxy) and is NOT part of the shared contract.
    expect(DEFAULT_LIMITS.maxPending).toBe(docker.DEFAULT_LIMITS.maxPending);
    expect(DEFAULT_LIMITS.drainAfterMs).toBe(
      docker.DEFAULT_LIMITS.drainAfterMs,
    );
    expect(DEFAULT_LIMITS.pollMs).toBe(docker.DEFAULT_LIMITS.pollMs);
  });

  it("agrees on FIFO claim order over timestamp-prefixed ids", () => {
    const names = [
      `${makeJobId(3_000, "c")}.json`,
      `${makeJobId(1_000, "a")}.json`,
      `${makeJobId(2_000, "b")}.json`,
      "README",
    ];
    expect(claimOrder(names)).toEqual(docker.claimOrder(names));
  });

  it("agrees on enqueue backpressure decisions", () => {
    for (const [pending, max] of [
      [0, 256],
      [255, 256],
      [256, 256],
      [300, 256],
    ] as const) {
      expect(decideEnqueue(pending, max)).toEqual(
        docker.decideEnqueue(pending, max),
      );
    }
  });

  it("agrees on id generation for the same clock + entropy", () => {
    expect(makeJobId(1_700_000_000_000, "abc123")).toBe(
      docker.makeJobId(1_700_000_000_000, "abc123"),
    );
  });

  it("agrees on the connectivity state machine, transition for transition", () => {
    expect(createWorkerState()).toEqual(docker.createWorkerState());

    // Drive both machines through the same outage timeline and compare every
    // intermediate state, plus the drain predicate (named differently per side).
    const timeline = [1_000, 5_000, 121_000, 200_000];
    let ours = createWorkerState();
    let theirs = docker.createWorkerState();
    for (const nowMs of timeline) {
      ours = onServiceUnreachable(ours, nowMs, DEFAULT_LIMITS.drainAfterMs);
      theirs = docker.onServiceUnreachable(
        theirs,
        nowMs,
        docker.DEFAULT_LIMITS.drainAfterMs,
      );
      expect(ours).toEqual(theirs);
      expect(shouldDrain(ours)).toBe(docker.shouldSkipJob(theirs));
    }

    // A successful contact fully resets both back to the healthy state.
    expect(onServiceOk()).toEqual(docker.onServiceOk());
    expect(shouldDrain(onServiceOk())).toBe(
      docker.shouldSkipJob(docker.onServiceOk()),
    );
  });
});
