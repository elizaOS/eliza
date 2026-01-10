//! Error types for the GitHub plugin
//!
//! Provides strongly-typed errors that fail fast with clear messages.

use std::fmt;
use thiserror::Error;

/// Result type alias for GitHub operations
pub type Result<T> = std::result::Result<T, GitHubError>;

/// GitHub plugin error types
///
/// All errors are designed to fail fast with clear, actionable messages.
/// No defensive programming or error swallowing.
#[derive(Debug, Error)]
pub enum GitHubError {
    /// GitHub client is not initialized
    #[error("GitHub client not initialized - call start() first")]
    ClientNotInitialized,

    /// Configuration error
    #[error("Configuration error: {0}")]
    ConfigError(String),

    /// Missing required setting
    #[error("Missing required setting: {0}")]
    MissingSetting(String),

    /// Invalid argument
    #[error("Invalid argument: {0}")]
    InvalidArgument(String),

    /// Repository not found
    #[error("Repository not found: {owner}/{repo}")]
    RepositoryNotFound {
        /// Repository owner
        owner: String,
        /// Repository name
        repo: String,
    },

    /// Branch not found
    #[error("Branch not found: {branch} in {owner}/{repo}")]
    BranchNotFound {
        /// Branch name
        branch: String,
        /// Repository owner
        owner: String,
        /// Repository name
        repo: String,
    },

    /// File not found
    #[error("File not found: {path} in {owner}/{repo}")]
    FileNotFound {
        /// File path
        path: String,
        /// Repository owner
        owner: String,
        /// Repository name
        repo: String,
    },

    /// Issue not found
    #[error("Issue #{issue_number} not found in {owner}/{repo}")]
    IssueNotFound {
        /// Issue number
        issue_number: u64,
        /// Repository owner
        owner: String,
        /// Repository name
        repo: String,
    },

    /// Pull request not found
    #[error("Pull request #{pull_number} not found in {owner}/{repo}")]
    PullRequestNotFound {
        /// Pull request number
        pull_number: u64,
        /// Repository owner
        owner: String,
        /// Repository name
        repo: String,
    },

    /// Permission denied
    #[error("Permission denied: {0}")]
    PermissionDenied(String),

    /// Rate limited by GitHub API
    #[error("Rate limited by GitHub API, retry after {retry_after_ms}ms")]
    RateLimited {
        /// Milliseconds until retry is allowed
        retry_after_ms: u64,
        /// Remaining requests
        remaining: u32,
        /// Reset timestamp
        reset_at: chrono::DateTime<chrono::Utc>,
    },

    /// Secondary rate limit (abuse detection)
    #[error("Secondary rate limit hit, retry after {retry_after_ms}ms")]
    SecondaryRateLimit {
        /// Milliseconds until retry is allowed
        retry_after_ms: u64,
    },

    /// Merge conflict
    #[error("Merge conflict in pull request #{pull_number} in {owner}/{repo}")]
    MergeConflict {
        /// Pull request number
        pull_number: u64,
        /// Repository owner
        owner: String,
        /// Repository name
        repo: String,
    },

    /// Branch already exists
    #[error("Branch already exists: {branch} in {owner}/{repo}")]
    BranchExists {
        /// Branch name
        branch: String,
        /// Repository owner
        owner: String,
        /// Repository name
        repo: String,
    },

    /// Validation error
    #[error("Validation failed for {field}: {reason}")]
    ValidationFailed {
        /// Field name
        field: String,
        /// Reason
        reason: String,
    },

    /// API error from GitHub
    #[error("GitHub API error ({status}): {message}")]
    ApiError {
        /// HTTP status code
        status: u16,
        /// Error message
        message: String,
        /// Error code
        code: Option<String>,
        /// Documentation URL
        documentation_url: Option<String>,
    },

    /// Network error
    #[error("Network error: {0}")]
    NetworkError(String),

    /// Timeout
    #[error("Operation timed out after {timeout_ms}ms: {operation}")]
    Timeout {
        /// Timeout in milliseconds
        timeout_ms: u64,
        /// Operation description
        operation: String,
    },

    /// Git operation error
    #[error("Git operation failed ({operation}): {reason}")]
    GitOperation {
        /// Operation name
        operation: String,
        /// Failure reason
        reason: String,
    },

    /// Webhook verification error
    #[error("Webhook verification failed: {0}")]
    WebhookVerification(String),

    /// Serialization/deserialization error
    #[error("Serialization error: {0}")]
    SerializationError(String),

    /// Internal error
    #[error("Internal error: {0}")]
    Internal(String),

    /// Octocrab error
    #[cfg(feature = "native")]
    #[error("GitHub API error: {0}")]
    OctocrabError(#[from] octocrab::Error),
}

impl GitHubError {
    /// Check if error is retryable
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            GitHubError::RateLimited { .. }
                | GitHubError::SecondaryRateLimit { .. }
                | GitHubError::Timeout { .. }
                | GitHubError::NetworkError(_)
        )
    }

    /// Get retry delay in milliseconds if applicable
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
        } else if err.is_connect() {
            GitHubError::NetworkError(err.to_string())
        } else {
            GitHubError::NetworkError(err.to_string())
        }
    }
}

/// Error context wrapper for adding contextual information
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

/// Extension trait for adding context to errors
pub trait WithContext<T, E: fmt::Display> {
    /// Add context to an error
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

