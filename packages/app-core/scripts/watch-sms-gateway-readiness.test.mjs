/**
 * Focused coverage for watch-sms-gateway-readiness --timeout / --interval:
 * parser contract plus real CLI rejection before any adb poll.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_INTERVAL_SECONDS,
  DEFAULT_TIMEOUT_SECONDS,
  MAX_WATCH_SECONDS,
  parseArgs,
  parseWatchSeconds,
} from "./watch-sms-gateway-readiness.mjs";

const SCRIPT = fileURLToPath(
  new URL("./watch-sms-gateway-readiness.mjs", import.meta.url),
);

function runCli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    timeout: 8_000,
  });
}

describe("parseWatchSeconds", () => {
  test("accepts complete positive decimals through the 24-hour cap", () => {
    expect(parseWatchSeconds("1", "--timeout")).toBe(1);
    expect(parseWatchSeconds("300", "--timeout")).toBe(300);
    expect(parseWatchSeconds(String(MAX_WATCH_SECONDS), "--interval")).toBe(
      MAX_WATCH_SECONDS,
    );
  });

  test("rejects scientific notation, trailing junk, zero, and overflow", () => {
    for (const value of [
      "0",
      "1e3",
      "8abc",
      "010",
      "3.5",
      "abc",
      "-1",
      "",
      " ",
      String(MAX_WATCH_SECONDS + 1),
    ]) {
      expect(() => parseWatchSeconds(value, "--timeout")).toThrow(
        `--timeout must be a positive decimal integer from 1 to ${MAX_WATCH_SECONDS}`,
      );
    }
  });
});

describe("parseArgs", () => {
  test("keeps documented defaults when flags are omitted", () => {
    expect(parseArgs([])).toEqual({
      timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
      intervalSeconds: DEFAULT_INTERVAL_SECONDS,
      runInstall: false,
    });
  });

  test("honors canonical --timeout and --interval", () => {
    expect(parseArgs(["--timeout", "3", "--interval", "1"])).toEqual({
      timeoutSeconds: 3,
      intervalSeconds: 1,
      runInstall: false,
    });
  });

  test("fails closed on 1e3, 8abc, and zero instead of coercing", () => {
    expect(() => parseArgs(["--timeout", "1e3"])).toThrow(/--timeout/);
    expect(() => parseArgs(["--timeout", "8abc"])).toThrow(/--timeout/);
    expect(() => parseArgs(["--timeout", "0"])).toThrow(/--timeout/);
    expect(() => parseArgs(["--interval", "1e3"])).toThrow(/--interval/);
    expect(() => parseArgs(["--timeout"])).toThrow(/--timeout requires a value/);
  });
});

describe("watch-sms-gateway-readiness CLI timing boundary", () => {
  test("rejects --timeout 1e3 before waiting or printing Timed out waiting 1s", () => {
    const startedAt = Date.now();
    const result = runCli(["--timeout", "1e3", "--interval", "1"]);
    expect(result.status).not.toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    const combined = `${result.stdout}${result.stderr}`;
    expect(combined).toMatch(
      /--timeout must be a positive decimal integer from 1 to 86400/,
    );
    expect(combined).not.toContain("Timed out waiting 1s");
    expect(combined).not.toContain("[sms-gateway-watch] waiting:");
  });

  test("rejects --timeout 8abc before sleeping eight seconds", () => {
    const startedAt = Date.now();
    const result = runCli(["--timeout", "8abc", "--interval", "1"]);
    expect(result.status).not.toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    const combined = `${result.stdout}${result.stderr}`;
    expect(combined).toMatch(/--timeout must be a positive decimal integer/);
    expect(combined).not.toContain("Timed out waiting 8s");
    expect(combined).not.toContain("[sms-gateway-watch] waiting:");
  });

  test("--help still prints usage without starting the poll loop", () => {
    const result = runCli(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("1-86400");
  });
});
