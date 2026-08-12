/**
 * Regression tests for Story Gate `--limit` and `--shard` CLI validation
 * (#18588). Confirms malformed values fail at the parser and process boundary
 * before filters silently drop stories or produce empty selections.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseArgs,
  requirePositiveSafeInteger,
  requireShardSpec,
} from "./run-story-gate.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const runner = join(here, "run-story-gate.mjs");
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Story Gate --limit / --shard validation (#18588)", () => {
  it("accepts valid limit and shard values", () => {
    expect(parseArgs([]).limit).toBeNull();
    expect(parseArgs([]).shard).toBeNull();
    expect(parseArgs(["--limit", "1"]).limit).toBe(1);
    expect(parseArgs(["--limit", "42"]).limit).toBe(42);
    expect(parseArgs(["--shard", "1/4"]).shard).toBe("1/4");
    expect(parseArgs(["--shard", "3/3"]).shard).toBe("3/3");
  });

  it.each(["0", "-1", "1.5", "1junk", "NaN", "Infinity", "", "01"])(
    "rejects invalid limit %j",
    (value) => {
      expect(() => parseArgs(["--limit", value])).toThrow(
        "--limit must be a positive integer",
      );
    },
  );

  it("rejects a missing limit value", () => {
    expect(() => parseArgs(["--limit"])).toThrow(
      "--limit requires a positive integer (received no value)",
    );
  });

  it.each([
    "0/1",
    "1/0",
    "-1/2",
    "1/-2",
    "1.5/2",
    "1junk/2",
    "1/2junk",
    "1",
    "1/",
    "/2",
    "abc",
    "2/1",
    "",
  ])("rejects invalid shard %j", (value) => {
    expect(() => parseArgs(["--shard", value])).toThrow(/--shard/);
  });

  it("rejects a missing shard value", () => {
    expect(() => parseArgs(["--shard"])).toThrow(
      "--shard requires N/M with positive integers (received no value)",
    );
  });

  it("requirePositiveSafeInteger and requireShardSpec match CLI errors", () => {
    expect(() => requirePositiveSafeInteger("-1", "--limit")).toThrow(
      "--limit must be a positive integer",
    );
    expect(() => requireShardSpec("1junk/2")).toThrow(
      "--shard must be N/M with positive integers",
    );
  });

  it("fails at the real CLI boundary for --limit -1 before creating artifacts", () => {
    const directory = mkdtempSync(join(tmpdir(), "eliza-story-gate-limit-"));
    temporaryDirectories.push(directory);
    const output = join(directory, "output");

    const result = spawnSync(
      process.execPath,
      [runner, "--out", output, "--limit", "-1"],
      { encoding: "utf8" },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "story-gate: --limit must be a positive integer",
    );
    expect(existsSync(output)).toBe(false);
  });

  it("fails at the real CLI boundary for --shard 1junk/2 before creating artifacts", () => {
    const directory = mkdtempSync(join(tmpdir(), "eliza-story-gate-shard-"));
    temporaryDirectories.push(directory);
    const output = join(directory, "output");

    const result = spawnSync(
      process.execPath,
      [runner, "--out", output, "--shard", "1junk/2"],
      { encoding: "utf8" },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "story-gate: --shard must be N/M with positive integers",
    );
    expect(existsSync(output)).toBe(false);
  });
});
