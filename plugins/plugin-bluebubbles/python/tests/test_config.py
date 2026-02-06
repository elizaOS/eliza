"""Tests for BlueBubbles configuration."""

import pytest

from elizaos_plugin_bluebubbles.config import (
    BlueBubblesConfig,
    is_handle_allowed,
    normalize_handle,
)
from elizaos_plugin_bluebubbles.types import DmPolicy


class TestNormalizeHandle:
    """Tests for normalize_handle function."""

    def test_normalize_phone_with_formatting(self):
        """Test normalizing a phone number with formatting."""
        assert normalize_handle("+1 (555) 123-4567") == "+15551234567"

    def test_normalize_phone_without_plus(self):
        """Test normalizing a phone number without plus prefix."""
        assert normalize_handle("555-123-4567") == "+5551234567"

    def test_normalize_international_phone(self):
        """Test normalizing an international phone number."""
        assert normalize_handle("+44 7700 900000") == "+447700900000"

    def test_normalize_email(self):
        """Test normalizing an email address."""
        assert normalize_handle("User@Example.COM") == "user@example.com"

    def test_normalize_email_with_whitespace(self):
        """Test normalizing an email with whitespace."""
        assert normalize_handle("  test@test.com  ") == "test@test.com"


class TestIsHandleAllowed:
    """Tests for is_handle_allowed function."""

    def test_open_policy_allows_all(self):
        """Test that open policy allows all handles."""
        assert is_handle_allowed("anyone", [], DmPolicy.OPEN)

    def test_disabled_policy_denies_all(self):
        """Test that disabled policy denies all handles."""
        assert not is_handle_allowed("anyone", [], DmPolicy.DISABLED)

    def test_pairing_empty_allows_first(self):
        """Test that pairing with empty allowlist allows first contact."""
        assert is_handle_allowed("first@contact.com", [], DmPolicy.PAIRING)

    def test_allowlist_matches_normalized(self):
        """Test that allowlist matches normalized handles."""
        allow_list = ["+15551234567"]
        assert is_handle_allowed("+1 (555) 123-4567", allow_list, DmPolicy.ALLOWLIST)

    def test_allowlist_denies_non_matching(self):
        """Test that allowlist denies non-matching handles."""
        allow_list = ["+15551234567"]
        assert not is_handle_allowed("+15559876543", allow_list, DmPolicy.ALLOWLIST)


class TestBlueBubblesConfig:
    """Tests for BlueBubblesConfig."""

    def test_valid_config(self):
        """Test creating a valid configuration."""
        config = BlueBubblesConfig(
            server_url="http://localhost:1234",
            password="password123",
        )
        assert config.server_url == "http://localhost:1234"
        assert config.password == "password123"

    def test_empty_url_fails(self):
        """Test that empty URL fails validation."""
        with pytest.raises(ValueError, match="Server URL is required"):
            BlueBubblesConfig(server_url="", password="password")

    def test_empty_password_fails(self):
        """Test that empty password fails validation."""
        with pytest.raises(ValueError, match="Password is required"):
            BlueBubblesConfig(server_url="http://localhost:1234", password="")

    def test_invalid_url_fails(self):
        """Test that invalid URL fails validation."""
        with pytest.raises(ValueError, match="must start with http"):
            BlueBubblesConfig(server_url="localhost:1234", password="password")

    def test_default_values(self):
        """Test default configuration values."""
        config = BlueBubblesConfig(
            server_url="http://localhost:1234",
            password="password",
        )
        assert config.webhook_path == "/webhooks/bluebubbles"
        assert config.dm_policy == DmPolicy.PAIRING
        assert config.send_read_receipts is True
        assert config.enabled is True
