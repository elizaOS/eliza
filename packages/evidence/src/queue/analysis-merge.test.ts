/**
 * Verifies analysis merges through real filesystem readback and separate Bun
 * processes. Invalid or mismatched documents retain their original bytes, and
 * every analyzer result must survive serialization and concurrent writers.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
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
