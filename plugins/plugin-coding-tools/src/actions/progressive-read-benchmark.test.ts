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
  corpus: Record<string, unknown> & {
    generation: {
      retainedSourceBytesAtMeasurement: number;
      retentionMetric: string;
    };
  };
  configuration: Record<string, unknown>;
  latency: {
    cold: Record<string, unknown>;
    warm: Record<string, unknown>;
    all: Record<string, unknown>;
  };
  traversal: { invariant: Record<string, boolean> };
  boundedPageComparison: { largeSourceBytes: number };
  cleanup: { remaining: string[] };
  memory: {
    peak: Record<string, number>;
    samples: number;
    generatorRetention: {
      measuredDeltaBytes: number;
      allowedDeltaBytes: number;
      bounded: boolean;
    };
    handlerRetention: {
      pageBytes: number;
      measuredDeltaBytes: number;
      allowedDeltaBytes: number;
      bounded: boolean;
    };
    leakingHandlerPositiveControl: {
      retainedBytes: number;
      measuredDeltaBytes: number;
      allowedDeltaBytes: number;
      bounded: boolean;
      detected: boolean;
    };
    fullBufferPositiveControl: {
      retainedBytes: number;
      measuredDeltaBytes: number;
      allowedDeltaBytes: number;
      bounded: boolean;
      detected: boolean;
    };
    invariant: Record<string, boolean>;
  };
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
        "1001",
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
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    }, 90_000);
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", (error) => {
        clearTimeout(deadline);
        if (killTimer) clearTimeout(killTimer);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(deadline);
        if (killTimer) clearTimeout(killTimer);
        resolve(code);
      });
    });
    expect(timedOut).toBe(false);
    expect(stdout).toBe("");
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
      generation: {
        mode: "streamed",
        maxChunkBytes: 64 * 1024,
        retentionMetric: "process.memoryUsage.rss",
      },
    });
    expect(report.corpus.manifestHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(report.configuration).toMatchObject({
      coldSamples: 1,
      samples: 1001,
      totalSamples: 1001,
      concurrency: 2,
      warmSamples: 1000,
    });
    expect(report.latency.cold).toMatchObject({
      distributionSufficient: false,
      samples: 1,
    });
    expect(report.latency.warm).toMatchObject({
      distributionSufficient: true,
      samples: 1000,
    });
    expect(report.latency.all).toMatchObject({
      distributionSufficient: true,
      samples: 1001,
    });
    for (const distribution of [
      report.latency.cold,
      report.latency.warm,
      report.latency.all,
    ]) {
      expect(distribution.p50Ms).toEqual(expect.any(Number));
      expect(distribution.p95Ms).toEqual(expect.any(Number));
      expect(distribution.p99Ms).toEqual(expect.any(Number));
    }
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
    expect(report.memory.samples).toBeGreaterThan(1001);
    expect(report.memory.generatorRetention.bounded).toBe(true);
    expect(report.corpus.generation.retainedSourceBytesAtMeasurement).toBe(
      report.memory.generatorRetention.measuredDeltaBytes,
    );
    expect(
      report.memory.generatorRetention.measuredDeltaBytes,
    ).toBeLessThanOrEqual(report.memory.generatorRetention.allowedDeltaBytes);
    expect(report.memory.handlerRetention).toMatchObject({
      pageBytes: 64 * 1024,
      bounded: true,
    });
    expect(
      report.memory.handlerRetention.measuredDeltaBytes,
    ).toBeLessThanOrEqual(report.memory.handlerRetention.allowedDeltaBytes);
    expect(report.memory.leakingHandlerPositiveControl).toMatchObject({
      retainedBytes: 10 * 1024 * 1024,
      bounded: false,
      detected: true,
    });
    expect(
      report.memory.leakingHandlerPositiveControl.measuredDeltaBytes,
    ).toBeGreaterThan(
      report.memory.leakingHandlerPositiveControl.allowedDeltaBytes,
    );
    expect(report.memory.fullBufferPositiveControl).toMatchObject({
      retainedBytes: 10 * 1024 * 1024,
      bounded: false,
      detected: true,
    });
    expect(
      report.memory.fullBufferPositiveControl.measuredDeltaBytes,
    ).toBeGreaterThan(
      report.memory.fullBufferPositiveControl.allowedDeltaBytes,
    );
    expect(report.memory.invariant).toEqual({
      generatorRetentionBounded: true,
      handlerPeakPageBounded: true,
      leakingHandlerControlDetected: true,
      fullBufferControlDetected: true,
    });
    expect(report.eventLoopDelay).toHaveProperty("p99Ms");
    expect(report.fileDescriptors).toHaveProperty("before");
    expect(report.fileDescriptors).toHaveProperty("afterCleanup");
  }, 120_000);
});
