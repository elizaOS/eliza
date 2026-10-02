/**
 * Unit tests for repository input normalizer: validates owner/repo expansion,
 * HTTPS clone URL formatting, and SSH preservation.
 */
import { describe, expect, it } from "vitest";
import { assertSafeGitRemote, normalizeRepositoryInput } from "./repo-input.ts";

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
      "https://gitlab.com/acme/platform/api/tree/main",
      "https://gitlab.com/acme/platform/api.git",
    ],
    ["https://gitlab.com/acme/api/issues/3", "https://gitlab.com/acme/api.git"],
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
});
