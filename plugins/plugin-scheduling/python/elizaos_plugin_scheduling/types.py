"""
Type definitions for the scheduling plugin.

Key concepts:
- AvailabilityWindow: A recurring time slot (e.g., "Mondays 9am-5pm")
- SchedulingRequest: A request to find a meeting time for multiple participants
- Meeting: A scheduled event with time, location, and participants
- CalendarEvent: An ICS-compatible event for calendar invites
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional


class DayOfWeek(str, Enum):
    MON = "mon"
    TUE = "tue"
    WED = "wed"
    THU = "thu"
    FRI = "fri"
    SAT = "sat"
    SUN = "sun"


@dataclass
class AvailabilityWindow:
    day: DayOfWeek
    start_minutes: int
    end_minutes: int

    def __post_init__(self) -> None:
        if not (0 <= self.start_minutes <= 1439):
            raise ValueError(f"start_minutes must be 0-1439, got {self.start_minutes}")
        if not (0 <= self.end_minutes <= 1439):
            raise ValueError(f"end_minutes must be 0-1439, got {self.end_minutes}")


@dataclass
class AvailabilityException:
    date: str
    unavailable: bool = False
    start_minutes: Optional[int] = None
    end_minutes: Optional[int] = None
    reason: Optional[str] = None


@dataclass
class Availability:
    time_zone: str
    weekly: list[AvailabilityWindow] = field(default_factory=list)
    exceptions: list[AvailabilityException] = field(default_factory=list)


@dataclass
class TimeSlot:
    start: str
    end: str
    time_zone: str


@dataclass
class Participant:
    entity_id: str
    name: str
    availability: Availability
    email: Optional[str] = None
    phone: Optional[str] = None
    priority: Optional[int] = None


class ParticipantRole(str, Enum):
    ORGANIZER = "organizer"
    REQUIRED = "required"
    OPTIONAL = "optional"


@dataclass
class MeetingParticipant:
    entity_id: str
    name: str
    role: ParticipantRole
    confirmed: bool = False
    email: Optional[str] = None
    phone: Optional[str] = None
    confirmed_at: Optional[int] = None
    decline_reason: Optional[str] = None


class LocationType(str, Enum):
    IN_PERSON = "in_person"
    VIRTUAL = "virtual"
    PHONE = "phone"


@dataclass
class MeetingLocation:
    type: LocationType
    name: Optional[str] = None
    address: Optional[str] = None
    city: Optional[str] = None
    place_id: Optional[str] = None
    video_url: Optional[str] = None
    phone_number: Optional[str] = None
    notes: Optional[str] = None


class SchedulingUrgency(str, Enum):
    FLEXIBLE = "flexible"
    SOON = "soon"
    URGENT = "urgent"


@dataclass
class SchedulingConstraints:
    min_duration_minutes: int
    preferred_duration_minutes: int
    max_days_out: int
    preferred_times: Optional[list[str]] = None
    preferred_days: Optional[list[DayOfWeek]] = None
    location_type: Optional[LocationType] = None
    location_constraint: Optional[str] = None


@dataclass
class SchedulingRequest:
    id: str
    room_id: str
    title: str
    participants: list[Participant]
    constraints: SchedulingConstraints
    urgency: SchedulingUrgency
    created_at: int
    description: Optional[str] = None
    max_proposals: Optional[int] = None


class MeetingStatus(str, Enum):
    PROPOSED = "proposed"
    CONFIRMED = "confirmed"
    SCHEDULED = "scheduled"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    RESCHEDULING = "rescheduling"
    NO_SHOW = "no_show"


@dataclass
class Meeting:
    id: str
    request_id: str
    room_id: str
    title: str
    slot: TimeSlot
    location: MeetingLocation
    participants: list[MeetingParticipant]
    status: MeetingStatus
    reschedule_count: int
    created_at: int
    updated_at: int
    description: Optional[str] = None
    cancellation_reason: Optional[str] = None
    notes: Optional[str] = None
    meta: Optional[dict[str, Any]] = None


@dataclass
class CalendarEventOrganizer:
    name: str
    email: str


@dataclass
class CalendarEventAttendee:
    name: str
    email: str
    role: ParticipantRole


@dataclass
class CalendarEvent:
    uid: str
    title: str
    start: str
    end: str
    time_zone: str
    description: Optional[str] = None
    location: Optional[str] = None
    organizer: Optional[CalendarEventOrganizer] = None
    attendees: Optional[list[CalendarEventAttendee]] = None
    url: Optional[str] = None
    reminder_minutes: Optional[list[int]] = None


@dataclass
class CalendarInvite:
    ics: str
    event: CalendarEvent
    recipient_email: str
    recipient_name: str


class ReminderType(str, Enum):
    SMS = "sms"
    EMAIL = "email"
    WHATSAPP = "whatsapp"
    PUSH = "push"


class ReminderStatus(str, Enum):
    PENDING = "pending"
    SENT = "sent"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass
class Reminder:
    id: str
    meeting_id: str
    participant_id: str
    scheduled_for: str
    type: ReminderType
    message: str
    status: ReminderStatus
    created_at: int
    sent_at: Optional[int] = None
    error: Optional[str] = None


@dataclass
class ProposedSlot:
    slot: TimeSlot
    score: float
    reasons: list[str] = field(default_factory=list)
    concerns: list[str] = field(default_factory=list)


@dataclass
class SchedulingResult:
    success: bool
    proposed_slots: list[ProposedSlot] = field(default_factory=list)
    failure_reason: Optional[str] = None
    conflicting_participants: Optional[list[str]] = None
