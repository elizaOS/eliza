/**
 * Focused CLI-boundary tests for voice_duet_sweep numeric option validation.
 * Invalid --turns / --cell-timeout-ms must fail before any cell work starts.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  MAX_NODE_TIMER_MS,
  parseArgs,
  parsePositiveInteger,
} from "./voice_duet_sweep.mjs";

const SCRIPT_PATH = fileURLToPath(
  new URL("./voice_duet_sweep.mjs", import.meta.url),
);

function runCli(args, scriptPath = SCRIPT_PATH) {
  return spawnSync("bun", [scriptPath, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });
}

describe("voice_duet_sweep numeric CLI validation", () => {
  it("keeps defaults when --turns and --cell-timeout-ms are omitted", () => {
    const args = parseArgs([]);
    assert.equal(args.turns, 20);
    assert.equal(args.timeoutMs, 600_000);
  });

  it("parses valid overrides including zero-padded decimals", () => {
    const args = parseArgs([
      "--turns",
      "2",
      "--cell-timeout-ms",
      "1000",
    ]);
    assert.equal(args.turns, 2);
    assert.equal(args.timeoutMs, 1000);
    assert.equal(parseArgs(["--turns", "01"]).turns, 1);
    assert.equal(
      parseArgs(["--cell-timeout-ms", "00001000"]).timeoutMs,
      1000,
    );
    assert.equal(parsePositiveInteger("01", "--turns"), 1);
    assert.equal(
      parsePositiveInteger("00001000", "--cell-timeout-ms", MAX_NODE_TIMER_MS),
      1000,
    );
  });

  it("accepts the Node timer upper bound for --cell-timeout-ms", () => {
    assert.equal(
      parseArgs(["--cell-timeout-ms", String(MAX_NODE_TIMER_MS)]).timeoutMs,
      MAX_NODE_TIMER_MS,
    );
    assert.equal(
      parsePositiveInteger(
        String(MAX_NODE_TIMER_MS),
        "--cell-timeout-ms",
        MAX_NODE_TIMER_MS,
      ),
      MAX_NODE_TIMER_MS,
    );
  });

  it("rejects invalid --turns forms", () => {
    for (const value of [
      "",
      "0",
      "00",
      "-3",
      "1.5",
      "10junk",
      "NaN",
      "Infinity",
      "+1",
    ]) {
      assert.throws(() => parseArgs(["--turns", value]), /--turns/);
    }
  });

  it("rejects invalid --cell-timeout-ms forms including timer overflow", () => {
    for (const value of [
      "",
      "0",
      "00",
      "-3",
      "1.5",
      "10junk",
      String(MAX_NODE_TIMER_MS + 1),
    ]) {
      assert.throws(
        () => parseArgs(["--cell-timeout-ms", value]),
        /--cell-timeout-ms/,
      );
    }
  });

  it("rejects missing --cell-timeout-ms without consuming the next flag", () => {
    assert.throws(
      () => parseArgs(["--cell-timeout-ms", "--dry-run"]),
      /--cell-timeout-ms requires a value/,
    );
  });

  it("CLI exits non-zero with a named flag before sweep work", () => {
    for (const args of [
      ["--turns", "junk"],
      ["--cell-timeout-ms", "junk"],
      ["--cell-timeout-ms", String(MAX_NODE_TIMER_MS + 1)],
    ]) {
      const result = runCli(args);
      assert.equal(result.status, 1, `expected failure for ${args.join(" ")}`);
      assert.match(result.stderr, new RegExp(args[0]));
      assert.doesNotMatch(
        result.stdout + result.stderr,
        /CSV →|before\/after|voice-duet-sweep-cells|TimeoutOverflowWarning/i,
      );
    }
  });

  it("CLI accepts zero-padded valid flags under --dry-run", () => {
    const result = runCli([
      "--dry-run",
      "--turns",
      "01",
      "--cell-timeout-ms",
      "00001000",
    ]);
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stderr, /--turns|--cell-timeout-ms/);
  });

  it("runs through a symlink so invalid flags still fail closed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-duet-sweep-"));
    try {
      const linkPath = path.join(dir, "voice-duet-sweep");
      fs.symlinkSync(SCRIPT_PATH, linkPath);
      const result = runCli(["--turns", "junk"], linkPath);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /--turns/);
      assert.doesNotMatch(result.stdout + result.stderr, /CSV →|before\/after/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
