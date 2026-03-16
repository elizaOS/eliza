"""
elizaOS Scheduling Plugin - Python Implementation.

Provides:
- Multi-party availability coordination
- Meeting scheduling with time slot proposals
- Calendar invite generation (ICS format)
- Automated reminders
- Rescheduling and cancellation handling

Usage:
    from elizaos_plugin_scheduling import scheduling_plugin
"""

from __future__ import annotations

from .actions import confirm_meeting_action, schedule_meeting_action, set_availability_action
from .config import DEFAULT_CONFIG, SchedulingServiceConfig
from .error import (
    InvalidAvailabilityError,
    MeetingNotFoundError,
    NoAvailabilityError,
    ParticipantNotFoundError,
    SchedulingError,
    ServiceNotAvailableError,
    StorageError,
)
from .ical import generate_ics, parse_ics
from .providers import scheduling_context_provider
from .service import SchedulingService
from .storage import (
    AvailabilityStorage,
    MeetingStorage,
    ReminderStorage,
    SchedulingRequestStorage,
    get_availability_storage,
    get_meeting_storage,
    get_reminder_storage,
    get_scheduling_request_storage,
)
from .types import (
    Availability,
    AvailabilityException,
    AvailabilityWindow,
    CalendarEvent,
    CalendarEventAttendee,
    CalendarEventOrganizer,
    CalendarInvite,
    DayOfWeek,
    LocationType,
    Meeting,
    MeetingLocation,
    MeetingParticipant,
    MeetingStatus,
    Participant,
    ParticipantRole,
    ProposedSlot,
    Reminder,
    ReminderStatus,
    ReminderType,
    SchedulingConstraints,
    SchedulingRequest,
    SchedulingResult,
    SchedulingUrgency,
    TimeSlot,
)

scheduling_plugin = {
    "name": "scheduling",
    "description": "Scheduling and calendar coordination for multi-party meetings",
    "services": [SchedulingService],
    "actions": [schedule_meeting_action, confirm_meeting_action, set_availability_action],
    "providers": [scheduling_context_provider],
}

__all__ = [
    # Plugin
    "scheduling_plugin",
    # Service
    "SchedulingService",
    # Config
    "SchedulingServiceConfig",
    "DEFAULT_CONFIG",
    # Types
    "DayOfWeek",
    "AvailabilityWindow",
    "AvailabilityException",
    "Availability",
    "TimeSlot",
    "ParticipantRole",
    "Participant",
    "MeetingParticipant",
    "LocationType",
    "MeetingLocation",
    "SchedulingUrgency",
    "SchedulingConstraints",
    "SchedulingRequest",
    "MeetingStatus",
    "Meeting",
    "CalendarEvent",
    "CalendarEventOrganizer",
    "CalendarEventAttendee",
    "CalendarInvite",
    "ReminderType",
    "ReminderStatus",
    "Reminder",
    "ProposedSlot",
    "SchedulingResult",
    # ICS
    "generate_ics",
    "parse_ics",
    # Storage
    "AvailabilityStorage",
    "MeetingStorage",
    "ReminderStorage",
    "SchedulingRequestStorage",
    "get_availability_storage",
    "get_meeting_storage",
    "get_reminder_storage",
    "get_scheduling_request_storage",
    # Errors
    "SchedulingError",
    "MeetingNotFoundError",
    "ParticipantNotFoundError",
    "NoAvailabilityError",
    "ServiceNotAvailableError",
    "InvalidAvailabilityError",
    "StorageError",
    # Actions/Providers
    "schedule_meeting_action",
    "confirm_meeting_action",
    "set_availability_action",
    "scheduling_context_provider",
]
