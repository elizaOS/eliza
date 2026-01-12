from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any


class CaptchaType(str, Enum):
    TURNSTILE = "turnstile"
    RECAPTCHA_V2 = "recaptcha-v2"
    RECAPTCHA_V3 = "recaptcha-v3"
    HCAPTCHA = "hcaptcha"
    NONE = "none"


class ErrorCode(str, Enum):
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
    id: str
    created_at: datetime = field(default_factory=datetime.now)
    url: str | None = None
    title: str | None = None


@dataclass
class NavigationResult:
    success: bool
    url: str
    title: str
    error: str | None = None


@dataclass
class ActionResult:
    success: bool
    data: dict[str, Any] | None = None
    error: str | None = None


@dataclass
class ExtractResult:
    success: bool
    found: bool
    data: str | None = None
    error: str | None = None


@dataclass
class ScreenshotResult:
    success: bool
    data: str | None = None  # Base64 encoded
    mime_type: str = "image/png"
    url: str | None = None
    title: str | None = None
    error: str | None = None


@dataclass
class CaptchaResult:
    detected: bool
    type: CaptchaType = CaptchaType.NONE
    site_key: str | None = None
    solved: bool = False
    token: str | None = None
    error: str | None = None


@dataclass
class SecurityConfig:
    allowed_domains: list[str] = field(default_factory=list)
    blocked_domains: list[str] = field(default_factory=lambda: ["malware.com", "phishing.com"])
    max_url_length: int = 2048
    allow_localhost: bool = True
    allow_file_protocol: bool = False


@dataclass
class RetryConfig:
    max_attempts: int = 3
    initial_delay_ms: int = 1000
    max_delay_ms: int = 5000
    backoff_multiplier: float = 2.0


@dataclass
class BrowserConfig:
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
    type: str
    request_id: str
    session_id: str | None = None
    data: dict[str, Any] | None = None


@dataclass
class WebSocketResponse:
    type: str
    request_id: str
    success: bool
    data: dict[str, Any] | None = None
    error: str | None = None


@dataclass
class RateLimitEntry:
    count: int
    reset_time: float


@dataclass
class RateLimitConfig:
    max_actions_per_minute: int = 60
    max_sessions_per_hour: int = 10


BROWSER_SERVICE_TYPE = "browser"
