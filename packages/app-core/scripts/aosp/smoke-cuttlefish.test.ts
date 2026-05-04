import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatResult, summarize } from "./smoke-cuttlefish.mjs";

const SMOKE_SOURCE = readFileSync(
  fileURLToPath(new URL("./smoke-cuttlefish.mjs", import.meta.url)),
  "utf8",
);

describe("smoke-cuttlefish formatters", () => {
  it("formatResult renders PASS lines with detail", () => {
    const out = formatResult(3, "ElizaAgentService start", true);
    expect(out).toContain("[3/8]");
    expect(out).toContain("PASS");
    expect(out).toContain("ElizaAgentService start");
  });

  it("formatResult renders FAIL lines with the detail tail", () => {
    const out = formatResult(4, "/api/health responds", false, "no 200 in 30s");
    expect(out).toContain("[4/8]");
    expect(out).toContain("FAIL");
    expect(out).toContain("/api/health responds");
    expect(out).toContain("no 200 in 30s");
  });

  it("summarize reports all-pass cleanly", () => {
    const summary = summarize([
      { step: 1, label: "a", ok: true },
      { step: 2, label: "b", ok: true },
    ]);
    expect(summary.allPassed).toBe(true);
    expect(summary.line).toContain("PASS");
    expect(summary.line).toContain("(2/2)");
  });

  it("summarize reports a partial-fail correctly", () => {
    const summary = summarize([
      { step: 1, label: "a", ok: true },
      { step: 2, label: "b", ok: false, detail: "broken" },
      { step: 3, label: "c", ok: true },
    ]);
    expect(summary.allPassed).toBe(false);
    expect(summary.line).toContain("FAIL");
    expect(summary.line).toContain("(2/3 passed, 1 failed)");
  });

  it("summarize handles an empty result array as all-pass (no work done)", () => {
    const summary = summarize([]);
    expect(summary.allPassed).toBe(true);
  });
});

describe("smoke-cuttlefish phase 8 grep quoting", () => {
  // Regression: phase 8 verifies local inference by grepping agent.log for
  // [aosp-llama] Loaded / gen done lines. The pattern contains parens and
  // a space — `(Loaded|gen done)` — and `adb shell` joins argv with a
  // space then hands the result to /system/bin/sh on the device. If the
  // regex is unquoted, the device shell parses `(Loaded|gen done)` as a
  // subshell and exits with `syntax error: unexpected '('`. The grep
  // never runs, stdout is empty, Number.parseInt → NaN, and phase 8
  // reports "0 aosp-llama Loaded/gen-done lines" — falsely failing
  // smoke runs where chat actually went through local inference.
  it("regex is single-quoted so the device shell hands it to grep verbatim", () => {
    expect(SMOKE_SOURCE).toContain("'aosp-llama. (Loaded|gen done)'");
    expect(SMOKE_SOURCE).not.toMatch(
      /"aosp-llama\. \(Loaded\|gen done\)"(?!')/,
    );
  });
});
