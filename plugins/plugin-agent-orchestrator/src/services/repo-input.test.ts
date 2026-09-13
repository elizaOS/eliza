/**
 * Unit tests for repository input normalizer: validates owner/repo expansion,
 * HTTPS clone URL formatting, and SSH preservation.
 */
import { describe, expect, it } from "vitest";
import {
  extractGitHubRepositorySlug,
  extractRepositoryUrl,
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

  it("keeps every GitLab group segment instead of promoting a subgroup to the repo (#31116)", () => {
    expect(
      normalizeRepositoryInput(
        "https://gitlab.com/gitlab-org/security-products/analyzers",
      ),
    ).toBe("https://gitlab.com/gitlab-org/security-products/analyzers.git");
    expect(
      normalizeRepositoryInput("https://gitlab.com/group/subgroup/repo.git/"),
    ).toBe("https://gitlab.com/group/subgroup/repo.git");
    expect(normalizeRepositoryInput("gitlab.com/group/sub/repo")).toBe(
      "https://gitlab.com/group/sub/repo.git",
    );
    expect(normalizeRepositoryInput("https://gitlab.com/group/repo")).toBe(
      "https://gitlab.com/group/repo.git",
    );
  });

  it("drops GitLab sub-resource paths after the `-` separator", () => {
    expect(
      normalizeRepositoryInput("https://gitlab.com/group/sub/repo/-/issues/12"),
    ).toBe("https://gitlab.com/group/sub/repo.git");
  });

  it("still keeps GitHub and Bitbucket at one owner level", () => {
    expect(
      normalizeRepositoryInput("https://github.com/elizaOS/eliza/pull/5"),
    ).toBe("https://github.com/elizaOS/eliza.git");
    expect(
      normalizeRepositoryInput("https://bitbucket.org/team/repo/src/main"),
    ).toBe("https://bitbucket.org/team/repo.git");
  });

  it("preserves nested SSH remotes unchanged", () => {
    const ssh = "git@gitlab.com:group/sub/repo.git";
    expect(normalizeRepositoryInput(ssh)).toBe(ssh);
  });
});

describe("extractRepositoryUrl", () => {
  it("captures a nested GitLab URL in full so normalization can canonicalize it", () => {
    const text =
      "please clone https://gitlab.com/gitlab-org/security-products/analyzers and fix the build";
    const url = extractRepositoryUrl(text);
    expect(url).toBe(
      "https://gitlab.com/gitlab-org/security-products/analyzers",
    );
    expect(normalizeRepositoryInput(url ?? "")).toBe(
      "https://gitlab.com/gitlab-org/security-products/analyzers.git",
    );
  });

  it("strips trailing sentence punctuation and ignores unsupported hosts", () => {
    expect(
      extractRepositoryUrl("look at https://github.com/acme/widgets."),
    ).toBe("https://github.com/acme/widgets");
    expect(extractRepositoryUrl("see https://example.com/acme/widgets")).toBe(
      undefined,
    );
    expect(extractRepositoryUrl("no url here")).toBe(undefined);
  });
});

describe("extractGitHubRepositorySlug", () => {
  it("reads explicit GitHub references in URL, shorthand, and SSH form", () => {
    expect(
      extractGitHubRepositorySlug("file it in https://github.com/acme/widgets"),
    ).toBe("acme/widgets");
    expect(
      extractGitHubRepositorySlug("the bug lives in github.com/acme/widgets"),
    ).toBe("acme/widgets");
    expect(
      extractGitHubRepositorySlug("remote is git@github.com:acme/widgets.git"),
    ).toBe("acme/widgets");
    expect(
      extractGitHubRepositorySlug(
        "open https://github.com/acme/widgets/issues/4",
      ),
    ).toBe("acme/widgets");
  });

  it("accepts a bare slug only when the sentence presents it as a repository", () => {
    expect(extractGitHubRepositorySlug("close issue 5 in acme/widgets")).toBe(
      "acme/widgets",
    );
    expect(
      extractGitHubRepositorySlug("repo: acme/widgets, label it bug"),
    ).toBe("acme/widgets");
    expect(extractGitHubRepositorySlug("acme/widgets issue 5")).toBe(undefined);
  });

  it("does not mistake prose for a repository", () => {
    expect(
      extractGitHubRepositorySlug(
        "close the issue about the and/or parsing bug",
      ),
    ).toBe(undefined);
    expect(
      extractGitHubRepositorySlug("file a bug for the login/logout redirect"),
    ).toBe(undefined);
    expect(
      extractGitHubRepositorySlug("reopen the ticket, it happens 24/7 in prod"),
    ).toBe(undefined);
    expect(extractGitHubRepositorySlug("it fails in 24/7 mode")).toBe(
      undefined,
    );
  });
});
