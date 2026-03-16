"""Comprehensive tests for the TTL module."""

from __future__ import annotations

import time
from unittest.mock import patch

import pytest

from elizaos_plugin_form.types import (
    FormDefinition,
    FormDefinitionNudge,
    FormDefinitionTTL,
    FormSession,
    SessionEffort,
)
from elizaos_plugin_form.ttl import (
    calculate_ttl,
    format_effort,
    format_time_remaining,
    is_expired,
    is_expiring_soon,
    should_confirm_cancel,
    should_nudge,
)


def _now_ms() -> int:
    return int(time.time() * 1000)


def _session(
    time_spent_ms: int = 0,
    last_interaction_ms: int | None = None,
    expires_at: int | None = None,
    nudge_count: int = 0,
    last_nudge_at: int | None = None,
) -> FormSession:
    now = _now_ms()
    return FormSession(
        id="sess-1",
        form_id="form-1",
        effort=SessionEffort(
            interaction_count=1,
            time_spent_ms=time_spent_ms,
            first_interaction_at=now - time_spent_ms,
            last_interaction_at=last_interaction_ms if last_interaction_ms is not None else now,
        ),
        expires_at=expires_at if expires_at is not None else (now + 14 * 24 * 60 * 60 * 1000),
        nudge_count=nudge_count,
        last_nudge_at=last_nudge_at,
    )


def _form(
    min_days: int | None = None,
    max_days: int | None = None,
    effort_multiplier: float | None = None,
    nudge_enabled: bool | None = None,
    nudge_max: int | None = None,
    nudge_after_hours: int | None = None,
) -> FormDefinition:
    ttl = FormDefinitionTTL()
    if min_days is not None:
        ttl.min_days = min_days
    if max_days is not None:
        ttl.max_days = max_days
    if effort_multiplier is not None:
        ttl.effort_multiplier = effort_multiplier
    nudge = FormDefinitionNudge()
    if nudge_enabled is not None:
        nudge.enabled = nudge_enabled
    if nudge_max is not None:
        nudge.max_nudges = nudge_max
    if nudge_after_hours is not None:
        nudge.after_inactive_hours = nudge_after_hours
    return FormDefinition(id="form-1", name="Test Form", ttl=ttl, nudge=nudge)


# ============================================================================
# CALCULATE TTL
# ============================================================================


class TestCalculateTTL:
    def test_no_effort_gets_min_days(self):
        """0 minutes → minDays (14)."""
        session = _session(time_spent_ms=0)
        expiry = calculate_ttl(session)
        now = _now_ms()
        expected_min = now + 14 * 24 * 60 * 60 * 1000
        # Allow 5-second tolerance
        assert abs(expiry - expected_min) < 5000

    def test_moderate_effort(self):
        """30 min * 0.5 = 15 days > 14 min → 15 days."""
        session = _session(time_spent_ms=30 * 60 * 1000)
        expiry = calculate_ttl(session)
        now = _now_ms()
        expected = now + 15 * 24 * 60 * 60 * 1000
        assert abs(expiry - expected) < 5000

    def test_high_effort_capped_at_max(self):
        """4 hours * 0.5 = 120 days, capped at 90."""
        session = _session(time_spent_ms=4 * 60 * 60 * 1000)
        expiry = calculate_ttl(session)
        now = _now_ms()
        expected = now + 90 * 24 * 60 * 60 * 1000
        assert abs(expiry - expected) < 5000

    def test_custom_config(self):
        """Custom config: min=7, max=30, multiplier=1.0."""
        session = _session(time_spent_ms=20 * 60 * 1000)  # 20 min
        form = _form(min_days=7, max_days=30, effort_multiplier=1.0)
        expiry = calculate_ttl(session, form)
        now = _now_ms()
        # 20 min * 1.0 = 20 days
        expected = now + 20 * 24 * 60 * 60 * 1000
        assert abs(expiry - expected) < 5000

    def test_no_form_uses_defaults(self):
        session = _session(time_spent_ms=0)
        expiry = calculate_ttl(session, None)
        now = _now_ms()
        expected = now + 14 * 24 * 60 * 60 * 1000
        assert abs(expiry - expected) < 5000


# ============================================================================
# SHOULD NUDGE
# ============================================================================


class TestShouldNudge:
    def test_nudge_disabled(self):
        session = _session(last_interaction_ms=_now_ms() - 100 * 60 * 60 * 1000)
        form = _form(nudge_enabled=False)
        assert should_nudge(session, form) is False

    def test_max_nudges_reached(self):
        session = _session(
            nudge_count=3,
            last_interaction_ms=_now_ms() - 100 * 60 * 60 * 1000,
        )
        assert should_nudge(session) is False

    def test_not_enough_inactive_time(self):
        """User interacted recently → no nudge."""
        session = _session(last_interaction_ms=_now_ms())
        assert should_nudge(session) is False

    def test_nudge_too_recent(self):
        """Last nudge was <24h ago → no nudge."""
        session = _session(
            last_interaction_ms=_now_ms() - 72 * 60 * 60 * 1000,
            last_nudge_at=_now_ms() - 12 * 60 * 60 * 1000,
        )
        assert should_nudge(session) is False

    def test_should_nudge_all_conditions_met(self):
        """Inactive >48h, no recent nudge, nudge count < max."""
        session = _session(
            last_interaction_ms=_now_ms() - 72 * 60 * 60 * 1000,
            nudge_count=0,
        )
        assert should_nudge(session) is True

    def test_should_nudge_with_previous_nudge_old_enough(self):
        session = _session(
            last_interaction_ms=_now_ms() - 72 * 60 * 60 * 1000,
            nudge_count=1,
            last_nudge_at=_now_ms() - 48 * 60 * 60 * 1000,
        )
        assert should_nudge(session) is True

    def test_custom_after_hours(self):
        session = _session(
            last_interaction_ms=_now_ms() - 12 * 60 * 60 * 1000,
        )
        form = _form(nudge_after_hours=6)
        assert should_nudge(session, form) is True


# ============================================================================
# IS EXPIRING SOON / IS EXPIRED
# ============================================================================


class TestExpiration:
    def test_not_expiring_soon(self):
        session = _session(expires_at=_now_ms() + 48 * 60 * 60 * 1000)
        assert is_expiring_soon(session, 24 * 60 * 60 * 1000) is False

    def test_expiring_soon(self):
        session = _session(expires_at=_now_ms() + 12 * 60 * 60 * 1000)
        assert is_expiring_soon(session, 24 * 60 * 60 * 1000) is True

    def test_not_expired(self):
        session = _session(expires_at=_now_ms() + 1000)
        assert is_expired(session) is False

    def test_expired(self):
        session = _session(expires_at=_now_ms() - 1000)
        assert is_expired(session) is True

    def test_exact_boundary_expired(self):
        """Session that expired exactly now is expired."""
        session = _session(expires_at=_now_ms() - 1)
        assert is_expired(session) is True


# ============================================================================
# SHOULD CONFIRM CANCEL
# ============================================================================


class TestShouldConfirmCancel:
    def test_low_effort_no_confirm(self):
        session = _session(time_spent_ms=2 * 60 * 1000)  # 2 min
        assert should_confirm_cancel(session) is False

    def test_threshold_boundary(self):
        session = _session(time_spent_ms=5 * 60 * 1000)  # exactly 5 min
        assert should_confirm_cancel(session) is False

    def test_high_effort_confirm(self):
        session = _session(time_spent_ms=10 * 60 * 1000)  # 10 min
        assert should_confirm_cancel(session) is True


# ============================================================================
# FORMAT TIME REMAINING
# ============================================================================


class TestFormatTimeRemaining:
    def test_expired(self):
        session = _session(expires_at=_now_ms() - 1000)
        assert format_time_remaining(session) == "expired"

    def test_days_plural(self):
        session = _session(expires_at=_now_ms() + 5 * 24 * 60 * 60 * 1000)
        result = format_time_remaining(session)
        assert "5 days" in result

    def test_day_singular(self):
        session = _session(expires_at=_now_ms() + 1 * 24 * 60 * 60 * 1000 + 1000)
        result = format_time_remaining(session)
        assert "1 day" in result
        assert "days" not in result

    def test_hours_plural(self):
        session = _session(expires_at=_now_ms() + 5 * 60 * 60 * 1000)
        result = format_time_remaining(session)
        assert "5 hours" in result

    def test_hour_singular(self):
        session = _session(expires_at=_now_ms() + 1 * 60 * 60 * 1000 + 1000)
        result = format_time_remaining(session)
        assert "1 hour" in result
        assert "hours" not in result

    def test_minutes_plural(self):
        session = _session(expires_at=_now_ms() + 30 * 60 * 1000)
        result = format_time_remaining(session)
        assert "30 minutes" in result

    def test_minute_singular(self):
        session = _session(expires_at=_now_ms() + 1 * 60 * 1000 + 1000)
        result = format_time_remaining(session)
        assert "1 minute" in result
        assert "minutes" not in result


# ============================================================================
# FORMAT EFFORT
# ============================================================================


class TestFormatEffort:
    def test_just_started(self):
        assert format_effort(_session(time_spent_ms=0)) == "just started"
        assert format_effort(_session(time_spent_ms=30_000)) == "just started"  # 30s

    def test_minutes_singular(self):
        assert format_effort(_session(time_spent_ms=60_000)) == "1 minute"

    def test_minutes_plural(self):
        assert format_effort(_session(time_spent_ms=5 * 60_000)) == "5 minutes"

    def test_hours_exact(self):
        result = format_effort(_session(time_spent_ms=2 * 60 * 60_000))
        assert result == "2 hours"

    def test_hour_singular(self):
        result = format_effort(_session(time_spent_ms=60 * 60_000))
        assert result == "1 hour"

    def test_hours_and_minutes(self):
        result = format_effort(_session(time_spent_ms=90 * 60_000))  # 1h 30m
        assert result == "1h 30m"
