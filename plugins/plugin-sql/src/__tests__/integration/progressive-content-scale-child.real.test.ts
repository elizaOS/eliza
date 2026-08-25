/** Runs scale SQL realization and cold/warm reads in a fresh Bun process per object. */

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const SCALE_BYTES = 10 * 1024 * 1024;
const READ_RSS_CEILING_BYTES = 128 * 1024 * 1024;

interface MemorySample {
  readonly rssBytes: number;
  readonly heapUsedBytes: number;
  readonly externalBytes: number;
  readonly arrayBuffersBytes: number;
}

interface ScaleChildReport {
  readonly schemaVersion: "elizaos.progressive-content.sql-scale-child.v1";
  readonly backend: "pglite";
  readonly family: "document" | "memory";
  readonly sourceBytes: number;
  readonly baseline: MemorySample;
  readonly afterIngestion: MemorySample;
  readonly afterColdRead: MemorySample;
  readonly afterWarmRead: MemorySample;
  readonly afterRestartRead: MemorySample;
  readonly afterCleanup: MemorySample;
  readonly peak: MemorySample;
  readonly deltas: {
    readonly ingestion: MemorySample;
    readonly coldRead: MemorySample;
    readonly warmRead: MemorySample;
    readonly restart: MemorySample;
    readonly cleanup: MemorySample;
  };
  readonly storageAfterIngestion: {
    readonly databaseBytes: number;
    readonly walBytes: number;
  };
  readonly storageBeforeCleanup: {
    readonly databaseBytes: number;
    readonly walBytes: number;
  };
  readonly storageAfterCleanup: {
    readonly databaseBytes: number;
    readonly walBytes: number;
  };
  readonly databaseRows: number;
  readonly restartVerified: boolean;
  readonly cleanupVerified: boolean;
}

async function runChild(family: ScaleChildReport["family"]): Promise<ScaleChildReport> {
  const script = path.resolve(
    process.cwd(),
    "plugins/plugin-sql/scripts/progressive-content-scale-child.mjs"
  );
  const { stdout } = await execFileAsync(
    "bun",
    [script, `--family=${family}`, `--bytes=${SCALE_BYTES}`, "--warm-reads=4"],
    {
      cwd: process.cwd(),
      env: process.env,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 120_000,
    }
  );
  const json = stdout
    .trim()
    .split("\n")
    .findLast((line) => line.startsWith("{"));
  if (!json) throw new Error(`scale child omitted its report: ${stdout}`);
  return JSON.parse(json) as ScaleChildReport;
}

describe("progressive SQL scale child", () => {
  it.each(["document", "memory"] as const)(
    "isolates %s ingestion from bounded cold and warm reads",
    async (family) => {
      const report = await runChild(family);
      expect(report).toMatchObject({
        schemaVersion: "elizaos.progressive-content.sql-scale-child.v1",
        backend: "pglite",
        family,
        sourceBytes: SCALE_BYTES,
        restartVerified: true,
        cleanupVerified: true,
      });
      expect(report.databaseRows).toBeGreaterThan(100);
      expect(report.storageAfterIngestion).toMatchObject({
        databaseBytes: expect.any(Number),
        walBytes: expect.any(Number),
      });
      expect(report.storageAfterIngestion.databaseBytes).toBeGreaterThan(0);
      expect(report.storageAfterIngestion.walBytes).toBeGreaterThan(0);
      expect(report.storageBeforeCleanup).toEqual(report.storageAfterIngestion);
      expect(report.storageAfterCleanup).toEqual({
        databaseBytes: 0,
        walBytes: 0,
      });
      expect(Math.max(0, report.deltas.coldRead.rssBytes)).toBeLessThanOrEqual(
        READ_RSS_CEILING_BYTES
      );
      expect(Math.max(0, report.deltas.warmRead.rssBytes)).toBeLessThanOrEqual(
        READ_RSS_CEILING_BYTES
      );
      for (const sample of [
        report.baseline,
        report.afterIngestion,
        report.afterColdRead,
        report.afterWarmRead,
        report.afterRestartRead,
        report.afterCleanup,
        report.peak,
      ]) {
        expect(Object.values(sample).every(Number.isSafeInteger)).toBe(true);
      }
    },
    180_000
  );
});
