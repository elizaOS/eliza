"""Comprehensive tests for the validation module."""

from __future__ import annotations

import math

import pytest

from elizaos_plugin_form.types import (
    FormControl,
    FormControlFileOptions,
    FormControlOption,
    ValidationResult,
)
from elizaos_plugin_form.validation import (
    TypeHandler,
    clear_type_handlers,
    format_value,
    get_type_handler,
    matches_mime_type,
    parse_value,
    register_type_handler,
    validate_field,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _clean_handlers():
    """Ensure type handler registry is clean between tests."""
    clear_type_handlers()
    yield
    clear_type_handlers()


def _control(type_: str = "text", **kwargs) -> FormControl:
    """Helper to create a FormControl with sensible defaults."""
    return FormControl(key="test_field", label="Test", type=type_, **kwargs)


# ============================================================================
# REQUIRED vs OPTIONAL
# ============================================================================


class TestRequired:
    def test_required_rejects_none(self):
        result = validate_field(None, _control(required=True))
        assert not result.valid
        assert "required" in (result.error or "").lower()

    def test_required_rejects_empty_string(self):
        result = validate_field("", _control(required=True))
        assert not result.valid

    def test_required_accepts_value(self):
        result = validate_field("hello", _control(required=True))
        assert result.valid

    def test_optional_accepts_none(self):
        result = validate_field(None, _control(required=False))
        assert result.valid

    def test_optional_accepts_empty_string(self):
        result = validate_field("", _control(required=False))
        assert result.valid

    def test_optional_accepts_value(self):
        result = validate_field("hello", _control(required=False))
        assert result.valid


# ============================================================================
# EMAIL VALIDATION
# ============================================================================


class TestEmailValidation:
    def test_valid_email(self):
        assert validate_field("user@example.com", _control("email")).valid

    def test_valid_email_subdomain(self):
        assert validate_field("user@mail.example.co.uk", _control("email")).valid

    def test_invalid_email_no_at(self):
        result = validate_field("userexample.com", _control("email"))
        assert not result.valid
        assert "email" in (result.error or "").lower()

    def test_invalid_email_no_domain(self):
        assert not validate_field("user@", _control("email")).valid

    def test_invalid_email_no_tld(self):
        assert not validate_field("user@example", _control("email")).valid

    def test_invalid_email_spaces(self):
        assert not validate_field("user @example.com", _control("email")).valid

    def test_email_with_plus(self):
        assert validate_field("user+tag@example.com", _control("email")).valid


# ============================================================================
# NUMBER VALIDATION
# ============================================================================


class TestNumberValidation:
    def test_integer(self):
        assert validate_field(42, _control("number")).valid

    def test_float(self):
        assert validate_field(3.14, _control("number")).valid

    def test_string_number(self):
        assert validate_field("42", _control("number")).valid

    def test_nan_rejected(self):
        result = validate_field(float("nan"), _control("number"))
        assert not result.valid

    def test_string_nan_rejected(self):
        result = validate_field("not_a_number", _control("number"))
        assert not result.valid

    def test_min_valid(self):
        assert validate_field(10, _control("number", min=5)).valid

    def test_min_invalid(self):
        result = validate_field(3, _control("number", min=5))
        assert not result.valid
        assert "at least" in (result.error or "").lower()

    def test_max_valid(self):
        assert validate_field(5, _control("number", max=10)).valid

    def test_max_invalid(self):
        result = validate_field(15, _control("number", max=10))
        assert not result.valid
        assert "at most" in (result.error or "").lower()

    def test_comma_formatted(self):
        assert validate_field("1,234", _control("number")).valid

    def test_dollar_formatted(self):
        assert validate_field("$50", _control("number")).valid

    def test_negative_number(self):
        assert validate_field(-5, _control("number")).valid

    def test_zero(self):
        assert validate_field(0, _control("number")).valid


# ============================================================================
# BOOLEAN VALIDATION
# ============================================================================


class TestBooleanValidation:
    @pytest.mark.parametrize("value", [True, False])
    def test_native_bool(self, value):
        assert validate_field(value, _control("boolean")).valid

    @pytest.mark.parametrize("value", ["true", "yes", "1", "on", "True", "YES"])
    def test_truthy_strings(self, value):
        assert validate_field(value, _control("boolean")).valid

    @pytest.mark.parametrize("value", ["false", "no", "0", "off", "False", "NO"])
    def test_falsy_strings(self, value):
        assert validate_field(value, _control("boolean")).valid

    def test_invalid_string(self):
        result = validate_field("maybe", _control("boolean"))
        assert not result.valid
        assert "true or false" in (result.error or "").lower()

    def test_invalid_number(self):
        result = validate_field(42, _control("boolean"))
        assert not result.valid


# ============================================================================
# DATE VALIDATION
# ============================================================================


class TestDateValidation:
    def test_valid_iso_date(self):
        assert validate_field("2024-01-15", _control("date")).valid

    def test_valid_iso_datetime(self):
        assert validate_field("2024-01-15T10:30:00", _control("date")).valid

    def test_invalid_date_string(self):
        result = validate_field("not-a-date", _control("date"))
        assert not result.valid

    def test_min_date(self):
        # Timestamp for 2024-06-01 in ms
        min_ts = 1717200000000
        result = validate_field("2024-01-01", _control("date", min=min_ts))
        assert not result.valid
        assert "too early" in (result.error or "").lower()

    def test_max_date(self):
        # Timestamp for 2024-01-01 in ms
        max_ts = 1704067200000
        result = validate_field("2025-01-01", _control("date", max=max_ts))
        assert not result.valid
        assert "too late" in (result.error or "").lower()

    def test_non_string_non_number(self):
        result = validate_field(["2024-01-01"], _control("date"))
        assert not result.valid


# ============================================================================
# SELECT VALIDATION
# ============================================================================


class TestSelectValidation:
    def _opts(self):
        return [
            FormControlOption(value="us", label="United States"),
            FormControlOption(value="ca", label="Canada"),
        ]

    def test_valid_option(self):
        result = validate_field("us", _control("select", options=self._opts()))
        assert result.valid

    def test_invalid_option(self):
        result = validate_field("mx", _control("select", options=self._opts()))
        assert not result.valid
        assert "available options" in (result.error or "").lower()

    def test_no_options_accepts_anything(self):
        result = validate_field("anything", _control("select"))
        assert result.valid


# ============================================================================
# TEXT VALIDATION
# ============================================================================


class TestTextValidation:
    def test_pattern_match(self):
        assert validate_field("abc123", _control("text", pattern=r"^[a-z0-9]+$")).valid

    def test_pattern_no_match(self):
        result = validate_field("ABC!", _control("text", pattern=r"^[a-z0-9]+$"))
        assert not result.valid
        assert "invalid format" in (result.error or "").lower()

    def test_min_length(self):
        result = validate_field("ab", _control("text", min_length=3))
        assert not result.valid
        assert "at least 3" in (result.error or "")

    def test_max_length(self):
        result = validate_field("toolong", _control("text", max_length=3))
        assert not result.valid
        assert "at most 3" in (result.error or "")

    def test_enum_valid(self):
        assert validate_field("small", _control("text", enum=["small", "medium", "large"])).valid

    def test_enum_invalid(self):
        result = validate_field("xl", _control("text", enum=["small", "medium", "large"]))
        assert not result.valid
        assert "must be one of" in (result.error or "").lower()

    def test_unknown_type_falls_back_to_text(self):
        result = validate_field("hello", _control("custom_unknown"))
        assert result.valid


# ============================================================================
# FILE VALIDATION
# ============================================================================


class TestFileValidation:
    def test_no_file_options_passes(self):
        result = validate_field({"name": "test.txt"}, _control("file"))
        assert result.valid

    def test_max_files_exceeded(self):
        opts = FormControlFileOptions(max_files=2)
        files = [{"name": "a.txt"}, {"name": "b.txt"}, {"name": "c.txt"}]
        result = validate_field(files, _control("file", file=opts))
        assert not result.valid
        assert "Maximum 2" in (result.error or "")

    def test_max_size_exceeded(self):
        opts = FormControlFileOptions(max_size=1024)
        result = validate_field(
            [{"name": "big.txt", "size": 2048, "mimeType": "text/plain"}],
            _control("file", file=opts),
        )
        assert not result.valid
        assert "exceeds" in (result.error or "").lower()

    def test_mime_type_rejected(self):
        opts = FormControlFileOptions(accept=["image/*"])
        result = validate_field(
            [{"name": "doc.pdf", "size": 100, "mimeType": "application/pdf"}],
            _control("file", file=opts),
        )
        assert not result.valid
        assert "not accepted" in (result.error or "").lower()

    def test_mime_type_accepted(self):
        opts = FormControlFileOptions(accept=["image/*"])
        result = validate_field(
            [{"name": "pic.png", "size": 100, "mimeType": "image/png"}],
            _control("file", file=opts),
        )
        assert result.valid


# ============================================================================
# MIME TYPE MATCHING
# ============================================================================


class TestMimeTypeMatching:
    def test_exact_match(self):
        assert matches_mime_type("image/png", "image/png")

    def test_exact_no_match(self):
        assert not matches_mime_type("image/png", "image/jpeg")

    def test_wildcard_match(self):
        assert matches_mime_type("image/png", "image/*")

    def test_wildcard_no_match(self):
        assert not matches_mime_type("application/pdf", "image/*")

    def test_universal_match(self):
        assert matches_mime_type("anything/at-all", "*/*")


# ============================================================================
# TYPE HANDLER REGISTRY
# ============================================================================


class TestTypeHandlerRegistry:
    def test_register_and_get(self):
        handler = TypeHandler(
            validate=lambda v, c: ValidationResult(valid=True),
        )
        register_type_handler("custom", handler)
        assert get_type_handler("custom") is handler

    def test_get_unregistered_returns_none(self):
        assert get_type_handler("nonexistent") is None

    def test_clear(self):
        register_type_handler("temp", TypeHandler())
        clear_type_handlers()
        assert get_type_handler("temp") is None

    def test_custom_handler_priority(self):
        """Custom handler is called before built-in type validation."""
        handler = TypeHandler(
            validate=lambda v, c: ValidationResult(valid=False, error="custom fail"),
        )
        register_type_handler("text", handler)
        result = validate_field("hello", _control("text"))
        assert not result.valid
        assert "custom fail" in (result.error or "")


# ============================================================================
# parse_value
# ============================================================================


class TestParseValue:
    def test_parse_number(self):
        assert parse_value("1,234.56", _control("number")) == 1234.56

    def test_parse_number_dollar(self):
        assert parse_value("$50", _control("number")) == 50.0

    def test_parse_boolean_true(self):
        assert parse_value("yes", _control("boolean")) is True

    def test_parse_boolean_false(self):
        assert parse_value("no", _control("boolean")) is False

    def test_parse_date(self):
        result = parse_value("2024-06-15", _control("date"))
        assert "2024-06-15" in str(result)

    def test_parse_text(self):
        assert parse_value("hello", _control("text")) == "hello"

    def test_parse_email(self):
        assert parse_value("user@example.com", _control("email")) == "user@example.com"

    def test_parse_select(self):
        assert parse_value("option1", _control("select")) == "option1"

    def test_parse_custom_handler(self):
        handler = TypeHandler(parse=lambda v: f"custom:{v}")
        register_type_handler("custom_type", handler)
        result = parse_value("hello", _control("custom_type"))
        assert result == "custom:hello"


# ============================================================================
# format_value
# ============================================================================


class TestFormatValue:
    def test_format_none(self):
        assert format_value(None, _control("text")) == ""

    def test_format_text(self):
        assert format_value("hello", _control("text")) == "hello"

    def test_format_number_int(self):
        result = format_value(1234, _control("number"))
        assert "1,234" in result or "1234" in result

    def test_format_boolean_true(self):
        assert format_value(True, _control("boolean")) == "Yes"

    def test_format_boolean_false(self):
        assert format_value(False, _control("boolean")) == "No"

    def test_format_select_with_label(self):
        opts = [FormControlOption(value="us", label="United States")]
        assert format_value("us", _control("select", options=opts)) == "United States"

    def test_format_select_no_match(self):
        opts = [FormControlOption(value="us", label="United States")]
        assert format_value("ca", _control("select", options=opts)) == "ca"

    def test_format_sensitive_short(self):
        result = format_value("secret", _control("text", sensitive=True))
        assert result == "****"

    def test_format_sensitive_long(self):
        result = format_value("mysecretpassword", _control("text", sensitive=True))
        assert result.startswith("myse")
        assert result.endswith("word")
        assert "..." in result

    def test_format_file_list(self):
        files = [{"name": "a.txt"}, {"name": "b.txt"}]
        result = format_value(files, _control("file"))
        assert "a.txt" in result
        assert "b.txt" in result

    def test_format_file_single(self):
        result = format_value({"name": "doc.pdf"}, _control("file"))
        assert "doc.pdf" in result

    def test_format_custom_handler(self):
        handler = TypeHandler(format=lambda v: f"formatted:{v}")
        register_type_handler("custom_fmt", handler)
        result = format_value("hello", _control("custom_fmt"))
        assert result == "formatted:hello"
