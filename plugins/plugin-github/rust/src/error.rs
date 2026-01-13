#![allow(missing_docs)]

use std::fmt;
use thiserror::Error;

pub type Result<T> = std::result::Result<T, GitHubError>;

#[derive(Debug, Error)]
pub enum GitHubError {
    #[error("GitHub client not initialized - call start() first")]
    ClientNotInitialized,

    #[error("Configuration error: {0}")]
    ConfigError(String),

    #[error("Missing required setting: {0}")]
    MissingSetting(String),

    #[error("Invalid argument: {0}")]
    InvalidArgument(String),

    #[error("Repository not found: {owner}/{repo}")]
    RepositoryNotFound { owner: String, repo: String },

    #[error("Branch not found: {branch} in {owner}/{repo}")]
    BranchNotFound {
        branch: String,
        owner: String,
        repo: String,
    },

    #[error("File not found: {path} in {owner}/{repo}")]
    FileNotFound {
        path: String,
        owner: String,
        repo: String,
    },

    #[error("Issue #{issue_number} not found in {owner}/{repo}")]
    IssueNotFound {
        issue_number: u64,
        owner: String,
        repo: String,
    },

    #[error("Pull request #{pull_number} not found in {owner}/{repo}")]
    PullRequestNotFound {
        pull_number: u64,
        owner: String,
        repo: String,
    },

    #[error("Permission denied: {0}")]
    PermissionDenied(String),

    #[error("Rate limited by GitHub API, retry after {retry_after_ms}ms")]
    RateLimited {
        retry_after_ms: u64,
        remaining: u32,
        reset_at: chrono::DateTime<chrono::Utc>,
    },

    #[error("Secondary rate limit hit, retry after {retry_after_ms}ms")]
    SecondaryRateLimit { retry_after_ms: u64 },

    #[error("Merge conflict in pull request #{pull_number} in {owner}/{repo}")]
    MergeConflict {
        pull_number: u64,
        owner: String,
        repo: String,
    },

    #[error("Branch already exists: {branch} in {owner}/{repo}")]
    BranchExists {
        branch: String,
        owner: String,
        repo: String,
    },

    #[error("Validation failed for {field}: {reason}")]
    ValidationFailed { field: String, reason: String },

    #[error("GitHub API error ({status}): {message}")]
    ApiError {
        status: u16,
        message: String,
        code: Option<String>,
        documentation_url: Option<String>,
    },

    #[error("Network error: {0}")]
    NetworkError(String),

    #[error("Operation timed out after {timeout_ms}ms: {operation}")]
    Timeout { timeout_ms: u64, operation: String },

    #[error("Git operation failed ({operation}): {reason}")]
    GitOperation { operation: String, reason: String },

    #[error("Webhook verification failed: {0}")]
    WebhookVerification(String),

    #[error("Serialization error: {0}")]
    SerializationError(String),

    #[error("Internal error: {0}")]
    Internal(String),

    #[cfg(feature = "native")]
    #[error("GitHub API error: {0}")]
    OctocrabError(#[from] octocrab::Error),
}

impl GitHubError {
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            GitHubError::RateLimited { .. }
                | GitHubError::SecondaryRateLimit { .. }
                | GitHubError::Timeout { .. }
                | GitHubError::NetworkError(_)
        )
    }

    pub fn retry_after_ms(&self) -> Option<u64> {
        match self {
            GitHubError::RateLimited { retry_after_ms, .. } => Some(*retry_after_ms),
            GitHubError::SecondaryRateLimit { retry_after_ms } => Some(*retry_after_ms),
            GitHubError::Timeout { timeout_ms, .. } => Some(*timeout_ms / 2),
            _ => None,
        }
    }
}

impl From<serde_json::Error> for GitHubError {
    fn from(err: serde_json::Error) -> Self {
        GitHubError::SerializationError(err.to_string())
    }
}

impl From<std::io::Error> for GitHubError {
    fn from(err: std::io::Error) -> Self {
        GitHubError::Internal(format!("I/O error: {}", err))
    }
}

impl From<reqwest::Error> for GitHubError {
    fn from(err: reqwest::Error) -> Self {
        if err.is_timeout() {
            GitHubError::Timeout {
                timeout_ms: 30000,
                operation: "HTTP request".to_string(),
            }
        } else {
            GitHubError::NetworkError(err.to_string())
        }
    }
}

#[derive(Debug)]
pub struct ErrorContext<E: fmt::Display> {
    error: E,
    context: String,
}

impl<E: fmt::Display> fmt::Display for ErrorContext<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.context, self.error)
    }
}

impl<E: fmt::Display + fmt::Debug> std::error::Error for ErrorContext<E> {}

pub trait WithContext<T, E: fmt::Display> {
    fn with_context<F: FnOnce() -> String>(self, f: F) -> std::result::Result<T, ErrorContext<E>>;
}

impl<T, E: fmt::Display> WithContext<T, E> for std::result::Result<T, E> {
    fn with_context<F: FnOnce() -> String>(self, f: F) -> std::result::Result<T, ErrorContext<E>> {
        self.map_err(|e| ErrorContext {
            error: e,
            context: f(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_display() {
        let err = GitHubError::MissingSetting("GITHUB_API_TOKEN".to_string());
        assert!(err.to_string().contains("GITHUB_API_TOKEN"));
    }

    #[test]
    fn test_error_retryable() {
        assert!(GitHubError::RateLimited {
            retry_after_ms: 1000,
            remaining: 0,
            reset_at: chrono::Utc::now(),
        }
        .is_retryable());
        assert!(GitHubError::Timeout {
            timeout_ms: 5000,
            operation: "test".to_string(),
        }
        .is_retryable());
        assert!(!GitHubError::ClientNotInitialized.is_retryable());
    }

    #[test]
    fn test_retry_after() {
        let err = GitHubError::RateLimited {
            retry_after_ms: 1000,
            remaining: 0,
            reset_at: chrono::Utc::now(),
        };
        assert_eq!(err.retry_after_ms(), Some(1000));

        let err = GitHubError::ClientNotInitialized;
        assert_eq!(err.retry_after_ms(), None);
    }
}
