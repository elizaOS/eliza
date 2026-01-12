export class GitHubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubError";
    Object.setPrototypeOf(this, GitHubError.prototype);
  }

  isRetryable(): boolean {
    return false;
  }

  retryAfterMs(): number | null {
    return null;
  }
}

export class ClientNotInitializedError extends GitHubError {
  constructor() {
    super("GitHub client not initialized - ensure GITHUB_API_TOKEN is configured");
    this.name = "ClientNotInitializedError";
    Object.setPrototypeOf(this, ClientNotInitializedError.prototype);
  }
}

export class ConfigError extends GitHubError {
  constructor(message: string) {
    super(`Configuration error: ${message}`);
    this.name = "ConfigError";
    Object.setPrototypeOf(this, ConfigError.prototype);
  }
}

export class MissingSettingError extends GitHubError {
  public readonly settingName: string;

  constructor(settingName: string) {
    super(`Missing required setting: ${settingName}`);
    this.name = "MissingSettingError";
    this.settingName = settingName;
    Object.setPrototypeOf(this, MissingSettingError.prototype);
  }
}

export class InvalidArgumentError extends GitHubError {
  constructor(message: string) {
    super(`Invalid argument: ${message}`);
    this.name = "InvalidArgumentError";
    Object.setPrototypeOf(this, InvalidArgumentError.prototype);
  }
}

export class RepositoryNotFoundError extends GitHubError {
  public readonly owner: string;
  public readonly repo: string;

  constructor(owner: string, repo: string) {
    super(`Repository not found: ${owner}/${repo}`);
    this.name = "RepositoryNotFoundError";
    this.owner = owner;
    this.repo = repo;
    Object.setPrototypeOf(this, RepositoryNotFoundError.prototype);
  }
}

export class BranchNotFoundError extends GitHubError {
  public readonly branch: string;

  constructor(branch: string, owner: string, repo: string) {
    super(`Branch not found: ${branch} in ${owner}/${repo}`);
    this.name = "BranchNotFoundError";
    this.branch = branch;
    Object.setPrototypeOf(this, BranchNotFoundError.prototype);
  }
}

export class FileNotFoundError extends GitHubError {
  public readonly path: string;

  constructor(path: string, owner: string, repo: string) {
    super(`File not found: ${path} in ${owner}/${repo}`);
    this.name = "FileNotFoundError";
    this.path = path;
    Object.setPrototypeOf(this, FileNotFoundError.prototype);
  }
}

export class IssueNotFoundError extends GitHubError {
  public readonly issueNumber: number;

  constructor(issueNumber: number, owner: string, repo: string) {
    super(`Issue #${issueNumber} not found in ${owner}/${repo}`);
    this.name = "IssueNotFoundError";
    this.issueNumber = issueNumber;
    Object.setPrototypeOf(this, IssueNotFoundError.prototype);
  }
}

export class PullRequestNotFoundError extends GitHubError {
  public readonly pullNumber: number;

  constructor(pullNumber: number, owner: string, repo: string) {
    super(`Pull request #${pullNumber} not found in ${owner}/${repo}`);
    this.name = "PullRequestNotFoundError";
    this.pullNumber = pullNumber;
    Object.setPrototypeOf(this, PullRequestNotFoundError.prototype);
  }
}

export class PermissionDeniedError extends GitHubError {
  constructor(action: string) {
    super(`Permission denied: ${action}`);
    this.name = "PermissionDeniedError";
    Object.setPrototypeOf(this, PermissionDeniedError.prototype);
  }
}

export class RateLimitedError extends GitHubError {
  private readonly _retryAfterMs: number;
  public readonly remaining: number;
  public readonly resetAt: Date;

  constructor(retryAfterMs: number, remaining: number, resetAt: Date) {
    super(`Rate limited by GitHub API, retry after ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = "RateLimitedError";
    this._retryAfterMs = retryAfterMs;
    this.remaining = remaining;
    this.resetAt = resetAt;
    Object.setPrototypeOf(this, RateLimitedError.prototype);
  }

  override isRetryable(): boolean {
    return true;
  }

  override retryAfterMs(): number {
    return this._retryAfterMs;
  }
}

export class SecondaryRateLimitError extends GitHubError {
  private readonly _retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super(`Secondary rate limit hit, retry after ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = "SecondaryRateLimitError";
    this._retryAfterMs = retryAfterMs;
    Object.setPrototypeOf(this, SecondaryRateLimitError.prototype);
  }

  override isRetryable(): boolean {
    return true;
  }

  override retryAfterMs(): number {
    return this._retryAfterMs;
  }
}

export class TimeoutError extends GitHubError {
  private readonly _timeoutMs: number;

  constructor(timeoutMs: number, operation: string) {
    super(`Operation timed out after ${timeoutMs}ms: ${operation}`);
    this.name = "TimeoutError";
    this._timeoutMs = timeoutMs;
    Object.setPrototypeOf(this, TimeoutError.prototype);
  }

  override isRetryable(): boolean {
    return true;
  }

  override retryAfterMs(): number {
    return Math.floor(this._timeoutMs / 2);
  }
}

export class MergeConflictError extends GitHubError {
  public readonly pullNumber: number;

  constructor(pullNumber: number, owner: string, repo: string) {
    super(`Merge conflict in pull request #${pullNumber} in ${owner}/${repo}`);
    this.name = "MergeConflictError";
    this.pullNumber = pullNumber;
    Object.setPrototypeOf(this, MergeConflictError.prototype);
  }
}

export class BranchExistsError extends GitHubError {
  public readonly branch: string;

  constructor(branch: string, owner: string, repo: string) {
    super(`Branch already exists: ${branch} in ${owner}/${repo}`);
    this.name = "BranchExistsError";
    this.branch = branch;
    Object.setPrototypeOf(this, BranchExistsError.prototype);
  }
}

export class ValidationError extends GitHubError {
  public readonly field: string;

  constructor(field: string, reason: string) {
    super(`Validation failed for ${field}: ${reason}`);
    this.name = "ValidationError";
    this.field = field;
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

export class GitHubApiError extends GitHubError {
  public readonly status: number;
  public readonly code: string | null;
  public readonly documentationUrl: string | null;

  constructor(
    status: number,
    message: string,
    code: string | null = null,
    documentationUrl: string | null = null
  ) {
    super(`GitHub API error (${status}): ${message}`);
    this.name = "GitHubApiError";
    this.status = status;
    this.code = code;
    this.documentationUrl = documentationUrl;
    Object.setPrototypeOf(this, GitHubApiError.prototype);
  }

  override isRetryable(): boolean {
    return this.status >= 500;
  }
}

export class NetworkError extends GitHubError {
  constructor(message: string) {
    super(`Network error: ${message}`);
    this.name = "NetworkError";
    Object.setPrototypeOf(this, NetworkError.prototype);
  }

  override isRetryable(): boolean {
    return true;
  }

  override retryAfterMs(): number {
    return 1000;
  }
}

export class GitOperationError extends GitHubError {
  public readonly operation: string;

  constructor(operation: string, reason: string) {
    super(`Git operation failed (${operation}): ${reason}`);
    this.name = "GitOperationError";
    this.operation = operation;
    Object.setPrototypeOf(this, GitOperationError.prototype);
  }
}

export class WebhookVerificationError extends GitHubError {
  constructor(reason: string) {
    super(`Webhook verification failed: ${reason}`);
    this.name = "WebhookVerificationError";
    Object.setPrototypeOf(this, WebhookVerificationError.prototype);
  }
}

interface OctokitErrorResponse {
  status: number;
  message?: string;
  response?: {
    headers?: {
      "retry-after"?: string;
      "x-ratelimit-remaining"?: string;
      "x-ratelimit-reset"?: string;
    };
    data?: {
      message?: string;
      errors?: Array<{ code?: string; field?: string; message?: string }>;
      documentation_url?: string;
    };
  };
}

export function mapOctokitError(error: unknown, owner: string, repo: string): GitHubError {
  if (error && typeof error === "object" && "status" in error && typeof error.status === "number") {
    const err = error as OctokitErrorResponse;

    const message = err.response?.data?.message ?? err.message ?? "Unknown error";
    const docUrl = err.response?.data?.documentation_url ?? null;

    switch (err.status) {
      case 401:
        return new PermissionDeniedError("Invalid or missing authentication token");

      case 403: {
        const remaining = err.response?.headers?.["x-ratelimit-remaining"];
        const reset = err.response?.headers?.["x-ratelimit-reset"];

        if (remaining === "0" && reset) {
          const resetTime = new Date(Number(reset) * 1000);
          const retryAfter = resetTime.getTime() - Date.now();
          return new RateLimitedError(Math.max(retryAfter, 0), 0, resetTime);
        }

        const retryAfter = err.response?.headers?.["retry-after"];
        if (retryAfter) {
          return new SecondaryRateLimitError(Number(retryAfter) * 1000);
        }

        return new PermissionDeniedError(message);
      }

      case 404:
        if (message.toLowerCase().includes("branch")) {
          return new BranchNotFoundError("", owner, repo);
        }
        if (message.toLowerCase().includes("issue")) {
          return new IssueNotFoundError(0, owner, repo);
        }
        if (message.toLowerCase().includes("pull")) {
          return new PullRequestNotFoundError(0, owner, repo);
        }
        return new RepositoryNotFoundError(owner, repo);

      case 409:
        if (message.toLowerCase().includes("merge")) {
          return new MergeConflictError(0, owner, repo);
        }
        if (message.toLowerCase().includes("already exists")) {
          return new BranchExistsError("", owner, repo);
        }
        return new GitHubApiError(err.status, message, null, docUrl);

      case 422: {
        const errors = err.response?.data?.errors ?? [];
        if (errors.length > 0) {
          const firstError = errors[0];
          return new ValidationError(firstError?.field ?? "", firstError?.message ?? message);
        }
        return new ValidationError("", message);
      }

      case 429: {
        const retryAfter = err.response?.headers?.["retry-after"];
        return new SecondaryRateLimitError(retryAfter ? Number(retryAfter) * 1000 : 60000);
      }

      default:
        return new GitHubApiError(err.status, message, null, docUrl);
    }
  }

  if (
    error instanceof Error &&
    (error.message.includes("ECONNREFUSED") ||
      error.message.includes("ETIMEDOUT") ||
      error.message.includes("ENOTFOUND") ||
      error.message.includes("fetch failed"))
  ) {
    return new NetworkError(error.message);
  }

  if (error instanceof Error) {
    return new GitHubError(error.message);
  }

  return new GitHubError(String(error));
}
