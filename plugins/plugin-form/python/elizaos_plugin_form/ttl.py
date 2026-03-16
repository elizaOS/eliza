"""
Smart TTL (Time-To-Live) management for form sessions.

TTL = clamp(minDays, effortDays, maxDays)
where effortDays = minutesSpent * effortMultiplier

Defaults: minDays=14, maxDays=90, effortMultiplier=0.5
"""

from __future__ import annotations

import time

from .types import (
    FORM_DEFINITION_DEFAULTS,
    FormDefinition,
    FormSession,
)

# Convenience accessors for nested defaults
_TTL_DEFAULTS: dict[str, float | int] = FORM_DEFINITION_DEFAULTS["ttl"]  # type: ignore[assignment]
_NUDGE_DEFAULTS: dict[str, float | int | bool] = FORM_DEFINITION_DEFAULTS["nudge"]  # type: ignore[assignment]


def _now_ms() -> int:
    """Current time in milliseconds since epoch."""
    return int(time.time() * 1000)


def calculate_ttl(session: FormSession, form: FormDefinition | None = None) -> int:
    """Calculate TTL based on user effort.

    Returns expiration timestamp in milliseconds since epoch.
    """
    ttl_cfg = form.ttl if form and form.ttl else None

    min_days: float = (ttl_cfg.min_days if ttl_cfg and ttl_cfg.min_days is not None else _TTL_DEFAULTS["min_days"])  # type: ignore[arg-type]
    max_days: float = (ttl_cfg.max_days if ttl_cfg and ttl_cfg.max_days is not None else _TTL_DEFAULTS["max_days"])  # type: ignore[arg-type]
    multiplier: float = (ttl_cfg.effort_multiplier if ttl_cfg and ttl_cfg.effort_multiplier is not None else _TTL_DEFAULTS["effort_multiplier"])  # type: ignore[arg-type]

    minutes_spent = session.effort.time_spent_ms / 60_000
    effort_days = minutes_spent * multiplier
    ttl_days = min(max_days, max(min_days, effort_days))

    return _now_ms() + int(ttl_days * 24 * 60 * 60 * 1000)


def should_nudge(session: FormSession, form: FormDefinition | None = None) -> bool:
    """Check if session should receive a nudge reminder."""
    nudge_cfg = form.nudge if form and form.nudge else None

    # Disabled?
    if nudge_cfg and nudge_cfg.enabled is False:
        return False

    # Max nudges reached?
    max_nudges: int = (nudge_cfg.max_nudges if nudge_cfg and nudge_cfg.max_nudges is not None else _NUDGE_DEFAULTS["max_nudges"])  # type: ignore[arg-type]
    if (session.nudge_count or 0) >= max_nudges:
        return False

    # Enough inactive time?
    after_hours: float = (nudge_cfg.after_inactive_hours if nudge_cfg and nudge_cfg.after_inactive_hours is not None else _NUDGE_DEFAULTS["after_inactive_hours"])  # type: ignore[arg-type]
    inactive_ms = after_hours * 60 * 60 * 1000
    now = _now_ms()
    if now - session.effort.last_interaction_at < inactive_ms:
        return False

    # Recent nudge? (24h minimum between nudges)
    if session.last_nudge_at is not None:
        if now - session.last_nudge_at < 24 * 60 * 60 * 1000:
            return False

    return True


def is_expiring_soon(session: FormSession, within_ms: int) -> bool:
    """Check if session expires within *within_ms* milliseconds."""
    return session.expires_at - _now_ms() < within_ms


def is_expired(session: FormSession) -> bool:
    """Check if session has expired."""
    return session.expires_at < _now_ms()


def should_confirm_cancel(session: FormSession) -> bool:
    """Check if we should confirm before cancelling (>5 min effort)."""
    return session.effort.time_spent_ms > 5 * 60 * 1000


def format_time_remaining(session: FormSession) -> str:
    """Human-readable time remaining for a session."""
    remaining = session.expires_at - _now_ms()

    if remaining <= 0:
        return "expired"

    hours = remaining // (60 * 60 * 1000)
    days = hours // 24

    if days > 0:
        return f"{days} day{'s' if days > 1 else ''}"
    if hours > 0:
        return f"{hours} hour{'s' if hours > 1 else ''}"

    minutes = remaining // (60 * 1000)
    return f"{minutes} minute{'s' if minutes > 1 else ''}"


def format_effort(session: FormSession) -> str:
    """Human-readable effort description."""
    minutes = session.effort.time_spent_ms // 60_000

    if minutes < 1:
        return "just started"
    if minutes < 60:
        return f"{minutes} minute{'s' if minutes > 1 else ''}"

    hours = minutes // 60
    remaining_minutes = minutes % 60

    if remaining_minutes == 0:
        return f"{hours} hour{'s' if hours > 1 else ''}"

    return f"{hours}h {remaining_minutes}m"
