/**
 * Unit and CLI-boundary tests for the login-transfer measurement argument
 * parser. The harness is deterministic here: invalid flags must fail closed
 * before Chromium launches, so subprocess cases never need a renderer or
 * browser.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_TIMER_DELAY_MS,
  parseArgs,
  parseDecimalInt,
} from "./measure-anonymous-login-transfer.mjs";

// Resolve the CLI relative to this test file (a sibling .mjs), not
// process.cwd(): the client test lane runs vitest from packages/app, so a
// cwd-relative "packages/app/..." path doubles into
// packages/app/packages/app/... and the spawned Node can't find the module.
const SCRIPT_PATH = path.join(
  import.meta.dirname,
  "measure-anonymous-login-transfer.mjs",
);

describe("parseDecimalInt", () => {
  it("accepts non-negative decimal integers through an explicit max", () => {
    expect(parseDecimalInt("0", "--settle-ms", { min: 0 })).toBe(0);
    expect(parseDecimalInt("1", "--timeout", { min: 1 })).toBe(1);
    expect(parseDecimalInt("6000", "--settle-ms")).toBe(6000);
    expect(
      parseDecimalInt(String(MAX_TIMER_DELAY_MS), "--timeout", {
        min: 1,
        max: MAX_TIMER_DELAY_MS,
      }),
    ).toBe(MAX_TIMER_DELAY_MS);
  });

  it.each([
    undefined,
    "",
    "junk",
    "10junk",
    "-1",
    "1.5",
    "1e3",
    "+2",
    " 3",
    "08",
    "NaN",
    "Infinity",
    "--url",
  ] as Array<string | undefined>)(
    "rejects invalid input %j at the boundary",
    (raw) => {
      expect(() => parseDecimalInt(raw, "--settle-ms")).toThrow(/--settle-ms/);
    },
  );

  it("rejects values below min or above max", () => {
    expect(() =>
      parseDecimalInt("0", "--timeout", { min: 1, max: MAX_TIMER_DELAY_MS }),
    ).toThrow(/--timeout/);
    expect(() =>
      parseDecimalInt(String(MAX_TIMER_DELAY_MS + 1), "--timeout", {
        min: 1,
        max: MAX_TIMER_DELAY_MS,
      }),
    ).toThrow(/--timeout/);
  });
});

describe("parseArgs --settle-ms / --timeout", () => {
  it("keeps defaults when flags are omitted", () => {
    const args = parseArgs(["node", "measure-anonymous-login-transfer.mjs"]);
    expect(args.settleMs).toBe(6000);
    expect(args.timeout).toBe(90_000);
  });

  it("records valid overrides including zero settle", () => {
    const args = parseArgs([
      "node",
      "measure-anonymous-login-transfer.mjs",
      "--settle-ms",
      "0",
      "--timeout",
      "5000",
      "--url",
      "http://127.0.0.1:4173/login",
    ]);
    expect(args.settleMs).toBe(0);
    expect(args.timeout).toBe(5000);
    expect(args.url).toBe("http://127.0.0.1:4173/login");
  });

  it("fails closed when --settle-ms is missing or malformed", () => {
    expect(() =>
      parseArgs([
        "node",
        "measure-anonymous-login-transfer.mjs",
        "--settle-ms",
      ]),
    ).toThrow(/--settle-ms/);
    expect(() =>
      parseArgs([
        "node",
        "measure-anonymous-login-transfer.mjs",
        "--settle-ms",
        "junk",
      ]),
    ).toThrow(/junk/);
    expect(() =>
      parseArgs([
        "node",
        "measure-anonymous-login-transfer.mjs",
        "--settle-ms",
        "-3",
      ]),
    ).toThrow(/--settle-ms/);
    expect(() =>
      parseArgs([
        "node",
        "measure-anonymous-login-transfer.mjs",
        "--settle-ms",
        "1.5",
      ]),
    ).toThrow(/--settle-ms/);
    expect(() =>
      parseArgs([
        "node",
        "measure-anonymous-login-transfer.mjs",
        "--settle-ms",
        "--url",
        "http://example",
      ]),
    ).toThrow(/--settle-ms/);
  });

  it("fails closed when --timeout is missing or malformed", () => {
    expect(() =>
      parseArgs(["node", "measure-anonymous-login-transfer.mjs", "--timeout"]),
    ).toThrow(/--timeout/);
    expect(() =>
      parseArgs([
        "node",
        "measure-anonymous-login-transfer.mjs",
        "--timeout",
        "10junk",
      ]),
    ).toThrow(/10junk/);
    expect(() =>
      parseArgs([
        "node",
        "measure-anonymous-login-transfer.mjs",
        "--timeout",
        "0",
      ]),
    ).toThrow(/--timeout/);
    expect(() =>
      parseArgs([
        "node",
        "measure-anonymous-login-transfer.mjs",
        "--timeout",
        String(MAX_TIMER_DELAY_MS + 1),
      ]),
    ).toThrow(/--timeout/);
  });

  it("accepts the exact Node timer ceiling for both flags", () => {
    const args = parseArgs([
      "node",
      "measure-anonymous-login-transfer.mjs",
      "--settle-ms",
      String(MAX_TIMER_DELAY_MS),
      "--timeout",
      String(MAX_TIMER_DELAY_MS),
    ]);
    expect(args.settleMs).toBe(MAX_TIMER_DELAY_MS);
    expect(args.timeout).toBe(MAX_TIMER_DELAY_MS);
  });
});

describe("measure-anonymous-login-transfer CLI", () => {
  it("exits non-zero on invalid --settle-ms without launching Chromium", () => {
    const result = spawnSync(
      process.execPath,
      [SCRIPT_PATH, "--settle-ms", "abc", "--url", "http://127.0.0.1:9/login"],
      { encoding: "utf8", timeout: 15_000 },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--settle-ms/);
    expect(result.stderr).not.toMatch(/playwright|chromium|browser/i);
    expect(result.stdout).not.toMatch(/Measuring cold/);
  });

  it("exits non-zero on invalid --timeout without launching Chromium", () => {
    const result = spawnSync(
      process.execPath,
      [
        SCRIPT_PATH,
        "--timeout",
        String(MAX_TIMER_DELAY_MS + 1),
        "--url",
        "http://127.0.0.1:9/login",
      ],
      { encoding: "utf8", timeout: 15_000 },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--timeout/);
    expect(result.stdout).not.toMatch(/Measuring cold/);
  });

  it("prints help and exits 0", () => {
    const result = spawnSync(process.execPath, [SCRIPT_PATH, "--help"], {
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/--settle-ms/);
    expect(result.stdout).toMatch(/--timeout/);
  });

  it("enters the CLI through a symlink for invalid and valid arguments", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "login-transfer-link-"));
    const linkedScript = path.join(directory, "measure-login.mjs");
    try {
      symlinkSync(SCRIPT_PATH, linkedScript);

      const invalid = spawnSync(
        process.execPath,
        [linkedScript, "--settle-ms", "abc"],
        { encoding: "utf8", timeout: 15_000 },
      );
      expect(invalid.status).toBe(1);
      expect(invalid.stderr).toMatch(/--settle-ms/);

      const valid = spawnSync(
        process.execPath,
        [
          linkedScript,
          "--settle-ms",
          "0",
          "--timeout",
          "1",
          "--url",
          "http://127.0.0.1:9/login",
        ],
        { encoding: "utf8", timeout: 15_000 },
      );
      expect(valid.status).not.toBe(0);
      expect(valid.stdout).toMatch(/Measuring cold \/login/);
      expect(valid.stderr).not.toMatch(/--settle-ms|--timeout/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
