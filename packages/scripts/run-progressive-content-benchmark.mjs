#!/usr/bin/env bun
/** Runs the fixed six-family progressive-content benchmark matrix in fresh child processes. */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  buildProgressiveContentBenchmarkReport,
  PROGRESSIVE_CONTENT_BENCHMARK_REPETITIONS,
  PROGRESSIVE_CONTENT_BENCHMARK_SOURCE_BYTES,
  runProgressiveContentBenchmarkProcessSample,
} from "../core/src/testing/progressive-content-benchmark.ts";
import { PROGRESSIVE_CONTENT_TARGET_FAMILIES } from "../core/src/testing/progressive-content-target.ts";
import { verifyProgressiveContentCorpus } from "../corpus-tools/src/progressive-content.ts";
import {
  createProgressiveContentBenchmarkFactory,
  createProgressiveContentProductionTarget,
} from "./lib/progressive-content-production-targets.mjs";

const THIS_FILE = fileURLToPath(import.meta.url);
export const PROGRESSIVE_CONTENT_BENCHMARK_BINARY_POLICY = {
  file: "typed-rejection",
  document: "typed-rejection",
  memory: "typed-rejection",
  email: "typed-rejection",
  attachment: "native-bytes",
  "tool-output": "native-bytes",
};

export const PROGRESSIVE_CONTENT_BENCHMARK_BACKENDS = Object.freeze({
  file: "filesystem",
  document: "postgres",
  memory: "postgres",
  email: "postgres",
  attachment: "content-addressed-media-store",
  "tool-output": "runtime-tool-output-store",
});

function requiredPostgresUrl() {
  const value = process.env.POSTGRES_URL?.trim();
  if (!value) {
    throw new Error(
      "POSTGRES_URL is required for the fixed PostgreSQL benchmark backend",
    );
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("POSTGRES_URL must be a valid PostgreSQL URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("POSTGRES_URL must use the PostgreSQL protocol");
  }
  return value;
}

export function parseProgressiveContentBenchmarkArgs(argv) {
  const options = {};
  for (const arg of argv) {
    if (arg.startsWith("--corpus-root=")) options.corpusRoot = arg.slice(14);
    else if (arg.startsWith("--out=")) options.out = arg.slice(6);
    else if (arg.startsWith("--commit=")) options.commit = arg.slice(9);
    else if (arg.startsWith("--worker-out=")) options.workerOut = arg.slice(13);
    else if (arg.startsWith("--work-root=")) options.workRoot = arg.slice(12);
    else if (arg.startsWith("--family=")) options.family = arg.slice(9);
    else if (arg.startsWith("--source-bytes="))
      options.sourceBytes = Number(arg.slice(15));
    else if (arg.startsWith("--repetition="))
      options.repetition = Number(arg.slice(13));
    else throw new Error(`unsupported benchmark argument: ${arg}`);
  }
  const worker = options.workerOut !== undefined;
  for (const key of [
    "corpusRoot",
    "commit",
    ...(worker ? ["workRoot"] : ["out"]),
  ]) {
    if (!options[key])
      throw new Error(
        `--${key.replace(/[A-Z]/g, (value) => `-${value.toLowerCase()}`)} is required`,
      );
  }
  if (!/^[0-9a-f]{40}$/u.test(options.commit))
    throw new Error("--commit must be an exact lowercase Git SHA");
  if (
    worker &&
    (!PROGRESSIVE_CONTENT_TARGET_FAMILIES.includes(options.family) ||
      !Number.isSafeInteger(options.sourceBytes) ||
      options.sourceBytes <= 0 ||
      !Number.isSafeInteger(options.repetition) ||
      options.repetition <= 0)
  )
    throw new Error(
      "benchmark workers require a supported family and positive source-bytes/repetition",
    );
  if (
    !worker &&
    (options.family !== undefined ||
      options.sourceBytes !== undefined ||
      options.repetition !== undefined ||
      options.workRoot !== undefined)
  )
    throw new Error(
      "family, source-bytes, repetition, and work-root are worker-only arguments",
    );
  return { ...options, worker };
}

async function atomicPrivateWrite(file, bytes) {
  const resolved = path.resolve(file);
  const directory = path.dirname(resolved);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const pending = path.join(
    directory,
    `.${path.basename(resolved)}.${process.pid}.${Date.now()}.pending`,
  );
  const handle = await fs.open(pending, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(pending, resolved);
  await fs.chmod(resolved, 0o600);
}

async function readManifestUnchecked(corpusRoot) {
  const handle = await fs.open(
    path.join(path.resolve(corpusRoot), "manifest.json"),
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1)
      throw new Error("benchmark corpus manifest is not a regular file");
    return JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}

/** Select exactly one text-capable scale object for a family/size coordinate. */
export function selectProgressiveContentBenchmarkObject(
  manifest,
  family,
  sourceBytes,
) {
  const binaryPolicy = PROGRESSIVE_CONTENT_BENCHMARK_BINARY_POLICY[family];
  if (!binaryPolicy) throw new Error(`unsupported benchmark family: ${family}`);
  const matches = manifest.objects.filter(
    (object) =>
      object.family === family &&
      object.byteLength === sourceBytes &&
      (binaryPolicy === "native-bytes" ||
        (object.format !== "binary" && object.format !== "invalid-utf8")),
  );
  if (matches.length !== 1)
    throw new Error(
      `benchmark corpus requires exactly one ${family}:${sourceBytes} native-readable object; found ${matches.length}`,
    );
  return matches[0];
}

async function countFileDescriptors() {
  for (const directory of ["/proc/self/fd", "/dev/fd"]) {
    try {
      return (await fs.readdir(directory)).length;
    } catch {
      // Try the next operating-system-specific descriptor view.
    }
  }
  throw new Error("process file-descriptor inventory is unavailable");
}

async function benchmarkResources(target, authoritativeStore) {
  const memory = process.memoryUsage();
  const snapshot = target
    ? await target.inspect()
    : { ownedBytes: 0, databaseRows: 0, walBytes: 0 };
  const databaseBacked = [
    "document-store",
    "message-store",
    "memory-store",
  ].includes(authoritativeStore);
  return {
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
    fileDescriptors: await countFileDescriptors(),
    databaseBytes: databaseBacked ? snapshot.ownedBytes : 0,
    databaseRows: databaseBacked ? snapshot.databaseRows : 0,
    walBytes: databaseBacked ? snapshot.walBytes : 0,
  };
}

async function runWorker(options) {
  const manifest = await readManifestUnchecked(options.corpusRoot);
  const object = selectProgressiveContentBenchmarkObject(
    manifest,
    options.family,
    options.sourceBytes,
  );
  const backend = PROGRESSIVE_CONTENT_BENCHMARK_BACKENDS[options.family];
  const postgresUrl =
    backend === "postgres" ? requiredPostgresUrl() : undefined;
  const factory = await createProgressiveContentBenchmarkFactory({
    workRoot: options.workRoot,
    family: options.family,
    idNamespace: `${options.family}-${options.sourceBytes}-${options.repetition}-${process.pid}`,
    ...(postgresUrl ? { postgresUrl } : {}),
  });
  const factories = [factory];
  if (factory.family !== options.family)
    throw new Error(`fixed production factory changed for ${options.family}`);
  if (
    backend === "postgres" &&
    !factory.adapterId.startsWith("plugin-sql-postgres-")
  )
    throw new Error(`fixed PostgreSQL backend changed for ${options.family}`);
  if (
    factory.binaryPolicy !==
    PROGRESSIVE_CONTENT_BENCHMARK_BINARY_POLICY[options.family]
  )
    throw new Error(
      `fixed production binary policy changed for ${options.family}`,
    );
  const observed = await runProgressiveContentBenchmarkProcessSample({
    family: factory.family,
    adapterId: factory.adapterId,
    productionMethod: factory.productionMethod,
    sourceBytes: options.sourceBytes,
    repetition: options.repetition,
    processId: process.pid,
    freshProcess: true,
    createTarget: () =>
      createProgressiveContentProductionTarget({
        corpusRoot: options.corpusRoot,
        object,
        factories,
      }),
    measureResources: (target) =>
      benchmarkResources(target, factory.authoritativeStore),
  });
  const sample = { ...observed, backend };
  const bytes = Buffer.from(`${JSON.stringify(sample)}\n`);
  await atomicPrivateWrite(options.workerOut, bytes);
  return { outputSha256: createHash("sha256").update(bytes).digest("hex") };
}

async function spawnWorker(options, coordinate, output, workRoot) {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        THIS_FILE,
        `--corpus-root=${path.resolve(options.corpusRoot)}`,
        `--worker-out=${output}`,
        `--work-root=${workRoot}`,
        `--commit=${options.commit}`,
        `--family=${coordinate.family}`,
        `--source-bytes=${coordinate.sourceBytes}`,
        `--repetition=${coordinate.repetition}`,
      ],
      { stdio: "inherit" },
    );
    child.once("error", reject);
    const childPid = child.pid;
    if (!Number.isSafeInteger(childPid) || childPid <= 0) {
      child.kill();
      reject(new Error("benchmark worker did not receive a process ID"));
      return;
    }
    child.once("exit", (code, signal) =>
      code === 0
        ? resolve(childPid)
        : reject(new Error(`benchmark worker failed (${signal ?? code})`)),
    );
  });
}

async function readWorkerSample(file) {
  const handle = await fs.open(
    file,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0)
      throw new Error("benchmark worker result is not private and regular");
    return JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}

/** Execute the fixed 90-worker matrix and publish one run-bound benchmark artifact. */
export async function runProgressiveContentBenchmark(options) {
  requiredPostgresUrl();
  const manifest = await verifyProgressiveContentCorpus(options.corpusRoot);
  if (manifest.profile !== "scale")
    throw new Error("benchmark requires the verified scale corpus profile");
  for (const family of PROGRESSIVE_CONTENT_TARGET_FAMILIES)
    for (const sourceBytes of PROGRESSIVE_CONTENT_BENCHMARK_SOURCE_BYTES)
      selectProgressiveContentBenchmarkObject(manifest, family, sourceBytes);
  const temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "eliza-progressive-benchmark-"),
  );
  await fs.chmod(temporaryRoot, 0o700);
  const samples = [];
  try {
    for (const family of PROGRESSIVE_CONTENT_TARGET_FAMILIES) {
      for (const sourceBytes of PROGRESSIVE_CONTENT_BENCHMARK_SOURCE_BYTES) {
        for (
          let repetition = 1;
          repetition <= PROGRESSIVE_CONTENT_BENCHMARK_REPETITIONS;
          repetition += 1
        ) {
          const coordinate = { family, sourceBytes, repetition };
          const basename = `${family}-${sourceBytes}-${repetition}`;
          const output = path.join(temporaryRoot, `${basename}.json`);
          const workRoot = path.join(temporaryRoot, `${basename}-work`);
          const childPid = await spawnWorker(
            options,
            coordinate,
            output,
            workRoot,
          );
          const sample = await readWorkerSample(output);
          if (sample.processId !== childPid)
            throw new Error(
              `benchmark worker PID mismatch: expected ${childPid}, received ${sample.processId}`,
            );
          if (
            sample.family !== family ||
            sample.sourceBytes !== sourceBytes ||
            sample.repetition !== repetition ||
            sample.backend !== PROGRESSIVE_CONTENT_BENCHMARK_BACKENDS[family]
          )
            throw new Error(
              `benchmark worker coordinate mismatch for ${basename}`,
            );
          samples.push(sample);
        }
      }
    }
    const report = buildProgressiveContentBenchmarkReport({ samples });
    const result = {
      ...report,
      commit: options.commit,
      corpusManifestSha256: manifest.manifestSha256,
      generatorRevision: manifest.generatorRevision,
      backendPolicy: PROGRESSIVE_CONTENT_BENCHMARK_BACKENDS,
      environment: {
        runtime: "bun",
        runtimeVersion: process.versions.bun ?? process.version,
        platform: process.platform,
        architecture: process.arch,
        cpu: os.cpus()[0]?.model ?? "unknown",
        logicalCpuCount: os.cpus().length,
        totalMemoryBytes: os.totalmem(),
        sqlBackend: "postgres",
      },
    };
    if (!result.evidenceEligible || result.status !== "passed")
      throw new Error(`benchmark matrix failed: ${result.failures.join("; ")}`);
    const bytes = Buffer.from(`${JSON.stringify(result, null, 2)}\n`);
    await atomicPrivateWrite(options.out, bytes);
    return {
      outputSha256: createHash("sha256").update(bytes).digest("hex"),
      report: result,
    };
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    const options = parseProgressiveContentBenchmarkArgs(process.argv.slice(2));
    const result = options.worker
      ? await runWorker(options)
      : await runProgressiveContentBenchmark(options);
    process.stdout.write(
      `${JSON.stringify({ outputSha256: result.outputSha256 })}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error?.stack ?? String(error)}\n`);
    process.exitCode = 1;
  }
}
