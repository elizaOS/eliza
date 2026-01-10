"""
Browser Plugin Types

Defines all types used across the browser automation plugin.
"""

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any


class CaptchaType(str, Enum):
    """Supported CAPTCHA types."""
    TURNSTILE = "turnstile"
    RECAPTCHA_V2 = "recaptcha-v2"
    RECAPTCHA_V3 = "recaptcha-v3"
    HCAPTCHA = "hcaptcha"
    NONE = "none"


class ErrorCode(str, Enum):
    """Browser error codes."""
    SERVICE_NOT_AVAILABLE = "SERVICE_NOT_AVAILABLE"
    SESSION_ERROR = "SESSION_ERROR"
    NAVIGATION_ERROR = "NAVIGATION_ERROR"
    ACTION_ERROR = "ACTION_ERROR"
    SECURITY_ERROR = "SECURITY_ERROR"
    CAPTCHA_ERROR = "CAPTCHA_ERROR"
    TIMEOUT_ERROR = "TIMEOUT_ERROR"
    NO_URL_FOUND = "NO_URL_FOUND"


@dataclass
class BrowserSession:
    """Browser session information."""
    id: str
    created_at: datetime = field(default_factory=datetime.now)
    url: str | None = None
    title: str | None = None


@dataclass
class NavigationResult:
    """Result of a navigation operation."""
    success: bool
    url: str
    title: str
    error: str | None = None


@dataclass
class ActionResult:
    """Result of a browser action."""
    success: bool
    data: dict[str, Any] | None = None
    error: str | None = None


@dataclass
class ExtractResult:
    """Result of data extraction."""
    success: bool
    found: bool
    data: str | None = None
    error: str | None = None


@dataclass
class ScreenshotResult:
    """Result of screenshot capture."""
    success: bool
    data: str | None = None  # Base64 encoded
    mime_type: str = "image/png"
    url: str | None = None
    title: str | None = None
    error: str | None = None


@dataclass
class CaptchaResult:
    """Result of CAPTCHA detection/solving."""
    detected: bool
    type: CaptchaType = CaptchaType.NONE
    site_key: str | None = None
    solved: bool = False
    token: str | None = None
    error: str | None = None


@dataclass
class SecurityConfig:
    """Security configuration for URL validation."""
    allowed_domains: list[str] = field(default_factory=list)
    blocked_domains: list[str] = field(default_factory=lambda: ["malware.com", "phishing.com"])
    max_url_length: int = 2048
    allow_localhost: bool = True
    allow_file_protocol: bool = False


@dataclass
class RetryConfig:
    """Retry configuration with exponential backoff."""
    max_attempts: int = 3
    initial_delay_ms: int = 1000
    max_delay_ms: int = 5000
    backoff_multiplier: float = 2.0


@dataclass
class BrowserConfig:
    """Browser service configuration."""
    headless: bool = True
    browserbase_api_key: str | None = None
    browserbase_project_id: str | None = None
    openai_api_key: str | None = None
    anthropic_api_key: str | None = None
    ollama_base_url: str | None = None
    ollama_model: str | None = None
    capsolver_api_key: str | None = None
    server_port: int = 3456


@dataclass
class WebSocketMessage:
    """WebSocket message format."""
    type: str
    request_id: str
    session_id: str | None = None
    data: dict[str, Any] | None = None


@dataclass
class WebSocketResponse:
    """WebSocket response format."""
    type: str
    request_id: str
    success: bool
    data: dict[str, Any] | None = None
    error: str | None = None


@dataclass
class RateLimitEntry:
    """Rate limit tracking entry."""
    count: int
    reset_time: float


@dataclass
class RateLimitConfig:
    """Rate limiting configuration."""
    max_actions_per_minute: int = 60
    max_sessions_per_hour: int = 10


# Browser service type constant (matches core's ServiceType.BROWSER)
BROWSER_SERVICE_TYPE = "browser"

