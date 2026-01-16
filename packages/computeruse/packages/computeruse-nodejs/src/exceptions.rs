use napi::{self, Status};
use computeruse::errors::AutomationError;

/// Map ComputerUse errors to NAPI errors
pub fn map_error(err: AutomationError) -> napi::Error {
    match err {
        AutomationError::ElementNotFound(msg) => {
            napi::Error::new(Status::InvalidArg, format!("ELEMENT_NOT_FOUND: {msg}"))
        }
        AutomationError::Timeout(msg) => napi::Error::new(
            Status::GenericFailure,
            format!("OPERATION_TIMED_OUT: {msg}"),
        ),
        AutomationError::PermissionDenied(msg) => {
            napi::Error::new(Status::GenericFailure, format!("PERMISSION_DENIED: {msg}"))
        }
        AutomationError::PlatformError(e) => {
            napi::Error::new(Status::GenericFailure, format!("PLATFORM_ERROR: {e}"))
        }
        AutomationError::UnsupportedOperation(msg) => {
            napi::Error::new(Status::InvalidArg, format!("UNSUPPORTED_OPERATION: {msg}"))
        }
        AutomationError::UnsupportedPlatform(msg) => {
            napi::Error::new(Status::InvalidArg, format!("UNSUPPORTED_PLATFORM: {msg}"))
        }
        AutomationError::InvalidArgument(e) => {
            napi::Error::new(Status::InvalidArg, format!("INVALID_ARGUMENT: {e}"))
        }
        AutomationError::Internal(e) => {
            napi::Error::new(Status::GenericFailure, format!("INTERNAL_ERROR: {e}"))
        }
        AutomationError::InvalidSelector(e) => {
            napi::Error::new(Status::InvalidArg, format!("INVALID_SELECTOR: {e}"))
        }
        AutomationError::UIAutomationAPIError { message, .. } => napi::Error::new(
            Status::GenericFailure,
            format!("UI_AUTOMATION_API_ERROR: {message}"),
        ),
        AutomationError::ElementDetached(msg) => {
            napi::Error::new(Status::InvalidArg, format!("ELEMENT_DETACHED: {msg}"))
        }
        AutomationError::ElementNotVisible(msg) => {
            napi::Error::new(Status::InvalidArg, format!("ELEMENT_NOT_VISIBLE: {msg}"))
        }
        AutomationError::ElementNotEnabled(msg) => {
            napi::Error::new(Status::InvalidArg, format!("ELEMENT_NOT_ENABLED: {msg}"))
        }
        AutomationError::ElementNotStable(msg) => {
            napi::Error::new(Status::GenericFailure, format!("ELEMENT_NOT_STABLE: {msg}"))
        }
        AutomationError::ElementObscured(msg) => {
            napi::Error::new(Status::InvalidArg, format!("ELEMENT_OBSCURED: {msg}"))
        }
        AutomationError::ScrollFailed(msg) => {
            napi::Error::new(Status::GenericFailure, format!("SCROLL_FAILED: {msg}"))
        }
        AutomationError::OperationCancelled(msg) => {
            napi::Error::new(Status::Cancelled, format!("OPERATION_CANCELLED: {msg}"))
        }
        AutomationError::VerificationFailed(msg) => napi::Error::new(
            Status::GenericFailure,
            format!("VERIFICATION_FAILED: {msg}"),
        ),
    }
}
