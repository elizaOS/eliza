/**
 * Focused coverage for prune-turbo-cache --max-gb validation: parser contract
 * plus real CLI boundary rejections before any cache eviction.
 */
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "../lib/spawn-sync-captured.mjs";
import {
  DEFAULT_MAX_GB,
  maxBytesFromGb,
  parseArgs,
  parseMaxGb,
  pruneTurboCache,
  resolveCacheDir,
} from "../prune-turbo-cache.mjs";

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "prune-turbo-cache.mjs",
);

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
    },
    timeout: 5_000,
  });
}

describe("parseMaxGb", () => {
  test("accepts positive finite values including fractions", () => {
    expect(parseMaxGb("20")).toBe(20);
    expect(parseMaxGb("1.5")).toBe(1.5);
    expect(parseMaxGb(" 2 ")).toBe(2);
    expect(parseMaxGb(String(DEFAULT_MAX_GB))).toBe(DEFAULT_MAX_GB);
  });

  test("rejects empty, non-positive, non-finite, and non-numeric forms", () => {
    const bad = [
      "",
      " ",
      "0",
      "-1",
      "-0.1",
      "abc",
      "NaN",
      "Infinity",
      "-Infinity",
      "20gb",
      "1.2.3",
    ];
    for (const value of bad) {
      expect(() => parseMaxGb(value, "--max-gb")).toThrow(
        /must be a positive finite number of gigabytes/,
      );
    }
  });
});

describe("maxBytesFromGb", () => {
  test("rounds valid fractional gigabytes to a positive safe byte cap", () => {
    expect(maxBytesFromGb(1.5)).toBe(1_610_612_736);
    expect(maxBytesFromGb(1e-9)).toBe(1);
  });

  test("rejects underflow, overflow, and unsafe byte conversions", () => {
    for (const value of [1e-20, 8_388_608, 1e300]) {
      expect(() => maxBytesFromGb(value)).toThrow(
        /--max-gb.*positive safe-integer byte cap/,
      );
    }
  });
});

describe("parseArgs", () => {
  test("defaults to 20 GB when --max-gb is omitted", () => {
    const options = parseArgs(["--dry-run"]);
    expect(options.dryRun).toBe(true);
    expect(options.maxGb).toBe(DEFAULT_MAX_GB);
    expect(options.maxBytes).toBe(maxBytesFromGb(DEFAULT_MAX_GB));
  });

  test("accepts a valid --max-gb override", () => {
    const options = parseArgs(["--max-gb=1.5"]);
    expect(options.dryRun).toBe(false);
    expect(options.maxGb).toBe(1.5);
    expect(options.maxBytes).toBe(maxBytesFromGb(1.5));
  });

  test("fails closed on invalid --max-gb overrides", () => {
    for (const arg of [
      "--max-gb=",
      "--max-gb=0",
      "--max-gb=-1",
      "--max-gb=abc",
      "--max-gb=NaN",
      "--max-gb=Infinity",
      "--max-gb=1e-20",
      "--max-gb=8388608",
      "--max-gb=1e300",
    ]) {
      expect(() => parseArgs([arg])).toThrow(
        /must (?:be a positive finite number of gigabytes|convert to a positive safe-integer byte cap)/,
      );
    }
  });
});

describe("resolveCacheDir", () => {
  test("prefers TURBO_CACHE_DIR over the default relative path", () => {
    expect(
      resolveCacheDir({ TURBO_CACHE_DIR: "/tmp/custom-turbo" }, "/repo"),
    ).toBe(path.resolve("/tmp/custom-turbo"));
    expect(resolveCacheDir({}, "/repo")).toBe(
      path.resolve("/repo", ".turbo/cache"),
    );
  });
});

describe("pruneTurboCache", () => {
  test("reports missing cache without throwing", () => {
    const cacheDir = path.join(
      os.tmpdir(),
      `eliza-prune-missing-${process.pid}-${Date.now()}`,
    );
    const result = pruneTurboCache({
      cacheDir,
      maxBytes: maxBytesFromGb(1),
      dryRun: true,
    });
    expect(result.missing).toBe(true);
  });

  test("evicts oldest entries when over the byte cap", () => {
    const cacheDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-prune-turbo-"),
    );
    try {
      const older = path.join(cacheDir, "aaa.tar.zst");
      const newer = path.join(cacheDir, "bbb.tar.zst");
      fs.writeFileSync(older, "x".repeat(100));
      fs.writeFileSync(newer, "y".repeat(100));
      const olderTime = Date.now() - 60_000;
      const newerTime = Date.now();
      fs.utimesSync(older, olderTime / 1000, olderTime / 1000);
      fs.utimesSync(newer, newerTime / 1000, newerTime / 1000);

      const result = pruneTurboCache({
        cacheDir,
        maxBytes: 150,
        dryRun: false,
      });
      expect(result.missing).toBe(false);
      expect(result.evictedCount).toBe(1);
      expect(fs.existsSync(older)).toBe(false);
      expect(fs.existsSync(newer)).toBe(true);
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});

describe("prune-turbo-cache CLI", () => {
  test("exits 0 when the cache directory is missing", () => {
    const missing = path.join(
      os.tmpdir(),
      `eliza-prune-cli-missing-${process.pid}-${Date.now()}`,
    );
    const result = runCli([], { TURBO_CACHE_DIR: missing });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("No cache at");
  });

  test("accepts a valid --max-gb dry-run", () => {
    const missing = path.join(
      os.tmpdir(),
      `eliza-prune-cli-valid-${process.pid}-${Date.now()}`,
    );
    const result = runCli(["--max-gb=1.5", "--dry-run"], {
      TURBO_CACHE_DIR: missing,
    });
    expect(result.status).toBe(0);
  });

  test("rejects invalid --max-gb overrides before pruning", () => {
    const cacheDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-prune-cli-bad-"),
    );
    try {
      const keep = path.join(cacheDir, "keep.tar.zst");
      fs.writeFileSync(keep, "payload");
      for (const arg of [
        "--max-gb=",
        "--max-gb=0",
        "--max-gb=-1",
        "--max-gb=abc",
        "--max-gb=NaN",
        "--max-gb=Infinity",
        "--max-gb=1e-20",
        "--max-gb=8388608",
        "--max-gb=1e300",
      ]) {
        const result = runCli([arg], { TURBO_CACHE_DIR: cacheDir });
        expect(result.status).toBe(2);
        expect(result.stderr).toMatch(
          /must (?:be a positive finite number of gigabytes|convert to a positive safe-integer byte cap)/,
        );
        expect(fs.existsSync(keep)).toBe(true);
      }
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
