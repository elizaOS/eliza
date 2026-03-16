"""Tests for browser plugin utilities."""

import time

import pytest

from elizaos_browser.types import ErrorCode, RateLimitConfig, RetryConfig, SecurityConfig
from elizaos_browser.utils.errors import (
    ActionError,
    BrowserError,
    CaptchaError,
    NavigationError,
    NoUrlFoundError,
    SecurityError,
    ServiceNotAvailableError,
    SessionError,
    handle_browser_error,
)
from elizaos_browser.utils.errors import (
    TimeoutError as BrowserTimeoutError,
)
from elizaos_browser.utils.retry import (
    DEFAULT_RETRY_CONFIGS,
    retry_with_backoff,
    sleep,
)
from elizaos_browser.utils.security import (
    InputSanitizer,
    RateLimiter,
    UrlValidator,
)
from elizaos_browser.utils.url import (
    extract_url,
    parse_click_target,
    parse_extract_instruction,
    parse_select_action,
    parse_type_action,
)


class TestErrorClasses:
    def test_should_create_browser_error_with_code_and_details(self) -> None:
        error = BrowserError(
            message="Test error",
            code=ErrorCode.ACTION_ERROR,
            user_message="User-friendly message",
            details={"context": "test"},
        )
        assert str(error) == "Test error"
        assert error.code == ErrorCode.ACTION_ERROR
        assert error.details == {"context": "test"}
        assert error.user_message == "User-friendly message"

    def test_should_create_service_not_available_error(self) -> None:
        error = ServiceNotAvailableError()
        assert error.code == ErrorCode.SERVICE_NOT_AVAILABLE

    def test_should_create_session_error(self) -> None:
        error = SessionError("Session invalid")
        assert error.code == ErrorCode.SESSION_ERROR

    def test_should_create_navigation_error(self) -> None:
        error = NavigationError("https://example.com")
        assert error.code == ErrorCode.NAVIGATION_ERROR

    def test_should_create_action_error(self) -> None:
        error = ActionError("click", "button")
        assert error.code == ErrorCode.ACTION_ERROR

    def test_should_create_security_error(self) -> None:
        error = SecurityError("Security violation")
        assert error.code == ErrorCode.SECURITY_ERROR

    def test_should_create_captcha_error(self) -> None:
        error = CaptchaError("Captcha failed")
        assert error.code == ErrorCode.CAPTCHA_ERROR

    def test_should_create_timeout_error(self) -> None:
        error = BrowserTimeoutError("operation", 5000)
        assert error.code == ErrorCode.TIMEOUT_ERROR

    def test_should_create_no_url_found_error(self) -> None:
        error = NoUrlFoundError()
        assert error.code == ErrorCode.NO_URL_FOUND

    def test_should_handle_browser_errors_correctly(self) -> None:
        browser_error = BrowserError(
            message="Test",
            code=ErrorCode.ACTION_ERROR,
            user_message="User message",
        )
        # handle_browser_error returns None and logs the error
        result = handle_browser_error(browser_error)
        assert result is None


class TestUrlExtraction:
    def test_should_extract_url_from_text_with_https(self) -> None:
        result = extract_url("Please navigate to https://example.com")
        assert result == "https://example.com"

    def test_should_extract_url_from_text_with_http(self) -> None:
        result = extract_url("Go to http://example.com/page")
        assert result == "http://example.com/page"

    def test_should_return_none_for_text_without_url(self) -> None:
        result = extract_url("No URL here")
        assert result is None

    def test_should_extract_first_url_when_multiple_present(self) -> None:
        result = extract_url("Check https://first.com and https://second.com")
        assert result == "https://first.com"


class TestClickTargetParsing:
    def test_should_parse_click_target_from_text(self) -> None:
        result = parse_click_target("click the submit button")
        assert result is not None

    def test_should_extract_target_description(self) -> None:
        result = parse_click_target("click on the login button")
        assert "login button" in result


class TestTypeActionParsing:
    def test_should_parse_type_action(self) -> None:
        text, target = parse_type_action('type "hello world" into the search box')
        assert text == "hello world"
        assert "search box" in target

    def test_should_return_empty_for_invalid_input(self) -> None:
        text, target = parse_type_action("no type action here")
        assert text == ""
        assert target == "input field"


class TestSelectActionParsing:
    def test_should_parse_select_action(self) -> None:
        value, target = parse_select_action('select "Option A" from the dropdown')
        assert value == "Option A"
        assert "dropdown" in target


class TestExtractInstructionParsing:
    def test_should_parse_extract_instruction(self) -> None:
        result = parse_extract_instruction("extract the main content from the page")
        assert result is not None


class TestUrlValidator:
    def test_should_validate_allowed_urls(self) -> None:
        config = SecurityConfig(
            allowed_domains=["example.com"],
            blocked_domains=[],
            max_url_length=2048,
            allow_localhost=False,
            allow_file_protocol=False,
        )
        validator = UrlValidator(config)
        valid, _, _ = validator.validate("https://example.com/page")
        assert valid is True

    def test_should_block_blocked_domains(self) -> None:
        config = SecurityConfig(
            allowed_domains=[],
            blocked_domains=["malware.com"],
            max_url_length=2048,
            allow_localhost=False,
            allow_file_protocol=False,
        )
        validator = UrlValidator(config)
        valid, _, _ = validator.validate("https://malware.com/bad")
        assert valid is False

    def test_should_respect_allow_localhost_setting(self) -> None:
        config_with_localhost = SecurityConfig(
            allowed_domains=[],
            blocked_domains=[],
            max_url_length=2048,
            allow_localhost=True,
            allow_file_protocol=False,
        )
        validator_with_localhost = UrlValidator(config_with_localhost)
        valid, _, _ = validator_with_localhost.validate("http://localhost:3000")
        assert valid is True

        config_without_localhost = SecurityConfig(
            allowed_domains=[],
            blocked_domains=[],
            max_url_length=2048,
            allow_localhost=False,
            allow_file_protocol=False,
        )
        validator_without_localhost = UrlValidator(config_without_localhost)
        valid, _, _ = validator_without_localhost.validate("http://localhost:3000")
        assert valid is False

    def test_should_reject_urls_exceeding_max_length(self) -> None:
        config = SecurityConfig(
            allowed_domains=[],
            blocked_domains=[],
            max_url_length=50,
            allow_localhost=False,
            allow_file_protocol=False,
        )
        validator = UrlValidator(config)
        long_url = "https://example.com/" + "a" * 100
        valid, _, _ = validator.validate(long_url)
        assert valid is False


class TestInputSanitizer:
    def test_should_sanitize_input_by_removing_dangerous_characters(self) -> None:
        sanitized = InputSanitizer.sanitize_text("<script>alert('xss')</script>")
        assert "<script>" not in sanitized

    def test_should_trim_whitespace(self) -> None:
        sanitized = InputSanitizer.sanitize_text("  hello world  ")
        assert sanitized == "hello world"


class TestRateLimiter:
    def test_should_allow_actions_within_limit(self) -> None:
        config = RateLimitConfig(
            max_actions_per_minute=10,
            max_sessions_per_hour=5,
        )
        limiter = RateLimiter(config)
        assert limiter.check_action_limit("user1") is True

    def test_should_track_action_count(self) -> None:
        config = RateLimitConfig(
            max_actions_per_minute=2,
            max_sessions_per_hour=5,
        )
        limiter = RateLimiter(config)
        # check_action_limit both checks and increments
        limiter.check_action_limit("user1")  # count becomes 1
        limiter.check_action_limit("user1")  # count becomes 2
        assert limiter.check_action_limit("user1") is False  # at limit


class TestRetryLogic:
    def test_should_have_default_retry_configs(self) -> None:
        assert "navigation" in DEFAULT_RETRY_CONFIGS
        assert DEFAULT_RETRY_CONFIGS["navigation"].max_attempts > 0

    @pytest.mark.asyncio
    async def test_should_sleep_for_specified_duration(self) -> None:
        start = time.time()
        await sleep(0.05)  # 50ms in seconds
        elapsed = (time.time() - start) * 1000
        assert elapsed >= 45

    @pytest.mark.asyncio
    async def test_should_retry_on_failure_and_succeed_eventually(self) -> None:
        attempts = 0

        async def fn() -> str:
            nonlocal attempts
            attempts += 1
            if attempts < 3:
                raise Exception("Temporary failure")
            return "success"

        config = RetryConfig(
            max_attempts=5,
            initial_delay_ms=10,
            max_delay_ms=50,
            backoff_multiplier=1.5,
        )
        result = await retry_with_backoff(fn, config, "test_operation")
        assert result == "success"
        assert attempts == 3

    @pytest.mark.asyncio
    async def test_should_raise_after_max_attempts_exceeded(self) -> None:
        async def fn() -> str:
            raise Exception("Permanent failure")

        config = RetryConfig(
            max_attempts=2,
            initial_delay_ms=10,
            max_delay_ms=50,
            backoff_multiplier=1.5,
        )

        with pytest.raises(Exception, match="Permanent failure"):
            await retry_with_backoff(fn, config, "test_operation")
