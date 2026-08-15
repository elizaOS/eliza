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
  const invalidCliCases: Array<[string, string[], RegExp]> = [
    ["--runs junk", ["--runs", "junk"], /^\[startup-trace\] --runs must/m],
    ["--runs 10junk", ["--runs", "10junk"], /^\[startup-trace\] --runs must/m],
    ["--runs 0", ["--runs", "0"], /^\[startup-trace\] --runs must/m],
    ["--runs -3", ["--runs", "-3"], /^\[startup-trace\] --runs must/m],
    ["missing --runs value", ["--runs"], /^\[startup-trace\] --runs requires/m],
    [
      "--runs followed by another option",
      ["--runs", "--url", "http://127.0.0.1:1"],
      /^\[startup-trace\] --runs requires/m,
    ],
    [
      "--timeout junk",
      ["--timeout", "junk"],
      /^\[startup-trace\] --timeout must/m,
    ],
    [
      "--timeout 10junk",
      ["--timeout", "10junk"],
      /^\[startup-trace\] --timeout must/m,
    ],
    ["--timeout 0", ["--timeout", "0"], /^\[startup-trace\] --timeout must/m],
    [
      "missing --timeout value",
      ["--timeout"],
      /^\[startup-trace\] --timeout requires/m,
    ],
    [
      "overflowing --timeout",
      ["--timeout", String(MAX_TIMER_DELAY_MS + 1)],
      /^\[startup-trace\] --timeout must/m,
    ],
  ];

  function runCli(extraArgs: string[]) {
    return spawnSync(process.execPath, [SCRIPT_PATH, ...extraArgs], {
      encoding: "utf8",
      killSignal: "SIGKILL",
      maxBuffer: 256 * 1024,
      timeout: 3_000,
    });
  }

  it.each(invalidCliCases)(
    "rejects %s before launching a capture",
    (_label, args, expectedDiagnostic) => {
      const result = runCli(args);
      expect(result.error, args.join(" ")).toBeUndefined();
      expect(result.signal, args.join(" ")).toBeNull();
      expect(result.status, args.join(" ")).not.toBe(0);
      // Anchor on the CLI boundary prefix and the exact flag. A bootstrap or
      // import failure can mention capture-startup-trace.mjs without ever
      // reaching parseArgs, and must not satisfy this regression.
      expect(result.stderr, args.join(" ")).toMatch(expectedDiagnostic);
      // Must not reach the capture banner that prints after successful parse.
      expect(result.stdout, args.join(" ")).not.toMatch(
        /Capturing startup trace:/,
      );
    },
  );
});
