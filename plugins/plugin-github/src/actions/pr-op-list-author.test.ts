/**
 * GITHUB_PR list author-filter tests drive the real action handler through a
 * structural GitHubOctokitClient: an author filter, with or without a repo,
 * runs server-side through GitHub's (case-insensitive) `author:` search
 * qualifier, while an unfiltered repo list uses the REST pulls endpoint.
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

const OTHER_AUTHORS_PAGE = Array.from({ length: 100 }, (_, index) => ({
  number: 1000 + index,
  title: `other ${index}`,
  state: "open",
  html_url: `https://github.test/org/repo/pull/${1000 + index}`,
  user: { login: "someone-else" },
}));

describe("GITHUB_PR list author filter", () => {
  it("finds a repo's PRs by author beyond the newest REST page", async () => {
    const pullsList = vi.fn().mockResolvedValue({ data: OTHER_AUTHORS_PAGE });
    const search = vi.fn().mockResolvedValue({
      data: {
        items: [
          {
            number: 7,
            title: "older octocat change",
            state: "open",
            html_url: "https://github.test/org/repo/pull/7",
            repository_url: "https://api.github.test/repos/org/repo",
            user: { login: "octocat" },
          },
        ],
      },
    });
    const octokit = {
      pulls: { list: pullsList },
      search: { issuesAndPullRequests: search },
    } as unknown as GitHubOctokitClient;

    const result = await prOpAction.handler(
      createRuntime(octokit),
      {} as never,
      undefined,
      { op: "list", repo: "org/repo", author: "OctoCat" },
    );

    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({
        q: "is:pr is:open repo:org/repo author:OctoCat",
      }),
    );
    expect(pullsList).not.toHaveBeenCalled();
    if (result.success && "prs" in result.data) {
      expect(result.data.prs).toEqual([
        expect.objectContaining({
          repo: "org/repo",
          number: 7,
          author: "octocat",
        }),
      ]);
    } else {
      throw new Error("expected a successful list result");
    }
  });

  it("lists a repo without an author filter through the REST endpoint", async () => {
    const pullsList = vi.fn().mockResolvedValue({ data: OPEN_PRS });
    const search = vi.fn();
    const octokit = {
      pulls: { list: pullsList },
      search: { issuesAndPullRequests: search },
    } as unknown as GitHubOctokitClient;

    const result = await prOpAction.handler(
      createRuntime(octokit),
      {} as never,
      undefined,
      { op: "list", repo: "org/repo" },
    );

    expect(pullsList).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "org", repo: "repo" }),
    );
    expect(search).not.toHaveBeenCalled();
    if (result.success && "prs" in result.data) {
      expect(result.data.prs.map((pr) => pr.author)).toEqual([
        "octocat",
        "hubot",
      ]);
    } else {
      throw new Error("expected a successful list result");
    }
  });
});
