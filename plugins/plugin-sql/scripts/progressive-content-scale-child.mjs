#!/usr/bin/env bun
/** Measures one SQL progressive-content object in a fresh process without source-sized buffers. */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { createProgressiveSqlTargetFactory } from "../src/testing/progressive-content-sql-targets.ts";

const PAGE_BYTES = 64 * 1024;
const FAMILIES = new Set(["document", "memory", "email"]);

function parseArgs(argv) {
  const options = { warmReads: 8 };
  for (const argument of argv) {
    if (argument.startsWith("--family=")) options.family = argument.slice(9);
    else if (argument.startsWith("--bytes="))
      options.bytes = Number(argument.slice(8));
    else if (argument.startsWith("--warm-reads="))
      options.warmReads = Number(argument.slice(13));
    else throw new Error(`unsupported argument: ${argument}`);
  }
  if (!FAMILIES.has(options.family)) throw new Error("--family is required");
  if (!Number.isSafeInteger(options.bytes) || options.bytes <= 0)
    throw new Error("--bytes must be a positive safe integer");
  if (!Number.isSafeInteger(options.warmReads) || options.warmReads <= 0)
    throw new Error("--warm-reads must be a positive safe integer");
  return options;
}

function memorySample() {
  const usage = process.memoryUsage();
  return {
    rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed,
    externalBytes: usage.external,
    arrayBuffersBytes: usage.arrayBuffers,
  };
}

function maxMemory(left, right) {
  return {
    rssBytes: Math.max(left.rssBytes, right.rssBytes),
    heapUsedBytes: Math.max(left.heapUsedBytes, right.heapUsedBytes),
    externalBytes: Math.max(left.externalBytes, right.externalBytes),
    arrayBuffersBytes: Math.max(
      left.arrayBuffersBytes,
      right.arrayBuffersBytes,
    ),
  };
}

function memoryDelta(after, before) {
  return {
    rssBytes: after.rssBytes - before.rssBytes,
    heapUsedBytes: after.heapUsedBytes - before.heapUsedBytes,
    externalBytes: after.externalBytes - before.externalBytes,
    arrayBuffersBytes: after.arrayBuffersBytes - before.arrayBuffersBytes,
  };
}

async function storageSample(root) {
  let databaseBytes = 0;
  let walBytes = 0;
  const visit = async (directory) => {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) {
        const bytes = (await fs.stat(file)).size;
        databaseBytes += bytes;
        if (file.includes(`${path.sep}pg_wal${path.sep}`)) walBytes += bytes;
      }
    }
  };
  await visit(root);
  return { databaseBytes, walBytes };
}

async function computeSourceSha256(byteLength) {
  const digest = createHash("sha256");
  for (let offset = 0; offset < byteLength; offset += PAGE_BYTES) {
    digest.update(
      Buffer.alloc(Math.min(PAGE_BYTES, byteLength - offset), 0x61),
    );
  }
  return digest.digest("hex");
}

async function run(options) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), `progressive-sql-scale-${options.family}-`),
  );
  const dataRoot = path.join(root, "pglite");
  const baseline = memorySample();
  let peak = baseline;
  let phase = "ingestion";
  const phasePeaks = { ingestion: baseline };
  const sampler = setInterval(() => {
    const sample = memorySample();
    peak = maxMemory(peak, sample);
    phasePeaks[phase] = maxMemory(phasePeaks[phase] ?? sample, sample);
  }, 5);
  sampler.unref?.();
  let target;
  const startedAt = performance.now();
  try {
    const sourceSha256 = await computeSourceSha256(options.bytes);
    const factory = await createProgressiveSqlTargetFactory({
      dataRoot,
      family: options.family,
    });
    target = await factory.create({
      object: {
        id: `scale:${options.family}:${options.bytes}`,
        family: options.family,
        byteLength: options.bytes,
        sourceSha256,
        sourceRevision: `source:${sourceSha256}`,
        format: "single-line",
        authorizationScope: `room:${options.family}:scale`,
        canaries: [],
      },
      source: {
        byteLength: options.bytes,
        async read(offset, maxBytes = PAGE_BYTES) {
          return Buffer.alloc(
            Math.min(maxBytes, Math.max(0, options.bytes - offset)),
            0x61,
          );
        },
      },
    });
    const afterIngestion = memorySample();
    phasePeaks.ingestion = maxMemory(phasePeaks.ingestion, afterIngestion);
    const storageAfterIngestion = await storageSample(dataRoot);
    const offset = Math.max(0, options.bytes - PAGE_BYTES);
    phase = "coldRead";
    const coldStartedAt = performance.now();
    const cold = await target.read({
      access: "authorized",
      offset,
      limit: PAGE_BYTES,
      expectedRevision: target.object.revision,
    });
    const coldReadMs = performance.now() - coldStartedAt;
    const afterColdRead = memorySample();
    phasePeaks.coldRead = maxMemory(
      phasePeaks.coldRead ?? afterColdRead,
      afterColdRead,
    );
    phase = "warmRead";
    const warmStartedAt = performance.now();
    for (let index = 0; index < options.warmReads; index += 1) {
      await target.read({
        access: "authorized",
        offset,
        limit: PAGE_BYTES,
        expectedRevision: target.object.revision,
      });
    }
    const warmReadMs = performance.now() - warmStartedAt;
    const afterWarmRead = memorySample();
    phasePeaks.warmRead = maxMemory(
      phasePeaks.warmRead ?? afterWarmRead,
      afterWarmRead,
    );
    phase = "restart";
    const beforeRestart = await target.inspect();
    await target.restart();
    const afterRestart = await target.inspect();
    const restarted = await target.read({
      access: "authorized",
      offset,
      limit: PAGE_BYTES,
      expectedRevision: target.object.revision,
    });
    const afterRestartRead = memorySample();
    phasePeaks.restart = maxMemory(
      phasePeaks.restart ?? afterRestartRead,
      afterRestartRead,
    );
    const storageBeforeCleanup = await storageSample(dataRoot);
    phase = "cleanup";
    await target.cleanup();
    target = undefined;
    const afterCleanup = memorySample();
    phasePeaks.cleanup = maxMemory(
      phasePeaks.cleanup ?? afterCleanup,
      afterCleanup,
    );
    const storageAfterCleanup = await storageSample(dataRoot);
    clearInterval(sampler);
    peak = maxMemory(peak, memorySample());
    return {
      schemaVersion: "elizaos.progressive-content.sql-scale-child.v1",
      backend: "pglite",
      family: options.family,
      sourceBytes: options.bytes,
      pageBytes: PAGE_BYTES,
      warmReads: options.warmReads,
      durationMs: performance.now() - startedAt,
      coldReadMs,
      warmReadMs,
      baseline,
      afterIngestion,
      afterColdRead,
      afterWarmRead,
      afterRestartRead,
      afterCleanup,
      deltas: {
        ingestion: memoryDelta(afterIngestion, baseline),
        coldRead: memoryDelta(afterColdRead, afterIngestion),
        warmRead: memoryDelta(afterWarmRead, afterColdRead),
        restart: memoryDelta(afterRestartRead, afterWarmRead),
        cleanup: memoryDelta(afterCleanup, afterRestartRead),
      },
      peak,
      phasePeaks,
      storageAfterIngestion,
      storageBeforeCleanup,
      storageAfterCleanup,
      databaseRows: afterRestart.databaseRows,
      restartVerified:
        beforeRestart.resolverGeneration !== afterRestart.resolverGeneration &&
        cold.view.slice.sliceSha256 === restarted.view.slice.sliceSha256,
      cleanupVerified: storageAfterCleanup.databaseBytes === 0,
    };
  } finally {
    clearInterval(sampler);
    await target?.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    process.stdout.write(
      `${JSON.stringify(await run(parseArgs(process.argv.slice(2))))}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.stack : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

export { parseArgs, run as runProgressiveSqlScaleChild };
