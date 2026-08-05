/**
 * Verifies that console-warning captures preserve per-test maxima and cannot
 * replace the committed ratchet after an incomplete or failed unit suite.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectConsoleWarningBaseline,
  replaceConsoleWarningBaseline,
} from "../scripts/console-warning-baseline.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true });
  }
});

function makeCapture() {
  const directory = mkdtempSync(join(tmpdir(), "ui-console-baseline-test-"));
  temporaryDirectories.push(directory);
  writeFileSync(
    join(directory, "warnings.1.jsonl"),
    [
      JSON.stringify({ testName: "first", messages: ["warn: a", "warn: a"] }),
      JSON.stringify({
        testName: "second",
        messages: ["warn: a", "error: b"],
      }),
      "",
    ].join("\n"),
  );
  return directory;
}

describe("console warning baseline updater", () => {
  it("records the largest count observed within one test", () => {
    expect(collectConsoleWarningBaseline(makeCapture())).toEqual({
      "error: b": 1,
      "warn: a": 2,
    });
  });

  it("leaves the baseline byte-identical when the suite fails", () => {
    const directory = makeCapture();
    const baselinePath = join(directory, "baseline.json");
    writeFileSync(baselinePath, '{"existing":3}\n');

    expect(
      replaceConsoleWarningBaseline({
        captureDirectory: directory,
        baselinePath,
        runStatus: 1,
      }),
    ).toBeNull();
    expect(readFileSync(baselinePath, "utf8")).toBe('{"existing":3}\n');
  });

  it("atomically replaces the ratchet after a successful suite", () => {
    const directory = makeCapture();
    const baselinePath = join(directory, "baseline.json");
    writeFileSync(baselinePath, '{"existing":3}\n');

    expect(
      replaceConsoleWarningBaseline({
        captureDirectory: directory,
        baselinePath,
        runStatus: 0,
      }),
    ).toBe(2);
    expect(JSON.parse(readFileSync(baselinePath, "utf8"))).toEqual({
      "error: b": 1,
      "warn: a": 2,
    });
  });
});
