"""
Security utilities for the browser plugin.

Provides URL validation, input sanitization, and rate limiting.
"""

import re
import time
from urllib.parse import urlparse

from elizaos_browser.types import SecurityConfig, RateLimitConfig, RateLimitEntry
from elizaos_browser.utils.errors import SecurityError


class UrlValidator:
    """URL validation and sanitization."""

    def __init__(self, config: SecurityConfig | None = None) -> None:
        self.config = config or SecurityConfig()

    def validate(self, url: str) -> tuple[bool, str | None, str | None]:
        """
        Validate if a URL is allowed.

        Returns:
            Tuple of (valid, sanitized_url, error_message)
        """
        try:
            # Check URL length
            if len(url) > self.config.max_url_length:
                return False, None, "URL is too long"

            # Parse URL
            try:
                parsed = urlparse(url)
                if not parsed.scheme:
                    # Try adding https://
                    url = f"https://{url}"
                    parsed = urlparse(url)
            except Exception:
                return False, None, "Invalid URL format"

            # Check protocol
            if parsed.scheme == "file" and not self.config.allow_file_protocol:
                return False, None, "File protocol is not allowed"

            if parsed.scheme not in ("http", "https", "file"):
                return False, None, "Only HTTP(S) protocols are allowed"

            # Check localhost
            hostname = parsed.hostname or ""
            is_localhost = hostname in ("localhost", "127.0.0.1", "::1")
            if is_localhost and not self.config.allow_localhost:
                return False, None, "Localhost URLs are not allowed"

            # Check against blocked domains
            for blocked in self.config.blocked_domains:
                if blocked in hostname:
                    return False, None, f"Domain {blocked} is blocked"

            # Check against allowed domains (if specified)
            if self.config.allowed_domains:
                allowed = any(
                    hostname == domain or hostname.endswith(f".{domain}")
                    for domain in self.config.allowed_domains
                )
                if not allowed:
                    return False, None, "Domain is not in the allowed list"

            return True, url, None

        except Exception:
            return False, None, "Error validating URL"

    def update_config(self, config: SecurityConfig) -> None:
        """Update security configuration."""
        self.config = config


class InputSanitizer:
    """Input sanitization utilities."""

    @staticmethod
    def sanitize_text(input_text: str) -> str:
        """Sanitize text input to prevent XSS and injection attacks."""
        result = re.sub(r"[<>]", "", input_text)
        result = re.sub(r"javascript:", "", result, flags=re.IGNORECASE)
        result = re.sub(r"on\w+\s*=", "", result, flags=re.IGNORECASE)
        return result.strip()

    @staticmethod
    def sanitize_selector(selector: str) -> str:
        """Sanitize selector strings for browser actions."""
        result = re.sub(r"['\"]", "", selector)
        result = re.sub(r"[<>]", "", result)
        return result.strip()

    @staticmethod
    def sanitize_file_path(path: str) -> str:
        """Sanitize file paths."""
        result = re.sub(r"\.\.", "", path)
        result = re.sub(r'[<>:"|?*]', "", result)
        return result.strip()


class RateLimiter:
    """Rate limiter for preventing abuse."""

    def __init__(self, config: RateLimitConfig) -> None:
        self.config = config
        self._action_counts: dict[str, RateLimitEntry] = {}
        self._session_counts: dict[str, RateLimitEntry] = {}

    def check_action_limit(self, user_id: str) -> bool:
        """Check if an action is allowed."""
        now = time.time()
        user_limit = self._action_counts.get(user_id)

        if not user_limit or now > user_limit.reset_time:
            self._action_counts[user_id] = RateLimitEntry(
                count=1,
                reset_time=now + 60,  # 1 minute
            )
            return True

        if user_limit.count >= self.config.max_actions_per_minute:
            return False

        user_limit.count += 1
        return True

    def check_session_limit(self, user_id: str) -> bool:
        """Check if a new session is allowed."""
        now = time.time()
        user_limit = self._session_counts.get(user_id)

        if not user_limit or now > user_limit.reset_time:
            self._session_counts[user_id] = RateLimitEntry(
                count=1,
                reset_time=now + 3600,  # 1 hour
            )
            return True

        if user_limit.count >= self.config.max_sessions_per_hour:
            return False

        user_limit.count += 1
        return True


# Default validator instance
default_url_validator = UrlValidator()


def validate_secure_action(url: str | None, validator: UrlValidator) -> None:
    """Validate URL security for actions."""
    if not url:
        return

    valid, _, error = validator.validate(url)
    if not valid:
        raise SecurityError(f"URL validation failed: {error}", {"url": url, "error": error})

