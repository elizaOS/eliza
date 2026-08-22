/** Runs the progressive FILE benchmark in a child process and validates its deterministic report contract. */

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const outputs: string[] = [];

type BenchmarkReport = {
  schema: string;
  commit: string;
  sourceRevision: {
    commit: string;
    dirty: boolean;
    statusSha256: string;
    files: Record<string, string>;
  };
  corpus: Record<string, unknown>;
  configuration: Record<string, unknown>;
  latency: { all: Record<string, unknown> };
  traversal: { invariant: Record<string, boolean> };
  boundedPageComparison: { largeSourceBytes: number };
  cleanup: { remaining: string[] };
  memory: { peak: Record<string, number> };
  eventLoopDelay: Record<string, number>;
  fileDescriptors: Record<string, number | null>;
};

afterEach(async () => {
  await Promise.all(
    outputs.splice(0).map((entry) => fs.rm(entry, { force: true })),
  );
});

describe("progressive read benchmark", () => {
  it("emits a labelled smoke report and proves bounded 10 MiB I/O plus linear traversal", async () => {
    const output = path.join(
      os.tmpdir(),
      `progressive-read-${process.pid}-${Date.now()}.json`,
    );
    outputs.push(output);
    const script = path.resolve(
      import.meta.dirname,
      "../../scripts/progressive-read-benchmark.ts",
    );
    const child = spawn(
      "bun",
      [
        script,
        "--output",
        output,
        "--samples",
        "12",
        "--concurrency",
        "2",
        "--source-bytes",
        String(10 * 1024 * 1024),
        "--page-bytes",
        String(64 * 1024),
        "--seed",
        "20260821",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const report = JSON.parse(
      await fs.readFile(output, "utf8"),
    ) as BenchmarkReport;
    expect(report.schema).toBe("eliza-progressive-read-benchmark/v1");
    expect(report.commit).toMatch(/^[0-9a-f]{40}$/u);
    expect(report.sourceRevision.commit).toBe(report.commit);
    expect(typeof report.sourceRevision.dirty).toBe("boolean");
    expect(report.sourceRevision.statusSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(
      report.sourceRevision.files[
        "plugins/plugin-coding-tools/src/actions/read.ts"
      ],
    ).toMatch(/^[0-9a-f]{64}$/u);
    expect(report.corpus).toMatchObject({
      schema: "eliza-progressive-corpus/v1",
      seed: 20260821,
    });
    expect(report.corpus.manifestHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(report.configuration).toMatchObject({
      samples: 12,
      concurrency: 2,
      warmSamples: 11,
    });
    expect(report.latency.all).toMatchObject({
      distributionSufficient: false,
      p50Ms: null,
      p95Ms: null,
      p99Ms: null,
    });
    expect(report.traversal.invariant).toEqual({
      boundedPageIoDoesNotScale: true,
      boundedPageSerializationDoesNotScale: true,
      fullTraversalLinear: true,
      reassemblyMatches: true,
      projectionDoesNotDuplicatePage: true,
    });
    expect(report.boundedPageComparison.largeSourceBytes).toBe(
      10 * 1024 * 1024,
    );
    expect(report.cleanup.remaining).toEqual([]);
    expect(report.memory.peak).toHaveProperty("rss");
    expect(report.eventLoopDelay).toHaveProperty("p99Ms");
    expect(report.fileDescriptors).toHaveProperty("before");
    expect(report.fileDescriptors).toHaveProperty("afterCleanup");
  }, 120_000);
});
