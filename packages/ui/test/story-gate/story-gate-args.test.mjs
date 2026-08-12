/**
 * Verifies Story Gate CLI argument parsing and its real process boundary.
 * Parser cases are deterministic; the subprocess case proves invalid input
 * fails before browser startup or output artifact creation.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseArgs } from "./run-story-gate.mjs";

const cliPath = fileURLToPath(new URL("./run-story-gate.mjs", import.meta.url));

describe("Story Gate --concurrency parsing", () => {
  it("preserves the default and accepts positive integers", () => {
    expect(parseArgs([]).concurrency).toBe(6);
    expect(parseArgs(["--concurrency", "1"]).concurrency).toBe(1);
    expect(parseArgs(["--concurrency", "12"]).concurrency).toBe(12);
  });

  it.each([
    ["zero", "0"],
    ["negative", "-1"],
    ["fractional", "1.5"],
    ["non-numeric", "many"],
    ["missing", undefined],
  ])("rejects a %s value", (_label, value) => {
    const argv =
      value === undefined ? ["--concurrency"] : ["--concurrency", value];
    expect(() => parseArgs(argv)).toThrow(
      "story-gate: --concurrency must be a positive integer",
    );
  });

  it("fails at the real CLI boundary without creating output", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "eliza-story-gate-args-"));
    const outDir = join(sandbox, "output");
    try {
      const result = spawnSync(
        process.execPath,
        [cliPath, "--out", outDir, "--concurrency", "0"],
        { encoding: "utf8" },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "story-gate: --concurrency must be a positive integer",
      );
      expect(existsSync(outDir)).toBe(false);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
