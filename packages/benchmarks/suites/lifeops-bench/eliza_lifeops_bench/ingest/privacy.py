"""Python port of the credential + geo redaction passes from
``plugins/app-training/src/core/privacy-filter.ts``.

This module deliberately implements only the two redaction passes the
LifeOpsBench ingestor needs: credential stripping and geo redaction. It
does NOT implement the cross-platform handle anonymization or the
``ContactPreferences.privacyLevel`` drop pass — those depend on a
runtime relationships service that has no analog in the bench process.

The replacement strings (``<REDACTED:label>``, ``[REDACTED_GEO]``) and
the regex shapes match the TS file character-for-character so anything
already redacted upstream round-trips identically.

Sync rule: when the TS file at
``plugins/app-training/src/core/privacy-filter.ts`` changes any of the
``DEFAULT_CREDENTIAL_PATTERNS`` / ``DEFAULT_GEO_PATTERNS`` arrays,
update this file in lockstep. There is intentionally no TS-to-Python
bridge — the patterns are small enough that a hand port is the simpler
contract.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

# ---------------------------------------------------------------------------
# Patterns — direct port of DEFAULT_CREDENTIAL_PATTERNS and
# DEFAULT_GEO_PATTERNS in privacy-filter.ts. Order matches the TS file.
# ---------------------------------------------------------------------------

DEFAULT_CREDENTIAL_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("openai-key", re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b")),
    ("anthropic-key", re.compile(r"\bsk-ant-[A-Za-z0-9_-]{16,}\b")),
    ("bearer", re.compile(r"\bBearer\s+[A-Za-z0-9._-]{16,}\b")),
    ("github-token", re.compile(r"\bghp_[A-Za-z0-9]{20,}\b")),
    ("aws-access-key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
]

GEO_REPLACEMENT = "[REDACTED_GEO]"

# Geo passes are applied IN ORDER so the JSON `coords` block consumes
# its inner latitude/longitude pair before any later pass can match it
# again. Same ordering as the TS file.
DEFAULT_GEO_PATTERNS: list[re.Pattern[str]] = [
    # 1. Capacitor-style JSON `"coords":{"latitude":..,"longitude":..[,...]}`.
    re.compile(
        r'"coords"\s*:\s*\{\s*"latitude"\s*:\s*-?\d+(?:\.\d+)?\s*,'
        r'\s*"longitude"\s*:\s*-?\d+(?:\.\d+)?'
        r'(?:\s*,\s*"[A-Za-z_][A-Za-z0-9_]*"\s*:\s*[^,}]+)*\s*\}'
    ),
    # 2. Bare JSON pair `"latitude":..,"longitude":..`.
    re.compile(
        r'"latitude"\s*:\s*-?\d+(?:\.\d+)?\s*,\s*"longitude"\s*:\s*-?\d+(?:\.\d+)?'
    ),
    # 3. `current location: 37.7, -122.4` / `coords: ...` / `coordinates=...`.
    re.compile(
        r"\b(?:current\s+location|location|coords|coordinates)\s*[:=]\s*"
        r"-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?",
        re.IGNORECASE,
    ),
    # 4. Labeled `lat: .., lng: ..` / `latitude=.., longitude=..`.
    re.compile(
        r"\b(?:lat|latitude)\s*[:=]\s*-?\d+(?:\.\d+)?\s*[,;]\s*"
        r"(?:lng|lon|long|longitude)\s*[:=]\s*-?\d+(?:\.\d+)?",
        re.IGNORECASE,
    ),
    # 5. Bare decimal pair `37.7749, -122.4194` (both numbers must have a
    #    fractional component to avoid matching integer pairs).
    re.compile(r"\b-?\d{1,3}\.\d{2,}\s*,\s*-?\d{1,3}\.\d{2,}\b"),
]


# ---------------------------------------------------------------------------
# Stats dataclass — counts per filter pass so callers can verify and audit.
# ---------------------------------------------------------------------------


@dataclass
class FilterStats:
    """Counters returned by :func:`apply_privacy_filter`.

    ``redaction_count`` mirrors the TS ``FilterResult.redactionCount`` —
    one tick per regex match across both credential and geo passes.
    ``anonymization_count`` is kept for parity with the TS API even
    though this Python port doesn't implement handle anonymization
    (always 0 for now).
    """

    redaction_count: int = 0
    anonymization_count: int = 0
    credential_hits: dict[str, int] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Single-string passes
# ---------------------------------------------------------------------------


def redact_credentials(text: str, *, stats: FilterStats | None = None) -> str:
    """Strip credential shapes (sk-*, sk-ant-*, Bearer …, ghp_*, AKIA*).

    Matches ``DEFAULT_CREDENTIAL_PATTERNS`` and replaces each with
    ``<REDACTED:{label}>``. If ``stats`` is supplied, increments the
    per-label hit counter and the global ``redaction_count``.
    """
    out = text
    for label, pattern in DEFAULT_CREDENTIAL_PATTERNS:
        def _sub(_m: re.Match[str], _label: str = label) -> str:
            if stats is not None:
                stats.redaction_count += 1
                stats.credential_hits[_label] = stats.credential_hits.get(_label, 0) + 1
            return f"<REDACTED:{_label}>"

        out = pattern.sub(_sub, out)
    return out


def redact_geo(text: str, *, stats: FilterStats | None = None) -> str:
    """Strip lat/lng pairs in JSON, labeled, and bare decimal forms.

    Replaces matches with ``[REDACTED_GEO]``. Patterns are applied in
    the same order as the TS source so the JSON ``coords`` block
    consumes its inner pair before later, looser passes can match it
    again.
    """
    out = text
    for pattern in DEFAULT_GEO_PATTERNS:
        def _sub(_m: re.Match[str]) -> str:
            if stats is not None:
                stats.redaction_count += 1
            return GEO_REPLACEMENT

        out = pattern.sub(_sub, out)
    return out


# ---------------------------------------------------------------------------
# Recursive trajectory pass
# ---------------------------------------------------------------------------


def _filter_value(value: Any, stats: FilterStats) -> Any:
    """Recursively filter every string field; pass-through everything else."""
    if isinstance(value, str):
        # Geo first so JSON coords blocks collapse before later passes see
        # them. Mirrors the TS ``transformText`` ordering.
        v = redact_geo(value, stats=stats)
        v = redact_credentials(v, stats=stats)
        return v
    if isinstance(value, dict):
        return {k: _filter_value(v, stats) for k, v in value.items()}
    if isinstance(value, list):
        return [_filter_value(item, stats) for item in value]
    if isinstance(value, tuple):
        return tuple(_filter_value(item, stats) for item in value)
    return value


def apply_privacy_filter(
    trajectory: dict[str, Any],
) -> tuple[dict[str, Any], FilterStats]:
    """Recursively redact every string field in a trajectory.

    Returns a deep-copied trajectory with all credential and geo patterns
    replaced, plus a :class:`FilterStats` describing what was found. The
    input dict is not mutated.
    """
    stats = FilterStats()
    cleaned = _filter_value(trajectory, stats)
    if not isinstance(cleaned, dict):
        # Defensive: top-level must remain a dict. ``_filter_value`` only
        # returns a non-dict when the input wasn't a dict, which would be
        # a programming error from the caller.
        raise TypeError(
            f"apply_privacy_filter expected a dict, got {type(trajectory).__name__}"
        )
    return cleaned, stats
