import { describe, expect, it } from "vitest";
import {
  BranchExistsError,
  BranchNotFoundError,
  ClientNotInitializedError,
  ConfigError,
  FileNotFoundError,
  GitHubApiError,
  GitHubError,
  GitOperationError,
  InvalidArgumentError,
  IssueNotFoundError,
  MergeConflictError,
  MissingSettingError,
  NetworkError,
  PermissionDeniedError,
  PullRequestNotFoundError,
  RateLimitedError,
  RepositoryNotFoundError,
  SecondaryRateLimitError,
  TimeoutError,
  ValidationError,
  WebhookVerificationError,
  mapOctokitError,
} from "../error";

// =============================================================================
// Error hierarchy
// =============================================================================

describe("Error hierarchy", () => {
  it("all errors should extend GitHubError", () => {
    const errors = [
      new GitHubError("test"),
      new ClientNotInitializedError(),
      new ConfigError("bad config"),
      new MissingSettingError("TOKEN"),
      new InvalidArgumentError("bad arg"),
      new RepositoryNotFoundError("owner", "repo"),
      new BranchNotFoundError("branch", "owner", "repo"),
      new FileNotFoundError("path", "owner", "repo"),
      new IssueNotFoundError(1, "owner", "repo"),
      new PullRequestNotFoundError(1, "owner", "repo"),
      new PermissionDeniedError("action"),
      new RateLimitedError(1000, 0, new Date()),
      new SecondaryRateLimitError(1000),
      new TimeoutError(5000, "operation"),
      new MergeConflictError(1, "owner", "repo"),
      new BranchExistsError("branch", "owner", "repo"),
      new ValidationError("field", "reason"),
      new GitHubApiError(500, "server error"),
      new NetworkError("connection refused"),
      new GitOperationError("push", "failed"),
      new WebhookVerificationError("invalid signature"),
    ];

    for (const err of errors) {
      expect(err).toBeInstanceOf(GitHubError);
      expect(err).toBeInstanceOf(Error);
    }
  });

  it("each error should have a descriptive name property", () => {
    expect(new GitHubError("test").name).toBe("GitHubError");
    expect(new ClientNotInitializedError().name).toBe("ClientNotInitializedError");
    expect(new ConfigError("msg").name).toBe("ConfigError");
    expect(new MissingSettingError("TOKEN").name).toBe("MissingSettingError");
    expect(new InvalidArgumentError("arg").name).toBe("InvalidArgumentError");
    expect(new PermissionDeniedError("action").name).toBe("PermissionDeniedError");
    expect(new NetworkError("msg").name).toBe("NetworkError");
    expect(new GitHubApiError(500, "msg").name).toBe("GitHubApiError");
    expect(new ValidationError("f", "r").name).toBe("ValidationError");
    expect(new GitOperationError("op", "reason").name).toBe("GitOperationError");
    expect(new WebhookVerificationError("reason").name).toBe("WebhookVerificationError");
  });
});

// =============================================================================
// Error messages
// =============================================================================

describe("Error messages", () => {
  it("ClientNotInitializedError should reference initialization", () => {
    const err = new ClientNotInitializedError();
    expect(err.message).toContain("not initialized");
    expect(err.message).toContain("GITHUB_API_TOKEN");
  });

  it("ConfigError should include the config message", () => {
    const err = new ConfigError("branch invalid");
    expect(err.message).toContain("Configuration error");
    expect(err.message).toContain("branch invalid");
  });

  it("MissingSettingError should include setting name", () => {
    const err = new MissingSettingError("GITHUB_API_TOKEN");
    expect(err.message).toContain("GITHUB_API_TOKEN");
    expect(err.settingName).toBe("GITHUB_API_TOKEN");
  });

  it("InvalidArgumentError should include argument info", () => {
    const err = new InvalidArgumentError("owner cannot be empty");
    expect(err.message).toContain("Invalid argument");
    expect(err.message).toContain("owner cannot be empty");
  });

  it("BranchNotFoundError should include branch and repo", () => {
    const err = new BranchNotFoundError("feature/x", "org", "repo");
    expect(err.message).toContain("feature/x");
    expect(err.message).toContain("org/repo");
    expect(err.branch).toBe("feature/x");
  });

  it("FileNotFoundError should include path and repo", () => {
    const err = new FileNotFoundError("src/main.ts", "org", "repo");
    expect(err.message).toContain("src/main.ts");
    expect(err.message).toContain("org/repo");
    expect(err.path).toBe("src/main.ts");
  });

  it("IssueNotFoundError should include issue number and repo", () => {
    const err = new IssueNotFoundError(42, "org", "repo");
    expect(err.message).toContain("#42");
    expect(err.message).toContain("org/repo");
    expect(err.issueNumber).toBe(42);
  });

  it("PullRequestNotFoundError should include PR number and repo", () => {
    const err = new PullRequestNotFoundError(99, "org", "repo");
    expect(err.message).toContain("#99");
    expect(err.message).toContain("org/repo");
    expect(err.pullNumber).toBe(99);
  });

  it("MergeConflictError should include PR number and repo", () => {
    const err = new MergeConflictError(10, "org", "repo");
    expect(err.message).toContain("#10");
    expect(err.message).toContain("org/repo");
    expect(err.pullNumber).toBe(10);
  });

  it("BranchExistsError should include branch and repo", () => {
    const err = new BranchExistsError("main", "org", "repo");
    expect(err.message).toContain("main");
    expect(err.message).toContain("org/repo");
    expect(err.branch).toBe("main");
  });

  it("ValidationError should include field and reason", () => {
    const err = new ValidationError("title", "cannot be empty");
    expect(err.message).toContain("title");
    expect(err.message).toContain("cannot be empty");
    expect(err.field).toBe("title");
  });

  it("GitHubApiError should include status and message", () => {
    const err = new GitHubApiError(404, "Not Found", "not_found", "https://docs.github.com");
    expect(err.message).toContain("404");
    expect(err.message).toContain("Not Found");
    expect(err.status).toBe(404);
    expect(err.code).toBe("not_found");
    expect(err.documentationUrl).toBe("https://docs.github.com");
  });

  it("GitHubApiError should handle null code and docUrl", () => {
    const err = new GitHubApiError(500, "Internal Error");
    expect(err.status).toBe(500);
    expect(err.code).toBeNull();
    expect(err.documentationUrl).toBeNull();
  });
});

// =============================================================================
// Retryable errors
// =============================================================================

describe("Retryable errors", () => {
  it("RateLimitedError should be retryable", () => {
    const resetAt = new Date(Date.now() + 60000);
    const err = new RateLimitedError(5000, 0, resetAt);
    expect(err.isRetryable()).toBe(true);
    expect(err.retryAfterMs()).toBe(5000);
    expect(err.remaining).toBe(0);
    expect(err.resetAt).toBe(resetAt);
  });

  it("SecondaryRateLimitError should be retryable", () => {
    const err = new SecondaryRateLimitError(30000);
    expect(err.isRetryable()).toBe(true);
    expect(err.retryAfterMs()).toBe(30000);
  });

  it("TimeoutError should be retryable with half timeout", () => {
    const err = new TimeoutError(10000, "API call");
    expect(err.isRetryable()).toBe(true);
    expect(err.retryAfterMs()).toBe(5000); // half of 10000
  });

  it("NetworkError should be retryable with 1s default", () => {
    const err = new NetworkError("ECONNREFUSED");
    expect(err.isRetryable()).toBe(true);
    expect(err.retryAfterMs()).toBe(1000);
  });

  it("GitHubApiError 5xx should be retryable", () => {
    const err = new GitHubApiError(500, "Internal Server Error");
    expect(err.isRetryable()).toBe(true);
  });

  it("GitHubApiError 4xx should NOT be retryable", () => {
    const err = new GitHubApiError(400, "Bad Request");
    expect(err.isRetryable()).toBe(false);
  });

  it("base GitHubError should NOT be retryable", () => {
    const err = new GitHubError("generic error");
    expect(err.isRetryable()).toBe(false);
    expect(err.retryAfterMs()).toBeNull();
  });

  it("ConfigError should NOT be retryable", () => {
    const err = new ConfigError("bad config");
    expect(err.isRetryable()).toBe(false);
  });

  it("MissingSettingError should NOT be retryable", () => {
    const err = new MissingSettingError("TOKEN");
    expect(err.isRetryable()).toBe(false);
  });
});

// =============================================================================
// mapOctokitError
// =============================================================================

describe("mapOctokitError", () => {
  it("should map 401 to PermissionDeniedError", () => {
    const error = { status: 401, message: "Bad credentials" };
    const mapped = mapOctokitError(error, "org", "repo");
    expect(mapped).toBeInstanceOf(PermissionDeniedError);
    expect(mapped.message).toContain("authentication");
  });

  it("should map 403 with rate limit headers to RateLimitedError", () => {
    const resetTime = Math.floor(Date.now() / 1000) + 60;
    const error = {
      status: 403,
      response: {
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(resetTime),
        },
        data: { message: "API rate limit exceeded" },
      },
    };
    const mapped = mapOctokitError(error, "org", "repo");
    expect(mapped).toBeInstanceOf(RateLimitedError);
  });

  it("should map 403 with retry-after to SecondaryRateLimitError", () => {
    const error = {
      status: 403,
      response: {
        headers: {
          "retry-after": "120",
        },
        data: { message: "secondary rate limit" },
      },
    };
    const mapped = mapOctokitError(error, "org", "repo");
    expect(mapped).toBeInstanceOf(SecondaryRateLimitError);
  });

  it("should map 403 without rate headers to PermissionDeniedError", () => {
    const error = {
      status: 403,
      response: {
        data: { message: "Forbidden" },
      },
    };
    const mapped = mapOctokitError(error, "org", "repo");
    expect(mapped).toBeInstanceOf(PermissionDeniedError);
  });

  it("should map 404 to appropriate not-found errors based on message", () => {
    const branchErr = {
      status: 404,
      response: { data: { message: "Branch not found" } },
    };
    expect(mapOctokitError(branchErr, "org", "repo")).toBeInstanceOf(BranchNotFoundError);

    const issueErr = {
      status: 404,
      response: { data: { message: "Issue not found" } },
    };
    expect(mapOctokitError(issueErr, "org", "repo")).toBeInstanceOf(IssueNotFoundError);

    const prErr = {
      status: 404,
      response: { data: { message: "Pull request not found" } },
    };
    expect(mapOctokitError(prErr, "org", "repo")).toBeInstanceOf(PullRequestNotFoundError);
  });

  it("should map 409 merge conflict to MergeConflictError", () => {
    const error = {
      status: 409,
      response: { data: { message: "Merge conflict" } },
    };
    const mapped = mapOctokitError(error, "org", "repo");
    expect(mapped).toBeInstanceOf(MergeConflictError);
  });

  it("should map 409 already exists to BranchExistsError", () => {
    const error = {
      status: 409,
      response: { data: { message: "Reference already exists" } },
    };
    const mapped = mapOctokitError(error, "org", "repo");
    expect(mapped).toBeInstanceOf(BranchExistsError);
  });

  it("should map 422 to ValidationError", () => {
    const error = {
      status: 422,
      response: {
        data: {
          message: "Validation failed",
          errors: [{ field: "title", message: "is required" }],
        },
      },
    };
    const mapped = mapOctokitError(error, "org", "repo");
    expect(mapped).toBeInstanceOf(ValidationError);
  });

  it("should map 429 to SecondaryRateLimitError", () => {
    const error = {
      status: 429,
      response: {
        headers: { "retry-after": "60" },
        data: { message: "rate limited" },
      },
    };
    const mapped = mapOctokitError(error, "org", "repo");
    expect(mapped).toBeInstanceOf(SecondaryRateLimitError);
  });

  it("should map network errors to NetworkError", () => {
    const error = new Error("fetch failed");
    const mapped = mapOctokitError(error, "org", "repo");
    expect(mapped).toBeInstanceOf(NetworkError);
  });

  it("should map ECONNREFUSED to NetworkError", () => {
    const error = new Error("connect ECONNREFUSED 127.0.0.1:443");
    const mapped = mapOctokitError(error, "org", "repo");
    expect(mapped).toBeInstanceOf(NetworkError);
  });

  it("should map unknown errors to GitHubError", () => {
    const mapped = mapOctokitError("some string error", "org", "repo");
    expect(mapped).toBeInstanceOf(GitHubError);
    expect(mapped.message).toContain("some string error");
  });

  it("should map Error instances to GitHubError", () => {
    const error = new Error("something went wrong");
    const mapped = mapOctokitError(error, "org", "repo");
    expect(mapped).toBeInstanceOf(GitHubError);
  });
});
