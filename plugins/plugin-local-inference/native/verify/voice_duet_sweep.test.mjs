/**
 * Focused CLI-boundary tests for voice_duet_sweep numeric option validation.
 * Invalid --turns / --cell-timeout-ms must fail before any cell work starts.
 * Parsing is asserted in-process; one spawned run proves the real entrypoint
 * exits non-zero rather than sweeping with a fabricated default.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import {
  MAX_NODE_TIMER_MS,
  parseArgs,
  parsePositiveInteger,
} from "./voice_duet_sweep.mjs";

const SCRIPT_PATH = fileURLToPath(
  new URL("./voice_duet_sweep.mjs", import.meta.url),
);

function runCli(args) {
  return spawnSync("bun", [SCRIPT_PATH, ...args], {
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

  it("CLI exits non-zero with the named flag before any sweep work", () => {
    const result = runCli(["--turns", "junk"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--turns/);
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /CSV \u2192|before\/after|voice-duet-sweep-cells|TimeoutOverflowWarning/i,
    );
  });
});
