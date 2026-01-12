import { describe, expect, it } from "vitest";
import type {
  Branch,
  Comment,
  GitHubConfig,
  GitHubEventType,
  Issue,
  PullRequest,
  Repository,
  User,
} from "../types";

describe("GitHub Types", () => {
  it("should define GitHubConfig correctly", () => {
    const config: GitHubConfig = {
      apiToken: "token",
      owner: "owner",
      repo: "repo",
      branch: "main",
    };

    expect(config.apiToken).toBe("token");
    expect(config.owner).toBe("owner");
    expect(config.repo).toBe("repo");
    expect(config.branch).toBe("main");
  });

  it("should define Issue correctly", () => {
    const issue: Issue = {
      number: 1,
      title: "Test Issue",
      body: "Issue body",
      state: "open",
      labels: ["bug"],
      assignees: ["user1"],
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      htmlUrl: "https://github.com/owner/repo/issues/1",
    };

    expect(issue.number).toBe(1);
    expect(issue.state).toBe("open");
    expect(issue.labels).toContain("bug");
  });

  it("should define PullRequest correctly", () => {
    const pr: PullRequest = {
      number: 42,
      title: "Test PR",
      body: "PR body",
      state: "open",
      draft: false,
      merged: false,
      head: "feature-branch",
      base: "main",
      labels: [],
      assignees: [],
      reviewers: [],
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      htmlUrl: "https://github.com/owner/repo/pull/42",
    };

    expect(pr.number).toBe(42);
    expect(pr.draft).toBe(false);
    expect(pr.head).toBe("feature-branch");
    expect(pr.base).toBe("main");
  });

  it("should define Branch correctly", () => {
    const branch: Branch = {
      name: "feature/test",
      sha: "abc123def456",
      protected: false,
    };

    expect(branch.name).toBe("feature/test");
    expect(branch.sha).toBe("abc123def456");
  });

  it("should define Comment correctly", () => {
    const comment: Comment = {
      id: 123,
      body: "This is a comment",
      user: "test-user",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      htmlUrl: "https://github.com/owner/repo/issues/1#issuecomment-123",
    };

    expect(comment.id).toBe(123);
    expect(comment.user).toBe("test-user");
  });

  it("should define Repository correctly", () => {
    const repo: Repository = {
      id: 12345,
      name: "test-repo",
      fullName: "owner/test-repo",
      owner: "owner",
      description: "A test repository",
      private: false,
      fork: false,
      defaultBranch: "main",
      language: "TypeScript",
      stargazersCount: 100,
      forksCount: 10,
      openIssuesCount: 5,
      htmlUrl: "https://github.com/owner/test-repo",
      cloneUrl: "https://github.com/owner/test-repo.git",
      sshUrl: "git@github.com:owner/test-repo.git",
    };

    expect(repo.name).toBe("test-repo");
    expect(repo.language).toBe("TypeScript");
    expect(repo.stargazersCount).toBe(100);
  });

  it("should define User correctly", () => {
    const user: User = {
      id: 1,
      login: "testuser",
      avatarUrl: "https://avatars.githubusercontent.com/u/1",
      htmlUrl: "https://github.com/testuser",
      type: "User",
    };

    expect(user.login).toBe("testuser");
    expect(user.type).toBe("User");
  });

  it("should have valid event types", () => {
    const eventTypes: GitHubEventType[] = [
      "push",
      "pull_request",
      "issues",
      "issue_comment",
      "pull_request_review",
      "pull_request_review_comment",
      "create",
      "delete",
      "fork",
      "star",
      "watch",
      "release",
    ];

    expect(eventTypes).toHaveLength(12);
    expect(eventTypes).toContain("push");
    expect(eventTypes).toContain("pull_request");
  });
});
