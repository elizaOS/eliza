/**
 * Unit coverage for the pure exports of the cloud-apps lib that the deploy
 * suite does not touch: query-key contracts, normalizeDeployRepoUrl's direct
 * branches, the remaining validateDeployAppInput rejections, and
 * deployRepoUrlFromApp's empty-repo fallbacks. Real module, no network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// Keep the module import hermetic: nothing here calls the api client, but the
// lib imports it at top level (same seam the deploy suite mocks).
const apiMock = vi.fn();
vi.mock("../../lib/api-client", () => ({
  api: (...args: unknown[]) => apiMock(...args),
}));

const {
  APPS_QUERY_KEY,
  appQueryKey,
  deployRepoUrlFromApp,
  normalizeDeployRepoUrl,
  validateDeployAppInput,
} = await import("./apps");

afterEach(() => {
  apiMock.mockReset();
});

describe("apps query keys", () => {
  it("exposes the stable list key mutations invalidate against", () => {
    expect(APPS_QUERY_KEY).toEqual(["apps"]);
  });

  it("builds a per-id key for targeted invalidation", () => {
    expect(appQueryKey("app_42")).toEqual(["app", "app_42"]);
    expect(appQueryKey("other")).not.toEqual(appQueryKey("app_42"));
  });
});

describe("normalizeDeployRepoUrl", () => {
  it("expands an owner/repo shorthand into an https GitHub clone URL", () => {
    expect(normalizeDeployRepoUrl("elizaOS/eliza")).toBe(
      "https://github.com/elizaOS/eliza.git",
    );
  });

  it("leaves a full repository URL untouched", () => {
    expect(normalizeDeployRepoUrl("https://github.com/elizaOS/eliza.git")).toBe(
      "https://github.com/elizaOS/eliza.git",
    );
    expect(normalizeDeployRepoUrl("git@github.com:elizaOS/eliza.git")).toBe(
      "git@github.com:elizaOS/eliza.git",
    );
  });

  it("trims surrounding whitespace before testing the shorthand", () => {
    expect(normalizeDeployRepoUrl("  elizaOS/eliza  ")).toBe(
      "https://github.com/elizaOS/eliza.git",
    );
    expect(normalizeDeployRepoUrl("\teliza\t")).toBe("eliza");
  });

  it("passes through values that are not owner/repo pairs", () => {
    expect(normalizeDeployRepoUrl("just-a-repo-name")).toBe("just-a-repo-name");
    expect(normalizeDeployRepoUrl("a/b/c")).toBe("a/b/c");
  });
});

describe("validateDeployAppInput rejection branches", () => {
  const FULL_SHA = "0123456789abcdef0123456789abcdef01234567";

  it("rejects non-record sources outright (null, arrays, strings)", () => {
    for (const input of [null, ["repo"], "https://github.com/x/y.git"]) {
      expect(validateDeployAppInput(input)).toEqual({
        ok: false,
        error: "Deployment source is required.",
      });
    }
  });

  it("requires a repository URL once the source is a record", () => {
    expect(validateDeployAppInput({})).toEqual({
      ok: false,
      error: "Repository URL is required.",
    });
  });

  it("rejects repository strings that do not parse as URLs", () => {
    expect(validateDeployAppInput({ repoUrl: "::::", ref: FULL_SHA })).toEqual({
      ok: false,
      error: "Enter a valid repository URL.",
    });
  });

  it("only accepts http(s) protocols", () => {
    expect(
      validateDeployAppInput({
        repoUrl: "ftp://example.com/repo.git",
        ref: FULL_SHA,
      }),
    ).toEqual({
      ok: false,
      error: "Use an http(s) Git repository URL.",
    });
  });

  it("requires a commit SHA even when the repository URL is valid", () => {
    expect(
      validateDeployAppInput({
        repoUrl: "https://github.com/elizaOS/eliza.git",
      }),
    ).toEqual({
      ok: false,
      error: "Commit SHA is required.",
    });
  });

  it("rejects each unsupported deploy-source key", () => {
    for (const key of [
      "archiveUrl",
      "artifact",
      "bundle",
      "file",
      "image",
      "tar",
      "zip",
    ]) {
      const result = validateDeployAppInput({
        repoUrl: "https://github.com/elizaOS/eliza.git",
        ref: FULL_SHA,
        [key]: "value",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(
          "Deploy from a Git repository and immutable commit SHA. Source bundles, images, zips, tars, and artifacts are not supported.",
        );
      }
    }
  });
});

describe("validateDeployAppInput Dockerfile path safety", () => {
  const VALID_BASE = {
    repoUrl: "https://github.com/elizaOS/eliza.git",
    ref: "0123456789abcdef0123456789abcdef01234567",
  };

  it("rejects absolute Dockerfile paths", () => {
    expect(
      validateDeployAppInput({ ...VALID_BASE, dockerfile: "/abs/Dockerfile" }),
    ).toEqual({
      ok: false,
      error: "Dockerfile path must be a relative path inside the repository.",
    });
  });

  it("rejects traversal segments and backslashes", () => {
    for (const dockerfile of [
      "../escape/Dockerfile",
      "docker/../../../etc/passwd",
      "docker\\windows.Dockerfile",
    ]) {
      expect(
        validateDeployAppInput({ ...VALID_BASE, dockerfile }),
      ).toMatchObject({
        ok: false,
        error: "Dockerfile path must be a relative path inside the repository.",
      });
    }
  });

  it("omits the dockerfile field entirely when none is supplied", () => {
    expect(validateDeployAppInput(VALID_BASE)).toEqual({
      ok: true,
      value: {
        repoUrl: "https://github.com/elizaOS/eliza.git",
        ref: "0123456789abcdef0123456789abcdef01234567",
      },
    });
  });

  it("normalizes owner/repo shorthands and trims ref/dockerfile in the success value", () => {
    expect(
      validateDeployAppInput({
        repoUrl: "elizaOS/eliza",
        ref: "  89abcdef0123456789abcdef0123456789abcdef  ",
        dockerfile: "  docker/app.Dockerfile  ",
      }),
    ).toEqual({
      ok: true,
      value: {
        repoUrl: "https://github.com/elizaOS/eliza.git",
        ref: "89abcdef0123456789abcdef0123456789abcdef",
        dockerfile: "docker/app.Dockerfile",
      },
    });
  });
});

describe("deployRepoUrlFromApp fallbacks", () => {
  it("returns an empty string when the app carries no usable github_repo", () => {
    expect(deployRepoUrlFromApp({ id: "a", github_repo: "" } as never)).toBe(
      "",
    );
    expect(deployRepoUrlFromApp({ id: "a" } as never)).toBe("");
  });
});
