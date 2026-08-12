/**
 * Regression tests for check-stories `--limit` and `--settle` CLI validation
 * (#18628). Confirms malformed values fail at the parser and process boundary
 * before Playwright launches or stories are silently mis-filtered.
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTLE_MS,
  parseArgs,
  requireNonNegativeSafeInteger,
  requirePositiveSafeInteger,
} from "../stories/check-stories.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const runner = join(here, "../stories/check-stories.mjs");

describe("check-stories --limit / --settle validation (#18628)", () => {
  it("accepts omitted and valid limit/settle values", () => {
    expect(parseArgs([])).toEqual({
      base: "http://localhost:6006",
      limit: 0,
      filter: "",
      globals: "",
      idsFile: "",
      settle: DEFAULT_SETTLE_MS,
    });
    expect(parseArgs(["--limit", "1"]).limit).toBe(1);
    expect(parseArgs(["--limit", "42"]).limit).toBe(42);
    expect(parseArgs(["--settle", "0"]).settle).toBe(0);
    expect(parseArgs(["--settle", "250"]).settle).toBe(250);
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

  it.each(["-1", "1.5", "1junk", "NaN", "Infinity", "", "01", "00"])(
    "rejects invalid settle %j",
    (value) => {
      expect(() => parseArgs(["--settle", value])).toThrow(
        "--settle must be a non-negative",
      );
    },
  );

  it("rejects a missing settle value", () => {
    expect(() => parseArgs(["--settle"])).toThrow(
      "--settle requires a non-negative integer (received no value)",
    );
  });

  it("validators match CLI error text", () => {
    expect(() => requirePositiveSafeInteger("-1", "--limit")).toThrow(
      "--limit must be a positive integer",
    );
    expect(() => requireNonNegativeSafeInteger("1junk", "--settle")).toThrow(
      "--settle must be a non-negative integer",
    );
  });

  it("fails at the real CLI boundary for --limit -1 before browser work", () => {
    const result = spawnSync(
      process.execPath,
      [runner, "--limit", "-1"],
      { encoding: "utf8" },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "check-stories: --limit must be a positive integer",
    );
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/Checking \d+ stories/);
  });

  it("fails at the real CLI boundary for --settle 1junk before browser work", () => {
    const result = spawnSync(
      process.execPath,
      [runner, "--settle", "1junk"],
      { encoding: "utf8" },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "check-stories: --settle must be a non-negative integer",
    );
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/Checking \d+ stories/);
  });
});
