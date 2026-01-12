"""Tests for browser plugin utilities."""

import pytest
import asyncio

from elizaos_browser.utils.errors import (
    BrowserError,
    ServiceNotAvailableError,
    SessionError,
    NavigationError,
    ActionError,
    SecurityError,
    CaptchaError,
    TimeoutError as BrowserTimeoutError,
    NoUrlFoundError,
    handle_browser_error,
)
from elizaos_browser.utils.url import (
    extract_url,
    parse_click_target,
    parse_type_action,
    parse_select_action,
    parse_extract_instruction,
)
from elizaos_browser.utils.security import (
    UrlValidator,
    InputSanitizer,
    RateLimiter,
    validate_secure_action,
    default_url_validator,
)
from elizaos_browser.utils.retry import (
    DEFAULT_RETRY_CONFIGS,
    retry_with_backoff,
    sleep,
)
from elizaos_browser.types import SecurityConfig, RetryConfig, RateLimitConfig


class TestErrorClasses:
    def test_should_create_browser_error_with_code_and_details(self) -> None:
        error = BrowserError("Test error", "ACTION_ERROR", {"context": "test"})
        assert str(error) == "Test error"
        assert error.code == "ACTION_ERROR"
        assert error.details == {"context": "test"}

    def test_should_create_service_not_available_error(self) -> None:
        error = ServiceNotAvailableError("Service unavailable")
        assert error.code == "SERVICE_NOT_AVAILABLE"

    def test_should_create_session_error(self) -> None:
        error = SessionError("Session invalid")
        assert error.code == "SESSION_ERROR"

    def test_should_create_navigation_error(self) -> None:
        error = NavigationError("Navigation failed")
        assert error.code == "NAVIGATION_ERROR"

    def test_should_create_action_error(self) -> None:
        error = ActionError("Action failed")
        assert error.code == "ACTION_ERROR"

    def test_should_create_security_error(self) -> None:
        error = SecurityError("Security violation")
        assert error.code == "SECURITY_ERROR"

    def test_should_create_captcha_error(self) -> None:
        error = CaptchaError("Captcha failed")
        assert error.code == "CAPTCHA_ERROR"

    def test_should_create_timeout_error(self) -> None:
        error = BrowserTimeoutError("Operation timed out")
        assert error.code == "TIMEOUT_ERROR"

    def test_should_create_no_url_found_error(self) -> None:
        error = NoUrlFoundError("No URL found")
        assert error.code == "NO_URL_FOUND"

    def test_should_handle_browser_errors_correctly(self) -> None:
        browser_error = BrowserError("Test", "TEST_ERROR")
        result = handle_browser_error(browser_error)
        assert result is browser_error

        generic_error = Exception("Generic error")
        wrapped_result = handle_browser_error(generic_error)
        assert isinstance(wrapped_result, BrowserError)
        assert wrapped_result.code == "ACTION_ERROR"


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

    def test_should_extract_selector_if_specified(self) -> None:
        result = parse_click_target('click on selector "#submit-btn"')
        assert result == "#submit-btn"


class TestTypeActionParsing:
    def test_should_parse_type_action(self) -> None:
        result = parse_type_action('type "hello world" into the search box')
        assert result == {"text": "hello world", "target": "the search box"}

    def test_should_return_none_for_invalid_input(self) -> None:
        result = parse_type_action("no type action here")
        assert result is None


class TestSelectActionParsing:
    def test_should_parse_select_action(self) -> None:
        result = parse_select_action('select "Option A" from the dropdown')
        assert result == {"value": "Option A", "target": "the dropdown"}


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
        assert validator.validate("https://example.com/page") is True

    def test_should_block_blocked_domains(self) -> None:
        config = SecurityConfig(
            allowed_domains=[],
            blocked_domains=["malware.com"],
            max_url_length=2048,
            allow_localhost=False,
            allow_file_protocol=False,
        )
        validator = UrlValidator(config)
        assert validator.validate("https://malware.com/bad") is False

    def test_should_respect_allow_localhost_setting(self) -> None:
        config_with_localhost = SecurityConfig(
            allowed_domains=[],
            blocked_domains=[],
            max_url_length=2048,
            allow_localhost=True,
            allow_file_protocol=False,
        )
        validator_with_localhost = UrlValidator(config_with_localhost)
        assert validator_with_localhost.validate("http://localhost:3000") is True

        config_without_localhost = SecurityConfig(
            allowed_domains=[],
            blocked_domains=[],
            max_url_length=2048,
            allow_localhost=False,
            allow_file_protocol=False,
        )
        validator_without_localhost = UrlValidator(config_without_localhost)
        assert validator_without_localhost.validate("http://localhost:3000") is False

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
        assert validator.validate(long_url) is False


class TestInputSanitizer:
    def test_should_sanitize_input_by_removing_dangerous_characters(self) -> None:
        sanitized = InputSanitizer.sanitize("<script>alert('xss')</script>")
        assert "<script>" not in sanitized

    def test_should_trim_whitespace(self) -> None:
        sanitized = InputSanitizer.sanitize("  hello world  ")
        assert sanitized == "hello world"


class TestRateLimiter:
    def test_should_allow_actions_within_limit(self) -> None:
        config = RateLimitConfig(
            max_actions_per_minute=10,
            max_sessions_per_hour=5,
        )
        limiter = RateLimiter(config)
        assert limiter.check_action("user1") is True

    def test_should_track_action_count(self) -> None:
        config = RateLimitConfig(
            max_actions_per_minute=2,
            max_sessions_per_hour=5,
        )
        limiter = RateLimiter(config)
        limiter.record_action("user1")
        limiter.record_action("user1")
        assert limiter.check_action("user1") is False


class TestRetryLogic:
    def test_should_have_default_retry_configs(self) -> None:
        assert "navigation" in DEFAULT_RETRY_CONFIGS
        assert DEFAULT_RETRY_CONFIGS["navigation"].max_attempts > 0

    @pytest.mark.asyncio
    async def test_should_sleep_for_specified_duration(self) -> None:
        import time
        start = time.time()
        await sleep(50)
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
        result = await retry_with_backoff(fn, config)
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
            await retry_with_backoff(fn, config)
