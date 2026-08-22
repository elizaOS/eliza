/**
 * Runs deterministic child-process performance and soak measurements against
 * the production FILE read handler and writes one machine-readable JSON report.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setupEnv } from "../src/actions/_test-helpers.js";
import { readFileHandler } from "../src/actions/read.js";

type Args = {
  output: string;
  samples: number;
  concurrency: number;
  sourceBytes: number;
  pageBytes: number;
  seed: number;
};

type ReadMetrics = {
  sourceBytesRead: number;
  bytesReturned: number;
};

function args(): Args {
  const values = new Map<string, string>();
  for (let index = 2; index < process.argv.length; index += 2) {
    values.set(process.argv[index] ?? "", process.argv[index + 1] ?? "");
  }
  const output = values.get("--output");
  if (!output) throw new Error("--output is required");
  const number = (name: string, fallback: number) => {
    const value = Number(values.get(name) ?? fallback);
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`${name} must be a positive safe integer`);
    return value;
  };
  return {
    output: path.resolve(output),
    samples: number("--samples", 1_001),
    concurrency: number("--concurrency", 1),
    sourceBytes: number("--source-bytes", 10 * 1024 * 1024),
    pageBytes: number("--page-bytes", 64 * 1024),
    seed: number("--seed", 20_260_821),
  };
}

const CORPUS_WRITE_CHUNK_BYTES = 64 * 1024;

async function writeCorpus(
  file: string,
  size: number,
  seed: number,
): Promise<string> {
  let state = seed >>> 0;
  const digest = createHash("sha256");
  const chunk = Buffer.allocUnsafe(Math.min(size, CORPUS_WRITE_CHUNK_BYTES));
  const handle = await fs.open(file, "w", 0o600);
  try {
    for (let offset = 0; offset < size; offset += chunk.length) {
      const length = Math.min(chunk.length, size - offset);
      for (let local = 0; local < length; local += 1) {
        const index = offset + local;
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        chunk[local] = index % 79 === 78 ? 10 : 32 + (state % 95);
      }
      let written = 0;
      while (written < length) {
        const result = await handle.write(
          chunk,
          written,
          length - written,
          offset + written,
        );
        if (result.bytesWritten === 0) {
          throw new Error(`corpus writer made no progress for ${file}`);
        }
        written += result.bytesWritten;
      }
      digest.update(chunk.subarray(0, length));
    }
  } finally {
    await handle.close();
  }
  return digest.digest("hex");
}

function sha(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function percentile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  return (
    sorted[
      Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
    ] ?? null
  );
}

function latency(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    distributionSufficient: sorted.length >= 1_000,
    samples: sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted.at(-1) ?? 0,
  };
}

function memoryMaximum(
  left: NodeJS.MemoryUsage,
  right: NodeJS.MemoryUsage,
): NodeJS.MemoryUsage {
  return {
    rss: Math.max(left.rss, right.rss),
    heapTotal: Math.max(left.heapTotal, right.heapTotal),
    heapUsed: Math.max(left.heapUsed, right.heapUsed),
    external: Math.max(left.external, right.external),
    arrayBuffers: Math.max(left.arrayBuffers, right.arrayBuffers),
  };
}

type HandlerMemoryProbeMode = "normal" | "retain-source";

function handlerMemoryProbeNumber(name: string): number {
  const index = process.argv.indexOf(name);
  const value = Number(index >= 0 ? process.argv[index + 1] : undefined);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

async function runHandlerMemoryProbe(): Promise<void> {
  const sourceBytes = handlerMemoryProbeNumber("--source-bytes");
  const pageBytes = handlerMemoryProbeNumber("--page-bytes");
  const seed = handlerMemoryProbeNumber("--seed");
  const modeIndex = process.argv.indexOf("--handler-memory-probe");
  const mode = process.argv[modeIndex + 1] as HandlerMemoryProbeMode;
  if (mode !== "normal" && mode !== "retain-source") {
    throw new Error("invalid --handler-memory-probe mode");
  }
  const env = await setupEnv(`progressive-read-handler-memory-${mode}`, {
    extraSettings: { CODING_TOOLS_MAX_FILE_SIZE_BYTES: pageBytes },
  });
  const sourcePath = path.join(env.tmpDir, "handler-memory-source.txt");
  try {
    await writeCorpus(sourcePath, sourceBytes, seed);
    Bun.gc(true);
    const beforeRssBytes = process.memoryUsage().rss;
    const result = await readFileHandler(env.runtime, env.message, undefined, {
      parameters: {
        file_path: sourcePath,
        unit: "byte",
        offset: 0,
        limit: pageBytes,
      },
    });
    diagnostics(result);
    const retainedSource =
      mode === "retain-source" ? await fs.readFile(sourcePath) : null;
    Bun.gc(true);
    const afterRssBytes = process.memoryUsage().rss;
    const checksum =
      (result.text?.charCodeAt(0) ?? 0) +
      (retainedSource?.[0] ?? 0) +
      (retainedSource?.at(-1) ?? 0);
    process.stdout.write(
      JSON.stringify({ beforeRssBytes, afterRssBytes, checksum }),
    );
  } finally {
    await env.cleanup();
  }
}

function handlerMemoryProbe(
  mode: HandlerMemoryProbeMode,
  sourceBytes: number,
  pageBytes: number,
  seed: number,
) {
  const child = Bun.spawnSync(
    [
      process.execPath,
      path.resolve(import.meta.dirname, "progressive-read-benchmark.ts"),
      "--handler-memory-probe",
      mode,
      "--source-bytes",
      String(sourceBytes),
      "--page-bytes",
      String(pageBytes),
      "--seed",
      String(seed),
    ],
    {
      timeout: 30_000,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    },
  );
  if (child.exitCode !== 0) {
    throw new Error(
      `handler memory probe ${mode} failed: ${child.stderr.toString()}`,
    );
  }
  const measured = JSON.parse(child.stdout.toString()) as {
    beforeRssBytes: number;
    afterRssBytes: number;
    checksum: number;
  };
  return {
    ...measured,
    measuredRssDeltaBytes: Math.max(
      0,
      measured.afterRssBytes - measured.beforeRssBytes,
    ),
  };
}

async function fdCount(): Promise<number | null> {
  for (const directory of ["/proc/self/fd", "/dev/fd"]) {
    try {
      return (await fs.readdir(directory)).length;
    } catch {
      /* error-policy:J3 platform probe tries the next explicit path. */
    }
  }
  return null;
}

function diagnostics(result: Awaited<ReturnType<typeof readFileHandler>>) {
  if (!result.success) throw new Error(result.text);
  const data = result.data as Record<string, unknown>;
  const metrics = data.diagnostics as ReadMetrics;
  const view = data.readView as {
    reference: { revision?: string };
    slice: { nextOffset?: number };
  };
  return { metrics, view };
}

async function main(): Promise<void> {
  const options = args();
  const env = await setupEnv("progressive-read-benchmark", {
    extraSettings: { CODING_TOOLS_MAX_FILE_SIZE_BYTES: options.pageBytes },
  });
  const sourcePath = path.join(env.tmpDir, "corpus-10m.txt");
  const smallPath = path.join(env.tmpDir, "corpus-1m.txt");
  const smallSourceBytes = Math.min(options.sourceBytes, 1024 * 1024);
  Bun.gc(true);
  const beforeGenerationMemory = process.memoryUsage();
  const [sourceSha256, smallSha256] = await Promise.all([
    writeCorpus(sourcePath, options.sourceBytes, options.seed),
    writeCorpus(smallPath, smallSourceBytes, options.seed),
  ]);
  Bun.gc(true);
  const beforeMemory = process.memoryUsage();
  const generatorBufferBudgetBytes =
    Math.min(options.sourceBytes, CORPUS_WRITE_CHUNK_BYTES) +
    Math.min(smallSourceBytes, CORPUS_WRITE_CHUNK_BYTES);
  const generatorRetentionAllowanceBytes = Math.max(
    4 * 1024 * 1024,
    generatorBufferBudgetBytes * 4,
  );
  const measuredGeneratorRssDeltaBytes = Math.max(
    0,
    beforeMemory.rss - beforeGenerationMemory.rss,
  );
  const generatorRetentionBounded =
    measuredGeneratorRssDeltaBytes <= generatorRetentionAllowanceBytes;
  const manifest = {
    schema: "eliza-progressive-corpus/v1",
    seed: options.seed,
    files: [
      {
        name: path.basename(sourcePath),
        bytes: options.sourceBytes,
        sha256: sourceSha256,
      },
      {
        name: path.basename(smallPath),
        bytes: smallSourceBytes,
        sha256: smallSha256,
      },
    ],
    generation: {
      mode: "streamed",
      maxChunkBytes: CORPUS_WRITE_CHUNK_BYTES,
    },
  };
  const manifestHash = sha(JSON.stringify(manifest));
  const beforeCpu = process.cpuUsage();
  const beforeFds = await fdCount();
  const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  eventLoop.enable();
  const latencies: number[] = [];
  let bytesReturned = 0;
  let sourceBytesRead = 0;
  let peak = beforeMemory;
  let memorySamples = 0;
  const sampleMemory = (): NodeJS.MemoryUsage => {
    const current = process.memoryUsage();
    peak = memoryMaximum(peak, current);
    memorySamples += 1;
    return current;
  };
  sampleMemory();
  const started = performance.now();
  const coldStarted = performance.now();
  const coldResult = await readFileHandler(
    env.runtime,
    env.message,
    undefined,
    {
      parameters: {
        file_path: sourcePath,
        unit: "byte",
        offset: 0,
        limit: options.pageBytes,
      },
    },
  );
  latencies.push(performance.now() - coldStarted);
  const cold = diagnostics(coldResult);
  sampleMemory();
  bytesReturned += cold.metrics.bytesReturned;
  sourceBytesRead += cold.metrics.sourceBytesRead;
  const sourceRevision = cold.view.reference.revision;
  let cursor = 1;
  const workers = Array.from({ length: options.concurrency }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= options.samples) return;
      const offset =
        (index * options.pageBytes) %
        Math.max(1, options.sourceBytes - options.pageBytes);
      const callStarted = performance.now();
      const result = await readFileHandler(
        env.runtime,
        env.message,
        undefined,
        {
          parameters: {
            file_path: sourcePath,
            unit: "byte",
            offset,
            limit: options.pageBytes,
            ...(offset > 0 ? { expectedRevision: sourceRevision } : {}),
          },
        },
      );
      latencies.push(performance.now() - callStarted);
      const measured = diagnostics(result).metrics;
      bytesReturned += measured.bytesReturned;
      sourceBytesRead += measured.sourceBytesRead;
      sampleMemory();
    }
  });
  await Promise.all(workers);
  const durationMs = performance.now() - started;

  const bounded = async (file: string) => {
    const result = await readFileHandler(env.runtime, env.message, undefined, {
      parameters: {
        file_path: file,
        unit: "byte",
        offset: 0,
        limit: options.pageBytes,
      },
    });
    const measured = diagnostics(result).metrics;
    sampleMemory();
    const projection = JSON.stringify(result.promptData ?? {});
    return {
      ...measured,
      serializedResultBytes: Buffer.byteLength(JSON.stringify(result)),
      projectionBytes: Buffer.byteLength(projection),
      projectionContainsPage: projection.includes(result.text ?? ""),
    };
  };
  const smallPage = await bounded(smallPath);
  const largePage = await bounded(sourcePath);

  let traversalOffset = 0;
  let traversalSourceBytes = 0;
  let traversalRevision: string | undefined;
  const traversalHash = createHash("sha256");
  let traversalPages = 0;
  while (traversalOffset < options.sourceBytes) {
    const result = await readFileHandler(env.runtime, env.message, undefined, {
      parameters: {
        file_path: sourcePath,
        unit: "byte",
        offset: traversalOffset,
        limit: options.pageBytes,
        ...(traversalRevision ? { expectedRevision: traversalRevision } : {}),
      },
    });
    const measured = diagnostics(result);
    traversalHash.update(result.text ?? "");
    traversalSourceBytes += measured.metrics.sourceBytesRead;
    traversalRevision = measured.view.reference.revision;
    traversalPages += 1;
    traversalOffset = measured.view.slice.nextOffset ?? options.sourceBytes;
    sampleMemory();
  }
  eventLoop.disable();
  const afterMemory = sampleMemory();
  const cpu = process.cpuUsage(beforeCpu);
  const handlerPeakAllowanceBytes = Math.max(
    2 * 1024 * 1024,
    options.pageBytes * 64,
  );
  const handlerRetention = handlerMemoryProbe(
    "normal",
    options.sourceBytes,
    options.pageBytes,
    options.seed,
  );
  const leakingHandlerControl = handlerMemoryProbe(
    "retain-source",
    options.sourceBytes,
    options.pageBytes,
    options.seed,
  );
  const handlerPeakPageBounded =
    handlerRetention.measuredRssDeltaBytes <= handlerPeakAllowanceBytes;
  const leakingHandlerControlDetected =
    leakingHandlerControl.measuredRssDeltaBytes > handlerPeakAllowanceBytes;
  const reassemblySha256 = traversalHash.digest("hex");
  const invariant = {
    boundedPageIoDoesNotScale:
      smallPage.sourceBytesRead === largePage.sourceBytesRead &&
      largePage.sourceBytesRead <= options.pageBytes + 3,
    boundedPageSerializationDoesNotScale:
      Math.abs(
        largePage.serializedResultBytes - smallPage.serializedResultBytes,
      ) <= 256,
    fullTraversalLinear:
      traversalSourceBytes <= options.sourceBytes + traversalPages * 3,
    reassemblyMatches: reassemblySha256 === sourceSha256,
    projectionDoesNotDuplicatePage:
      !smallPage.projectionContainsPage && !largePage.projectionContainsPage,
  };
  const commit = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    cwd: path.resolve(import.meta.dir, "../../.."),
    timeout: 10_000,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  })
    .stdout.toString()
    .trim();
  const repoRoot = path.resolve(import.meta.dir, "../../..");
  const status = Bun.spawnSync(["git", "status", "--porcelain=v1"], {
    cwd: repoRoot,
    timeout: 10_000,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  }).stdout.toString();
  const productionFiles = [
    path.join(repoRoot, "plugins/plugin-coding-tools/src/actions/read.ts"),
    path.join(
      repoRoot,
      "plugins/plugin-coding-tools/scripts/progressive-read-benchmark.ts",
    ),
  ];
  const report = {
    schema: "eliza-progressive-read-benchmark/v1",
    commit,
    sourceRevision: {
      commit,
      dirty: status.length > 0,
      statusSha256: sha(status),
      files: Object.fromEntries(
        await Promise.all(
          productionFiles.map(async (file) => [
            path.relative(repoRoot, file).split(path.sep).join("/"),
            sha(await fs.readFile(file)),
          ]),
        ),
      ),
    },
    corpus: {
      ...manifest,
      generation: {
        ...manifest.generation,
        retainedSourceBytesAtMeasurement: measuredGeneratorRssDeltaBytes,
        retentionMetric: "process.memoryUsage.rss",
      },
      manifestHash,
    },
    runtime: {
      bun: Bun.version,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    },
    machine: {
      hostname: os.hostname(),
      cpus: os.cpus().length,
      model: os.cpus()[0]?.model ?? "unknown",
      totalMemoryBytes: os.totalmem(),
    },
    configuration: {
      coldSamples: Math.min(1, options.samples),
      warmSamples: Math.max(0, options.samples - 1),
      totalSamples: options.samples,
      samples: options.samples,
      concurrency: options.concurrency,
      pageBytes: options.pageBytes,
    },
    latency: {
      cold: latency(latencies.slice(0, 1)),
      warm: latency(latencies.slice(1)),
      all: latency(latencies),
    },
    throughput: {
      operationsPerSecond: options.samples / (durationMs / 1000),
      bytesPerSecond: bytesReturned / (durationMs / 1000),
      durationMs,
    },
    io: {
      sourceBytesRead,
      bytesReturned,
      ratio: sourceBytesRead / Math.max(1, bytesReturned),
    },
    memory: {
      beforeGeneration: beforeGenerationMemory,
      before: beforeMemory,
      peak,
      after: afterMemory,
      samples: memorySamples,
      generatorRetention: {
        metric: "process.memoryUsage.rss",
        beforeGenerationBytes: beforeGenerationMemory.rss,
        afterGenerationGcBytes: beforeMemory.rss,
        measuredDeltaBytes: measuredGeneratorRssDeltaBytes,
        allowedDeltaBytes: generatorRetentionAllowanceBytes,
        bounded: generatorRetentionBounded,
      },
      handlerRetention: {
        metric: "fresh-child process.memoryUsage.rss",
        pageBytes: options.pageBytes,
        beforeBytes: handlerRetention.beforeRssBytes,
        afterGcBytes: handlerRetention.afterRssBytes,
        measuredDeltaBytes: handlerRetention.measuredRssDeltaBytes,
        allowedDeltaBytes: handlerPeakAllowanceBytes,
        bounded: handlerPeakPageBounded,
      },
      leakingHandlerPositiveControl: {
        retainedBytes: options.sourceBytes,
        process: "fresh-bun-production-handler-child",
        beforeRssBytes: leakingHandlerControl.beforeRssBytes,
        afterRssBytes: leakingHandlerControl.afterRssBytes,
        measuredDeltaBytes: leakingHandlerControl.measuredRssDeltaBytes,
        allowedDeltaBytes: handlerPeakAllowanceBytes,
        checksum: leakingHandlerControl.checksum,
        bounded: !leakingHandlerControlDetected,
        detected: leakingHandlerControlDetected,
      },
      fullBufferPositiveControl: {
        retainedBytes: options.sourceBytes,
        process: "fresh-bun-production-handler-child",
        beforeRssBytes: leakingHandlerControl.beforeRssBytes,
        afterRssBytes: leakingHandlerControl.afterRssBytes,
        measuredDeltaBytes: leakingHandlerControl.measuredRssDeltaBytes,
        allowedDeltaBytes: handlerPeakAllowanceBytes,
        checksum: leakingHandlerControl.checksum,
        bounded: !leakingHandlerControlDetected,
        detected: leakingHandlerControlDetected,
      },
      invariant: {
        generatorRetentionBounded,
        handlerPeakPageBounded,
        leakingHandlerControlDetected,
        fullBufferControlDetected: leakingHandlerControlDetected,
      },
    },
    cpu: { userMicros: cpu.user, systemMicros: cpu.system },
    eventLoopDelay: {
      minMs: eventLoop.min / 1e6,
      meanMs: eventLoop.mean / 1e6,
      maxMs: eventLoop.max / 1e6,
      p99Ms: eventLoop.percentile(99) / 1e6,
    },
    fileDescriptors: {
      before: beforeFds,
      beforeCleanup: await fdCount(),
      afterCleanup: null as number | null,
    },
    boundedPageComparison: {
      smallSourceBytes,
      largeSourceBytes: options.sourceBytes,
      smallPage,
      largePage,
    },
    traversal: {
      pages: traversalPages,
      sourceBytesRead: traversalSourceBytes,
      reassemblySha256,
      invariant,
    },
    cleanup: {
      created: [sourcePath, smallPath],
      removed: [env.tmpDir],
      remaining: [] as string[],
      retained: [options.output],
    },
  };
  await env.cleanup();
  report.fileDescriptors.afterCleanup = await fdCount();
  try {
    await fs.access(env.tmpDir);
    report.cleanup.remaining.push(env.tmpDir);
  } catch {
    /* error-policy:J3 cleanup probe records an empty remaining inventory. */
  }
  await fs.mkdir(path.dirname(options.output), { recursive: true });
  await fs.writeFile(
    options.output,
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  if (
    Object.values(invariant).some((value) => !value) ||
    !generatorRetentionBounded ||
    !handlerPeakPageBounded ||
    !leakingHandlerControlDetected
  ) {
    process.exitCode = 1;
  }
}

if (process.argv.includes("--handler-memory-probe")) {
  await runHandlerMemoryProbe();
} else {
  await main();
}
