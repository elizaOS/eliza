use crate::types::ErrorCode;
use thiserror::Error;

#[derive(Error, Debug)]
pub struct BrowserError {
    pub code: ErrorCode,
    pub message: String,
    pub user_message: String,
    pub recoverable: bool,
    pub details: Option<serde_json::Value>,
}

impl std::fmt::Display for BrowserError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{:?}] {}", self.code, self.message)
    }
}

impl BrowserError {
    pub fn new(
        message: impl Into<String>,
        code: ErrorCode,
        user_message: impl Into<String>,
        recoverable: bool,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            user_message: user_message.into(),
            recoverable,
            details: None,
        }
    }

    pub fn with_details(mut self, details: serde_json::Value) -> Self {
        self.details = Some(details);
        self
    }
}

pub fn service_not_available() -> BrowserError {
    BrowserError::new(
        "Browser service is not available",
        ErrorCode::ServiceNotAvailable,
        "The browser automation service is not available. Please ensure the plugin is properly configured.",
        false,
    )
}

pub fn session_error(message: impl Into<String>) -> BrowserError {
    BrowserError::new(
        message,
        ErrorCode::SessionError,
        "There was an error with the browser session. Please try again.",
        true,
    )
}

pub fn navigation_error(url: &str, original_error: Option<&str>) -> BrowserError {
    let message = match original_error {
        Some(err) => format!("Failed to navigate to {}: {}", url, err),
        None => format!("Failed to navigate to {}", url),
    };

    BrowserError::new(
        message,
        ErrorCode::NavigationError,
        "I couldn't navigate to the requested page. Please check the URL and try again.",
        true,
    )
    .with_details(serde_json::json!({
        "url": url,
        "original_error": original_error,
    }))
}

pub fn action_error(action: &str, target: &str, original_error: Option<&str>) -> BrowserError {
    let message = match original_error {
        Some(err) => format!("Failed to {} on {}: {}", action, target, err),
        None => format!("Failed to {} on {}", action, target),
    };

    BrowserError::new(
        message,
        ErrorCode::ActionError,
        format!("I couldn't {} on the requested element. Please check if the element exists and try again.", action),
        true,
    )
    .with_details(serde_json::json!({
        "action": action,
        "target": target,
        "original_error": original_error,
    }))
}

pub fn security_error(message: impl Into<String>) -> BrowserError {
    BrowserError::new(
        message,
        ErrorCode::SecurityError,
        "This action was blocked for security reasons.",
        false,
    )
}

pub fn captcha_error(message: impl Into<String>) -> BrowserError {
    BrowserError::new(
        message,
        ErrorCode::CaptchaError,
        "Failed to solve the CAPTCHA. Please try again.",
        true,
    )
}

pub fn timeout_error(operation: &str, timeout_ms: u64) -> BrowserError {
    BrowserError::new(
        format!("{} timed out after {}ms", operation, timeout_ms),
        ErrorCode::TimeoutError,
        "The operation timed out. Please try again.",
        true,
    )
    .with_details(serde_json::json!({
        "operation": operation,
        "timeout_ms": timeout_ms,
    }))
}

pub fn no_url_found() -> BrowserError {
    BrowserError::new(
        "No URL found in message",
        ErrorCode::NoUrlFound,
        "I couldn't find a URL in your request. Please provide a valid URL to navigate to.",
        false,
    )
}

pub fn handle_browser_error<F>(error: &BrowserError, callback: Option<F>, action: Option<&str>)
where
    F: FnOnce(&str, bool),
{
    tracing::error!("Browser error [{}]: {}", error.code as u8, error.message);

    if let Some(cb) = callback {
        let message = match action {
            Some(a) => format!(
                "I encountered an error while trying to {}. Please try again.",
                a
            ),
            None => error.user_message.clone(),
        };
        cb(&message, true);
    }
}
