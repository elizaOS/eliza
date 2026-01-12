import logging
from typing import Any

from elizaos_browser.types import ErrorCode

logger = logging.getLogger(__name__)


class BrowserError(Exception):
    def __init__(
        self,
        message: str,
        code: ErrorCode,
        user_message: str,
        recoverable: bool = True,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.user_message = user_message
        self.recoverable = recoverable
        self.details = details or {}


class ServiceNotAvailableError(BrowserError):
    def __init__(self) -> None:
        super().__init__(
            message="Browser service is not available",
            code=ErrorCode.SERVICE_NOT_AVAILABLE,
            user_message="The browser automation service is not available. Please ensure the plugin is properly configured.",
            recoverable=False,
        )


class SessionError(BrowserError):
    def __init__(self, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(
            message=message,
            code=ErrorCode.SESSION_ERROR,
            user_message="There was an error with the browser session. Please try again.",
            recoverable=True,
            details=details,
        )


class NavigationError(BrowserError):
    def __init__(self, url: str, original_error: Exception | None = None) -> None:
        message = f"Failed to navigate to {url}"
        if original_error:
            message = f"{message}: {original_error}"

        super().__init__(
            message=message,
            code=ErrorCode.NAVIGATION_ERROR,
            user_message="I couldn't navigate to the requested page. Please check the URL and try again.",
            recoverable=True,
            details={"url": url, "original_error": str(original_error) if original_error else None},
        )


class ActionError(BrowserError):
    def __init__(self, action: str, target: str, original_error: Exception | None = None) -> None:
        message = f"Failed to {action} on {target}"
        if original_error:
            message = f"{message}: {original_error}"

        super().__init__(
            message=message,
            code=ErrorCode.ACTION_ERROR,
            user_message=f"I couldn't {action} on the requested element. Please check if the element exists and try again.",
            recoverable=True,
            details={
                "action": action,
                "target": target,
                "original_error": str(original_error) if original_error else None,
            },
        )


class SecurityError(BrowserError):
    def __init__(self, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(
            message=message,
            code=ErrorCode.SECURITY_ERROR,
            user_message="This action was blocked for security reasons.",
            recoverable=False,
            details=details,
        )


class CaptchaError(BrowserError):
    def __init__(self, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(
            message=message,
            code=ErrorCode.CAPTCHA_ERROR,
            user_message="Failed to solve the CAPTCHA. Please try again.",
            recoverable=True,
            details=details,
        )


class TimeoutError(BrowserError):
    def __init__(self, operation: str, timeout_ms: int) -> None:
        super().__init__(
            message=f"{operation} timed out after {timeout_ms}ms",
            code=ErrorCode.TIMEOUT_ERROR,
            user_message="The operation timed out. Please try again.",
            recoverable=True,
            details={"operation": operation, "timeout_ms": timeout_ms},
        )


class NoUrlFoundError(BrowserError):
    def __init__(self) -> None:
        super().__init__(
            message="No URL found in message",
            code=ErrorCode.NO_URL_FOUND,
            user_message="I couldn't find a URL in your request. Please provide a valid URL to navigate to.",
            recoverable=False,
        )


def handle_browser_error(
    error: Exception,
    callback: Any | None = None,
    action: str | None = None,
) -> None:
    if isinstance(error, BrowserError):
        logger.error(f"Browser error [{error.code}]: {error}")
        if callback:
            callback({"text": error.user_message, "error": True})
    else:
        logger.error(f"Unexpected browser error: {error}")
        if callback:
            message = (
                f"I encountered an error while trying to {action}. Please try again."
                if action
                else "I encountered an unexpected error. Please try again."
            )
            callback({"text": message, "error": True})
