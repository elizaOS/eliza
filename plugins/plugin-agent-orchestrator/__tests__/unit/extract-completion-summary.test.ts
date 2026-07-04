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

  it("returns 'done' when input is only acpx scaffolding (regression: leaked '[tool output: \"\"]')", () => {
    // Regression: synthesized `[Tool: ""]` markers must not bubble up as
    // the completion summary.
    expect(extractCompletionSummary('[tool output: ""]')).toBe("done");
    expect(
      extractCompletionSummary("[tool output: Bash]\nls\n[/tool output]"),
    ).toBe("done");
  });

  it("picks the last narrative line (the conclusion / URL)", () => {
    const raw = [
      "Now reading the camping-car site...",
      "[tool output: Read]",
      "<file contents>",
      "[/tool output]",
      "",
      "Site deployed at https://camping-car-europe.pages.dev",
    ].join("\n");
    expect(extractCompletionSummary(raw)).toBe(
      "Site deployed at https://camping-car-europe.pages.dev",
    );
  });

  it("filters synthesized [Tool: …] markers from the candidate lines", () => {
    const raw = [
      "Done! Added contact form and hero gallery.",
      "[tool output: Bash]",
      "wrangler pages deploy",
      "[/tool output]",
    ].join("\n");
    expect(extractCompletionSummary(raw)).toBe(
      "Done! Added contact form and hero gallery.",
    );
  });

  it("caps long lines at 300 chars with ellipsis", () => {
    const long = "a".repeat(500);
    const result = extractCompletionSummary(long);
    expect(result.length).toBe(298);
    expect(result.endsWith("…")).toBe(true);
  });

  it("strips router/verification annotations via stripToolTranscripts", () => {
    const raw = [
      "Site live at https://x.pages.dev",
      "[sub-agent: foo]",
      "[verification: ok]",
    ].join("\n");
    expect(extractCompletionSummary(raw)).toBe(
      "Site live at https://x.pages.dev",
    );
  });
});
