/**
 * Verifies the Story Gate CLI rejects worker counts that would execute no
 * stories, using both the pure parser and the real process boundary.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "./run-story-gate.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const runner = join(here, "run-story-gate.mjs");
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Story Gate CLI arguments", () => {
  it("preserves the default and accepts positive integer concurrency", () => {
    expect(parseArgs([]).concurrency).toBe(6);
    expect(parseArgs(["--concurrency", "1"]).concurrency).toBe(1);
    expect(parseArgs(["--concurrency", "12"]).concurrency).toBe(12);
  });

  it.each(["0", "-1", "1.5", "NaN", "Infinity", ""])(
    "rejects invalid concurrency %j",
    (value) => {
      expect(() => parseArgs(["--concurrency", value])).toThrow(
        "--concurrency must be a positive integer",
      );
    },
  );

  it("rejects a missing concurrency value", () => {
    expect(() => parseArgs(["--concurrency"])).toThrow(
      "--concurrency must be a positive integer (received no value)",
    );
  });

  it("fails at the real CLI boundary before creating artifacts", () => {
    const directory = mkdtempSync(join(tmpdir(), "eliza-story-gate-args-"));
    temporaryDirectories.push(directory);
    const output = join(directory, "output");

    const result = spawnSync(
      process.execPath,
      [runner, "--out", output, "--concurrency", "0"],
      { encoding: "utf8" },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "story-gate: --concurrency must be a positive integer",
    );
    expect(existsSync(output)).toBe(false);
  });
});
