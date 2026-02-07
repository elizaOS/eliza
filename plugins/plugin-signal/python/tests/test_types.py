"""
Tests for Signal plugin type definitions and validation utilities.

Covers:
- E.164 phone number validation (is_valid_e164)
- E.164 normalization (normalize_e164)
- UUID v4 validation (is_valid_uuid)
- Group ID validation (is_valid_group_id)
- Contact display name resolution (get_signal_contact_display_name)
- Constants and exception hierarchy
- Dataclass construction
"""

import pytest

from elizaos_plugin_signal.types import (
    MAX_SIGNAL_ATTACHMENT_SIZE,
    MAX_SIGNAL_MESSAGE_LENGTH,
    SIGNAL_SERVICE_NAME,
    SignalApiError,
    SignalAttachment,
    SignalClientNotAvailableError,
    SignalConfigurationError,
    SignalContact,
    SignalEventTypes,
    SignalGroup,
    SignalGroupMember,
    SignalMessage,
    SignalMessageSendOptions,
    SignalPluginError,
    SignalQuote,
    SignalReactionInfo,
    SignalServiceNotInitializedError,
    SignalSettings,
    get_signal_contact_display_name,
    is_valid_e164,
    is_valid_group_id,
    is_valid_uuid,
    normalize_e164,
)


# =========================================================================
# is_valid_e164
# =========================================================================


class TestIsValidE164:
    """E.164 phone number validation."""

    # --- positive cases ---

    def test_us_number(self):
        assert is_valid_e164("+14155551234") is True

    def test_uk_number(self):
        assert is_valid_e164("+447911123456") is True

    def test_min_length_two_digits(self):
        """Shortest valid E.164: country code (1 digit) + subscriber (1 digit)."""
        assert is_valid_e164("+12") is True

    def test_max_length_fifteen_digits(self):
        """E.164 allows up to 15 digits total (including country code)."""
        assert is_valid_e164("+123456789012345") is True

    def test_single_digit_country_code_long_subscriber(self):
        assert is_valid_e164("+11234567890") is True

    # --- negative cases ---

    def test_missing_plus_prefix(self):
        assert is_valid_e164("14155551234") is False

    def test_leading_zero_country_code(self):
        assert is_valid_e164("+0123456789") is False

    def test_empty_string(self):
        assert is_valid_e164("") is False

    def test_plus_only(self):
        assert is_valid_e164("+") is False

    def test_too_long(self):
        assert is_valid_e164("+1234567890123456") is False  # 16 digits

    def test_contains_letters(self):
        assert is_valid_e164("+1415abc1234") is False

    def test_contains_spaces(self):
        assert is_valid_e164("+1 415 555 1234") is False

    def test_contains_dashes(self):
        assert is_valid_e164("+1-415-555-1234") is False

    def test_contains_parentheses(self):
        assert is_valid_e164("+1(415)5551234") is False

    def test_double_plus(self):
        assert is_valid_e164("++14155551234") is False


# =========================================================================
# normalize_e164
# =========================================================================


class TestNormalizeE164:
    """Phone number normalization to E.164."""

    # --- already valid ---

    def test_already_valid_number(self):
        assert normalize_e164("+14155551234") == "+14155551234"

    # --- missing plus ---

    def test_adds_plus_prefix(self):
        assert normalize_e164("14155551234") == "+14155551234"

    # --- strips separators ---

    def test_strips_dashes(self):
        assert normalize_e164("+1-415-555-1234") == "+14155551234"

    def test_strips_spaces(self):
        assert normalize_e164("+1 415 555 1234") == "+14155551234"

    def test_strips_parentheses(self):
        assert normalize_e164("+1 (415) 555-1234") == "+14155551234"

    def test_strips_dots(self):
        assert normalize_e164("+1.415.555.1234") == "+14155551234"

    def test_strips_brackets(self):
        assert normalize_e164("+1[415]5551234") == "+14155551234"

    def test_combined_separators(self):
        assert normalize_e164("1-(415) 555.1234") == "+14155551234"

    # --- returns None for invalid ---

    def test_empty_string_returns_none(self):
        assert normalize_e164("") is None

    def test_all_letters_returns_none(self):
        assert normalize_e164("invalid") is None

    def test_too_short_returns_none(self):
        assert normalize_e164("+") is None

    def test_leading_zero_country_code_returns_none(self):
        assert normalize_e164("+01234567") is None

    def test_too_many_digits_returns_none(self):
        assert normalize_e164("+1234567890123456") is None


# =========================================================================
# is_valid_uuid
# =========================================================================


class TestIsValidUuid:
    """UUID v4 validation."""

    def test_valid_lowercase(self):
        assert is_valid_uuid("a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d") is True

    def test_valid_uppercase(self):
        assert is_valid_uuid("A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D") is True

    def test_valid_mixed_case(self):
        assert is_valid_uuid("a1B2c3D4-e5F6-4a7B-8c9D-0e1F2a3B4c5D") is True

    def test_invalid_version_not_4(self):
        assert is_valid_uuid("a1b2c3d4-e5f6-3a7b-8c9d-0e1f2a3b4c5d") is False

    def test_invalid_variant_bits(self):
        assert is_valid_uuid("a1b2c3d4-e5f6-4a7b-0c9d-0e1f2a3b4c5d") is False

    def test_empty_string(self):
        assert is_valid_uuid("") is False

    def test_random_string(self):
        assert is_valid_uuid("not-a-uuid") is False

    def test_missing_hyphens(self):
        assert is_valid_uuid("a1b2c3d4e5f64a7b8c9d0e1f2a3b4c5d") is False


# =========================================================================
# is_valid_group_id
# =========================================================================


class TestIsValidGroupId:
    """Signal group ID validation (base64)."""

    def test_valid_base64_with_padding(self):
        assert is_valid_group_id("YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=") is True

    def test_valid_base64_no_padding(self):
        assert is_valid_group_id("YWJjZGVmZ2hpamtsbW5vcHFy") is True

    def test_valid_with_plus_slash(self):
        assert is_valid_group_id("YWJjZGVmZ2hp+amtsbW5v/w==") is True

    def test_too_short_under_20_chars(self):
        assert is_valid_group_id("YWJjZGVmZ2hpamts") is False  # 16 chars

    def test_exactly_20_chars(self):
        assert is_valid_group_id("YWJjZGVmZ2hpamtsbW5v") is True  # 20 chars

    def test_empty_string(self):
        assert is_valid_group_id("") is False

    def test_contains_invalid_base64_chars(self):
        assert is_valid_group_id("YWJjZGVmZ2hpamts!@#$bW5v") is False


# =========================================================================
# get_signal_contact_display_name
# =========================================================================


class TestGetSignalContactDisplayName:
    """Contact display name priority resolution."""

    def test_prefers_name_field(self):
        contact = SignalContact(
            number="+14155551234",
            name="Full Name",
            profile_name="Profile",
            given_name="Given",
        )
        assert get_signal_contact_display_name(contact) == "Full Name"

    def test_falls_back_to_profile_name(self):
        contact = SignalContact(
            number="+14155551234",
            profile_name="ProfileName",
            given_name="Given",
        )
        assert get_signal_contact_display_name(contact) == "ProfileName"

    def test_falls_back_to_given_name_only(self):
        contact = SignalContact(
            number="+14155551234",
            given_name="Alice",
        )
        assert get_signal_contact_display_name(contact) == "Alice"

    def test_combines_given_and_family_name(self):
        contact = SignalContact(
            number="+14155551234",
            given_name="Alice",
            family_name="Smith",
        )
        assert get_signal_contact_display_name(contact) == "Alice Smith"

    def test_falls_back_to_phone_number(self):
        contact = SignalContact(number="+14155551234")
        assert get_signal_contact_display_name(contact) == "+14155551234"

    def test_ignores_none_name(self):
        contact = SignalContact(
            number="+14155551234",
            name=None,
            profile_name=None,
            given_name=None,
        )
        assert get_signal_contact_display_name(contact) == "+14155551234"


# =========================================================================
# Constants
# =========================================================================


class TestConstants:
    """Verify important constants."""

    def test_max_message_length(self):
        assert MAX_SIGNAL_MESSAGE_LENGTH == 2000

    def test_max_attachment_size(self):
        assert MAX_SIGNAL_ATTACHMENT_SIZE == 100 * 1024 * 1024

    def test_service_name(self):
        assert SIGNAL_SERVICE_NAME == "signal"


# =========================================================================
# Event types
# =========================================================================


class TestSignalEventTypes:
    """SignalEventTypes enum values."""

    def test_message_received_value(self):
        assert SignalEventTypes.MESSAGE_RECEIVED.value == "SIGNAL_MESSAGE_RECEIVED"

    def test_message_sent_value(self):
        assert SignalEventTypes.MESSAGE_SENT.value == "SIGNAL_MESSAGE_SENT"

    def test_reaction_received_value(self):
        assert SignalEventTypes.REACTION_RECEIVED.value == "SIGNAL_REACTION_RECEIVED"

    def test_group_joined_value(self):
        assert SignalEventTypes.GROUP_JOINED.value == "SIGNAL_GROUP_JOINED"

    def test_all_members_are_strings(self):
        for member in SignalEventTypes:
            assert isinstance(member.value, str)

    def test_event_count(self):
        assert len(SignalEventTypes) == 8


# =========================================================================
# Exception hierarchy
# =========================================================================


class TestExceptions:
    """Custom exception classes."""

    def test_base_exception_hierarchy(self):
        assert issubclass(SignalPluginError, Exception)
        assert issubclass(SignalServiceNotInitializedError, SignalPluginError)
        assert issubclass(SignalClientNotAvailableError, SignalPluginError)
        assert issubclass(SignalConfigurationError, SignalPluginError)
        assert issubclass(SignalApiError, SignalPluginError)

    def test_service_not_initialized_default_message(self):
        err = SignalServiceNotInitializedError()
        assert "not initialized" in str(err)

    def test_client_not_available_default_message(self):
        err = SignalClientNotAvailableError()
        assert "not available" in str(err)

    def test_configuration_error_captures_setting_name(self):
        err = SignalConfigurationError("bad value", setting_name="SIGNAL_HTTP_URL")
        assert err.setting_name == "SIGNAL_HTTP_URL"
        assert "bad value" in str(err)

    def test_api_error_captures_status_and_body(self):
        err = SignalApiError(
            "request failed",
            status_code=502,
            response_body='{"error":"bad gateway"}',
        )
        assert err.status_code == 502
        assert err.response_body == '{"error":"bad gateway"}'
        assert "request failed" in str(err)

    def test_api_error_optional_fields_default_to_none(self):
        err = SignalApiError("oops")
        assert err.status_code is None
        assert err.response_body is None


# =========================================================================
# Dataclass construction
# =========================================================================


class TestDataclasses:
    """Verify dataclass defaults and construction."""

    def test_signal_settings_defaults(self):
        settings = SignalSettings(account_number="+14155551234")
        assert settings.http_url is None
        assert settings.cli_path is None
        assert settings.should_ignore_group_messages is False
        assert settings.poll_interval_ms == 1000
        assert settings.typing_indicator_enabled is True

    def test_signal_attachment_defaults(self):
        att = SignalAttachment(content_type="image/png")
        assert att.filename is None
        assert att.voice_note is False
        assert att.size is None

    def test_signal_message_defaults(self):
        msg = SignalMessage(timestamp=1700000000000, source="+14155551234")
        assert msg.text is None
        assert msg.attachments == []
        assert msg.group_id is None
        assert msg.is_view_once is False

    def test_signal_quote_construction(self):
        quote = SignalQuote(id=1700000000000, author="+14155551234", text="quoted")
        assert quote.id == 1700000000000
        assert quote.author == "+14155551234"
        assert quote.text == "quoted"
        assert quote.attachments == []

    def test_signal_reaction_info(self):
        reaction = SignalReactionInfo(
            emoji="👍",
            target_author="+14155551234",
            target_sent_timestamp=1700000000000,
        )
        assert reaction.emoji == "👍"
        assert reaction.is_remove is False

    def test_signal_group_defaults(self):
        group = SignalGroup(id="abc", name="Test")
        assert group.members == []
        assert group.is_member is True
        assert group.is_blocked is False
        assert group.invite_link is None

    def test_signal_group_member_defaults(self):
        member = SignalGroupMember(uuid="u1")
        assert member.role == "DEFAULT"
        assert member.number is None

    def test_signal_message_send_options_defaults(self):
        opts = SignalMessageSendOptions()
        assert opts.attachments == []
        assert opts.mentions == []
        assert opts.quote_timestamp is None
