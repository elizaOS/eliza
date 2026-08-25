#!/usr/bin/env bun
/** Runs each progressive-content benchmark repetition in a fresh child process and atomically publishes its report. */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildProgressiveContentBenchmarkReport,
  PROGRESSIVE_CONTENT_BENCHMARK_REPETITIONS,
  PROGRESSIVE_CONTENT_BENCHMARK_SOURCE_BYTES,
  runProgressiveContentBenchmarkProcessSample,
} from "../core/src/testing/progressive-content-benchmark.ts";

export const PROGRESSIVE_CONTENT_BENCHMARK_FACTORY_SCHEMA_VERSION =
  "elizaos.progressive-content.benchmark-factory.v1";

const THIS_FILE = fileURLToPath(import.meta.url);

export function parseProgressiveContentBenchmarkArgs(argv) {
  const options = {};
  for (const arg of argv) {
    if (arg.startsWith("--factory-module="))
      options.factoryModule = arg.slice(17);
    else if (arg.startsWith("--out=")) options.out = arg.slice(6);
    else if (arg.startsWith("--commit=")) options.commit = arg.slice(9);
    else if (arg.startsWith("--worker-out=")) options.workerOut = arg.slice(13);
    else if (arg.startsWith("--source-bytes="))
      options.sourceBytes = Number(arg.slice(15));
    else if (arg.startsWith("--repetition="))
      options.repetition = Number(arg.slice(13));
    else throw new Error(`unsupported benchmark argument: ${arg}`);
  }
  for (const key of ["factoryModule", "out", "commit"]) {
    if (!options[key] && !(key === "out" && options.workerOut))
      throw new Error(
        `--${key.replace(/[A-Z]/g, (value) => `-${value.toLowerCase()}`)} is required`,
      );
  }
  if (!/^[0-9a-f]{40}$/u.test(options.commit))
    throw new Error("--commit must be an exact lowercase Git SHA");
  const worker = options.workerOut !== undefined;
  if (
    worker &&
    (!Number.isSafeInteger(options.sourceBytes) ||
      options.sourceBytes <= 0 ||
      !Number.isSafeInteger(options.repetition) ||
      options.repetition <= 0)
  )
    throw new Error(
      "benchmark workers require positive source-bytes and repetition",
    );
  if (
    !worker &&
    (options.sourceBytes !== undefined || options.repetition !== undefined)
  )
    throw new Error("source-bytes and repetition are worker-only arguments");
  return { ...options, worker };
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateProgressiveContentBenchmarkFactory(value) {
  if (
    !plainObject(value) ||
    value.schemaVersion !==
      PROGRESSIVE_CONTENT_BENCHMARK_FACTORY_SCHEMA_VERSION ||
    value.production !== true ||
    typeof value.adapterId !== "string" ||
    !value.adapterId ||
    /(?:fixture|mock|stub|test)/iu.test(value.adapterId) ||
    typeof value.productionMethod !== "string" ||
    !value.productionMethod ||
    /(?:fixture|mock|stub|test)/iu.test(value.productionMethod) ||
    typeof value.create !== "function" ||
    typeof value.measureResources !== "function"
  )
    throw new TypeError(
      "benchmark factory must declare a production adapter, method, create function, and complete resource sampler",
    );
  return value;
}

async function readPrivateModule(file) {
  const handle = await fs.open(
    file,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o022) !== 0)
      throw new Error("benchmark factory must be a non-writable regular file");
  } finally {
    await handle.close();
  }
}

async function loadFactory(file) {
  const resolved = path.resolve(file);
  await readPrivateModule(resolved);
  const imported = await import(pathToFileURL(resolved).href);
  return validateProgressiveContentBenchmarkFactory(
    imported.default ?? imported,
  );
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

async function runWorker(options) {
  const factory = await loadFactory(options.factoryModule);
  const sample = await runProgressiveContentBenchmarkProcessSample({
    sourceBytes: options.sourceBytes,
    repetition: options.repetition,
    processId: process.pid,
    freshProcess: true,
    createTarget: async () => {
      const target = await factory.create({
        sourceBytes: options.sourceBytes,
        repetition: options.repetition,
      });
      if (
        !plainObject(target) ||
        target.family === undefined ||
        target.read === undefined
      )
        throw new TypeError("benchmark factory returned an invalid target");
      return target;
    },
    measureResources: (target) => factory.measureResources({ target }),
  });
  const bytes = Buffer.from(`${JSON.stringify(sample)}\n`);
  await atomicPrivateWrite(options.workerOut, bytes);
  return { outputSha256: createHash("sha256").update(bytes).digest("hex") };
}

async function spawnWorker(options, sourceBytes, repetition, output) {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        THIS_FILE,
        `--factory-module=${path.resolve(options.factoryModule)}`,
        `--worker-out=${output}`,
        `--commit=${options.commit}`,
        `--source-bytes=${sourceBytes}`,
        `--repetition=${repetition}`,
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

/** Execute the required 15-worker matrix and publish one run-bound benchmark artifact. */
export async function runProgressiveContentBenchmark(options) {
  await loadFactory(options.factoryModule);
  const temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "eliza-progressive-benchmark-"),
  );
  await fs.chmod(temporaryRoot, 0o700);
  const samples = [];
  try {
    for (const sourceBytes of PROGRESSIVE_CONTENT_BENCHMARK_SOURCE_BYTES) {
      for (
        let repetition = 1;
        repetition <= PROGRESSIVE_CONTENT_BENCHMARK_REPETITIONS;
        repetition += 1
      ) {
        const output = path.join(
          temporaryRoot,
          `${sourceBytes}-${repetition}.json`,
        );
        const childPid = await spawnWorker(
          options,
          sourceBytes,
          repetition,
          output,
        );
        const sample = await readWorkerSample(output);
        if (sample.processId !== childPid)
          throw new Error(
            `benchmark worker PID mismatch: expected ${childPid}, received ${sample.processId}`,
          );
        samples.push(sample);
      }
    }
    const report = buildProgressiveContentBenchmarkReport({ samples });
    const result = {
      ...report,
      commit: options.commit,
      environment: {
        runtime: "bun",
        runtimeVersion: process.versions.bun ?? process.version,
        platform: process.platform,
        architecture: process.arch,
        cpu: os.cpus()[0]?.model ?? "unknown",
        logicalCpuCount: os.cpus().length,
        totalMemoryBytes: os.totalmem(),
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
