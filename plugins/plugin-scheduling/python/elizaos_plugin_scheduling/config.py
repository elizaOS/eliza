"""Configuration for the scheduling plugin."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class SchedulingServiceConfig:
    """Configuration for the SchedulingService."""

    # Default reminder times (minutes before meeting)
    default_reminder_minutes: list[int] = field(default_factory=lambda: [1440, 120])
    # Maximum proposals per scheduling request
    max_proposals: int = 3
    # How many days out to look for availability
    default_max_days_out: int = 7
    # Minimum meeting duration in minutes
    min_meeting_duration: int = 30
    # Default meeting duration in minutes
    default_meeting_duration: int = 60
    # Whether to auto-send calendar invites
    auto_send_calendar_invites: bool = True
    # Whether to auto-schedule reminders
    auto_schedule_reminders: bool = True


DEFAULT_CONFIG = SchedulingServiceConfig()
