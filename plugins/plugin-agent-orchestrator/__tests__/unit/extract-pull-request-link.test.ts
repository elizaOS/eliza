/**
 * Verifies extractPullRequestLink — the pure parser that pulls the first
 * GitHub PR link out of a sub-agent's completion output so the orchestrator can
 * stamp it onto task metadata (the task-widget PR chip).
 *
 * Deterministic unit test of a pure helper; no runtime, no live model.
 */
import { describe, expect, it } from "vitest";
import { extractPullRequestLink } from "../../src/services/pull-request-link.js";

describe("extractPullRequestLink", () => {
  it("returns null for empty / PR-free input", () => {
    expect(extractPullRequestLink("")).toBeNull();
    expect(extractPullRequestLink("   \n  ")).toBeNull();
    expect(
      extractPullRequestLink("Committed abc1234 and pushed the branch."),
    ).toBeNull();
    // A non-PR github URL (issue / tree) must not match the /pull/ shape.
    expect(
      extractPullRequestLink("See https://github.com/elizaOS/eliza/issues/42"),
    ).toBeNull();
  });

  it("parses a canonical PR URL into url/number/repo", () => {
    const link = extractPullRequestLink(
      "Opened https://github.com/elizaOS/eliza/pull/16090 for review.",
    );
    expect(link).toEqual({
      url: "https://github.com/elizaOS/eliza/pull/16090",
      number: 16090,
      repo: "elizaOS/eliza",
    });
  });

  it("returns the FIRST PR when several are present", () => {
    const raw = [
      "Created https://github.com/acme/widget/pull/7",
      "Superseded https://github.com/acme/widget/pull/9",
    ].join("\n");
    expect(extractPullRequestLink(raw)?.number).toBe(7);
  });

  it("stops the number at the URL boundary (trailing punctuation/paths)", () => {
    const link = extractPullRequestLink(
      "PR is at https://github.com/o/r/pull/123). More text follows.",
    );
    expect(link?.url).toBe("https://github.com/o/r/pull/123");
    expect(link?.number).toBe(123);
  });

  it("tolerates ANSI color codes wrapping the URL (TUI output)", () => {
    // A terminal may wrap the link in SGR sequences; the parser strips them.
    const raw = `\u001b[36mhttps://github.com/o/r/pull/55\u001b[0m`;
    expect(extractPullRequestLink(raw)?.number).toBe(55);
  });

  it("canonicalizes an http:// GitHub PR link to https:// (chip contract)", () => {
    // The UI chip only renders https:// GitHub links; a sub-agent echoing an
    // http:// URL must still produce renderable metadata.
    const link = extractPullRequestLink(
      "Opened http://github.com/o/r/pull/88 (plain-scheme echo)",
    );
    expect(link).toEqual({
      url: "https://github.com/o/r/pull/88",
      number: 88,
      repo: "o/r",
    });
  });

  it("handles owner/repo names with dots and hyphens", () => {
    const link = extractPullRequestLink(
      "https://github.com/my-org/my.repo-name/pull/321",
    );
    expect(link?.repo).toBe("my-org/my.repo-name");
    expect(link?.number).toBe(321);
  });
});
