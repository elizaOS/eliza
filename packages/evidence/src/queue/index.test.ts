// Public-surface suite for the GPU vision job queue barrel: every re-exported
// runtime symbol is driven through `./index.ts` exactly as a consumer imports
// it — pure state-machine transitions, typed errors, a real tmp-directory
// FileJobQueue round trip, real analysis merges, real worker transitions over
// hand-written analyzers, executor routing, and the CLI boundary over captured
// io. The only seams are injectable clocks/entropy; there are no module mocks.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  Analyzer,
  AnalyzerFragment,
  AnalyzerInput,
  AnalyzerResult,
} from "../analyzers/types.ts";
import {
  claimOrder,
  createWorkerState,
  DEFAULT_LIMITS,
  decideEnqueue,
  drainSkipResult,
  FileJobQueue,
  isConnectivityFailure,
  type JobResult,
  makeJobId,
  mergeAnalyzerResult,
  onServiceOk,
  onServiceUnreachable,
  parseJob,
  processJob,
  QUEUE_DIRS,
  QueueBackpressureError,
  QueueExecutor,
  QueueJobInvalidError,
  runQueueCli,
  runQueueWorker,
  shouldDrain,
} from "./index.ts";

const validJob = {
  id: "20260706T000000000Z-abc123",
  analyzerId: "ocr.unlimited",
  imagePath: "/abs/shot.png",
  artifact: "visual/login/desktop/shot.png",
  kind: "keyframe",
  analysisPath: "/abs/visual/login/desktop/shot.png.analysis.json",
  enqueuedAt: "2026-07-06T00:00:00.000Z",
};

/** Hand-written analyzer whose fragment is fixed by the caller. */
function mkAnalyzer(
  name: string,
  fragment: AnalyzerFragment,
  tier: Analyzer["tier"] = "gpu",
): Analyzer {
  return {
    name,
    tier,
    kinds: ["screenshot", "keyframe"],
    analyze: () => fragment,
  };
}

function queueInput(imagePath: string, artifact: string): AnalyzerInput {
  return {
    entry: {
      path: artifact,
      sha256: "0".repeat(64),
      bytes: 0,
      kind: "screenshot",
      source: "queue",
      producedBy: "index.test.ts",
      createdAt: "2026-07-06T00:00:00.000Z",
    },
    absolutePath: imagePath,
  };
}

describe("parseJob through the public surface", () => {
  it("round-trips a well-formed job including opaque params", () => {
    const raw = JSON.stringify({
      ...validJob,
      kind: "screenshot",
      params: { lang: "en" },
    });
    const job = parseJob(raw);
    expect(job.id).toBe(validJob.id);
    expect(job.kind).toBe("screenshot");
    expect(job.params).toEqual({ lang: "en" });
  });

  it("rejects non-JSON with the typed invalid error, never a default", () => {
    expect(() => parseJob("{not json")).toThrow(QueueJobInvalidError);
    try {
      parseJob("{not json");
      throw new Error("should have thrown");
    } catch (error) {
      const invalid = error as QueueJobInvalidError;
      expect(invalid).toBeInstanceOf(Error);
      expect(invalid.name).toBe("QueueJobInvalidError");
      expect(invalid.code).toBe("QUEUE_JOB_INVALID");
      expect(invalid.issues[0]).toMatchObject({
        path: "",
        message: "not valid JSON",
      });
    }
  });

  it("reports an empty-string required field as a defect", () => {
    try {
      parseJob(JSON.stringify({ ...validJob, analyzerId: "" }));
      throw new Error("should have thrown");
    } catch (error) {
      const issues = (error as QueueJobInvalidError).issues;
      expect(issues).toContainEqual({
        path: "analyzerId",
        message: "analyzerId must be a non-empty string",
      });
    }
  });

  it("rejects array params", () => {
    try {
      parseJob(JSON.stringify({ ...validJob, params: ["x"] }));
      throw new Error("should have thrown");
    } catch (error) {
      const issues = (error as QueueJobInvalidError).issues;
      expect(issues).toContainEqual({
        path: "params",
        message: "params must be an object when present",
      });
    }
  });

  it("lists every missing field at once", () => {
    try {
      parseJob(JSON.stringify({}));
      throw new Error("should have thrown");
    } catch (error) {
      const paths = (error as QueueJobInvalidError).issues.map((i) => i.path);
      for (const key of [
        "id",
        "analyzerId",
        "imagePath",
        "artifact",
        "analysisPath",
        "enqueuedAt",
        "kind",
      ]) {
        expect(paths).toContain(key);
      }
    }
  });
});

describe("makeJobId + claimOrder FIFO", () => {
  it("sorts ids from increasing timestamps into arrival order", () => {
    const first = `${makeJobId(1_000, "a")}.json`;
    const second = `${makeJobId(2_000, "b")}.json`;
    const third = `${makeJobId(3_000, "c")}.json`;
    expect(claimOrder([third, first, second])).toEqual([first, second, third]);
  });

  it("breaks same-millisecond ties deterministically by entropy suffix", () => {
    const b = `${makeJobId(1_000, "b")}.json`;
    const a = `${makeJobId(1_000, "a")}.json`;
    expect(claimOrder([b, a, b])).toEqual([a, b, b]);
  });

  it("ignores non-job entries and sorts the rest", () => {
    expect(claimOrder(["z.json", "README.md", ".keep", "y.json"])).toEqual([
      "y.json",
      "z.json",
    ]);
  });
});

describe("decideEnqueue backpressure decision", () => {
  it("accepts strictly below the cap", () => {
    expect(decideEnqueue(7, 8)).toEqual({ accept: true });
  });

  it("refuses at the cap with both counts in the reason", () => {
    const decision = decideEnqueue(4, 4);
    expect(decision.accept).toBe(false);
    if (!decision.accept) {
      expect(decision.reason).toBe("backpressure: 4 pending >= max 4");
    }
  });

  it("refuses above the cap", () => {
    expect(decideEnqueue(9, 8).accept).toBe(false);
  });
});

describe("worker connectivity latch", () => {
  it("starts healthy", () => {
    const state = createWorkerState();
    expect(state.unreachableSince).toBeNull();
    expect(shouldDrain(state)).toBe(false);
  });

  it("stamps the first failure time but does not drain yet", () => {
    const state = onServiceUnreachable(createWorkerState(), 1_000, 10_000);
    expect(state.unreachableSince).toBe(1_000);
    expect(shouldDrain(state)).toBe(false);
  });

  it("drains exactly when the outage reaches the window, and stays latched", () => {
    let state = onServiceUnreachable(createWorkerState(), 1_000, 10_000);
    state = onServiceUnreachable(state, 11_000, 10_000);
    expect(shouldDrain(state)).toBe(true);
    state = onServiceUnreachable(state, 60_000, 10_000);
    expect(shouldDrain(state)).toBe(true);
    expect(state.unreachableSince).toBe(1_000);
  });

  it("resets fully on a successful contact", () => {
    let state = onServiceUnreachable(createWorkerState(), 1_000, 10_000);
    state = onServiceUnreachable(state, 20_000, 10_000);
    state = onServiceOk();
    expect(state.unreachableSince).toBeNull();
    expect(shouldDrain(state)).toBe(false);
  });
});

describe("connectivity classification", () => {
  it("treats only skipped-missing-tool as a connectivity failure", () => {
    expect(
      isConnectivityFailure({
        status: "skipped-missing-tool",
        reason: "host down",
        durationMs: 0,
      }),
    ).toBe(true);
    expect(
      isConnectivityFailure({ status: "ran", durationMs: 5, data: {} }),
    ).toBe(false);
    expect(
      isConnectivityFailure({ status: "failed", reason: "x", durationMs: 5 }),
    ).toBe(false);
    expect(
      isConnectivityFailure({
        status: "skipped-tier",
        reason: "x",
        durationMs: 5,
      }),
    ).toBe(false);
  });

  it("builds an honest drain marker with no fabricated data", () => {
    const result = drainSkipResult("vision service unreachable");
    expect(result.status).toBe("skipped-missing-tool");
    expect(result.reason).toBe("vision service unreachable");
    expect(result.durationMs).toBe(0);
    expect("data" in result).toBe(false);
  });
});

describe("typed queue errors", () => {
  it("carries name, code, counts, and context on backpressure", () => {
    const error = new QueueBackpressureError(3, 2);
    expect(error.name).toBe("QueueBackpressureError");
    expect(error.code).toBe("QUEUE_BACKPRESSURE");
    expect(error.message).toContain("3 pending >= max 2");
    expect(error.context).toEqual({ pendingCount: 3, maxPending: 2 });
  });
});

describe("FileJobQueue end-to-end", () => {
  let base: string;

  beforeAll(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-index-fq-"));
  });
  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("creates every queue directory under the root", () => {
    const root = path.join(base, "dirs");
    new FileJobQueue(root);
    for (const dir of QUEUE_DIRS) {
      expect(fs.statSync(path.join(root, dir)).isDirectory()).toBe(true);
    }
  });

  it("claims oldest-first, finalizes into done/, and records results", () => {
    const root = path.join(base, "roundtrip");
    let ms = 0;
    const names = ["a", "b"];
    let next = 0;
    const queue = new FileJobQueue(root, {
      now: () => (ms += 1_000),
      entropy: () => names[next++] ?? "z",
    });
    const first = queue.enqueue("/abs/one.png", "ocr.unlimited", {
      artifact: "visual/one.png",
      kind: "screenshot",
      analysisPath: "/abs/visual/one.png.analysis.json",
    });
    const second = queue.enqueue("/abs/two.png", "ocr.unlimited", {
      artifact: "visual/two.png",
      kind: "screenshot",
      analysisPath: "/abs/visual/two.png.analysis.json",
    });
    expect(queue.pendingCount()).toBe(2);

    const claimed = queue.claim();
    if (!claimed) throw new Error("precondition failed: nothing claimed");
    expect(claimed.job.id).toBe(first.id);
    expect(
      fs.existsSync(path.join(root, "processing", `${first.id}.json`)),
    ).toBe(true);

    const result: JobResult = {
      schema: 1,
      id: first.id,
      analyzerId: "ocr.unlimited",
      status: "completed",
      completedAt: "2026-07-06T00:00:01.000Z",
      analyzer: { status: "ran", durationMs: 12, data: { text: "hi" } },
    };
    queue.complete(claimed, result);
    expect(queue.readResult(first.id)).toEqual(result);
    expect(fs.existsSync(path.join(root, "done", `${first.id}.json`))).toBe(
      true,
    );
    expect(
      fs.existsSync(path.join(root, "processing", `${first.id}.json`)),
    ).toBe(false);

    expect(queue.claim()?.job.id).toBe(second.id);
    expect(queue.claim()).toBeNull();
  });

  it("refuses to enqueue past the backpressure cap with a typed error", () => {
    const queue = new FileJobQueue(path.join(base, "cap"), { maxPending: 1 });
    queue.enqueue("/abs/x.png", "ocr.unlimited", {
      artifact: "visual/x.png",
      kind: "screenshot",
      analysisPath: "/abs/x.analysis.json",
    });
    expect(() =>
      queue.enqueue("/abs/y.png", "ocr.unlimited", {
        artifact: "visual/y.png",
        kind: "screenshot",
        analysisPath: "/abs/y.analysis.json",
      }),
    ).toThrow(QueueBackpressureError);
  });

  it("returns null from readResult before completion", () => {
    const queue = new FileJobQueue(path.join(base, "noresult"));
    expect(queue.readResult("never-enqueued")).toBeNull();
  });
});

describe("mergeAnalyzerResult", () => {
  let base: string;

  beforeAll(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-index-merge-"));
  });
  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("creates a fresh schema-1 document when the target is absent", () => {
    const analysisPath = path.join(
      base,
      "fresh",
      "nested",
      "shot.png.analysis.json",
    );
    const result: AnalyzerResult = {
      status: "ran",
      durationMs: 4,
      data: { text: "hello" },
    };
    const document = mergeAnalyzerResult({
      analysisPath,
      artifact: "visual/shot.png",
      analyzerId: "ocr.unlimited",
      result,
    });
    expect(document.schema).toBe(1);
    expect(document.artifact).toBe("visual/shot.png");
    expect(document.results["ocr.unlimited"]).toEqual(result);
    expect(JSON.parse(fs.readFileSync(analysisPath, "utf8"))).toEqual(document);
  });

  it("preserves earlier analyzers when a second merges in", () => {
    const analysisPath = path.join(base, "two", "doc.analysis.json");
    mergeAnalyzerResult({
      analysisPath,
      artifact: "visual/a.png",
      analyzerId: "first.pass",
      result: { status: "ran", durationMs: 1, data: { n: 1 } },
    });
    const document = mergeAnalyzerResult({
      analysisPath,
      artifact: "visual/a.png",
      analyzerId: "second.pass",
      result: { status: "ran", durationMs: 2, data: { n: 2 } },
    });
    expect(Object.keys(document.results).sort()).toEqual([
      "first.pass",
      "second.pass",
    ]);
    expect(document.results["first.pass"]).toMatchObject({ data: { n: 1 } });
  });
});

describe("processJob transitions", () => {
  let base: string;

  beforeAll(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-index-pj-"));
  });
  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  /** Enqueue one job and claim it, with deterministic ids and a fixed clock. */
  function claimedIn(
    name: string,
    analyzerId: string,
  ): {
    queue: FileJobQueue;
    claimed: NonNullable<ReturnType<FileJobQueue["claim"]>>;
  } {
    const root = path.join(base, name);
    const queue = new FileJobQueue(root, {
      now: () => 1_000,
      entropy: () => "job1",
    });
    queue.enqueue(`/abs/${name}.png`, analyzerId, {
      artifact: `visual/${name}.png`,
      kind: "screenshot",
      analysisPath: path.join(root, "subject.analysis.json"),
    });
    const claimed = queue.claim();
    if (!claimed) throw new Error("precondition failed: nothing claimed");
    return { queue, claimed };
  }

  it("fails a job naming an unknown analyzer id", async () => {
    const { queue, claimed } = claimedIn("unknown", "nope.missing");
    const analyzer = mkAnalyzer("ocr.unlimited", {
      status: "ran",
      data: {},
    });
    const outcome = await processJob(
      claimed,
      {
        queue,
        analyzers: [analyzer],
        tier: "gpu",
        limits: { ...DEFAULT_LIMITS },
        now: () => 5_000,
      },
      createWorkerState(),
    );
    expect(outcome.action).toBe("failed");
    expect(outcome.state.unreachableSince).toBeNull();
    expect(outcome.result.status).toBe("failed");
    expect(outcome.result.reason).toMatch(
      /unknown analyzer id 'nope\.missing'/,
    );
    const document = JSON.parse(
      fs.readFileSync(claimed.job.analysisPath, "utf8"),
    );
    expect(document.results["nope.missing"].status).toBe("failed");
    expect(queue.readResult(claimed.job.id)?.status).toBe("failed");
  });

  it("completes a real contact, merges its data, and clears any drain latch", async () => {
    const { queue, claimed } = claimedIn("completed", "ocr.unlimited");
    const analyzer = mkAnalyzer("ocr.unlimited", {
      status: "ran",
      data: { text: "hello" },
    });
    const state = onServiceUnreachable(createWorkerState(), 100, 10_000);
    const outcome = await processJob(
      claimed,
      {
        queue,
        analyzers: [analyzer],
        tier: "gpu",
        limits: { ...DEFAULT_LIMITS },
        now: () => 5_000,
      },
      state,
    );
    expect(outcome.action).toBe("completed");
    expect(outcome.state.unreachableSince).toBeNull();
    expect(shouldDrain(outcome.state)).toBe(false);
    const document = JSON.parse(
      fs.readFileSync(claimed.job.analysisPath, "utf8"),
    );
    expect(document.results["ocr.unlimited"].data).toEqual({ text: "hello" });
    const recorded = queue.readResult(claimed.job.id);
    expect(recorded?.status).toBe("completed");
    expect(recorded?.analyzer?.status).toBe("ran");
  });

  it("requeues a transient connectivity failure instead of consuming the job", async () => {
    const { queue, claimed } = claimedIn("requeue", "ocr.unlimited");
    const analyzer = mkAnalyzer("ocr.unlimited", {
      status: "skipped-missing-tool",
      reason: "host down",
    });
    const outcome = await processJob(
      claimed,
      {
        queue,
        analyzers: [analyzer],
        tier: "gpu",
        limits: { ...DEFAULT_LIMITS },
        now: () => 5_000,
      },
      createWorkerState(),
    );
    expect(outcome.action).toBe("requeued");
    expect(outcome.state).toMatchObject({
      unreachableSince: 5_000,
      draining: false,
    });
    expect(queue.pendingCount()).toBe(1);
    expect(queue.readResult(claimed.job.id)).toBeNull();
    expect(fs.existsSync(claimed.job.analysisPath)).toBe(false);
  });

  it("skips honestly once the outage outlasts the drain window", async () => {
    const { queue, claimed } = claimedIn("drained", "ocr.unlimited");
    const analyzer = mkAnalyzer("ocr.unlimited", {
      status: "skipped-missing-tool",
      reason: "still down",
    });
    const state = onServiceUnreachable(createWorkerState(), 1_000, 10_000);
    const outcome = await processJob(
      claimed,
      {
        queue,
        analyzers: [analyzer],
        tier: "gpu",
        limits: { ...DEFAULT_LIMITS, drainAfterMs: 10_000 },
        now: () => 20_000,
      },
      state,
    );
    expect(outcome.action).toBe("skipped");
    expect(outcome.state.draining).toBe(true);
    expect(outcome.state.unreachableSince).toBe(1_000);
    expect(outcome.result.status).toBe("skipped");
    expect(outcome.result.reason).toBe("still down");
    expect(outcome.result.analyzer).toBeUndefined();
    const document = JSON.parse(
      fs.readFileSync(claimed.job.analysisPath, "utf8"),
    );
    expect(document.results["ocr.unlimited"]).toMatchObject({
      status: "skipped-missing-tool",
      reason: "still down",
    });
    expect(queue.readResult(claimed.job.id)?.status).toBe("skipped");
  });
});

describe("runQueueWorker drains to idle", () => {
  it("processes every pending job and stops when the queue empties", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-index-loop-"));
    try {
      const queue = new FileJobQueue(path.join(base, "q"), {
        now: () => 1_000,
        entropy: () => "only",
      });
      const job = queue.enqueue("/abs/shot.png", "ocr.unlimited", {
        artifact: "visual/shot.png",
        kind: "screenshot",
        analysisPath: path.join(base, "shot.png.analysis.json"),
      });
      const events: unknown[] = [];
      const counts = await runQueueWorker({
        queue,
        analyzers: [
          mkAnalyzer("ocr.unlimited", { status: "ran", data: { ok: true } }),
        ],
        tier: "gpu",
        stopWhenIdle: true,
        limits: { ...DEFAULT_LIMITS, pollMs: 1 },
        onEvent: (event) => events.push(event),
      });
      expect(counts).toEqual({
        completed: 1,
        failed: 0,
        skipped: 0,
        requeued: 0,
      });
      expect(events[0]).toMatchObject({
        type: "claimed",
        id: job.id,
        analyzerId: "ocr.unlimited",
      });
      expect(events).toContainEqual({
        type: "processed",
        id: job.id,
        action: "completed",
        reason: undefined,
      });
      expect(events.at(-1)).toEqual({ type: "idle" });
      expect(queue.pendingCount()).toBe(0);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("QueueExecutor routing", () => {
  let base: string;

  beforeAll(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-index-exec-"));
  });
  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("runs cpu-tier analyzers inline unchanged", async () => {
    const executor = new QueueExecutor(
      new FileJobQueue(path.join(base, "cpu")),
      {
        scratchDir: path.join(base, "scratch-cpu"),
      },
    );
    const cpu = mkAnalyzer(
      "diff.region",
      { status: "ran", data: { regions: 2 } },
      "cpu",
    );
    const result = await executor.execute(
      cpu,
      queueInput("/abs/a.png", "visual/a.png"),
      {
        tier: "gpu",
      },
    );
    expect(result.status).toBe("ran");
    expect(result.data).toEqual({ regions: 2 });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("skips honestly when no worker produces a result in time", async () => {
    const queue = new FileJobQueue(path.join(base, "gpu"), {
      now: () => 1_000,
      entropy: () => "g1",
    });
    let calls = 0;
    const executor = new QueueExecutor(queue, {
      scratchDir: path.join(base, "scratch-gpu"),
      resultTimeoutMs: 50,
      pollMs: 1,
      sleep: () => Promise.resolve(),
      now: () => (calls++ < 2 ? 1_000 : 1_051),
    });
    const gpu = mkAnalyzer("vlm.describe", { status: "ran", data: {} });
    const result = await executor.execute(
      gpu,
      queueInput("/abs/b.png", "visual/b.png"),
      {
        tier: "gpu",
      },
    );
    expect(result.status).toBe("skipped-missing-tool");
    expect(result.durationMs).toBe(50);
    expect(result.reason).toMatch(/no gpu queue worker produced a result/);
    expect(queue.pendingCount()).toBe(1);
  });
});

describe("runQueueCli", () => {
  function captureIo() {
    const out: string[] = [];
    const err: string[] = [];
    return {
      io: {
        out: (line: string) => out.push(line),
        err: (line: string) => err.push(line),
      },
      out,
      err,
    };
  }

  it("prints usage on stderr and exits 0 with no command", async () => {
    const { io, err } = captureIo();
    const code = await runQueueCli([], io);
    expect(code).toBe(0);
    expect(err[0]).toMatch(/^Usage:/);
  });

  it("translates a usage error into a structured stderr line and exit 1", async () => {
    const { io, err } = captureIo();
    const code = await runQueueCli(["enqueue"], io);
    expect(code).toBe(1);
    expect(err[0]).toBe("error [CLI_USAGE]: missing required --root");
    expect(err.join("\n")).toContain("Usage:");
  });

  it("enqueue writes one pending job and reports its id", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-index-cli-"));
    try {
      const root = path.join(base, "q");
      const { io, out } = captureIo();
      const code = await runQueueCli(
        [
          "enqueue",
          "--root",
          root,
          "--image",
          "/abs/shot.png",
          "--analyzer",
          "ocr.unlimited",
          "--artifact",
          "visual/shot.png",
          "--analysis",
          "/abs/shot.analysis.json",
        ],
        io,
      );
      expect(code).toBe(0);
      expect(out.join("\n")).toMatch(
        /\[gpu-queue\] enqueued \S+ \(ocr\.unlimited\)/,
      );
      const pending = fs.readdirSync(path.join(root, "pending"));
      expect(pending).toHaveLength(1);
      expect(pending[0]?.endsWith(".json")).toBe(true);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
