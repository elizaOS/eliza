/**
 * Verifies extractCompletionSummary.
 * Deterministic unit test of pure helpers; no runtime, no live model.
 */
import { describe, expect, it } from "vitest";
import { extractCompletionSummary } from "../../src/index.js";

describe("extractCompletionSummary", () => {
  it("returns 'done' for empty input", () => {
    expect(extractCompletionSummary("")).toBe("done");
    expect(extractCompletionSummary("   \n  ")).toBe("done");
  });

  it("preserves tool-only completion output", () => {
    expect(extractCompletionSummary('[tool output: ""]')).toBe(
      '[tool output: ""]',
    );
    const raw = "[tool output: Bash]\nls\n[/tool output]";
    expect(extractCompletionSummary(raw)).toBe(raw);
  });

  it("preserves every narrative and tool-output line", () => {
    const raw = [
      "Now reading the camping-car site...",
      "[tool output: Read]",
      "<file contents>",
      "[/tool output]",
      "",
      "Site deployed at https://camping-car-europe.pages.dev",
    ].join("\n");
    expect(extractCompletionSummary(raw)).toBe(raw);
  });

  it("preserves synthesized tool markers", () => {
    const raw = [
      "Done! Added contact form and hero gallery.",
      "[tool output: Bash]",
      "wrangler pages deploy",
      "[/tool output]",
    ].join("\n");
    expect(extractCompletionSummary(raw)).toBe(raw);
  });

  it("preserves long lines", () => {
    const long = "a".repeat(500);
    const result = extractCompletionSummary(long);
    expect(result).toBe(long);
  });

  it("preserves router and verification annotations", () => {
    const raw = [
      "Site live at https://x.pages.dev",
      "[sub-agent: foo]",
      "[verification: ok]",
    ].join("\n");
    expect(extractCompletionSummary(raw)).toBe(raw);
  });
});
