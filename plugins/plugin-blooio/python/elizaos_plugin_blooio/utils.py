"""Validation helpers, webhook signature verification, and URL extraction."""

from __future__ import annotations

import hashlib
import hmac
import re

# ---------------------------------------------------------------------------
# Regex patterns (compiled once at module level)
# ---------------------------------------------------------------------------

_E164_RE = re.compile(r"^\+\d{1,15}$")
_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
_GROUP_RE = re.compile(r"^grp_[A-Za-z0-9]+$")
_URL_RE = re.compile(r"https?://[^\s)]+")
_PHONE_EXTRACT_RE = re.compile(r"\+\d{1,15}")
_GROUP_EXTRACT_RE = re.compile(r"\bgrp_[A-Za-z0-9]+\b")
_EMAIL_EXTRACT_RE = re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b")

# ---------------------------------------------------------------------------
# Validators
# ---------------------------------------------------------------------------


def validate_phone(phone: str) -> bool:
    """Return ``True`` if *phone* is a valid E.164 number."""
    return bool(_E164_RE.match(phone))


def validate_email(email: str) -> bool:
    """Return ``True`` if *email* is a valid email address."""
    return bool(_EMAIL_RE.match(email))


def validate_group_id(gid: str) -> bool:
    """Return ``True`` if *gid* is a valid Blooio group identifier."""
    return bool(_GROUP_RE.match(gid))


def validate_chat_id(chat_id: str) -> bool:
    """Validate a chat identifier (comma-separated phones, emails, or group IDs)."""
    parts = [p.strip() for p in chat_id.split(",") if p.strip()]
    if not parts:
        return False
    return all(validate_phone(p) or validate_email(p) or validate_group_id(p) for p in parts)


# ---------------------------------------------------------------------------
# Webhook signature verification
# ---------------------------------------------------------------------------


def _parse_signature_header(header: str) -> tuple[str, str] | None:
    """Parse ``t=<timestamp>,v1=<hex_sig>`` into ``(timestamp, sig)``."""
    parts = [p.strip() for p in header.split(",")]
    timestamp: str | None = None
    sig: str | None = None
    for part in parts:
        if part.startswith("t="):
            timestamp = part[2:]
        elif part.startswith("v1="):
            sig = part[3:]
    if not timestamp or not sig:
        return None
    return timestamp, sig


def verify_webhook_signature(payload: bytes, signature: str, secret: str) -> bool:
    """Verify a Blooio webhook signature (HMAC-SHA256, constant-time)."""
    parsed = _parse_signature_header(signature)
    if parsed:
        timestamp, sig_hex = parsed
        msg = f"{timestamp}.{payload.decode('utf-8', errors='replace')}"
        expected = hmac.new(secret.encode(), msg.encode(), hashlib.sha256).hexdigest()
        return hmac.compare_digest(expected, sig_hex)

    # Fall back to raw HMAC comparison.
    expected = hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)


# ---------------------------------------------------------------------------
# URL extraction
# ---------------------------------------------------------------------------


def extract_urls(text: str) -> list[str]:
    """Return unique HTTP/HTTPS URLs found in *text*, preserving order."""
    seen: set[str] = set()
    urls: list[str] = []
    for m in _URL_RE.finditer(text):
        url = m.group()
        if url not in seen:
            seen.add(url)
            urls.append(url)
    return urls


# ---------------------------------------------------------------------------
# Chat-ID candidate extraction (used by the action)
# ---------------------------------------------------------------------------


def extract_chat_id_candidates(text: str) -> list[str]:
    """Extract candidate chat identifiers (phones, group IDs, emails) from text."""
    matches: list[tuple[int, str]] = []

    for m in _PHONE_EXTRACT_RE.finditer(text):
        matches.append((m.start(), m.group()))
    for m in _GROUP_EXTRACT_RE.finditer(text):
        matches.append((m.start(), m.group()))
    for m in _EMAIL_EXTRACT_RE.finditer(text):
        matches.append((m.start(), m.group()))

    matches.sort(key=lambda x: x[0])

    unique: list[str] = []
    for _, val in matches:
        if val not in unique:
            unique.append(val)
    return unique
