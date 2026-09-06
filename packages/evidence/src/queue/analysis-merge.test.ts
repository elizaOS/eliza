// The per-subject merge into analysis.json, driven on a REAL filesystem. The
// load path is unit-tested (create-when-absent, refuse-corrupt, and reject a
// document whose bytes describe a different artifact, all retaining their
// original bytes), and the concurrency guarantee is proven the only way it can
// be — with genuinely separate OS processes: N `bun` children merge N distinct
// analyzers into one analysis.json at once, and every result must survive.
// Without the O_EXCL lock this is a lost-update race (temp+rename is atomic per
// write but not per read-modify-write across processes), so the child-race test
// is the regression guard for that bug.
//
// The stale-lock break-in test (#30110) hardens that guard for the reclamation
// path specifically: it seeds an already-stale lock so every worker must break
// it at once, the exact condition under which the old stat-then-unlink TOCTOU
// let two workers hold the lock and drop an analyzer result. A focused, seam-
// injected unit test proves the committer detects the break-in and retries
// rather than clobbering a concurrently merged result.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { EvidenceError } from "../errors.ts";
import { mergeAnalyzerResult } from "./analysis-merge.ts";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-merge-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

let n = 0;
function newDir(): string {
  const dir = path.join(scratch, `s${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const MERGE_SOURCE = fileURLToPath(
  new URL("./analysis-merge.ts", import.meta.url),
);

// A standalone worker that performs one merge, spawned as a separate OS process
// so the cross-process lock is genuinely exercised (a single JS process cannot
// interleave synchronous merges).
const WORKER_PATH = path.join(scratch, "merge-worker.mjs");
fs.writeFileSync(
  WORKER_PATH,
  `import { mergeAnalyzerResult } from ${JSON.stringify(MERGE_SOURCE)};
const [analysisPath, analyzerId] = process.argv.slice(2);
mergeAnalyzerResult({
  analysisPath,
  artifact: "visual/x/shot.png",
  analyzerId,
  result: { status: "ran", durationMs: 1, data: { text: analyzerId } },
});
`,
);

describe("mergeAnalyzerResult (single process)", () => {
  it("creates a fresh schema-1 document when the target is absent", () => {
    const analysisPath = path.join(newDir(), "shot.png.analysis.json");
    const doc = mergeAnalyzerResult({
      analysisPath,
      artifact: "visual/x/shot.png",
      analyzerId: "ocr.unlimited",
      result: { status: "ran", durationMs: 3, data: { text: "hi" } },
    });
    expect(doc.schema).toBe(1);
    expect(doc.artifact).toBe("visual/x/shot.png");
    expect(doc.results["ocr.unlimited"].status).toBe("ran");
    // Persisted to disk, not just returned.
    const onDisk = JSON.parse(fs.readFileSync(analysisPath, "utf8"));
    expect(onDisk.results["ocr.unlimited"].status).toBe("ran");
    // The lockfile is released, never left behind.
    expect(fs.existsSync(`${analysisPath}.lock`)).toBe(false);
  });

  it("adds a second analyzer without dropping the first", () => {
    const analysisPath = path.join(newDir(), "shot.png.analysis.json");
    mergeAnalyzerResult({
      analysisPath,
      artifact: "visual/x/shot.png",
      analyzerId: "brand.rules",
      result: { status: "ran", durationMs: 1, data: {} },
    });
    mergeAnalyzerResult({
      analysisPath,
      artifact: "visual/x/shot.png",
      analyzerId: "ocr.unlimited",
      result: { status: "ran", durationMs: 2, data: { text: "hi" } },
    });
    const doc = JSON.parse(fs.readFileSync(analysisPath, "utf8"));
    expect(Object.keys(doc.results).sort()).toEqual([
      "brand.rules",
      "ocr.unlimited",
    ]);
  });

  it("refuses to merge onto a corrupt existing document", () => {
    const analysisPath = path.join(newDir(), "shot.png.analysis.json");
    fs.writeFileSync(analysisPath, "{ not json");
    expect(() =>
      mergeAnalyzerResult({
        analysisPath,
        artifact: "visual/x/shot.png",
        analyzerId: "ocr.unlimited",
        result: { status: "ran", durationMs: 1, data: {} },
      }),
    ).toThrow(/not valid JSON/);
  });

  it.each([
    { schema: 1, artifact: "visual/x/shot.png", results: [] },
    { schema: 1, artifact: "visual/x/shot.png", results: null },
    { schema: 1, results: {} },
    { schema: 1, artifact: 42, results: {} },
  ])("preserves an invalid existing document: %j", (document) => {
    const dir = newDir();
    const analysisPath = path.join(dir, "shot.png.analysis.json");
    const original = `${JSON.stringify(document, null, 2)}\n`;
    fs.writeFileSync(analysisPath, original);

    expect(() =>
      mergeAnalyzerResult({
        analysisPath,
        artifact: "visual/x/shot.png",
        analyzerId: "ocr.unlimited",
        result: { status: "ran", durationMs: 1, data: { text: "new text" } },
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "EvidenceError",
        code: "ANALYSIS_MERGE_CORRUPT",
      }),
    );
    expect(fs.readFileSync(analysisPath, "utf8")).toBe(original);
    expect(fs.readdirSync(dir)).toEqual([path.basename(analysisPath)]);
  });

  it("refuses to attribute a result to another subject without replacing its bytes", () => {
    const dir = newDir();
    const analysisPath = path.join(dir, "shot.png.analysis.json");
    const original = `${JSON.stringify(
      {
        schema: 1,
        artifact: "visual/other/shot.png",
        results: {
          "ocr.unlimited": {
            status: "ran",
            durationMs: 1,
            data: { text: "old text" },
          },
        },
      },
      null,
      2,
    )}\n`;
    fs.writeFileSync(analysisPath, original);

    expect(() =>
      mergeAnalyzerResult({
        analysisPath,
        artifact: "visual/x/shot.png",
        analyzerId: "ocr.unlimited",
        result: { status: "ran", durationMs: 1, data: { text: "new text" } },
      }),
    ).toThrowError(
      expect.objectContaining({
        name: EvidenceError.name,
        code: "ANALYSIS_MERGE_ARTIFACT_MISMATCH",
        context: {
          analysisPath,
          artifact: "visual/x/shot.png",
          existingArtifact: "visual/other/shot.png",
        },
      }),
    );
    expect(fs.readFileSync(analysisPath, "utf8")).toBe(original);
    expect(fs.readdirSync(dir)).toEqual([path.basename(analysisPath)]);
  });

  it.each(["__proto__", "constructor", "toString"])(
    "persists and replaces analyzer results named %s alongside ordinary results",
    (analyzerId) => {
      const analysisPath = path.join(newDir(), "shot.png.analysis.json");
      for (const [id, text] of [
        [analyzerId, "first"],
        ["ocr.unlimited", "ordinary"],
        [analyzerId, "replacement"],
      ]) {
        mergeAnalyzerResult({
          analysisPath,
          artifact: "visual/x/shot.png",
          analyzerId: id,
          result: { status: "ran", durationMs: 1, data: { text } },
        });
      }

      const onDisk = JSON.parse(fs.readFileSync(analysisPath, "utf8"));
      expect(Object.hasOwn(onDisk.results, analyzerId)).toBe(true);
      expect(onDisk.results[analyzerId].data.text).toBe("replacement");
      expect(onDisk.results["ocr.unlimited"].data.text).toBe("ordinary");
    },
  );
});

/** Run one merge in a separate OS process via bun so the race is real. */
function spawnMerge(analysisPath: string, analyzerId: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [WORKER_PATH, analysisPath, analyzerId], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (c) => {
      err += String(c);
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(0)
        : reject(
            new Error(`merge child (${analyzerId}) exited ${code}: ${err}`),
          ),
    );
  });
}

describe("mergeAnalyzerResult (concurrent cross-process writers)", () => {
  it("preserves every analyzer when N processes merge one subject at once", async () => {
    const analysisPath = path.join(newDir(), "shot.png.analysis.json");
    // Ten simultaneous processes, each a distinct gpu/cpu analyzer landing on
    // the same subject — the two-workers-one-screenshot case the queue permits.
    const analyzers = Array.from({ length: 10 }, (_, i) => `analyzer.${i}`);

    const codes = await Promise.all(
      analyzers.map((id) => spawnMerge(analysisPath, id)),
    );
    expect(codes.every((c) => c === 0)).toBe(true);

    const doc = JSON.parse(fs.readFileSync(analysisPath, "utf8"));
    // Every writer survives — no lost update. (Unlocked, several would vanish.)
    expect(Object.keys(doc.results).sort()).toEqual([...analyzers].sort());
    for (const id of analyzers) {
      expect(doc.results[id].status).toBe("ran");
      expect(doc.results[id].data.text).toBe(id);
    }
    expect(fs.existsSync(`${analysisPath}.lock`)).toBe(false);
  });
});

// A worker that blocks on a barrier file before merging, so all N children
// enter the stale-lock break-in path together instead of trickling in.
const BARRIER_WORKER_PATH = path.join(scratch, "barrier-merge-worker.mjs");
fs.writeFileSync(
  BARRIER_WORKER_PATH,
  `import fs from "node:fs";
import { mergeAnalyzerResult } from ${JSON.stringify(MERGE_SOURCE)};
const [analysisPath, analyzerId, barrier] = process.argv.slice(2);
for (;;) {
  if (fs.existsSync(barrier)) break;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
}
mergeAnalyzerResult({
  analysisPath,
  artifact: "visual/x/shot.png",
  analyzerId,
  result: { status: "ran", durationMs: 1, data: { text: analyzerId } },
});
`,
);

function spawnBarrierMerge(
  analysisPath: string,
  analyzerId: string,
  barrier: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "bun",
      [BARRIER_WORKER_PATH, analysisPath, analyzerId, barrier],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let err = "";
    child.stderr.on("data", (c) => {
      err += String(c);
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(0)
        : reject(
            new Error(`barrier child (${analyzerId}) exited ${code}: ${err}`),
          ),
    );
  });
}

describe("mergeAnalyzerResult (stale-lock break-in, #30110)", () => {
  it("loses no analyzer result when N workers all break one stale lock at once", async () => {
    // Each round seeds an empty doc plus an already-stale lock (mtime 60s in the
    // past) so every worker judges the holder dead and races into the break-in
    // path simultaneously — the exact TOCTOU that dropped results before the
    // fix. Looped so a regression surfaces as a failing round, not a rare flake.
    const N = 16;
    const ROUNDS = 8;
    for (let round = 0; round < ROUNDS; round++) {
      const dir = newDir();
      const analysisPath = path.join(dir, "shot.png.analysis.json");
      const barrier = path.join(dir, "barrier");
      fs.writeFileSync(
        analysisPath,
        `${JSON.stringify(
          { schema: 1, artifact: "visual/x/shot.png", results: {} },
          null,
          2,
        )}\n`,
      );
      const lockPath = `${analysisPath}.lock`;
      fs.writeFileSync(lockPath, "99999 1970-01-01T00:00:00.000Z\n");
      const past = new Date(Date.now() - 60_000);
      fs.utimesSync(lockPath, past, past);

      const analyzers = Array.from({ length: N }, (_, i) => `az-${i}`);
      const pending = analyzers.map((id) =>
        spawnBarrierMerge(analysisPath, id, barrier),
      );
      // Give every child a moment to reach the barrier spin, then release them.
      await new Promise((r) => setTimeout(r, 120));
      fs.writeFileSync(barrier, "go");
      const codes = await Promise.all(pending);
      expect(codes.every((c) => c === 0)).toBe(true);

      const doc = JSON.parse(fs.readFileSync(analysisPath, "utf8"));
      // The regression: intermittently 1+ results were silently overwritten
      // because two workers held the "exclusive" lock. Every analyzer must land.
      expect(Object.keys(doc.results).sort()).toEqual([...analyzers].sort());
      expect(fs.existsSync(lockPath)).toBe(false);
    }
  }, 60_000);
});

describe("mergeAnalyzerResult (break-in detection, #30110)", () => {
  it("retries instead of dropping a result when its lock is broken in mid-write", () => {
    const analysisPath = path.join(newDir(), "shot.png.analysis.json");
    const lockPath = `${analysisPath}.lock`;
    // A prior analyzer's result already lives in the document.
    fs.writeFileSync(
      analysisPath,
      `${JSON.stringify(
        {
          schema: 1,
          artifact: "visual/x/shot.png",
          results: {
            "prior.analyzer": {
              status: "ran",
              durationMs: 1,
              data: { text: "prior" },
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const realWriteFileSync = fs.writeFileSync.bind(fs);
    let brokeInOnce = false;
    // Inject a break-in exactly once, at the moment our writer has staged its
    // temp doc (loaded from the pre-theft document) but before it commits: a
    // second acquirer broke our stale lock, merged its own analyzer, and
    // released. Our nonce is therefore gone, so the pending commit would drop
    // the intruder's result if it proceeded. The fix must detect this and retry.
    const spy = vi
      .spyOn(fs, "writeFileSync")
      .mockImplementation((file, data, options) => {
        realWriteFileSync(file as string, data as string, options as never);
        const isTemp = typeof file === "string" && file.endsWith(".tmp");
        if (isTemp && !brokeInOnce) {
          brokeInOnce = true;
          const current = JSON.parse(fs.readFileSync(analysisPath, "utf8"));
          current.results["intruder.analyzer"] = {
            status: "ran",
            durationMs: 2,
            data: { text: "intruder" },
          };
          realWriteFileSync(
            analysisPath,
            `${JSON.stringify(current, null, 2)}\n`,
          );
          // The intruder released its lock on the way out.
          fs.rmSync(lockPath, { force: true });
        }
      });

    try {
      mergeAnalyzerResult({
        analysisPath,
        artifact: "visual/x/shot.png",
        analyzerId: "winner.analyzer",
        result: { status: "ran", durationMs: 3, data: { text: "winner" } },
      });
    } finally {
      spy.mockRestore();
    }

    // The break-in fired exactly once, forcing a retry.
    expect(brokeInOnce).toBe(true);
    const doc = JSON.parse(fs.readFileSync(analysisPath, "utf8"));
    // All three results survive: the retry re-read the intruder's committed
    // write instead of overwriting the document it had loaded pre-theft.
    expect(Object.keys(doc.results).sort()).toEqual([
      "intruder.analyzer",
      "prior.analyzer",
      "winner.analyzer",
    ]);
    expect(doc.results["intruder.analyzer"].data.text).toBe("intruder");
    expect(doc.results["winner.analyzer"].data.text).toBe("winner");
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
