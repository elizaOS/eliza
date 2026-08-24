/**
 * Unit tests for pull-request-link extractor: validates canonical GitHub PR URL
 * parsing, number extraction, and ANSI escape handling.
 */
import { describe, expect, it } from "vitest";
import { extractPullRequestLink } from "./pull-request-link.ts";

describe("pull-request-link", () => {
  it("extracts clean GitHub PR URL from plain text", () => {
    const text =
      "Created PR at https://github.com/elizaOS/eliza/pull/12345 successfully.";
    const res = extractPullRequestLink(text);
    expect(res).toEqual({
      url: "https://github.com/elizaOS/eliza/pull/12345",
      number: 12345,
      repo: "elizaOS/eliza",
    });
  });

  it("extracts PR URL from ANSI colored terminal output", () => {
    const text = "[32mhttps://github.com/test-org/test-repo/pull/42[39m";
    const res = extractPullRequestLink(text);
    expect(res).toEqual({
      url: "https://github.com/test-org/test-repo/pull/42",
      number: 42,
      repo: "test-org/test-repo",
    });
  });

  it("returns null when no PR URL is present or number is invalid", () => {
    expect(extractPullRequestLink("no pull request here")).toBeNull();
    expect(
      extractPullRequestLink("https://github.com/elizaOS/eliza/issues/123"),
    ).toBeNull();
  });
});
