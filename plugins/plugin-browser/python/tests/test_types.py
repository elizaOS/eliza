"""Tests for browser plugin types."""

from datetime import datetime

from elizaos_browser.types import (
    BROWSER_SERVICE_TYPE,
    ActionResult,
    BrowserConfig,
    BrowserSession,
    CaptchaResult,
    CaptchaType,
    ErrorCode,
    ExtractResult,
    NavigationResult,
    RateLimitConfig,
    RetryConfig,
    ScreenshotResult,
    SecurityConfig,
    WebSocketMessage,
    WebSocketResponse,
)


class TestBrowserServiceType:
    def test_should_be_defined_as_browser(self) -> None:
        assert BROWSER_SERVICE_TYPE == "browser"


class TestBrowserSession:
    def test_should_create_valid_session_object(self) -> None:
        session = BrowserSession(
            id="test-session-id",
            created_at=datetime.now(),
            url="https://example.com",
            title="Example",
        )

        assert session.id == "test-session-id"
        assert isinstance(session.created_at, datetime)
        assert session.url == "https://example.com"
        assert session.title == "Example"

    def test_should_allow_optional_url_and_title(self) -> None:
        session = BrowserSession(id="test-session-id")

        assert session.url is None
        assert session.title is None


class TestNavigationResult:
    def test_should_create_successful_navigation_result(self) -> None:
        result = NavigationResult(
            success=True,
            url="https://example.com",
            title="Example Page",
        )

        assert result.success is True
        assert result.url == "https://example.com"
        assert result.title == "Example Page"
        assert result.error is None

    def test_should_create_failed_navigation_result(self) -> None:
        result = NavigationResult(
            success=False,
            url="",
            title="",
            error="Navigation failed",
        )

        assert result.success is False
        assert result.error == "Navigation failed"


class TestActionResult:
    def test_should_create_successful_action_result(self) -> None:
        result = ActionResult(
            success=True,
            data={"clicked": True},
        )

        assert result.success is True
        assert result.data == {"clicked": True}


class TestExtractResult:
    def test_should_create_successful_extract_result(self) -> None:
        result = ExtractResult(
            success=True,
            found=True,
            data="Extracted text",
        )

        assert result.success is True
        assert result.found is True
        assert result.data == "Extracted text"


class TestScreenshotResult:
    def test_should_create_successful_screenshot_result(self) -> None:
        result = ScreenshotResult(
            success=True,
            data="base64encodeddata",
            mime_type="image/png",
            url="https://example.com",
            title="Example",
        )

        assert result.success is True
        assert result.mime_type == "image/png"


class TestCaptchaResult:
    def test_should_create_captcha_detection_result(self) -> None:
        result = CaptchaResult(
            detected=True,
            type=CaptchaType.RECAPTCHA_V2,
            site_key="test-site-key",
            solved=False,
        )

        assert result.detected is True
        assert result.type == CaptchaType.RECAPTCHA_V2
        assert result.solved is False


class TestCaptchaType:
    def test_should_support_all_captcha_types(self) -> None:
        types = [
            CaptchaType.TURNSTILE,
            CaptchaType.RECAPTCHA_V2,
            CaptchaType.RECAPTCHA_V3,
            CaptchaType.HCAPTCHA,
            CaptchaType.NONE,
        ]

        assert len(types) == 5

    def test_captcha_type_values(self) -> None:
        assert CaptchaType.TURNSTILE.value == "turnstile"
        assert CaptchaType.RECAPTCHA_V2.value == "recaptcha-v2"
        assert CaptchaType.RECAPTCHA_V3.value == "recaptcha-v3"
        assert CaptchaType.HCAPTCHA.value == "hcaptcha"
        assert CaptchaType.NONE.value == "none"


class TestErrorCode:
    def test_error_codes_exist(self) -> None:
        assert ErrorCode.SERVICE_NOT_AVAILABLE.value == "SERVICE_NOT_AVAILABLE"
        assert ErrorCode.SESSION_ERROR.value == "SESSION_ERROR"
        assert ErrorCode.NAVIGATION_ERROR.value == "NAVIGATION_ERROR"
        assert ErrorCode.ACTION_ERROR.value == "ACTION_ERROR"
        assert ErrorCode.SECURITY_ERROR.value == "SECURITY_ERROR"
        assert ErrorCode.CAPTCHA_ERROR.value == "CAPTCHA_ERROR"
        assert ErrorCode.TIMEOUT_ERROR.value == "TIMEOUT_ERROR"
        assert ErrorCode.NO_URL_FOUND.value == "NO_URL_FOUND"


class TestSecurityConfig:
    def test_should_create_security_config_with_defaults(self) -> None:
        config = SecurityConfig(
            allowed_domains=["example.com"],
            blocked_domains=["malware.com"],
            max_url_length=2048,
            allow_localhost=True,
            allow_file_protocol=False,
        )

        assert "example.com" in config.allowed_domains
        assert config.allow_localhost is True

    def test_should_have_default_blocked_domains(self) -> None:
        config = SecurityConfig()
        assert "malware.com" in config.blocked_domains
        assert "phishing.com" in config.blocked_domains


class TestRetryConfig:
    def test_should_create_retry_config(self) -> None:
        config = RetryConfig(
            max_attempts=3,
            initial_delay_ms=1000,
            max_delay_ms=5000,
            backoff_multiplier=2.0,
        )

        assert config.max_attempts == 3
        assert config.backoff_multiplier == 2.0

    def test_should_have_defaults(self) -> None:
        config = RetryConfig()
        assert config.max_attempts == 3
        assert config.initial_delay_ms == 1000
        assert config.max_delay_ms == 5000
        assert config.backoff_multiplier == 2.0


class TestBrowserConfig:
    def test_should_create_browser_config(self) -> None:
        config = BrowserConfig(
            headless=True,
            server_port=3456,
        )

        assert config.headless is True
        assert config.server_port == 3456

    def test_should_have_defaults(self) -> None:
        config = BrowserConfig()
        assert config.headless is True
        assert config.server_port == 3456
        assert config.browserbase_api_key is None


class TestWebSocketMessage:
    def test_should_create_websocket_message(self) -> None:
        message = WebSocketMessage(
            type="navigate",
            request_id="req-123",
            session_id="sess-456",
            data={"url": "https://example.com"},
        )

        assert message.type == "navigate"
        assert message.request_id == "req-123"
        assert message.session_id == "sess-456"
        assert message.data == {"url": "https://example.com"}


class TestWebSocketResponse:
    def test_should_create_websocket_response(self) -> None:
        response = WebSocketResponse(
            type="navigate",
            request_id="req-123",
            success=True,
            data={"url": "https://example.com", "title": "Example"},
        )

        assert response.success is True
        assert response.data is not None


class TestRateLimitConfig:
    def test_should_create_rate_limit_config(self) -> None:
        config = RateLimitConfig(
            max_actions_per_minute=60,
            max_sessions_per_hour=10,
        )

        assert config.max_actions_per_minute == 60
        assert config.max_sessions_per_hour == 10

    def test_should_have_defaults(self) -> None:
        config = RateLimitConfig()
        assert config.max_actions_per_minute == 60
        assert config.max_sessions_per_hour == 10
