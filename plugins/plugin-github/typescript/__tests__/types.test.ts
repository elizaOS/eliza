import { describe, expect, it } from "vitest";
import {
  type CreateBranchParams,
  type CreateCommentParams,
  type CreateCommitParams,
  type CreateIssueParams,
  type CreatePullRequestParams,
  type CreateReviewParams,
  createBranchSchema,
  createCommentSchema,
  createCommitSchema,
  createIssueSchema,
  createPullRequestSchema,
  createReviewSchema,
  type FileChange,
  fileRefSchema,
  formatZodErrors,
  type GitHubBranch,
  type GitHubComment,
  type GitHubCommit,
  type GitHubCommitAuthor,
  type GitHubEventType,
  type GitHubIssue,
  type GitHubLabel,
  type GitHubLicense,
  type GitHubMilestone,
  type GitHubPullRequest,
  type GitHubRepository,
  type GitHubReview,
  type GitHubSettings,
  type GitHubUser,
  gitHubSettingsSchema,
  type IssueState,
  type MergeableState,
  type MergePullRequestParams,
  mergePullRequestSchema,
  type PullRequestState,
  type RepositoryRef,
  type ReviewState,
  repositoryRefSchema,
  updateIssueSchema,
} from "../types";

// =============================================================================
// Zod Schema Validation
// =============================================================================

describe("Zod Schema Validation", () => {
  describe("repositoryRefSchema", () => {
    it("should accept valid owner/repo", () => {
      const result = repositoryRefSchema.safeParse({ owner: "org", repo: "project" });
      expect(result.success).toBe(true);
    });

    it("should reject empty owner", () => {
      const result = repositoryRefSchema.safeParse({ owner: "", repo: "project" });
      expect(result.success).toBe(false);
    });

    it("should reject empty repo", () => {
      const result = repositoryRefSchema.safeParse({ owner: "org", repo: "" });
      expect(result.success).toBe(false);
    });

    it("should reject missing owner", () => {
      const result = repositoryRefSchema.safeParse({ repo: "project" });
      expect(result.success).toBe(false);
    });

    it("should reject missing repo", () => {
      const result = repositoryRefSchema.safeParse({ owner: "org" });
      expect(result.success).toBe(false);
    });
  });

  describe("fileRefSchema", () => {
    it("should accept valid file ref with branch", () => {
      const result = fileRefSchema.safeParse({
        owner: "org",
        repo: "project",
        path: "src/main.rs",
        branch: "develop",
      });
      expect(result.success).toBe(true);
    });

    it("should accept file ref without branch (optional)", () => {
      const result = fileRefSchema.safeParse({
        owner: "org",
        repo: "project",
        path: "README.md",
      });
      expect(result.success).toBe(true);
    });

    it("should reject empty path", () => {
      const result = fileRefSchema.safeParse({
        owner: "org",
        repo: "project",
        path: "",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("createIssueSchema", () => {
    it("should accept valid issue params", () => {
      const result = createIssueSchema.safeParse({
        owner: "org",
        repo: "project",
        title: "Bug: Something is broken",
        body: "Steps to reproduce...",
        labels: ["bug"],
        assignees: ["user1"],
      });
      expect(result.success).toBe(true);
    });

    it("should accept minimal params (title only)", () => {
      const result = createIssueSchema.safeParse({
        owner: "org",
        repo: "project",
        title: "Fix this",
      });
      expect(result.success).toBe(true);
    });

    it("should reject empty title", () => {
      const result = createIssueSchema.safeParse({
        owner: "org",
        repo: "project",
        title: "",
      });
      expect(result.success).toBe(false);
    });

    it("should reject missing title", () => {
      const result = createIssueSchema.safeParse({
        owner: "org",
        repo: "project",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("updateIssueSchema", () => {
    it("should accept valid update params", () => {
      const result = updateIssueSchema.safeParse({
        owner: "org",
        repo: "project",
        issueNumber: 42,
        state: "closed",
        stateReason: "completed",
      });
      expect(result.success).toBe(true);
    });

    it("should reject invalid state", () => {
      const result = updateIssueSchema.safeParse({
        owner: "org",
        repo: "project",
        issueNumber: 1,
        state: "invalid",
      });
      expect(result.success).toBe(false);
    });

    it("should reject zero issue number", () => {
      const result = updateIssueSchema.safeParse({
        owner: "org",
        repo: "project",
        issueNumber: 0,
      });
      expect(result.success).toBe(false);
    });

    it("should allow nullable milestone", () => {
      const result = updateIssueSchema.safeParse({
        owner: "org",
        repo: "project",
        issueNumber: 1,
        milestone: null,
      });
      expect(result.success).toBe(true);
    });
  });

  describe("createPullRequestSchema", () => {
    it("should accept valid PR params", () => {
      const result = createPullRequestSchema.safeParse({
        owner: "org",
        repo: "project",
        title: "Add dark mode",
        head: "feature/dark-mode",
        base: "main",
        draft: true,
      });
      expect(result.success).toBe(true);
    });

    it("should reject missing head branch", () => {
      const result = createPullRequestSchema.safeParse({
        owner: "org",
        repo: "project",
        title: "Some PR",
        base: "main",
      });
      expect(result.success).toBe(false);
    });

    it("should reject empty base branch", () => {
      const result = createPullRequestSchema.safeParse({
        owner: "org",
        repo: "project",
        title: "Some PR",
        head: "feature",
        base: "",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("createReviewSchema", () => {
    it("should accept APPROVE event", () => {
      const result = createReviewSchema.safeParse({
        owner: "org",
        repo: "project",
        pullNumber: 42,
        event: "APPROVE",
        body: "LGTM!",
      });
      expect(result.success).toBe(true);
    });

    it("should accept REQUEST_CHANGES event", () => {
      const result = createReviewSchema.safeParse({
        owner: "org",
        repo: "project",
        pullNumber: 42,
        event: "REQUEST_CHANGES",
        body: "Needs fixes",
      });
      expect(result.success).toBe(true);
    });

    it("should accept COMMENT event", () => {
      const result = createReviewSchema.safeParse({
        owner: "org",
        repo: "project",
        pullNumber: 42,
        event: "COMMENT",
      });
      expect(result.success).toBe(true);
    });

    it("should reject invalid event", () => {
      const result = createReviewSchema.safeParse({
        owner: "org",
        repo: "project",
        pullNumber: 42,
        event: "INVALID",
      });
      expect(result.success).toBe(false);
    });

    it("should accept review with inline comments", () => {
      const result = createReviewSchema.safeParse({
        owner: "org",
        repo: "project",
        pullNumber: 42,
        event: "COMMENT",
        comments: [
          { path: "src/main.ts", line: 10, body: "Consider refactoring" },
          { path: "src/utils.ts", line: 5, body: "Good approach", side: "RIGHT" },
        ],
      });
      expect(result.success).toBe(true);
    });
  });

  describe("createCommentSchema", () => {
    it("should accept valid comment params", () => {
      const result = createCommentSchema.safeParse({
        owner: "org",
        repo: "project",
        issueNumber: 42,
        body: "This looks good!",
      });
      expect(result.success).toBe(true);
    });

    it("should reject empty body", () => {
      const result = createCommentSchema.safeParse({
        owner: "org",
        repo: "project",
        issueNumber: 42,
        body: "",
      });
      expect(result.success).toBe(false);
    });

    it("should reject zero issue number", () => {
      const result = createCommentSchema.safeParse({
        owner: "org",
        repo: "project",
        issueNumber: 0,
        body: "Comment",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("createBranchSchema", () => {
    it("should accept valid branch params", () => {
      const result = createBranchSchema.safeParse({
        owner: "org",
        repo: "project",
        branchName: "feature/new-thing",
        fromRef: "main",
      });
      expect(result.success).toBe(true);
    });

    it("should reject empty branch name", () => {
      const result = createBranchSchema.safeParse({
        owner: "org",
        repo: "project",
        branchName: "",
        fromRef: "main",
      });
      expect(result.success).toBe(false);
    });

    it("should reject empty fromRef", () => {
      const result = createBranchSchema.safeParse({
        owner: "org",
        repo: "project",
        branchName: "feature",
        fromRef: "",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("createCommitSchema", () => {
    it("should accept valid commit params", () => {
      const result = createCommitSchema.safeParse({
        owner: "org",
        repo: "project",
        message: "Add new file",
        files: [{ path: "hello.txt", content: "Hello world" }],
        branch: "main",
      });
      expect(result.success).toBe(true);
    });

    it("should accept commit with file encoding and operation", () => {
      const result = createCommitSchema.safeParse({
        owner: "org",
        repo: "project",
        message: "Update files",
        files: [
          { path: "data.bin", content: "dGVzdA==", encoding: "base64", operation: "add" },
          { path: "old.txt", content: "", operation: "delete" },
        ],
        branch: "develop",
        authorName: "Bot",
        authorEmail: "bot@example.com",
      });
      expect(result.success).toBe(true);
    });

    it("should reject empty commit message", () => {
      const result = createCommitSchema.safeParse({
        owner: "org",
        repo: "project",
        message: "",
        files: [{ path: "f.txt", content: "c" }],
        branch: "main",
      });
      expect(result.success).toBe(false);
    });

    it("should reject file with empty path", () => {
      const result = createCommitSchema.safeParse({
        owner: "org",
        repo: "project",
        message: "Test",
        files: [{ path: "", content: "c" }],
        branch: "main",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("mergePullRequestSchema", () => {
    it("should accept valid merge params", () => {
      const result = mergePullRequestSchema.safeParse({
        owner: "org",
        repo: "project",
        pullNumber: 42,
        mergeMethod: "squash",
      });
      expect(result.success).toBe(true);
    });

    it("should accept all merge methods", () => {
      for (const method of ["merge", "squash", "rebase"]) {
        const result = mergePullRequestSchema.safeParse({
          owner: "org",
          repo: "project",
          pullNumber: 1,
          mergeMethod: method,
        });
        expect(result.success).toBe(true);
      }
    });

    it("should reject invalid merge method", () => {
      const result = mergePullRequestSchema.safeParse({
        owner: "org",
        repo: "project",
        pullNumber: 1,
        mergeMethod: "invalid",
      });
      expect(result.success).toBe(false);
    });

    it("should reject zero pull number", () => {
      const result = mergePullRequestSchema.safeParse({
        owner: "org",
        repo: "project",
        pullNumber: 0,
      });
      expect(result.success).toBe(false);
    });
  });

  describe("gitHubSettingsSchema", () => {
    it("should accept valid settings", () => {
      const result = gitHubSettingsSchema.safeParse({
        apiToken: "ghp_test",
        owner: "org",
        repo: "project",
      });
      expect(result.success).toBe(true);
    });

    it("should reject empty token", () => {
      const result = gitHubSettingsSchema.safeParse({
        apiToken: "",
      });
      expect(result.success).toBe(false);
    });
  });
});

// =============================================================================
// formatZodErrors
// =============================================================================

describe("formatZodErrors", () => {
  it("should format validation errors into a readable string", () => {
    const result = createIssueSchema.safeParse({
      owner: "",
      repo: "",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const formatted = formatZodErrors(result.error);
      expect(typeof formatted).toBe("string");
      expect(formatted.length).toBeGreaterThan(0);
    }
  });
});

// =============================================================================
// Type Construction Tests
// =============================================================================

describe("Type Construction", () => {
  it("should construct a valid GitHubUser", () => {
    const user: GitHubUser = {
      id: 12345,
      login: "octocat",
      name: "The Octocat",
      avatarUrl: "https://avatars.githubusercontent.com/u/12345",
      htmlUrl: "https://github.com/octocat",
      type: "User",
    };
    expect(user.login).toBe("octocat");
    expect(user.type).toBe("User");
    expect(user.name).toBe("The Octocat");
  });

  it("should construct a valid GitHubLabel", () => {
    const label: GitHubLabel = {
      id: 1,
      name: "bug",
      color: "d73a4a",
      description: "Something is broken",
      default: false,
    };
    expect(label.name).toBe("bug");
    expect(label.color).toBe("d73a4a");
  });

  it("should construct a valid GitHubIssue", () => {
    const user: GitHubUser = {
      id: 1,
      login: "author",
      name: null,
      avatarUrl: "",
      htmlUrl: "",
      type: "User",
    };

    const issue: GitHubIssue = {
      number: 42,
      title: "Bug: Login fails",
      body: "Users cannot login",
      state: "open",
      stateReason: null,
      user,
      assignees: [],
      labels: [],
      milestone: null,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      closedAt: null,
      htmlUrl: "https://github.com/org/repo/issues/42",
      comments: 3,
      isPullRequest: false,
    };

    expect(issue.number).toBe(42);
    expect(issue.state).toBe("open");
    expect(issue.isPullRequest).toBe(false);
  });

  it("should construct a valid GitHubPullRequest", () => {
    const user: GitHubUser = {
      id: 1,
      login: "dev",
      name: null,
      avatarUrl: "",
      htmlUrl: "",
      type: "User",
    };

    const pr: GitHubPullRequest = {
      number: 99,
      title: "Add dark mode",
      body: "Implements dark mode support",
      state: "open",
      draft: false,
      merged: false,
      mergeable: true,
      mergeableState: "mergeable",
      user,
      head: {
        ref: "feature/dark-mode",
        label: "user:feature/dark-mode",
        sha: "abc123",
        repo: null,
      },
      base: { ref: "main", label: "org:main", sha: "def456", repo: null },
      assignees: [],
      requestedReviewers: [],
      labels: [],
      milestone: null,
      createdAt: "2024-06-01T00:00:00Z",
      updatedAt: "2024-06-02T00:00:00Z",
      closedAt: null,
      mergedAt: null,
      htmlUrl: "https://github.com/org/repo/pull/99",
      commits: 3,
      additions: 150,
      deletions: 20,
      changedFiles: 5,
    };

    expect(pr.number).toBe(99);
    expect(pr.head.ref).toBe("feature/dark-mode");
    expect(pr.base.ref).toBe("main");
    expect(pr.draft).toBe(false);
    expect(pr.mergeableState).toBe("mergeable");
  });

  it("should construct a valid GitHubBranch", () => {
    const branch: GitHubBranch = {
      name: "feature/test",
      sha: "abc123def456789012345678901234567890abcd",
      protected: false,
    };
    expect(branch.name).toBe("feature/test");
    expect(branch.protected).toBe(false);
  });

  it("should construct a valid GitHubComment", () => {
    const user: GitHubUser = {
      id: 1,
      login: "commenter",
      name: null,
      avatarUrl: "",
      htmlUrl: "",
      type: "User",
    };

    const comment: GitHubComment = {
      id: 500,
      body: "Great work!",
      user,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      htmlUrl: "https://github.com/org/repo/issues/1#issuecomment-500",
    };

    expect(comment.id).toBe(500);
    expect(comment.body).toBe("Great work!");
  });

  it("should construct a valid GitHubCommit", () => {
    const author: GitHubCommitAuthor = {
      name: "Dev",
      email: "dev@example.com",
      date: "2024-01-01T00:00:00Z",
    };

    const commit: GitHubCommit = {
      sha: "abc123",
      message: "Initial commit",
      author,
      committer: author,
      timestamp: "2024-01-01T00:00:00Z",
      htmlUrl: "https://github.com/org/repo/commit/abc123",
      parents: [],
    };

    expect(commit.sha).toBe("abc123");
    expect(commit.message).toBe("Initial commit");
    expect(commit.parents).toHaveLength(0);
  });

  it("should construct a valid GitHubRepository", () => {
    const owner: GitHubUser = {
      id: 1,
      login: "org",
      name: "Organization",
      avatarUrl: "",
      htmlUrl: "",
      type: "Organization",
    };

    const repo: GitHubRepository = {
      id: 100,
      name: "project",
      fullName: "org/project",
      owner,
      description: "A great project",
      private: false,
      fork: false,
      defaultBranch: "main",
      language: "TypeScript",
      stargazersCount: 500,
      forksCount: 50,
      openIssuesCount: 10,
      watchersCount: 100,
      htmlUrl: "https://github.com/org/project",
      cloneUrl: "https://github.com/org/project.git",
      sshUrl: "git@github.com:org/project.git",
      createdAt: "2023-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      pushedAt: "2024-01-01T00:00:00Z",
      topics: ["typescript", "ai"],
      license: { key: "mit", name: "MIT License", spdxId: "MIT", url: null },
    };

    expect(repo.name).toBe("project");
    expect(repo.language).toBe("TypeScript");
    expect(repo.owner.type).toBe("Organization");
    expect(repo.topics).toContain("typescript");
  });

  it("should construct a valid GitHubReview", () => {
    const user: GitHubUser = {
      id: 1,
      login: "reviewer",
      name: null,
      avatarUrl: "",
      htmlUrl: "",
      type: "User",
    };

    const review: GitHubReview = {
      id: 200,
      user,
      body: "LGTM!",
      state: "APPROVED",
      commitId: "abc123",
      htmlUrl: "https://github.com/org/repo/pull/1#pullrequestreview-200",
      submittedAt: "2024-01-01T00:00:00Z",
    };

    expect(review.state).toBe("APPROVED");
    expect(review.body).toBe("LGTM!");
  });

  it("should construct GitHubSettings", () => {
    const settings: GitHubSettings = {
      apiToken: "ghp_test",
      owner: "org",
      repo: "project",
      branch: "main",
    };

    expect(settings.apiToken).toBe("ghp_test");
    expect(settings.branch).toBe("main");
  });

  it("should use valid state types", () => {
    const issueStates: IssueState[] = ["open", "closed"];
    const prStates: PullRequestState[] = ["open", "closed"];
    const mergeStates: MergeableState[] = ["mergeable", "conflicting", "unknown"];
    const reviewStates: ReviewState[] = [
      "APPROVED",
      "CHANGES_REQUESTED",
      "COMMENTED",
      "DISMISSED",
      "PENDING",
    ];

    expect(issueStates).toHaveLength(2);
    expect(prStates).toHaveLength(2);
    expect(mergeStates).toHaveLength(3);
    expect(reviewStates).toHaveLength(5);
  });

  it("should have valid event types", () => {
    const eventTypes: GitHubEventType[] = [
      "push",
      "pull_request",
      "pull_request_review",
      "pull_request_review_comment",
      "issues",
      "issue_comment",
      "create",
      "delete",
      "fork",
      "star",
      "watch",
      "release",
      "workflow_run",
      "check_run",
      "check_suite",
      "status",
    ];

    expect(eventTypes).toHaveLength(16);
    expect(eventTypes).toContain("push");
    expect(eventTypes).toContain("pull_request");
    expect(eventTypes).toContain("workflow_run");
  });
});

// =============================================================================
// Serialization / JSON round-trip
// =============================================================================

describe("JSON Serialization", () => {
  it("should serialize and parse RepositoryRef", () => {
    const ref: RepositoryRef = { owner: "org", repo: "project" };
    const json = JSON.stringify(ref);
    const parsed = JSON.parse(json) as RepositoryRef;
    expect(parsed.owner).toBe("org");
    expect(parsed.repo).toBe("project");
  });

  it("should serialize and parse FileChange", () => {
    const change: FileChange = {
      path: "src/index.ts",
      content: "export default {};",
      encoding: "utf-8",
      operation: "modify",
    };
    const json = JSON.stringify(change);
    const parsed = JSON.parse(json) as FileChange;
    expect(parsed.path).toBe("src/index.ts");
    expect(parsed.encoding).toBe("utf-8");
    expect(parsed.operation).toBe("modify");
  });

  it("should serialize and parse CreateIssueParams", () => {
    const params: CreateIssueParams = {
      owner: "org",
      repo: "project",
      title: "Test",
      body: "Body",
      labels: ["bug", "urgent"],
      assignees: ["user1"],
    };
    const json = JSON.stringify(params);
    const parsed = JSON.parse(json) as CreateIssueParams;
    expect(parsed.labels).toEqual(["bug", "urgent"]);
  });

  it("should serialize and parse GitHubLicense", () => {
    const license: GitHubLicense = {
      key: "mit",
      name: "MIT License",
      spdxId: "MIT",
      url: "https://api.github.com/licenses/mit",
    };
    const json = JSON.stringify(license);
    const parsed = JSON.parse(json) as GitHubLicense;
    expect(parsed.key).toBe("mit");
    expect(parsed.spdxId).toBe("MIT");
  });

  it("should serialize and parse GitHubMilestone", () => {
    const milestone: GitHubMilestone = {
      number: 1,
      title: "v1.0",
      description: "First release",
      state: "open",
      dueOn: "2024-12-31T00:00:00Z",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-06-01T00:00:00Z",
      closedAt: null,
      openIssues: 5,
      closedIssues: 10,
    };
    const json = JSON.stringify(milestone);
    const parsed = JSON.parse(json) as GitHubMilestone;
    expect(parsed.title).toBe("v1.0");
    expect(parsed.openIssues).toBe(5);
  });
});
