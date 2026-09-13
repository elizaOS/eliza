/**
 * GITHUB_PR list author-filter tests drive the real action handler through a
 * structural GitHubOctokitClient with canonical-cased logins: the repo (REST)
 * branch must match authors case-insensitively, mirroring GitHub's
 * case-insensitive `author:` search qualifier used by the no-repo branch.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { GitHubOctokitClient } from "../types.js";
import { prOpAction } from "./pr-op.js";

function createRuntime(octokit: GitHubOctokitClient): IAgentRuntime {
  return {
    agentId: "00000000-0000-0000-0000-00000000agent",
    getService: () => ({ getOctokit: () => octokit }),
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  } as unknown as IAgentRuntime;
}

const OPEN_PRS = [
  {
    number: 1,
    title: "first",
    state: "open",
    html_url: "https://github.test/org/repo/pull/1",
    user: { login: "octocat" },
  },
  {
    number: 2,
    title: "second",
    state: "open",
    html_url: "https://github.test/org/repo/pull/2",
    user: { login: "hubot" },
  },
];

describe("GITHUB_PR list author filter", () => {
  it("matches authors case-insensitively in the repo branch", async () => {
    const pullsList = vi.fn().mockResolvedValue({ data: OPEN_PRS });
    const octokit = {
      pulls: { list: pullsList },
    } as unknown as GitHubOctokitClient;

    const result = await prOpAction.handler(
      createRuntime(octokit),
      {} as never,
      undefined,
      { op: "list", repo: "org/repo", author: "OctoCat" },
    );

    expect(pullsList).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "org", repo: "repo" }),
    );
    expect(result.success).toBe(true);
    if (result.success && "prs" in result.data) {
      expect(result.data.prs).toHaveLength(1);
      expect(result.data.prs[0]?.author).toBe("octocat");
    }
  });

  it("keeps exact-case matches working in the repo branch", async () => {
    const pullsList = vi.fn().mockResolvedValue({ data: OPEN_PRS });
    const octokit = {
      pulls: { list: pullsList },
    } as unknown as GitHubOctokitClient;

    const result = await prOpAction.handler(
      createRuntime(octokit),
      {} as never,
      undefined,
      { op: "list", repo: "org/repo", author: "hubot" },
    );

    if (result.success && "prs" in result.data) {
      expect(result.data.prs).toHaveLength(1);
      expect(result.data.prs[0]?.author).toBe("hubot");
    } else {
      throw new Error("expected a successful list result");
    }
  });
});
