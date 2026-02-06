use thiserror::Error;

/// Result type used throughout the Gmail Watch plugin.
pub type Result<T> = std::result::Result<T, GmailWatchError>;

#[derive(Debug, Error)]
/// Errors produced by the Gmail Watch plugin.
pub enum GmailWatchError {
    #[error("Configuration error: {0}")]
    /// Configuration values were invalid or inconsistent.
    ConfigError(String),

    #[error("The gog binary was not found in PATH")]
    /// The `gog` CLI binary could not be located.
    GogBinaryNotFound,

    #[error("Process error: {0}")]
    /// An error related to the child process.
    ProcessError(String),

    #[error("Process exited with code {exit_code}: {message}")]
    /// The child process exited with a non-zero code.
    ProcessExited {
        /// Human-readable description.
        message: String,
        /// The exit code.
        exit_code: i32,
    },

    #[error("Watch renewal failed: {0}")]
    /// Watch renewal failed.
    RenewalError(String),

    #[error("Max restart attempts ({max}) reached")]
    /// Maximum restart attempts were exhausted.
    MaxRestartsExceeded {
        /// The maximum number of restarts that were attempted.
        max: u32,
    },

    #[error("Service is already running")]
    /// The service is already running.
    AlreadyRunning,

    #[error("Service is not running")]
    /// The service is not running.
    NotRunning,

    #[error("I/O error: {0}")]
    /// An I/O operation failed.
    IoError(String),
}

impl GmailWatchError {
    /// Returns `true` if retrying the operation might succeed.
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            GmailWatchError::ProcessError(_)
                | GmailWatchError::ProcessExited { .. }
                | GmailWatchError::RenewalError(_)
                | GmailWatchError::IoError(_)
        )
    }
}

impl From<std::io::Error> for GmailWatchError {
    fn from(err: std::io::Error) -> Self {
        GmailWatchError::IoError(err.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_display() {
        let err = GmailWatchError::ConfigError("Account cannot be empty".to_string());
        assert!(err.to_string().contains("Account cannot be empty"));
    }

    #[test]
    fn test_gog_not_found_display() {
        let err = GmailWatchError::GogBinaryNotFound;
        assert!(err.to_string().contains("gog"));
    }

    #[test]
    fn test_process_exited_display() {
        let err = GmailWatchError::ProcessExited {
            message: "crashed".to_string(),
            exit_code: 1,
        };
        let msg = err.to_string();
        assert!(msg.contains("crashed"));
        assert!(msg.contains("1"));
    }

    #[test]
    fn test_max_restarts_display() {
        let err = GmailWatchError::MaxRestartsExceeded { max: 10 };
        assert!(err.to_string().contains("10"));
    }

    #[test]
    fn test_retryable() {
        assert!(GmailWatchError::ProcessError("x".to_string()).is_retryable());
        assert!(GmailWatchError::RenewalError("x".to_string()).is_retryable());
        assert!(GmailWatchError::IoError("x".to_string()).is_retryable());
        assert!(
            GmailWatchError::ProcessExited {
                message: "x".to_string(),
                exit_code: 1
            }
            .is_retryable()
        );
        assert!(!GmailWatchError::ConfigError("x".to_string()).is_retryable());
        assert!(!GmailWatchError::GogBinaryNotFound.is_retryable());
        assert!(!GmailWatchError::AlreadyRunning.is_retryable());
    }

    #[test]
    fn test_from_io_error() {
        let io_err = std::io::Error::new(std::io::ErrorKind::NotFound, "file missing");
        let err: GmailWatchError = io_err.into();
        assert!(matches!(err, GmailWatchError::IoError(_)));
        assert!(err.to_string().contains("file missing"));
    }
}
