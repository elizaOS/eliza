/** Unit tests for the operation-summary string helpers. */
import { describe, expect, it } from "vitest";
import {
  compactSummaryText,
  summarizeFileOperation,
  summarizeShellCommand,
} from "./summaries.js";

describe("coding tool planner summaries", () => {
  it("summarizes write and edit file operations", () => {
    expect(
      summarizeFileOperation({
        action: "write",
        file_path: "/workspace/src/app.ts",
      }),
    ).toBe("wrote app.ts");
    expect(
      summarizeFileOperation({
        action: "edit",
        path: "/workspace/src/app.ts",
      }),
    ).toBe("edited app.ts");
    expect(
      summarizeFileOperation({
        action: "read",
        file_path: "/workspace/src/app.ts",
      }),
    ).toBeUndefined();
  });

  it("summarizes shell commands with bounded text", () => {
    expect(summarizeShellCommand("bun test")).toBe("ran `bun test`");
    expect(
      compactSummaryText(
        "bun run test --filter very-long-package-name -- --reporter verbose",
        20,
      ),
    ).toBe("bun run test --filt…");
  });
  it("keeps a surrogate pair intact at the max-plus-one boundary", () => {
    const s = `${"a".repeat(8)}🦊b`;
    expect(s.length).toBe(11);
    const out = compactSummaryText(s, 10);
    expect(out.isWellFormed()).toBe(true);
    expect(out.length).toBeLessThanOrEqual(10);
    expect(out).toBe(`${"a".repeat(8)}…`);
  });
  it("preserves a fitting emoji under the cap", () => {
    const s = `${"a".repeat(8)}🦊`;
    expect(compactSummaryText(s, 10)).toBe(s);
    expect(compactSummaryText(s, 10).isWellFormed()).toBe(true);
  });
  it("sanitizes lone surrogates before truncating", () => {
    const s = "a\ud800bcdef";
    const out = compactSummaryText(s, 4);
    expect(out).toBe(`${"a\ufffdbc".slice(0, 3)}…`);
    expect(out.isWellFormed()).toBe(true);
  });
  it("sanitizes either lone surrogate half without truncation", () => {
    for (const s of ["a\ud800bc", "a\udc00bc"]) {
      const out = compactSummaryText(s, 10);
      expect(out).toBe("a\ufffdbc");
      expect(out.isWellFormed()).toBe(true);
    }
  });
  it("returns single ellipsis when maxLength is 1 and input is long", () => {
    const out = compactSummaryText("hello world", 1);
    expect(out).toBe("…");
    expect(out.isWellFormed()).toBe(true);
  });
});
