from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from enum import Enum
from typing import Any


# ---------------------------------------------------------------------------
# Schedule types
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class ScheduleAt:
    """One-time execution at a specific datetime (UTC)."""
    at: datetime


@dataclass(frozen=True)
class ScheduleEvery:
    """Recurring execution at a fixed interval."""
    interval: timedelta


@dataclass(frozen=True)
class ScheduleCron:
    """Cron-expression-based schedule (5-field: min hour dom month dow)."""
    expr: str


ScheduleType = ScheduleAt | ScheduleEvery | ScheduleCron


# ---------------------------------------------------------------------------
# Payload types
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class PayloadPrompt:
    """Send a prompt to the agent."""
    text: str


@dataclass(frozen=True)
class PayloadAction:
    """Invoke a named action with optional parameters."""
    name: str
    params: dict[str, Any] | None = None


@dataclass(frozen=True)
class PayloadEvent:
    """Emit a custom event with optional data."""
    name: str
    data: dict[str, Any] | None = None


PayloadType = PayloadPrompt | PayloadAction | PayloadEvent


# ---------------------------------------------------------------------------
# Job state
# ---------------------------------------------------------------------------

class JobState(str, Enum):
    ACTIVE = "active"
    PAUSED = "paused"
    COMPLETED = "completed"
    FAILED = "failed"


# ---------------------------------------------------------------------------
# Job definition
# ---------------------------------------------------------------------------

@dataclass
class JobDefinition:
    id: str
    name: str
    schedule: ScheduleType
    payload: PayloadType
    state: JobState = JobState.ACTIVE
    description: str | None = None
    created_at: datetime = field(default_factory=datetime.utcnow)
    updated_at: datetime = field(default_factory=datetime.utcnow)
    last_run: datetime | None = None
    next_run: datetime | None = None
    run_count: int = 0
    max_runs: int | None = None
    room_id: str | None = None


# ---------------------------------------------------------------------------
# Job update (partial)
# ---------------------------------------------------------------------------

@dataclass
class JobUpdate:
    name: str | None = None
    description: str | None = field(default=None)
    schedule: ScheduleType | None = None
    payload: PayloadType | None = None
    state: JobState | None = None
    max_runs: int | None = None
    room_id: str | None = None
    _clear_description: bool = False  # set True to explicitly clear description


# ---------------------------------------------------------------------------
# Service config
# ---------------------------------------------------------------------------

DEFAULT_MAX_JOBS = 100
DEFAULT_TIMEOUT_MS = 300_000


@dataclass(frozen=True)
class CronConfig:
    enabled: bool = True
    max_jobs: int = DEFAULT_MAX_JOBS
    default_timeout_ms: int = DEFAULT_TIMEOUT_MS
