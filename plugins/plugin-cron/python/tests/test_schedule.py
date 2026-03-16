"""Tests for schedule utilities: validation, parsing, next-run, formatting."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from elizaos_plugin_cron.schedule import (
    compute_next_run,
    format_schedule,
    parse_duration,
    parse_natural_language_schedule,
    parse_schedule,
    validate_cron_expression,
)
from elizaos_plugin_cron.types import ScheduleAt, ScheduleCron, ScheduleEvery


# -- validate_cron_expression --------------------------------------------------

def test_valid_standard_cron_expressions():
    assert validate_cron_expression("* * * * *")
    assert validate_cron_expression("0 9 * * 1-5")
    assert validate_cron_expression("*/5 * * * *")
    assert validate_cron_expression("0 0 1 1 *")
    assert validate_cron_expression("30 14 * * 0,6")


def test_reject_invalid_cron_expressions():
    assert not validate_cron_expression("")
    assert not validate_cron_expression("not a cron")
    assert not validate_cron_expression("60 * * * *")
    assert not validate_cron_expression("* * * *")  # only 4 fields


# -- parse_duration ------------------------------------------------------------

def test_parse_duration_seconds():
    d = parse_duration("30s")
    assert d is not None
    assert d.total_seconds() == 30


def test_parse_duration_minutes():
    d = parse_duration("5m")
    assert d is not None
    assert d.total_seconds() == 300


def test_parse_duration_hours():
    d = parse_duration("2h")
    assert d is not None
    assert d.total_seconds() == 7200


def test_parse_duration_days():
    d = parse_duration("1d")
    assert d is not None
    assert d.total_seconds() == 86400


def test_parse_duration_invalid():
    assert parse_duration("") is None
    assert parse_duration("abc") is None
    assert parse_duration("0s") is None


# -- parse_schedule ------------------------------------------------------------

def test_parse_schedule_iso_datetime():
    result = parse_schedule("2030-01-15T10:30:00Z")
    assert isinstance(result, ScheduleAt)
    assert result.at.year == 2030


def test_parse_schedule_duration():
    result = parse_schedule("5m")
    assert isinstance(result, ScheduleEvery)
    assert result.interval.total_seconds() == 300


def test_parse_schedule_cron():
    result = parse_schedule("0 9 * * 1-5")
    assert isinstance(result, ScheduleCron)
    assert result.expr == "0 9 * * 1-5"


def test_parse_schedule_empty_raises():
    with pytest.raises(ValueError):
        parse_schedule("")


def test_parse_schedule_garbage_raises():
    with pytest.raises(ValueError):
        parse_schedule("not valid at all")


# -- natural language schedule -------------------------------------------------

def test_nl_every_n_minutes():
    s = parse_natural_language_schedule("every 5 minutes")
    assert isinstance(s, ScheduleEvery)
    assert s.interval.total_seconds() == 300


def test_nl_every_n_hours():
    s = parse_natural_language_schedule("every 2 hours")
    assert isinstance(s, ScheduleEvery)
    assert s.interval.total_seconds() == 7200


def test_nl_every_n_seconds():
    s = parse_natural_language_schedule("every 30 seconds")
    assert isinstance(s, ScheduleEvery)
    assert s.interval.total_seconds() == 30


def test_nl_every_single_unit():
    s = parse_natural_language_schedule("every minute")
    assert isinstance(s, ScheduleEvery)
    assert s.interval.total_seconds() == 60


def test_nl_daily_at_9am():
    s = parse_natural_language_schedule("daily at 9am")
    assert isinstance(s, ScheduleCron)
    assert s.expr == "0 9 * * *"


def test_nl_daily_at_1430():
    s = parse_natural_language_schedule("daily at 14:30")
    assert isinstance(s, ScheduleCron)
    assert s.expr == "30 14 * * *"


def test_nl_keywords():
    assert isinstance(parse_natural_language_schedule("hourly"), ScheduleCron)
    assert isinstance(parse_natural_language_schedule("daily"), ScheduleCron)
    assert isinstance(parse_natural_language_schedule("weekly"), ScheduleCron)


def test_nl_invalid():
    assert parse_natural_language_schedule("") is None
    assert parse_natural_language_schedule("whenever") is None


# -- compute_next_run ----------------------------------------------------------

def test_next_run_at_future():
    future = datetime.now(timezone.utc) + timedelta(hours=1)
    schedule = ScheduleAt(at=future)
    result = compute_next_run(schedule)
    assert result is not None
    assert result == future


def test_next_run_at_past():
    past = datetime.now(timezone.utc) - timedelta(hours=1)
    schedule = ScheduleAt(at=past)
    result = compute_next_run(schedule)
    assert result is None


def test_next_run_every():
    schedule = ScheduleEvery(interval=timedelta(minutes=10))
    now = datetime.now(timezone.utc)
    result = compute_next_run(schedule, now)
    assert result is not None
    assert abs((result - now).total_seconds() - 600) < 1


def test_next_run_cron():
    schedule = ScheduleCron(expr="* * * * *")
    now = datetime.now(timezone.utc)
    result = compute_next_run(schedule, now)
    assert result is not None
    assert result > now
    assert (result - now).total_seconds() <= 120


# -- format_schedule -----------------------------------------------------------

def test_format_every_seconds():
    s = ScheduleEvery(interval=timedelta(seconds=30))
    assert format_schedule(s) == "every 30 seconds"


def test_format_every_minutes():
    s = ScheduleEvery(interval=timedelta(minutes=5))
    assert format_schedule(s) == "every 5 minutes"


def test_format_every_hours():
    s = ScheduleEvery(interval=timedelta(hours=1))
    assert format_schedule(s) == "every 1 hour"


def test_format_cron():
    s = ScheduleCron(expr="0 9 * * 1-5")
    assert format_schedule(s) == "cron: 0 9 * * 1-5"
