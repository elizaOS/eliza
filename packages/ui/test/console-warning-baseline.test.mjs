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
  normalizeConsoleMessage,
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

// The exact bytes packages/ui emitted on CI run 31145403572, whose plain-text
// twin was already committed to console-warning-baseline.json. Before the
// fingerprint dropped color, this pair could not match and failed the test.
const COLORIZED_STARTUP_WARNING =
  "\u001B[1m\u001B[30m\u001B[43m Warn      \u001B[49m\u001B[31m\u001B[22m [eliza][startup:init] cloud-managed conversations passthrough is persistently 500\u001B[39m";
const PLAIN_STARTUP_WARNING =
  " Warn       [eliza][startup:init] cloud-managed conversations passthrough is persistently 500";

describe("console message fingerprint", () => {
  it("matches a colorized structured log to its plain baseline entry", () => {
    expect(normalizeConsoleMessage(COLORIZED_STARTUP_WARNING)).toBe(
      PLAIN_STARTUP_WARNING,
    );
  });

  it("agrees with the committed baseline for a real logger message", () => {
    const baseline = JSON.parse(
      readFileSync(
        new URL("./console-warning-baseline.json", import.meta.url),
        "utf8",
      ),
    );
    const key = `warn: ${normalizeConsoleMessage(COLORIZED_STARTUP_WARNING)}`;
    expect(Object.keys(baseline).some((entry) => entry.startsWith(key))).toBe(
      true,
    );
  });

  it("leaves an uncolored message untouched", () => {
    expect(normalizeConsoleMessage(PLAIN_STARTUP_WARNING)).toBe(
      PLAIN_STARTUP_WARNING,
    );
    expect(normalizeConsoleMessage("Warning: [0-9;]*m is not markup")).toBe(
      "Warning: [0-9;]*m is not markup",
    );
  });

  it("collapses color variants of one message into a single fingerprint", () => {
    const directory = mkdtempSync(join(tmpdir(), "ui-console-color-test-"));
    temporaryDirectories.push(directory);
    writeFileSync(
      join(directory, "warnings.1.jsonl"),
      `${JSON.stringify({
        testName: "colored and plain",
        messages: [
          `warn: ${COLORIZED_STARTUP_WARNING}`,
          `warn: ${PLAIN_STARTUP_WARNING}`,
        ],
      })}\n`,
    );

    expect(collectConsoleWarningBaseline(directory)).toEqual({
      [`warn: ${PLAIN_STARTUP_WARNING}`]: 2,
    });
  });
});

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
