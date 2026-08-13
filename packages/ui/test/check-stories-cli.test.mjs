/**
 * Real-process coverage for the story checker numeric CLI boundary, proving
 * malformed bounds fail before fetch or Playwright work begins.
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { integerArg } from "../stories/check-stories-cli.mjs";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(packageRoot, "stories", "check-stories.mjs");

function runCli(args) {
  return spawnSync(
    process.execPath,
    [script, "--base", "http://127.0.0.1:1", ...args],
    {
      encoding: "utf8",
      timeout: 10_000,
    },
  );
}

describe("check-stories numeric CLI boundary", () => {
  it("preserves defaults, a positive limit, and an explicit zero settle", () => {
    expect(integerArg([], "--limit", 0, 1)).toBe(0);
    expect(integerArg([], "--settle", 600, 0)).toBe(600);
    expect(integerArg(["--limit", "42"], "--limit", 0, 1)).toBe(42);
    expect(integerArg(["--settle", "0"], "--settle", 600, 0)).toBe(0);
  });

  it.each([
    ["--limit", "0"],
    ["--limit", "-1"],
    ["--limit", "1.5"],
    ["--limit", "1junk"],
    ["--limit", "9007199254740992"],
    ["--settle", "-1"],
    ["--settle", "1.5"],
    ["--settle", "600junk"],
    ["--settle", "9007199254740992"],
  ])("rejects %s %j before fetch or Playwright work", (flag, value) => {
    const result = runCli([flag, value]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(flag);
    expect(result.stderr).toContain("safe integer");
    expect(result.stderr).not.toContain("fetch failed");
    expect(result.stdout).not.toContain("Checking ");
  });

  it.each(["--limit", "--settle"])("rejects a missing %s value", (flag) => {
    const result = runCli([flag]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(flag);
    expect(result.stderr).toContain("received undefined");
    expect(result.stderr).not.toContain("fetch failed");
  });

  it("accepts a positive limit and preserves an explicit zero settle", () => {
    const result = runCli(["--limit", "1", "--settle", "0"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("fetch failed");
    expect(result.stderr).not.toContain("safe integer");
  });

  it("keeps omitted limit and settle defaults", () => {
    const result = runCli([]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("fetch failed");
    expect(result.stderr).not.toContain("safe integer");
  });
});
