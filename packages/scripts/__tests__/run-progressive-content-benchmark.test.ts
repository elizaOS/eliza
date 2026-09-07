/** Tests the closed fixed-target benchmark command without executing its production 90-worker matrix. */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { generateProgressiveContentCorpus } from "../../corpus-tools/src/progressive-content";
import {
  PROGRESSIVE_CONTENT_BENCHMARK_BACKENDS,
  PROGRESSIVE_CONTENT_BENCHMARK_BINARY_POLICY,
  parseProgressiveContentBenchmarkArgs,
  selectProgressiveContentBenchmarkObject,
} from "../run-progressive-content-benchmark.mjs";

const commit = "a".repeat(40);
const execFileAsync = promisify(execFile);
const bunExecutable = process.versions.bun ? process.execPath : "bun";

describe("progressive content benchmark producer", () => {
  it("requires only the repository corpus, output, and exact commit", () => {
    expect(() => parseProgressiveContentBenchmarkArgs([])).toThrow(
      /corpus-root/u,
    );
    expect(
      parseProgressiveContentBenchmarkArgs([
        "--corpus-root=/private/corpus",
        "--out=/private/benchmark.json",
        `--commit=${commit}`,
      ]),
    ).toMatchObject({ worker: false, commit });
    expect(() =>
      parseProgressiveContentBenchmarkArgs([
        "--factory-module=/private/caller-selected.mjs",
        "--corpus-root=/private/corpus",
        "--out=/private/benchmark.json",
        `--commit=${commit}`,
      ]),
    ).toThrow(/unsupported benchmark argument/u);
    expect(() =>
      parseProgressiveContentBenchmarkArgs([
        "--postgres-url=postgresql://caller-selected/db",
        "--corpus-root=/private/corpus",
        "--out=/private/benchmark.json",
        `--commit=${commit}`,
      ]),
    ).toThrow(/unsupported benchmark argument/u);
    expect(PROGRESSIVE_CONTENT_BENCHMARK_BACKENDS).toEqual({
      file: "filesystem",
      document: "postgres",
      memory: "postgres",
      email: "postgres",
      attachment: "content-addressed-media-store",
      "tool-output": "runtime-tool-output-store",
    });
    expect(Object.isFrozen(PROGRESSIVE_CONTENT_BENCHMARK_BACKENDS)).toBe(true);
  });

  it("fails closed before corpus access when PostgreSQL is unavailable", async () => {
    const script = fileURLToPath(
      new URL("../run-progressive-content-benchmark.mjs", import.meta.url),
    );
    const baseArguments = [
      script,
      "--corpus-root=/private/missing-corpus",
      "--out=/private/missing-output.json",
      `--commit=${commit}`,
    ];
    await expect(
      execFileAsync(bunExecutable, baseArguments, {
        env: { ...process.env, POSTGRES_URL: "" },
      }),
    ).rejects.toMatchObject({ stderr: expect.stringMatching(/POSTGRES_URL/u) });
    await expect(
      execFileAsync(bunExecutable, baseArguments, {
        env: { ...process.env, POSTGRES_URL: "https://not-postgres.invalid" },
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringMatching(/PostgreSQL protocol/u),
    });
  });

  it("keeps every coordinate and work root internal to workers", () => {
    expect(() =>
      parseProgressiveContentBenchmarkArgs([
        "--corpus-root=/private/corpus",
        "--out=/private/benchmark.json",
        `--commit=${commit}`,
        "--family=file",
      ]),
    ).toThrow(/worker-only/u);
    expect(
      parseProgressiveContentBenchmarkArgs([
        "--corpus-root=/private/corpus",
        "--worker-out=/private/sample.json",
        "--work-root=/private/work",
        `--commit=${commit}`,
        "--family=attachment",
        "--source-bytes=104857600",
        "--repetition=5",
      ]),
    ).toMatchObject({
      worker: true,
      family: "attachment",
      sourceBytes: 104_857_600,
      repetition: 5,
    });
  });

  it("requires one exact native-readable object per family and size", () => {
    const object = {
      family: "email",
      byteLength: 1_048_576,
      format: "lf-lines",
      id: "email-1",
    };
    expect(
      selectProgressiveContentBenchmarkObject(
        { objects: [object] },
        "email",
        1_048_576,
      ),
    ).toBe(object);
    expect(() =>
      selectProgressiveContentBenchmarkObject(
        { objects: [object, { ...object, id: "duplicate" }] },
        "email",
        1_048_576,
      ),
    ).toThrow(/exactly one/u);
    expect(() =>
      selectProgressiveContentBenchmarkObject(
        { objects: [{ ...object, format: "binary" }] },
        "email",
        1_048_576,
      ),
    ).toThrow(/found 0/u);
    expect(
      selectProgressiveContentBenchmarkObject(
        {
          objects: [
            {
              ...object,
              family: "attachment",
              format: "binary",
            },
          ],
        },
        "attachment",
        1_048_576,
      ).format,
    ).toBe("binary");
    expect(PROGRESSIVE_CONTENT_BENCHMARK_BINARY_POLICY.memory).toBe(
      "typed-rejection",
    );
  });

  it("executes a fixed repository FILE worker in a distinct process", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "progressive-benchmark-test-"),
    );
    try {
      const corpusRoot = path.join(root, "corpus");
      const workerOut = path.join(root, "sample.json");
      const workRoot = path.join(root, "work");
      await mkdir(corpusRoot, { mode: 0o700 });
      const manifest = await generateProgressiveContentCorpus({
        outDir: corpusRoot,
        profile: "micro",
        rootSeed: "benchmark-worker-test",
        generatorRevision: "test-revision",
      });
      const object = manifest.objects.find(
        ({ family, byteLength, format }) =>
          family === "file" &&
          byteLength > 0 &&
          format !== "binary" &&
          format !== "invalid-utf8",
      );
      if (!object) throw new Error("micro corpus lacks a readable FILE object");
      const script = fileURLToPath(
        new URL("../run-progressive-content-benchmark.mjs", import.meta.url),
      );
      await execFileAsync(bunExecutable, [
        script,
        `--corpus-root=${corpusRoot}`,
        `--worker-out=${workerOut}`,
        `--work-root=${workRoot}`,
        `--commit=${commit}`,
        "--family=file",
        `--source-bytes=${object.byteLength}`,
        "--repetition=1",
      ]);
      const sample = JSON.parse(await readFile(workerOut, "utf8"));
      expect(sample.processId).not.toBe(process.pid);
      expect(sample.family).toBe("file");
      expect(sample.adapterId).toBeTypeOf("string");
      expect(sample.productionMethod).toBeTypeOf("string");
      expect(sample.backend).toBe("filesystem");
      expect(sample.cold.bytesReturned).toBe(object.byteLength);
      expect(sample.warm.bytesReturned).toBe(object.byteLength);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
