import { describe, expect, it, vi } from "vitest";

// Mock the spec helpers before importing providers, since provider modules
// call requireProviderSpec() at the top level and the generated spec names
// don't match the lookup keys used in the provider source.
vi.mock("../generated/specs/spec-helpers", () => ({
  requireProviderSpec: (_name: string) => ({
    name: _name,
    description: `Mock spec for ${_name}`,
  }),
  requireActionSpec: (_name: string) => ({
    name: _name,
    description: `Mock spec for ${_name}`,
    similes: [],
  }),
  getActionSpec: (_name: string) => ({
    name: _name,
    description: `Mock spec for ${_name}`,
    similes: [],
  }),
  getProviderSpec: (_name: string) => ({
    name: _name,
    description: `Mock spec for ${_name}`,
  }),
}));

import { issueContextProvider } from "../providers/issueContext";
import { repositoryStateProvider } from "../providers/repositoryState";
import { allProviders } from "../providers";

// =============================================================================
// allProviders export
// =============================================================================

describe("allProviders export", () => {
  it("should export exactly 2 providers", () => {
    expect(allProviders).toHaveLength(2);
  });

  it("should include repositoryStateProvider and issueContextProvider", () => {
    const names = allProviders.map((p) => p.name);
    expect(names).toContain(repositoryStateProvider.name);
    expect(names).toContain(issueContextProvider.name);
  });
});

// =============================================================================
// issueContextProvider
// =============================================================================

describe("issueContextProvider", () => {
  it("should have a name", () => {
    expect(issueContextProvider.name).toBeTruthy();
    expect(typeof issueContextProvider.name).toBe("string");
  });

  it("should have a description", () => {
    expect(issueContextProvider.description).toBeTruthy();
    expect(issueContextProvider.description).toContain("issue");
  });

  it("should have a get function", () => {
    expect(typeof issueContextProvider.get).toBe("function");
  });

  it("should return null text when no service is available", async () => {
    const runtime = {
      getService: vi.fn().mockReturnValue(null),
    };
    const message = { content: { text: "Check #42" } };
    const state = {};

    const result = await issueContextProvider.get(
      runtime as never,
      message as never,
      state as never,
    );

    expect(result).toEqual({ text: null });
  });

  it("should return null text when message has no issue reference", async () => {
    const runtime = {
      getService: vi.fn().mockReturnValue({
        getConfig: () => ({
          owner: "test-owner",
          repo: "test-repo",
        }),
      }),
    };
    const message = { content: { text: "Hello world" } };
    const state = {};

    const result = await issueContextProvider.get(
      runtime as never,
      message as never,
      state as never,
    );

    expect(result).toEqual({ text: null });
  });

  it("should return null text when config has no owner", async () => {
    const runtime = {
      getService: vi.fn().mockReturnValue({
        getConfig: () => ({
          owner: undefined,
          repo: "test-repo",
        }),
      }),
    };
    const message = { content: { text: "Check #42" } };
    const state = {};

    const result = await issueContextProvider.get(
      runtime as never,
      message as never,
      state as never,
    );

    expect(result).toEqual({ text: null });
  });

  it("should return null text when config has no repo", async () => {
    const runtime = {
      getService: vi.fn().mockReturnValue({
        getConfig: () => ({
          owner: "test-owner",
          repo: undefined,
        }),
      }),
    };
    const message = { content: { text: "Check #42" } };
    const state = {};

    const result = await issueContextProvider.get(
      runtime as never,
      message as never,
      state as never,
    );

    expect(result).toEqual({ text: null });
  });

  it("should attempt to fetch issue when reference is found", async () => {
    const mockGetIssue = vi.fn().mockRejectedValue(new Error("Not found"));
    const runtime = {
      getService: vi.fn().mockReturnValue({
        getConfig: () => ({
          owner: "test-owner",
          repo: "test-repo",
        }),
        getIssue: mockGetIssue,
      }),
    };
    const message = { content: { text: "Look at #42" } };
    const state = {};

    const result = await issueContextProvider.get(
      runtime as never,
      message as never,
      state as never,
    );

    expect(mockGetIssue).toHaveBeenCalledWith({
      owner: "test-owner",
      repo: "test-repo",
      issueNumber: 42,
    });
    // Should return a "not found" message
    expect(result.text).toContain("42");
    expect(result.text).toContain("test-owner/test-repo");
  });

  it("should format issue details when found", async () => {
    const mockIssue = {
      number: 42,
      title: "Bug: Login fails",
      body: "Steps to reproduce...",
      state: "open",
      stateReason: null,
      user: { login: "author" },
      assignees: [{ login: "dev1" }],
      labels: [{ name: "bug" }, { name: "critical" }],
      milestone: { title: "v1.0" },
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-02T00:00:00Z",
      comments: 5,
      htmlUrl: "https://github.com/test-owner/test-repo/issues/42",
      isPullRequest: false,
    };

    const runtime = {
      getService: vi.fn().mockReturnValue({
        getConfig: () => ({
          owner: "test-owner",
          repo: "test-repo",
        }),
        getIssue: vi.fn().mockResolvedValue(mockIssue),
      }),
    };
    const message = { content: { text: "Check issue #42" } };
    const state = {};

    const result = await issueContextProvider.get(
      runtime as never,
      message as never,
      state as never,
    );

    expect(result.text).toContain("Issue #42");
    expect(result.text).toContain("Bug: Login fails");
    expect(result.text).toContain("**State:** open");
    expect(result.text).toContain("**Author:** author");
    expect(result.text).toContain("**Labels:** bug, critical");
    expect(result.text).toContain("**Assignees:** dev1");
    expect(result.text).toContain("**Milestone:** v1.0");
    expect(result.text).toContain("Steps to reproduce...");
    expect(result.text).toContain("**URL:**");
  });

  it("should format PR details when issue is a pull request", async () => {
    const mockIssue = {
      isPullRequest: true,
    };

    const mockPR = {
      number: 99,
      title: "Add feature",
      body: "Adds new feature",
      state: "open",
      draft: false,
      merged: false,
      user: { login: "dev" },
      head: { ref: "feature/new" },
      base: { ref: "main" },
      assignees: [],
      requestedReviewers: [{ login: "reviewer1" }],
      labels: [{ name: "enhancement" }],
      additions: 100,
      deletions: 20,
      changedFiles: 5,
      createdAt: "2024-06-01T00:00:00Z",
      updatedAt: "2024-06-02T00:00:00Z",
      htmlUrl: "https://github.com/test-owner/test-repo/pull/99",
    };

    const runtime = {
      getService: vi.fn().mockReturnValue({
        getConfig: () => ({
          owner: "test-owner",
          repo: "test-repo",
        }),
        getIssue: vi.fn().mockResolvedValue(mockIssue),
        getPullRequest: vi.fn().mockResolvedValue(mockPR),
      }),
    };
    const message = { content: { text: "Check #99" } };
    const state = {};

    const result = await issueContextProvider.get(
      runtime as never,
      message as never,
      state as never,
    );

    expect(result.text).toContain("Pull Request #99");
    expect(result.text).toContain("Add feature");
    expect(result.text).toContain("**Branch:** feature/new → main");
    expect(result.text).toContain("**Labels:** enhancement");
    expect(result.text).toContain("**Reviewers Requested:** reviewer1");
    expect(result.text).toContain("**Changes:** +100 / -20 (5 files)");
  });

  it("should handle draft and merged PR flags", async () => {
    const mockIssue = { isPullRequest: true };
    const mockPR = {
      number: 50,
      title: "Draft PR",
      body: null,
      state: "open",
      draft: true,
      merged: false,
      user: { login: "dev" },
      head: { ref: "wip" },
      base: { ref: "main" },
      assignees: [],
      requestedReviewers: [],
      labels: [],
      additions: 0,
      deletions: 0,
      changedFiles: 0,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      htmlUrl: "",
    };

    const runtime = {
      getService: vi.fn().mockReturnValue({
        getConfig: () => ({ owner: "org", repo: "repo" }),
        getIssue: vi.fn().mockResolvedValue(mockIssue),
        getPullRequest: vi.fn().mockResolvedValue(mockPR),
      }),
    };
    const message = { content: { text: "#50" } };

    const result = await issueContextProvider.get(
      runtime as never,
      message as never,
      {} as never,
    );

    expect(result.text).toContain("(Draft)");
    expect(result.text).toContain("_No description provided_");
  });
});

// =============================================================================
// repositoryStateProvider
// =============================================================================

describe("repositoryStateProvider", () => {
  it("should have a name", () => {
    expect(repositoryStateProvider.name).toBeTruthy();
    expect(typeof repositoryStateProvider.name).toBe("string");
  });

  it("should have a description", () => {
    expect(repositoryStateProvider.description).toBeTruthy();
    expect(repositoryStateProvider.description).toContain("repository");
  });

  it("should have a get function", () => {
    expect(typeof repositoryStateProvider.get).toBe("function");
  });

  it("should return null text when no service is available", async () => {
    const runtime = {
      getService: vi.fn().mockReturnValue(null),
    };

    const result = await repositoryStateProvider.get(
      runtime as never,
      {} as never,
      {} as never,
    );

    expect(result).toEqual({ text: null });
  });

  it("should return config message when owner/repo not set", async () => {
    const runtime = {
      getService: vi.fn().mockReturnValue({
        getConfig: () => ({
          owner: undefined,
          repo: undefined,
        }),
      }),
    };

    const result = await repositoryStateProvider.get(
      runtime as never,
      {} as never,
      {} as never,
    );

    expect(result.text).toContain("not configured");
    expect(result.text).toContain("GITHUB_OWNER");
    expect(result.text).toContain("GITHUB_REPO");
  });

  it("should format repository state when service is available", async () => {
    const mockRepo = {
      fullName: "org/project",
      description: "A great project",
      defaultBranch: "main",
      language: "TypeScript",
      stargazersCount: 500,
      forksCount: 50,
      openIssuesCount: 10,
    };

    const mockIssues = [
      { number: 1, title: "Bug 1", labels: [{ name: "bug" }] },
      { number: 2, title: "Feature 2", labels: [] },
    ];

    const mockPRs = [
      {
        number: 10,
        title: "PR Alpha",
        draft: false,
        head: { ref: "feature/alpha" },
        base: { ref: "main" },
      },
      {
        number: 11,
        title: "PR Beta",
        draft: true,
        head: { ref: "feature/beta" },
        base: { ref: "main" },
      },
    ];

    const runtime = {
      getService: vi.fn().mockReturnValue({
        getConfig: () => ({ owner: "org", repo: "project" }),
        getRepository: vi.fn().mockResolvedValue(mockRepo),
        listIssues: vi.fn().mockResolvedValue(mockIssues),
        listPullRequests: vi.fn().mockResolvedValue(mockPRs),
      }),
    };

    const result = await repositoryStateProvider.get(
      runtime as never,
      {} as never,
      {} as never,
    );

    expect(result.text).toContain("org/project");
    expect(result.text).toContain("A great project");
    expect(result.text).toContain("**Default Branch:** main");
    expect(result.text).toContain("TypeScript");
    expect(result.text).toContain("500");
    expect(result.text).toContain("Recent Open Issues");
    expect(result.text).toContain("#1: Bug 1 [bug]");
    expect(result.text).toContain("#2: Feature 2");
    expect(result.text).toContain("Recent Open Pull Requests");
    expect(result.text).toContain("#10:");
    expect(result.text).toContain("feature/alpha → main");
    expect(result.text).toContain("[DRAFT]");
  });

  it("should handle empty issues and PRs gracefully", async () => {
    const mockRepo = {
      fullName: "org/empty-project",
      description: null,
      defaultBranch: "main",
      language: null,
      stargazersCount: 0,
      forksCount: 0,
      openIssuesCount: 0,
    };

    const runtime = {
      getService: vi.fn().mockReturnValue({
        getConfig: () => ({ owner: "org", repo: "empty-project" }),
        getRepository: vi.fn().mockResolvedValue(mockRepo),
        listIssues: vi.fn().mockResolvedValue([]),
        listPullRequests: vi.fn().mockResolvedValue([]),
      }),
    };

    const result = await repositoryStateProvider.get(
      runtime as never,
      {} as never,
      {} as never,
    );

    expect(result.text).toContain("org/empty-project");
    expect(result.text).toContain("No description");
    expect(result.text).toContain("Not specified");
    expect(result.text).not.toContain("Recent Open Issues");
    expect(result.text).not.toContain("Recent Open Pull Requests");
  });

  it("should handle service errors gracefully", async () => {
    const runtime = {
      getService: vi.fn().mockReturnValue({
        getConfig: () => ({ owner: "org", repo: "project" }),
        getRepository: vi.fn().mockRejectedValue(new Error("API rate limit exceeded")),
      }),
    };

    const result = await repositoryStateProvider.get(
      runtime as never,
      {} as never,
      {} as never,
    );

    expect(result.text).toContain("Unable to fetch");
    expect(result.text).toContain("API rate limit exceeded");
  });
});
