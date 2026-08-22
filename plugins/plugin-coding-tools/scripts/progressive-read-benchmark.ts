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
    samples: number("--samples", 1_000),
    concurrency: number("--concurrency", 1),
    sourceBytes: number("--source-bytes", 10 * 1024 * 1024),
    pageBytes: number("--page-bytes", 64 * 1024),
    seed: number("--seed", 20_260_821),
  };
}

function corpus(size: number, seed: number): Buffer {
  let state = seed >>> 0;
  const output = Buffer.allocUnsafe(size);
  for (let index = 0; index < size; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    output[index] = index % 79 === 78 ? 10 : 32 + (state % 95);
  }
  return output;
}

function sha(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function percentile(sorted: number[], fraction: number): number | null {
  if (sorted.length < 1_000) return null;
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
  const source = corpus(options.sourceBytes, options.seed);
  const small = source.subarray(0, Math.min(source.length, 1024 * 1024));
  await Promise.all([
    fs.writeFile(sourcePath, source),
    fs.writeFile(smallPath, small),
  ]);
  const manifest = {
    schema: "eliza-progressive-corpus/v1",
    seed: options.seed,
    files: [
      {
        name: path.basename(sourcePath),
        bytes: source.length,
        sha256: sha(source),
      },
      {
        name: path.basename(smallPath),
        bytes: small.length,
        sha256: sha(small),
      },
    ],
  };
  const manifestHash = sha(JSON.stringify(manifest));
  const beforeMemory = process.memoryUsage();
  const beforeCpu = process.cpuUsage();
  const beforeFds = await fdCount();
  const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  eventLoop.enable();
  const latencies: number[] = [];
  let bytesReturned = 0;
  let sourceBytesRead = 0;
  let peak = process.memoryUsage();
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
        Math.max(1, source.length - options.pageBytes);
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
      const current = process.memoryUsage();
      for (const key of [
        "rss",
        "heapTotal",
        "heapUsed",
        "external",
        "arrayBuffers",
      ] as const) {
        if (current[key] > peak[key]) peak = { ...peak, [key]: current[key] };
      }
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
  while (traversalOffset < source.length) {
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
    traversalOffset = measured.view.slice.nextOffset ?? source.length;
  }
  eventLoop.disable();
  const afterMemory = process.memoryUsage();
  const cpu = process.cpuUsage(beforeCpu);
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
      traversalSourceBytes <= source.length + traversalPages * 3,
    reassemblyMatches: reassemblySha256 === sha(source),
    projectionDoesNotDuplicatePage:
      !smallPage.projectionContainsPage && !largePage.projectionContainsPage,
  };
  const commit = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    cwd: path.resolve(import.meta.dir, "../../.."),
  })
    .stdout.toString()
    .trim();
  const repoRoot = path.resolve(import.meta.dir, "../../..");
  const status = Bun.spawnSync(["git", "status", "--porcelain=v1"], {
    cwd: repoRoot,
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
    corpus: { ...manifest, manifestHash },
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
    memory: { before: beforeMemory, peak, after: afterMemory },
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
      smallSourceBytes: small.length,
      largeSourceBytes: source.length,
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
  if (Object.values(invariant).some((value) => !value)) process.exitCode = 1;
}

await main();
