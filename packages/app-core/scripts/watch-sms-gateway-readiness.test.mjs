/**
 * Focused coverage for watch-sms-gateway-readiness --timeout / --interval:
 * parser contract plus real CLI rejection before any adb poll.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
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
    expect(() => parseArgs(["--timeout"])).toThrow(
      /--timeout requires a value/,
    );
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

  test("a short --timeout is honored even when --interval is far longer", () => {
    // Both values parse independently; before the sleep clip, --timeout 1
    // --interval 86400 slept the full accepted interval past the deadline.
    // PATH=/nonexistent keeps every probe a fast failure, no adb required.
    const startedAt = Date.now();
    const result = spawnSync(
      process.execPath,
      [SCRIPT, "--timeout", "1", "--interval", "86400"],
      {
        encoding: "utf8",
        timeout: 8_000,
        env: { ...process.env, PATH: "/nonexistent" },
      },
    );
    const elapsedMs = Date.now() - startedAt;
    expect(result.signal).toBeNull(); // must exit on its own, not our timeout
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "Timed out waiting 1s",
    );
    expect(elapsedMs).toBeLessThan(6_000);
  });

  test("a TERM-ignoring stalled probe is killed at the watch deadline", () => {
    // A controlled fake curl, first on PATH, traps SIGTERM and sleeps far
    // past the watch window. spawnSync's default SIGTERM would wait forever
    // on it (Node documents this); the probes use SIGKILL, so the watcher
    // must exit near --timeout, the fake must provably have been invoked,
    // and its process must be gone afterwards.
    const fakeDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "sms-watch-fakebin-"),
    );
    const markerDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "sms-watch-marker-"),
    );
    const fakeCurl = path.join(fakeDir, "curl");
    fs.writeFileSync(
      fakeCurl,
      // Busy-wait in the shell itself (no sleep child to orphan): SIGKILL on
      // this pid must leave nothing behind.
      `#!/bin/sh\ntrap '' TERM\necho $$ > "${markerDir}/curl.pid"\nwhile :; do :; done\n`,
      { mode: 0o755 },
    );
    try {
      const startedAt = Date.now();
      const result = spawnSync(
        process.execPath,
        [SCRIPT, "--timeout", "2", "--interval", "3"],
        {
          encoding: "utf8",
          timeout: 15_000,
          env: { ...process.env, PATH: `${fakeDir}:/usr/bin:/bin` },
        },
      );
      const elapsedMs = Date.now() - startedAt;
      expect(result.signal).toBeNull(); // exits on its own, not our timeout
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain(
        "Timed out waiting 2s",
      );
      expect(elapsedMs).toBeLessThan(4_500);

      // The fake probe really ran, and its process did not survive SIGKILL.
      const pidFile = path.join(markerDir, "curl.pid");
      expect(fs.existsSync(pidFile)).toBe(true);
      const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
      expect(Number.isSafeInteger(pid)).toBe(true);
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    } finally {
      fs.rmSync(fakeDir, { recursive: true, force: true });
      fs.rmSync(markerDir, { recursive: true, force: true });
    }
  });
});
