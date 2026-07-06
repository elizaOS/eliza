// Pure state-machine transitions for the GPU job queue: job parsing (valid,
// unsafe-id, missing fields, bad kind — every defect listed, never a repaired
// default), FIFO claim order over enqueue-timestamped ids, enqueue backpressure,
// and the worker connectivity latch (healthy → unreachable → drain past the
// window → reset on contact). No filesystem, no clock, no GPU — every function
// under test is total.

import { describe, expect, it } from "vitest";
import type { AnalyzerResult } from "../analyzers/types.ts";
import {
  claimOrder,
  createWorkerState,
  decideEnqueue,
  drainSkipResult,
  isConnectivityFailure,
  makeJobId,
  onServiceOk,
  onServiceUnreachable,
  parseJob,
  QueueJobInvalidError,
  shouldDrain,
} from "./state.ts";

const validJob = {
  id: "20260706T000000000Z-abc123",
  analyzerId: "ocr.unlimited",
  imagePath: "/abs/shot.png",
  artifact: "visual/login/desktop/shot.png",
  kind: "screenshot",
  analysisPath: "/abs/visual/login/desktop/shot.png.analysis.json",
  enqueuedAt: "2026-07-06T00:00:00.000Z",
};

describe("parseJob", () => {
  it("accepts a well-formed job", () => {
    const job = parseJob(JSON.stringify(validJob));
    expect(job.analyzerId).toBe("ocr.unlimited");
    expect(job.kind).toBe("screenshot");
  });

  it("rejects non-JSON with a typed invalid error, not a default", () => {
    expect(() => parseJob("{not json")).toThrow(QueueJobInvalidError);
    try {
      parseJob("{not json");
    } catch (error) {
      expect((error as QueueJobInvalidError).issues[0].message).toMatch(
        /not valid JSON/,
      );
    }
  });

  it("rejects an unsafe id (path-traversal characters)", () => {
    try {
      parseJob(JSON.stringify({ ...validJob, id: "../../etc/passwd" }));
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(QueueJobInvalidError);
      expect((error as QueueJobInvalidError).issues[0].message).toMatch(
        /unsafe characters/,
      );
    }
  });

  it("lists every missing field at once", () => {
    try {
      parseJob(JSON.stringify({ id: "ok" }));
      throw new Error("should have thrown");
    } catch (error) {
      const issues = (error as QueueJobInvalidError).issues.map((i) => i.path);
      expect(issues).toContain("analyzerId");
      expect(issues).toContain("imagePath");
      expect(issues).toContain("analysisPath");
      expect(issues).toContain("kind");
    }
  });

  it("rejects an artifact kind that carries no pixels", () => {
    try {
      parseJob(JSON.stringify({ ...validJob, kind: "aria-tree" }));
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as QueueJobInvalidError).issues[0].message).toMatch(
        /kind must be one of/,
      );
    }
  });
});

describe("claimOrder", () => {
  it("returns oldest-first by lexicographic id (== arrival order)", () => {
    const a = `${makeJobId(1_000, "a")}.json`;
    const b = `${makeJobId(2_000, "b")}.json`;
    const c = `${makeJobId(3_000, "c")}.json`;
    expect(claimOrder([c, a, b])).toEqual([a, b, c]);
  });

  it("ignores non-json entries", () => {
    expect(claimOrder(["x.json", "README", ".keep"])).toEqual(["x.json"]);
  });
});

describe("decideEnqueue (backpressure)", () => {
  it("accepts below the cap", () => {
    expect(decideEnqueue(5, 256).accept).toBe(true);
  });

  it("refuses with a reason at or above the cap", () => {
    const decision = decideEnqueue(256, 256);
    expect(decision.accept).toBe(false);
    if (!decision.accept) expect(decision.reason).toMatch(/backpressure/);
  });
});

describe("worker connectivity latch", () => {
  it("stamps unreachableSince on the first failure but does not drain yet", () => {
    const s0 = createWorkerState();
    const s1 = onServiceUnreachable(s0, 1_000, 10_000);
    expect(s1.unreachableSince).toBe(1_000);
    expect(shouldDrain(s1)).toBe(false);
  });

  it("latches into drain once the outage outlasts the window", () => {
    let s = createWorkerState();
    s = onServiceUnreachable(s, 1_000, 10_000);
    s = onServiceUnreachable(s, 5_000, 10_000);
    expect(shouldDrain(s)).toBe(false);
    s = onServiceUnreachable(s, 11_000, 10_000); // 10_000ms since first failure
    expect(shouldDrain(s)).toBe(true);
    expect(s.unreachableSince).toBe(1_000);
  });

  it("resets fully on a successful contact", () => {
    let s = createWorkerState();
    s = onServiceUnreachable(s, 1_000, 10_000);
    s = onServiceUnreachable(s, 20_000, 10_000);
    expect(shouldDrain(s)).toBe(true);
    s = onServiceOk();
    expect(s.unreachableSince).toBeNull();
    expect(shouldDrain(s)).toBe(false);
  });
});

describe("connectivity classification", () => {
  it("treats a gpu skipped-missing-tool as a connectivity failure", () => {
    const result: AnalyzerResult = {
      status: "skipped-missing-tool",
      reason: "gpu vision unreachable",
      durationMs: 0,
    };
    expect(isConnectivityFailure(result)).toBe(true);
  });

  it("treats ran/failed as real contacts (not connectivity failures)", () => {
    expect(
      isConnectivityFailure({ status: "ran", durationMs: 5, data: {} }),
    ).toBe(false);
    expect(
      isConnectivityFailure({ status: "failed", reason: "x", durationMs: 5 }),
    ).toBe(false);
  });

  it("drainSkipResult never carries data", () => {
    const result = drainSkipResult("service down");
    expect(result.status).toBe("skipped-missing-tool");
    expect("data" in result).toBe(false);
    expect(result.reason).toBe("service down");
  });
});
