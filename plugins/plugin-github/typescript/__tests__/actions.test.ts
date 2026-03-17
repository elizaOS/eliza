import { describe, expect, it, vi } from "vitest";

// Mock the spec helpers before importing actions, since the action modules
// call requireActionSpec() at the top level and the generated spec names
// (CREATE_GITHUB_ISSUE) don't match the short lookup keys (CREATE_ISSUE).
vi.mock("../generated/specs/spec-helpers", () => ({
  requireActionSpec: (_name: string) => ({
    name: _name,
    description: `Mock spec for ${_name}`,
    similes: [],
  }),
  requireProviderSpec: (_name: string) => ({
    name: _name,
    description: `Mock spec for ${_name}`,
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

import { allActions } from "../actions";
import { createBranchAction } from "../actions/createBranch";
import { createCommentAction } from "../actions/createComment";
import { createIssueAction } from "../actions/createIssue";
import { createPullRequestAction } from "../actions/createPullRequest";
import { mergePullRequestAction } from "../actions/mergePullRequest";
import { pushCodeAction } from "../actions/pushCode";
import { reviewPullRequestAction } from "../actions/reviewPullRequest";

// =============================================================================
// Helpers
// =============================================================================

function mockRuntime(serviceAvailable: boolean) {
  return {
    getService: vi.fn().mockReturnValue(
      serviceAvailable
        ? {
            getConfig: () => ({
              apiToken: "ghp_test",
              owner: "test-owner",
              repo: "test-repo",
              branch: "main",
            }),
          }
        : undefined
    ),
    getSetting: vi.fn().mockReturnValue(null),
  };
}

function mockMessage(text: string) {
  return {
    content: { text },
    userId: "test-user",
    roomId: "test-room",
  };
}

// =============================================================================
// All actions export
// =============================================================================

describe("allActions export", () => {
  it("should export exactly 7 actions", () => {
    expect(allActions).toHaveLength(7);
  });

  it("should have unique action names", () => {
    const names = allActions.map((a) => a.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("should include all expected action names", () => {
    const names = allActions.map((a) => a.name);
    expect(names).toContain("CREATE_GITHUB_ISSUE");
    expect(names).toContain("CREATE_GITHUB_PULL_REQUEST");
    expect(names).toContain("CREATE_GITHUB_COMMENT");
    expect(names).toContain("CREATE_GITHUB_BRANCH");
    expect(names).toContain("MERGE_GITHUB_PULL_REQUEST");
    expect(names).toContain("PUSH_GITHUB_CODE");
    expect(names).toContain("REVIEW_GITHUB_PULL_REQUEST");
  });

  it("all actions should have descriptions", () => {
    for (const action of allActions) {
      expect(typeof action.description).toBe("string");
    }
  });

  it("all actions should have examples", () => {
    for (const action of allActions) {
      expect(action.examples).toBeDefined();
      expect(Array.isArray(action.examples)).toBe(true);
    }
  });
});

// =============================================================================
// createIssueAction
// =============================================================================

describe("createIssueAction", () => {
  it("should have correct name", () => {
    expect(createIssueAction.name).toBe("CREATE_GITHUB_ISSUE");
  });

  it("should validate when message contains 'issue'", async () => {
    const runtime = mockRuntime(true);
    const message = mockMessage("Create an issue for this bug");
    const result = await createIssueAction.validate(runtime as never, message as never);
    expect(result).toBe(true);
  });

  it("should validate when message contains 'bug'", async () => {
    const runtime = mockRuntime(true);
    const message = mockMessage("Found a bug in login");
    const result = await createIssueAction.validate(runtime as never, message as never);
    expect(result).toBe(true);
  });

  it("should validate when message contains 'report'", async () => {
    const runtime = mockRuntime(true);
    const message = mockMessage("I want to report a problem");
    const result = await createIssueAction.validate(runtime as never, message as never);
    expect(result).toBe(true);
  });

  it("should validate when message contains 'ticket'", async () => {
    const runtime = mockRuntime(true);
    const message = mockMessage("Open a ticket for this");
    const result = await createIssueAction.validate(runtime as never, message as never);
    expect(result).toBe(true);
  });

  it("should not validate when no keywords present", async () => {
    const runtime = mockRuntime(true);
    const message = mockMessage("Hello world");
    const result = await createIssueAction.validate(runtime as never, message as never);
    expect(result).toBe(false);
  });

  it("should not validate when service is not available", async () => {
    const runtime = mockRuntime(false);
    const message = mockMessage("Create an issue");
    const result = await createIssueAction.validate(runtime as never, message as never);
    expect(result).toBe(false);
  });
});

// =============================================================================
// createPullRequestAction
// =============================================================================

describe("createPullRequestAction", () => {
  it("should have correct name", () => {
    expect(createPullRequestAction.name).toBe("CREATE_GITHUB_PULL_REQUEST");
  });

  it("should validate when message contains 'pull request'", async () => {
    const runtime = mockRuntime(true);
    const message = mockMessage("Create a pull request");
    const result = await createPullRequestAction.validate(runtime as never, message as never);
    expect(result).toBe(true);
  });

  it("should validate when message contains 'pr'", async () => {
    const runtime = mockRuntime(true);
    const message = mockMessage("Open a PR from feature to main");
    const result = await createPullRequestAction.validate(runtime as never, message as never);
    expect(result).toBe(true);
  });

  it("should validate when message contains 'merge'", async () => {
    const runtime = mockRuntime(true);
    const message = mockMessage("I want to merge my branch");
    const result = await createPullRequestAction.validate(runtime as never, message as never);
    expect(result).toBe(true);
  });

  it("should not validate without keywords", async () => {
    const runtime = mockRuntime(true);
    const message = mockMessage("Hello world");
    const result = await createPullRequestAction.validate(runtime as never, message as never);
    expect(result).toBe(false);
  });

  it("should not validate when service is not available", async () => {
    const runtime = mockRuntime(false);
    const message = mockMessage("Create a pull request");
    const result = await createPullRequestAction.validate(runtime as never, message as never);
    expect(result).toBe(false);
  });
});

// =============================================================================
// createCommentAction
// =============================================================================

describe("createCommentAction", () => {
  it("should have correct name", () => {
    expect(createCommentAction.name).toBe("CREATE_GITHUB_COMMENT");
  });

  it("should validate when message contains 'comment'", async () => {
    const runtime = mockRuntime(true);
    const message = mockMessage("Comment on issue #42");
    const result = await createCommentAction.validate(runtime as never, message as never);
    expect(result).toBe(true);
  });

  it("should validate when message contains 'reply'", async () => {
    const runtime = mockRuntime(true);
    const message = mockMessage("Reply to this PR");
    const result = await createCommentAction.validate(runtime as never, message as never);
    expect(result).toBe(true);
  });

  it("should validate when message contains 'respond'", async () => {
    const runtime = mockRuntime(true);
    const message = mockMessage("Respond to the feedback");
    const result = await createCommentAction.validate(runtime as never, message as never);
    expect(result).toBe(true);
  });

  it("should not validate without keywords", async () => {
    const runtime = mockRuntime(true);
    const message = mockMessage("Hello world");
    const result = await createCommentAction.validate(runtime as never, message as never);
    expect(result).toBe(false);
  });

  it("should not validate when service is not available", async () => {
    const runtime = mockRuntime(false);
    const message = mockMessage("Comment on issue");
    const result = await createCommentAction.validate(runtime as never, message as never);
    expect(result).toBe(false);
  });
});

// =============================================================================
// createBranchAction
// =============================================================================

describe("createBranchAction", () => {
  it("should have correct name", () => {
    expect(createBranchAction.name).toBe("CREATE_GITHUB_BRANCH");
  });

  it("should validate when message contains 'branch'", async () => {
    const runtime = mockRuntime(true);
    const message = mockMessage("Create a branch called feature/new");
    const result = await createBranchAction.validate(runtime as never, message as never);
    expect(result).toBe(true);
  });

  it("should validate when message contains 'checkout'", async () => {
    const runtime = mockRuntime(true);
    const message = mockMessage("Checkout a new feature branch");
    const result = await createBranchAction.validate(runtime as never, message as never);
    expect(result).toBe(true);
  });

  it("should not validate without keywords", async () => {
    const runtime = mockRuntime(true);
    const message = mockMessage("Hello world");
    const result = await createBranchAction.validate(runtime as never, message as never);
    expect(result).toBe(false);
  });

  it("should not validate when service is not available", async () => {
    const runtime = mockRuntime(false);
    const message = mockMessage("Create a branch");
    const result = await createBranchAction.validate(runtime as never, message as never);
    expect(result).toBe(false);
  });
});

// =============================================================================
// mergePullRequestAction
// =============================================================================

describe("mergePullRequestAction", () => {
  it("should have correct name", () => {
    expect(mergePullRequestAction.name).toBe("MERGE_GITHUB_PULL_REQUEST");
  });

  it("should validate when message contains 'merge'", async () => {
    const runtime = mockRuntime(true);
    const message = mockMessage("Merge pull request #42");
    const result = await mergePullRequestAction.validate(runtime as never, message as never);
    expect(result).toBe(true);
  });

  it("should not validate without keywords", async () => {
    const runtime = mockRuntime(true);
    const message = mockMessage("Hello world");
    const result = await mergePullRequestAction.validate(runtime as never, message as never);
    expect(result).toBe(false);
  });

  it("should not validate when service is not available", async () => {
    const runtime = mockRuntime(false);
    const message = mockMessage("Merge this PR");
    const result = await mergePullRequestAction.validate(runtime as never, message as never);
    expect(result).toBe(false);
  });
});

// =============================================================================
// pushCodeAction
// =============================================================================

describe("pushCodeAction", () => {
  it("should have correct name", () => {
    expect(pushCodeAction.name).toBe("PUSH_GITHUB_CODE");
  });

  it("should validate when message contains 'push'", async () => {
    const runtime = mockRuntime(true);
    const message = mockMessage("Push these changes");
    const result = await pushCodeAction.validate(runtime as never, message as never);
    expect(result).toBe(true);
  });

  it("should validate when message contains 'commit'", async () => {
    const runtime = mockRuntime(true);
    const message = mockMessage("Commit this file");
    const result = await pushCodeAction.validate(runtime as never, message as never);
    expect(result).toBe(true);
  });

  it("should validate when message contains 'save'", async () => {
    const runtime = mockRuntime(true);
    const message = mockMessage("Save these changes to the repo");
    const result = await pushCodeAction.validate(runtime as never, message as never);
    expect(result).toBe(true);
  });

  it("should validate when message contains 'upload'", async () => {
    const runtime = mockRuntime(true);
    const message = mockMessage("Upload the files");
    const result = await pushCodeAction.validate(runtime as never, message as never);
    expect(result).toBe(true);
  });

  it("should not validate without keywords", async () => {
    const runtime = mockRuntime(true);
    const message = mockMessage("Hello world");
    const result = await pushCodeAction.validate(runtime as never, message as never);
    expect(result).toBe(false);
  });

  it("should not validate when service is not available", async () => {
    const runtime = mockRuntime(false);
    const message = mockMessage("Push these changes");
    const result = await pushCodeAction.validate(runtime as never, message as never);
    expect(result).toBe(false);
  });
});

// =============================================================================
// reviewPullRequestAction
// =============================================================================

describe("reviewPullRequestAction", () => {
  it("should have correct name", () => {
    expect(reviewPullRequestAction.name).toBe("REVIEW_GITHUB_PULL_REQUEST");
  });

  it("should validate when message contains 'review'", async () => {
    const runtime = mockRuntime(true);
    const message = mockMessage("Review this pull request");
    const result = await reviewPullRequestAction.validate(runtime as never, message as never);
    expect(result).toBe(true);
  });

  it("should validate when message contains 'approve'", async () => {
    const runtime = mockRuntime(true);
    const message = mockMessage("Approve PR #42");
    const result = await reviewPullRequestAction.validate(runtime as never, message as never);
    expect(result).toBe(true);
  });

  it("should validate when message contains 'request changes'", async () => {
    const runtime = mockRuntime(true);
    const message = mockMessage("Request changes on this PR");
    const result = await reviewPullRequestAction.validate(runtime as never, message as never);
    expect(result).toBe(true);
  });

  it("should validate when message contains 'lgtm'", async () => {
    const runtime = mockRuntime(true);
    const message = mockMessage("LGTM on this change");
    const result = await reviewPullRequestAction.validate(runtime as never, message as never);
    expect(result).toBe(true);
  });

  it("should not validate without keywords", async () => {
    const runtime = mockRuntime(true);
    const message = mockMessage("Hello world");
    const result = await reviewPullRequestAction.validate(runtime as never, message as never);
    expect(result).toBe(false);
  });

  it("should not validate when service is not available", async () => {
    const runtime = mockRuntime(false);
    const message = mockMessage("Review this PR");
    const result = await reviewPullRequestAction.validate(runtime as never, message as never);
    expect(result).toBe(false);
  });
});

// =============================================================================
// Case insensitivity
// =============================================================================

describe("case insensitivity", () => {
  it("should match keywords regardless of case", async () => {
    const runtime = mockRuntime(true);

    const results = await Promise.all([
      createIssueAction.validate(runtime as never, mockMessage("ISSUE here") as never),
      createIssueAction.validate(runtime as never, mockMessage("Issue here") as never),
      createIssueAction.validate(runtime as never, mockMessage("iSsUe here") as never),
      pushCodeAction.validate(runtime as never, mockMessage("PUSH changes") as never),
      pushCodeAction.validate(runtime as never, mockMessage("COMMIT files") as never),
      reviewPullRequestAction.validate(runtime as never, mockMessage("APPROVE it") as never),
      reviewPullRequestAction.validate(runtime as never, mockMessage("Lgtm") as never),
    ]);

    expect(results.every((r) => r === true)).toBe(true);
  });
});
