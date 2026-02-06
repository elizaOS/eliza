"""Tests for validation helpers, webhook signature verification, and URL extraction."""

from __future__ import annotations

import hashlib
import hmac as hmac_mod

from elizaos_plugin_blooio.utils import (
    extract_chat_id_candidates,
    extract_urls,
    validate_chat_id,
    validate_email,
    validate_group_id,
    validate_phone,
    verify_webhook_signature,
)


# ---------------------------------------------------------------------------
# Phone validation
# ---------------------------------------------------------------------------


def test_validate_phone_valid_e164() -> None:
    assert validate_phone("+15551234567")


def test_validate_phone_valid_short() -> None:
    assert validate_phone("+44")


def test_validate_phone_invalid_no_plus() -> None:
    assert not validate_phone("15551234567")


def test_validate_phone_invalid_too_long() -> None:
    assert not validate_phone("+1234567890123456")


def test_validate_phone_invalid_letters() -> None:
    assert not validate_phone("+1555abc1234")


# ---------------------------------------------------------------------------
# Email validation
# ---------------------------------------------------------------------------


def test_validate_email_valid() -> None:
    assert validate_email("user@example.com")


def test_validate_email_valid_subdomains() -> None:
    assert validate_email("user@mail.example.co.uk")


def test_validate_email_invalid_no_at() -> None:
    assert not validate_email("userexample.com")


def test_validate_email_invalid_spaces() -> None:
    assert not validate_email("user @example.com")


# ---------------------------------------------------------------------------
# Group ID validation
# ---------------------------------------------------------------------------


def test_validate_group_id_valid() -> None:
    assert validate_group_id("grp_abc123")


def test_validate_group_id_invalid_prefix() -> None:
    assert not validate_group_id("group_abc123")


def test_validate_group_id_empty_suffix() -> None:
    assert not validate_group_id("grp_")


# ---------------------------------------------------------------------------
# Chat ID validation (composite)
# ---------------------------------------------------------------------------


def test_validate_chat_id_phone() -> None:
    assert validate_chat_id("+15551234567")


def test_validate_chat_id_email() -> None:
    assert validate_chat_id("user@example.com")


def test_validate_chat_id_group() -> None:
    assert validate_chat_id("grp_abc123")


def test_validate_chat_id_comma_separated() -> None:
    assert validate_chat_id("+15551234567,user@example.com")


def test_validate_chat_id_empty() -> None:
    assert not validate_chat_id("")


def test_validate_chat_id_invalid() -> None:
    assert not validate_chat_id("not_a_valid_id")


def test_validate_chat_id_mixed_valid_invalid() -> None:
    assert not validate_chat_id("+15551234567,invalid")


# ---------------------------------------------------------------------------
# Webhook signature verification
# ---------------------------------------------------------------------------


def test_verify_webhook_signature_valid() -> None:
    secret = "test_secret"
    payload = b"test payload"
    timestamp = "1234567890"

    msg = f"{timestamp}.{payload.decode()}"
    sig = hmac_mod.new(secret.encode(), msg.encode(), hashlib.sha256).hexdigest()
    header = f"t={timestamp},v1={sig}"

    assert verify_webhook_signature(payload, header, secret)


def test_verify_webhook_signature_invalid() -> None:
    bad_sig = "0" * 64
    header = f"t=1234567890,v1={bad_sig}"
    assert not verify_webhook_signature(b"payload", header, "secret")


def test_verify_webhook_signature_malformed() -> None:
    assert not verify_webhook_signature(b"payload", "malformed_header", "secret")


def test_verify_webhook_signature_raw_hmac() -> None:
    secret = "raw_secret"
    payload = b"raw payload data"
    sig = hmac_mod.new(secret.encode(), payload, hashlib.sha256).hexdigest()
    assert verify_webhook_signature(payload, sig, secret)


# ---------------------------------------------------------------------------
# URL extraction
# ---------------------------------------------------------------------------


def test_extract_urls_https() -> None:
    urls = extract_urls("Check https://example.com for info")
    assert urls == ["https://example.com"]


def test_extract_urls_http() -> None:
    urls = extract_urls("Visit http://example.com/page")
    assert urls == ["http://example.com/page"]


def test_extract_urls_deduplicates() -> None:
    urls = extract_urls("https://a.com and https://a.com again")
    assert len(urls) == 1


def test_extract_urls_empty() -> None:
    assert extract_urls("") == []


def test_extract_urls_no_urls() -> None:
    assert extract_urls("Just plain text") == []


# ---------------------------------------------------------------------------
# Chat-ID candidate extraction
# ---------------------------------------------------------------------------


def test_extract_candidates_phone() -> None:
    assert "+15551234567" in extract_chat_id_candidates("Call +15551234567 now")


def test_extract_candidates_email() -> None:
    assert "user@example.com" in extract_chat_id_candidates("Email user@example.com")


def test_extract_candidates_group() -> None:
    assert "grp_abc" in extract_chat_id_candidates("Group grp_abc is active")


def test_extract_candidates_empty() -> None:
    assert extract_chat_id_candidates("no identifiers here") == []
