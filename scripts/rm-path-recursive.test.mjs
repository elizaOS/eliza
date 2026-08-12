import { describe, expect, it, mock } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  parseArgs,
  removePathRecursive,
  runCli,
} from "./rm-path-recursive.mjs";

describe("rm-path-recursive CLI option parsing", () => {
  it("defaults to standard configuration with target path", () => {
    const opts = parseArgs(["dist"]);
    expect(opts.help).toBe(false);
    expect(opts.dryRun).toBe(false);
    expect(opts.maxRetries).toBe(5);
    expect(opts.retryDelayMs).toBe(50);
    expect(opts.targets).toEqual(["dist"]);
  });

  it("parses --help and -h flags", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
  });

  it("parses --dry-run flag", () => {
    const opts = parseArgs(["--dry-run", "dist"]);
    expect(opts.dryRun).toBe(true);
    expect(opts.targets).toEqual(["dist"]);
  });

  it("parses --max-retries flag with = and separated forms", () => {
    expect(parseArgs(["--max-retries=3", "dist"]).maxRetries).toBe(3);
    expect(parseArgs(["--max-retries", "4", "dist"]).maxRetries).toBe(4);
  });

  it("parses --retry-delay-ms flag with = and separated forms", () => {
    expect(parseArgs(["--retry-delay-ms=100", "dist"]).retryDelayMs).toBe(100);
    expect(parseArgs(["--retry-delay-ms", "200", "dist"]).retryDelayMs).toBe(
      200,
    );
  });

  it("parses multiple positional target paths", () => {
    const opts = parseArgs(["dist", "coverage", "tmp"]);
    expect(opts.targets).toEqual(["dist", "coverage", "tmp"]);
  });

  it("rejects unknown options", () => {
    expect(() => parseArgs(["--invalid", "dist"])).toThrow(
      "Unknown option: --invalid",
    );
  });

  it("rejects missing path argument when not requesting help", () => {
    expect(() => parseArgs([])).toThrow(
      "Missing required path argument. Use --help for usage.",
    );
  });

  it("rejects invalid --max-retries values", () => {
    expect(() => parseArgs(["--max-retries=invalid", "dist"])).toThrow(
      "Invalid --max-retries value: invalid",
    );
    expect(() => parseArgs(["--max-retries", "0", "dist"])).toThrow(
      "--max-retries requires a positive integer value",
    );
  });

  it("rejects invalid --retry-delay-ms values", () => {
    expect(() => parseArgs(["--retry-delay-ms=-5", "dist"])).toThrow(
      "Invalid --retry-delay-ms value: -5",
    );
  });
});

describe("rm-path-recursive execution", () => {
  it("recursively removes a directory with nested contents", async () => {
    const tmpDir = path.resolve(process.cwd(), ".tmp-test-rm-recursive-1");
    const nestedDir = path.join(tmpDir, "nested", "sub");
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(path.join(nestedDir, "file.txt"), "hello world");

    expect(existsSync(path.join(nestedDir, "file.txt"))).toBe(true);

    const res = await removePathRecursive(".tmp-test-rm-recursive-1");
    expect(res.deleted).toBe(true);
    expect(existsSync(tmpDir)).toBe(false);
  });

  it("handles non-existent paths gracefully", async () => {
    const res = await removePathRecursive(".tmp-non-existent-directory-9999");
    expect(res.deleted).toBe(false);
  });

  it("supports --dry-run without deleting files", async () => {
    const tmpDir = path.resolve(process.cwd(), ".tmp-test-rm-dryrun");
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(path.join(tmpDir, "keep.txt"), "data");

    const res = await removePathRecursive(".tmp-test-rm-dryrun", {
      dryRun: true,
    });
    expect(res.dryRun).toBe(true);
    expect(res.deleted).toBe(false);
    expect(existsSync(tmpDir)).toBe(true);

    await removePathRecursive(".tmp-test-rm-dryrun");
  });

  it("retries on retryable filesystem errors before succeeding", async () => {
    const tmpDir = path.resolve(process.cwd(), ".tmp-test-rm-retry");
    mkdirSync(tmpDir, { recursive: true });

    let attempts = 0;
    const mockRmSync = mock((targetPath, opts) => {
      attempts++;
      if (attempts === 1) {
        const err = new Error("Resource busy");
        err.code = "EBUSY";
        throw err;
      }
      return rmSync(targetPath, opts);
    });

    try {
      const res = await removePathRecursive(".tmp-test-rm-retry", {
        maxRetries: 3,
        retryDelayMs: 1,
        rmFn: mockRmSync,
      });
      expect(res.deleted).toBe(true);
      expect(res.attempts).toBe(2);
      expect(mockRmSync).toHaveBeenCalledTimes(2);
    } finally {
      await removePathRecursive(".tmp-test-rm-retry");
    }
  });

  it("rethrows non-retryable filesystem errors", async () => {
    const tmpDir = path.resolve(process.cwd(), ".tmp-test-rm-fatal");
    mkdirSync(tmpDir, { recursive: true });

    const mockRmSync = mock(() => {
      const err = new Error("Permission denied");
      err.code = "EACCES";
      throw err;
    });

    try {
      expect(
        removePathRecursive(".tmp-test-rm-fatal", {
          maxRetries: 3,
          retryDelayMs: 1,
          rmFn: mockRmSync,
        }),
      ).rejects.toThrow("Permission denied");
    } finally {
      await removePathRecursive(".tmp-test-rm-fatal");
    }
  });
});

describe("rm-path-recursive CLI integration", () => {
  it("runCli returns 0 for --help", async () => {
    const code = await runCli(["--help"]);
    expect(code).toBe(0);
  });

  it("runCli removes target directory and returns 0", async () => {
    const tmpDir = path.resolve(process.cwd(), ".tmp-test-cli-run");
    mkdirSync(tmpDir, { recursive: true });

    const code = await runCli([".tmp-test-cli-run"]);
    expect(code).toBe(0);
    expect(existsSync(tmpDir)).toBe(false);
  });

  it("runCli returns 1 on error", async () => {
    const code = await runCli(["--invalid-option"]);
    expect(code).toBe(1);
  });
});
