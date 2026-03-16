from datetime import datetime


class GitHubError(Exception):
    def __init__(self, message: str) -> None:
        self.message = message
        super().__init__(message)

    def is_retryable(self) -> bool:
        return False

    def retry_after_ms(self) -> int | None:
        return None


class ClientNotInitializedError(GitHubError):
    def __init__(self) -> None:
        super().__init__("GitHub client not initialized - ensure GITHUB_API_TOKEN is configured")


class ConfigError(GitHubError):
    def __init__(self, message: str) -> None:
        super().__init__(f"Configuration error: {message}")


class MissingSettingError(GitHubError):
    def __init__(self, setting_name: str) -> None:
        self.setting_name = setting_name
        super().__init__(f"Missing required setting: {setting_name}")


class InvalidArgumentError(GitHubError):
    def __init__(self, message: str) -> None:
        super().__init__(f"Invalid argument: {message}")


class RepositoryNotFoundError(GitHubError):
    def __init__(self, owner: str, repo: str) -> None:
        self.owner = owner
        self.repo = repo
        super().__init__(f"Repository not found: {owner}/{repo}")


class BranchNotFoundError(GitHubError):
    def __init__(self, branch: str, owner: str, repo: str) -> None:
        self.branch = branch
        super().__init__(f"Branch not found: {branch} in {owner}/{repo}")


class FileNotFoundError(GitHubError):
    def __init__(self, path: str, owner: str, repo: str) -> None:
        self.path = path
        super().__init__(f"File not found: {path} in {owner}/{repo}")


class IssueNotFoundError(GitHubError):
    def __init__(self, issue_number: int, owner: str, repo: str) -> None:
        self.issue_number = issue_number
        super().__init__(f"Issue #{issue_number} not found in {owner}/{repo}")


class PullRequestNotFoundError(GitHubError):
    def __init__(self, pull_number: int, owner: str, repo: str) -> None:
        self.pull_number = pull_number
        super().__init__(f"Pull request #{pull_number} not found in {owner}/{repo}")


class PermissionDeniedError(GitHubError):
    def __init__(self, action: str) -> None:
        super().__init__(f"Permission denied: {action}")


class RateLimitedError(GitHubError):
    def __init__(self, retry_after_ms: int, remaining: int, reset_at: datetime) -> None:
        self._retry_after_ms = retry_after_ms
        self.remaining = remaining
        self.reset_at = reset_at
        super().__init__(f"Rate limited by GitHub API, retry after {retry_after_ms // 1000}s")

    def is_retryable(self) -> bool:
        return True

    def retry_after_ms(self) -> int | None:
        return self._retry_after_ms


class SecondaryRateLimitError(GitHubError):
    def __init__(self, retry_after_ms: int) -> None:
        self._retry_after_ms = retry_after_ms
        super().__init__(f"Secondary rate limit hit, retry after {retry_after_ms // 1000}s")

    def is_retryable(self) -> bool:
        return True

    def retry_after_ms(self) -> int | None:
        return self._retry_after_ms


class TimeoutError(GitHubError):
    def __init__(self, timeout_ms: int, operation: str) -> None:
        self._timeout_ms = timeout_ms
        super().__init__(f"Operation timed out after {timeout_ms}ms: {operation}")

    def is_retryable(self) -> bool:
        return True

    def retry_after_ms(self) -> int | None:
        return self._timeout_ms // 2


class MergeConflictError(GitHubError):
    def __init__(self, pull_number: int, owner: str, repo: str) -> None:
        self.pull_number = pull_number
        super().__init__(f"Merge conflict in pull request #{pull_number} in {owner}/{repo}")


class BranchExistsError(GitHubError):
    def __init__(self, branch: str, owner: str, repo: str) -> None:
        self.branch = branch
        super().__init__(f"Branch already exists: {branch} in {owner}/{repo}")


class ValidationError(GitHubError):
    def __init__(self, field: str, reason: str) -> None:
        self.field = field
        super().__init__(f"Validation failed for {field}: {reason}")


class GitHubApiError(GitHubError):
    def __init__(
        self,
        status: int,
        message: str,
        code: str | None = None,
        documentation_url: str | None = None,
    ) -> None:
        self.status = status
        self.code = code
        self.documentation_url = documentation_url
        super().__init__(f"GitHub API error ({status}): {message}")

    def is_retryable(self) -> bool:
        return self.status >= 500


class NetworkError(GitHubError):
    def __init__(self, message: str) -> None:
        super().__init__(f"Network error: {message}")

    def is_retryable(self) -> bool:
        return True

    def retry_after_ms(self) -> int | None:
        return 1000


class GitOperationError(GitHubError):
    def __init__(self, operation: str, reason: str) -> None:
        self.operation = operation
        super().__init__(f"Git operation failed ({operation}): {reason}")


class WebhookVerificationError(GitHubError):
    def __init__(self, reason: str) -> None:
        super().__init__(f"Webhook verification failed: {reason}")
