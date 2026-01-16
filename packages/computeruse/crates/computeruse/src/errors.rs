use thiserror::Error;

#[derive(Error, Debug)]
pub enum AutomationError {
    #[error("Element not found: {0}")]
    ElementNotFound(String),

    #[error("Operation timed out: {0}")]
    Timeout(String),

    #[error("Permission denied: {0}")]
    PermissionDenied(String),

    #[error("Platform-specific error: {0}")]
    PlatformError(String),

    #[error("Unsupported operation: {0}")]
    UnsupportedOperation(String),

    #[error("Unsupported platform: {0}")]
    UnsupportedPlatform(String),

    #[error("Invalid argument: {0}")]
    InvalidArgument(String),

    #[error("Internal error: {0}")]
    Internal(String),

    #[error("Invalid selector: {0}")]
    InvalidSelector(String),

    #[error("UI Automation API error: {message}")]
    UIAutomationAPIError {
        message: String,
        com_error: Option<i32>,
        operation: String,
        is_retryable: bool,
    },

    #[error("Element is detached from DOM: {0}")]
    ElementDetached(String),

    #[error("Element is not visible: {0}")]
    ElementNotVisible(String),

    #[error("Element is not enabled: {0}")]
    ElementNotEnabled(String),

    #[error("Element bounds are not stable: {0}")]
    ElementNotStable(String),

    #[error("Element is obscured by another element: {0}")]
    ElementObscured(String),

    #[error("Failed to scroll element into view: {0}")]
    ScrollFailed(String),

    #[error("Operation cancelled: {0}")]
    OperationCancelled(String),

    #[error("Verification failed: {0}")]
    VerificationFailed(String),
}
