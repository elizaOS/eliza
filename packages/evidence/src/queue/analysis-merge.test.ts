// The per-subject merge into analysis.json, driven on a REAL filesystem. The
// load path is unit-tested (create-when-absent, refuse-corrupt), and the
// concurrency guarantee is proven the only way it can be — with genuinely
// separate OS processes: N `bun` children merge N distinct analyzers into one
// analysis.json at once, and every result must survive. Without the O_EXCL lock
// this is a lost-update race (temp+rename is atomic per write but not per
// read-modify-write across processes), so the child-race test is the regression
// guard for that bug.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
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
