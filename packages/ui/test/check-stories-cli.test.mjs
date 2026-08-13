/**
 * Exercises the headless story checker's numeric CLI boundary in real Node
 * processes, proving malformed bounds fail before file, network, or browser work.
 */

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const checker = resolve(here, "../stories/check-stories.mjs");

function run(...args) {
  return spawnSync(process.execPath, [checker, ...args], {
    encoding: "utf8",
    timeout: 10_000,
  });
}

describe("check-stories numeric CLI validation (#18934)", () => {
  it.each([
    "",
    "0",
    "-1",
    "+1",
    "1.5",
    "1junk",
    "NaN",
    "Infinity",
    "01",
    "9007199254740992",
  ])("rejects invalid --limit %j before external work", (value) => {
    const result = run("--limit", value, "--ids-file", "/does/not/exist");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--limit must be an integer between 1");
    expect(result.stderr).not.toContain("ENOENT");
  });

  it.each([
    "",
    "-1",
    "+1",
    "1.5",
    "1junk",
    "NaN",
    "Infinity",
    "01",
    "2147483648",
    "9007199254740992",
  ])("rejects invalid --settle %j before external work", (value) => {
    const result = run("--settle", value, "--ids-file", "/does/not/exist");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "--settle must be an integer between 0 and 2147483647",
    );
    expect(result.stderr).not.toContain("ENOENT");
  });

  it.each(["--limit", "--settle"])(
    "rejects a missing value for %s before external work",
    (flag) => {
      const result = run(flag);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`${flag} must be an integer between`);
      expect(result.stderr).not.toContain("fetch failed");
    },
  );

  it("rejects an adjacent flag as a missing numeric value", () => {
    const result = run("--limit", "--settle", "0");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--limit must be an integer between 1");
    expect(result.stderr).not.toContain("fetch failed");
  });

  it.each([
    ["omitted defaults", [], { limit: 0, settle: 600 }],
    [
      "--limit 7 with --settle 0",
      ["--limit", "7", "--settle", "0"],
      { limit: 7, settle: 0 },
    ],
    [
      "the maximum safe --limit",
      ["--limit", "9007199254740991"],
      { limit: 9007199254740991, settle: 600 },
    ],
    [
      "the maximum Node timer --settle",
      ["--settle", "2147483647"],
      { limit: 0, settle: 2147483647 },
    ],
  ])("accepts %s", (_label, args, expected) => {
    const result = run(...args, "--print-options");

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(expected);
    expect(result.stderr).toBe("");
  });
});
