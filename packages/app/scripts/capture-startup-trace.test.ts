/**
 * Unit and CLI-boundary tests for the startup-trace harness argument parser.
 * The harness is deterministic here: invalid flags must fail closed before
 * Chromium launches, so subprocess cases never need a renderer or browser.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_TIMER_DELAY_MS,
  parseArgs,
  parsePositiveInt,
} from "./capture-startup-trace.mjs";

// Resolve the CLI relative to this test file (a sibling .mjs), not
// process.cwd(): the client test lane runs vitest from packages/app, so a
// cwd-relative "packages/app/..." path doubles into
// packages/app/packages/app/... and the spawned Node can't find the module.
const SCRIPT_PATH = path.join(import.meta.dirname, "capture-startup-trace.mjs");

describe("parsePositiveInt", () => {
  it("accepts positive decimal integers", () => {
    expect(parsePositiveInt("1", "--runs")).toBe(1);
    expect(parsePositiveInt("42", "--runs")).toBe(42);
    expect(parsePositiveInt("60000", "--timeout")).toBe(60_000);
  });

  it.each([
    undefined,
    "",
    "junk",
    "10junk",
    "0",
    "-1",
    "1.5",
    "1e3",
    "+2",
    " 3",
    "--url",
  ] as Array<string | undefined>)(
    "rejects invalid input %j at the boundary",
    (raw) => {
      expect(() => parsePositiveInt(raw, "--runs")).toThrow(/--runs/);
    },
  );

  it("rejects values above an explicit max", () => {
    expect(() =>
      parsePositiveInt(String(MAX_TIMER_DELAY_MS + 1), "--timeout", {
        max: MAX_TIMER_DELAY_MS,
      }),
    ).toThrow(/--timeout/);
    expect(
      parsePositiveInt(String(MAX_TIMER_DELAY_MS), "--timeout", {
        max: MAX_TIMER_DELAY_MS,
      }),
    ).toBe(MAX_TIMER_DELAY_MS);
  });
});

describe("parseArgs --runs / --timeout", () => {
  it("keeps defaults when flags are omitted", () => {
    const args = parseArgs(["node", "capture-startup-trace.mjs"]);
    expect(args.runs).toBe(1);
    expect(args.timeout).toBe(60_000);
  });

  it("records valid overrides", () => {
    const args = parseArgs([
      "node",
      "capture-startup-trace.mjs",
      "--runs",
      "3",
      "--timeout",
      "5000",
      "--url",
      "http://127.0.0.1:2138",
    ]);
    expect(args.runs).toBe(3);
    expect(args.timeout).toBe(5000);
    expect(args.url).toBe("http://127.0.0.1:2138");
  });

  it("fails closed when --runs is missing or malformed", () => {
    expect(() =>
      parseArgs(["node", "capture-startup-trace.mjs", "--runs"]),
    ).toThrow(/--runs/);
    expect(() =>
      parseArgs(["node", "capture-startup-trace.mjs", "--runs", "junk"]),
    ).toThrow(/junk/);
    expect(() =>
      parseArgs(["node", "capture-startup-trace.mjs", "--runs", "0"]),
    ).toThrow(/--runs/);
    expect(() =>
      parseArgs(["node", "capture-startup-trace.mjs", "--runs", "-3"]),
    ).toThrow(/--runs/);
    expect(() =>
      parseArgs([
        "node",
        "capture-startup-trace.mjs",
        "--runs",
        "--url",
        "http://example",
      ]),
    ).toThrow(/--runs/);
  });

  it("fails closed when --timeout is missing or malformed", () => {
    expect(() =>
      parseArgs(["node", "capture-startup-trace.mjs", "--timeout"]),
    ).toThrow(/--timeout/);
    expect(() =>
      parseArgs(["node", "capture-startup-trace.mjs", "--timeout", "10junk"]),
    ).toThrow(/10junk/);
    expect(() =>
      parseArgs(["node", "capture-startup-trace.mjs", "--timeout", "0"]),
    ).toThrow(/--timeout/);
    expect(() =>
      parseArgs([
        "node",
        "capture-startup-trace.mjs",
        "--timeout",
        String(MAX_TIMER_DELAY_MS + 1),
      ]),
    ).toThrow(/--timeout/);
  });
});

describe("CLI --runs / --timeout fail-closed", () => {
  function runCli(extraArgs: string[]) {
    return spawnSync(process.execPath, [SCRIPT_PATH, ...extraArgs], {
      encoding: "utf8",
    });
  }

  it("rejects malformed and missing values before launching a capture", () => {
    for (const args of [
      ["--runs", "junk"],
      ["--runs", "10junk"],
      ["--runs", "0"],
      ["--runs", "-3"],
      ["--runs"],
      ["--runs", "--url", "http://127.0.0.1:1"],
      ["--timeout", "junk"],
      ["--timeout", "10junk"],
      ["--timeout", "0"],
      ["--timeout"],
      ["--timeout", String(MAX_TIMER_DELAY_MS + 1)],
    ]) {
      const result = runCli(args);
      expect(result.status, args.join(" ")).not.toBe(0);
      expect(result.stderr, args.join(" ")).toMatch(/startup-trace/i);
      // Must not reach the capture banner that prints after successful parse.
      expect(result.stdout, args.join(" ")).not.toMatch(
        /Capturing startup trace:/,
      );
    }
  });
});
