/**
 * Unit tests for repository input normalizer: validates owner/repo expansion,
 * HTTPS clone URL formatting, and SSH preservation.
 */
import { describe, expect, it } from "vitest";
import {
  assertSafeGitRemote,
  extractRepositoryUrlFromText,
  normalizeRepositoryInput,
} from "./repo-input.ts";

describe("repo-input", () => {
  it("returns empty string for empty input", () => {
    expect(normalizeRepositoryInput("")).toBe("");
    expect(normalizeRepositoryInput("   ")).toBe("");
  });

  it("preserves SSH clone URLs unchanged", () => {
    const ssh = "git@github.com:elizaOS/eliza.git";
    expect(normalizeRepositoryInput(ssh)).toBe(ssh);
  });

  it("normalizes owner/repo shorthand to HTTPS clone URL", () => {
    const res = normalizeRepositoryInput("elizaOS/eliza");
    expect(res).toBe("https://github.com/elizaOS/eliza.git");
  });

  it("normalizes github.com/owner/repo without protocol", () => {
    const res = normalizeRepositoryInput("github.com/elizaOS/eliza");
    expect(res).toBe("https://github.com/elizaOS/eliza.git");
  });

  it("normalizes full HTTPS URLs by appending .git if missing", () => {
    const res = normalizeRepositoryInput("https://github.com/elizaOS/eliza");
    expect(res).toBe("https://github.com/elizaOS/eliza.git");
  });

  it.each([
    [
      "https://gitlab.com/acme/platform/api",
      "https://gitlab.com/acme/platform/api.git",
    ],
    [
      "https://gitlab.com/acme/platform/backend/api.git",
      "https://gitlab.com/acme/platform/backend/api.git",
    ],
    [
      "gitlab.com/acme/platform/api",
      "https://gitlab.com/acme/platform/api.git",
    ],
    [
      "https://gitlab.com/acme/platform/api/-/merge_requests/12",
      "https://gitlab.com/acme/platform/api.git",
    ],
    [
      "https://gitlab.com/acme/platform/api/-/tree/main/src",
      "https://gitlab.com/acme/platform/api.git",
    ],
    [
      "https://gitlab.com/acme/platform/issues/api",
      "https://gitlab.com/acme/platform/issues/api.git",
    ],
    [
      "https://gitlab.com/acme/platform/releases/api",
      "https://gitlab.com/acme/platform/releases/api.git",
    ],
    ["https://gitlab.com/acme/api", "https://gitlab.com/acme/api.git"],
  ])("keeps the full GitLab namespace path: %s", (input, expected) => {
    const normalized = normalizeRepositoryInput(input);
    expect(normalized).toBe(expected);
    expect(assertSafeGitRemote(normalized)).toBe(normalized);
  });

  it.each([
    [
      "https://github.com/elizaOS/eliza/tree/develop/packages",
      "https://github.com/elizaOS/eliza.git",
    ],
    [
      "github.com/elizaOS/eliza/pull/33045",
      "https://github.com/elizaOS/eliza.git",
    ],
    [
      "https://bitbucket.org/acme/api/src/main/README.md",
      "https://bitbucket.org/acme/api.git",
    ],
  ])(
    "keeps GitHub and Bitbucket repositories at owner/repo: %s",
    (input, expected) => {
      expect(normalizeRepositoryInput(input)).toBe(expected);
    },
  );

  it.each([
    [
      "clone https://gitlab.com/gitlab-org/charts/gitlab.",
      "https://gitlab.com/gitlab-org/charts/gitlab.git",
    ],
    [
      "Please fix https://gitlab.com/acme/platform/api/-/merge_requests/12.",
      "https://gitlab.com/acme/platform/api.git",
    ],
    [
      "work in https://github.com/elizaOS/eliza.git.",
      "https://github.com/elizaOS/eliza.git",
    ],
    [
      "see https://github.com/elizaOS/eliza/pull/33045 for context",
      "https://github.com/elizaOS/eliza.git",
    ],
  ])(
    "extracts and normalizes the repository in task text: %s",
    (text, expected) => {
      const extracted = extractRepositoryUrlFromText(text);
      expect(extracted).not.toBeNull();
      expect(normalizeRepositoryInput(extracted ?? "")).toBe(expected);
    },
  );

  it("finds no repository in text without a known-host URL", () => {
    expect(
      extractRepositoryUrlFromText("fix the build on my laptop"),
    ).toBeNull();
    expect(
      extractRepositoryUrlFromText("https://example.com/acme/api"),
    ).toBeNull();
  });
});
