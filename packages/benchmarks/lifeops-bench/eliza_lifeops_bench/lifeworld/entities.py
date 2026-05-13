"""Entity dataclasses for the LifeWorld in-memory database.

All datetime fields are ISO 8601 strings in UTC (e.g. "2026-05-10T14:30:00Z").
Money values are integer cents to avoid float drift.

Every entity is a frozen dataclass: mutations go through `LifeWorld.update`
which produces a new instance via `dataclasses.replace`. This keeps the
state hash deterministic and prevents accidental in-place edits from
desynchronizing snapshots.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Literal


class EntityKind(str, Enum):
    """Names every entity stored by LifeWorld.

    The string values double as the dict-name on `LifeWorld` (without the
    trailing 's' for irregulars — see `LifeWorld._STORE_FOR_KIND`).
    """

    CONTACT = "contact"
    EMAIL = "email"
    EMAIL_THREAD = "email_thread"
    CHAT_MESSAGE = "chat_message"
    CONVERSATION = "conversation"
    CALENDAR_EVENT = "calendar_event"
    CALENDAR = "calendar"
    REMINDER = "reminder"
    REMINDER_LIST = "reminder_list"
    NOTE = "note"
    TRANSACTION = "transaction"
    ACCOUNT = "account"
    SUBSCRIPTION = "subscription"
    HEALTH_METRIC = "health_metric"
    LOCATION_POINT = "location_point"
    SCHEDULED_TASK = "scheduled_task"
    WORKOUT = "workout"


Relationship = Literal["family", "friend", "work", "acquaintance"]
EmailFolder = Literal["inbox", "sent", "drafts", "archive", "trash", "spam"]
ChatChannel = Literal[
    "imessage", "whatsapp", "signal", "telegram", "slack", "discord", "sms"
]
EventStatus = Literal["confirmed", "tentative", "cancelled"]
EventVisibility = Literal["default", "public", "private"]
CalendarSource = Literal["google", "apple", "outlook"]
ReminderPriority = Literal["none", "low", "medium", "high"]
ReminderSource = Literal["apple-reminders", "things", "todoist", "google-tasks"]
NoteSource = Literal["apple-notes", "obsidian", "notion"]
AccountType = Literal["checking", "savings", "credit", "investment"]
SubscriptionStatus = Literal["active", "paused", "cancelled"]
HealthMetricType = Literal[
    "steps", "heart_rate", "sleep_hours", "weight_kg", "blood_pressure", "calories"
]
HealthSource = Literal["apple-health", "fitbit", "oura", "manual"]


@dataclass(frozen=True)
class Contact:
    id: str
    display_name: str
    given_name: str
    family_name: str
    primary_email: str
    phones: list[str] = field(default_factory=list)
    company: str | None = None
    role: str | None = None
    relationship: Relationship = "acquaintance"
    importance: int = 0
    tags: list[str] = field(default_factory=list)
    birthday: str | None = None


@dataclass(frozen=True)
class EmailMessage:
    id: str
    thread_id: str
    folder: EmailFolder
    from_email: str
    to_emails: list[str]
    cc_emails: list[str]
    subject: str
    body_plain: str
    sent_at: str
    received_at: str | None = None
    is_read: bool = False
    is_starred: bool = False
    labels: list[str] = field(default_factory=list)
    attachments: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class EmailThread:
    id: str
    subject: str
    message_ids: list[str]
    participants: list[str]
    last_activity_at: str


@dataclass(frozen=True)
class ChatMessage:
    id: str
    channel: ChatChannel
    conversation_id: str
    from_handle: str
    to_handles: list[str]
    text: str
    sent_at: str
    is_read: bool = False
    is_outgoing: bool = False
    attachments: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class Conversation:
    id: str
    channel: ChatChannel
    participants: list[str]
    title: str | None
    last_activity_at: str
    is_group: bool = False


@dataclass(frozen=True)
class CalendarEvent:
    id: str
    calendar_id: str
    title: str
    description: str
    location: str | None
    start: str
    end: str
    all_day: bool = False
    attendees: list[str] = field(default_factory=list)
    status: EventStatus = "confirmed"
    visibility: EventVisibility = "default"
    recurrence_rule: str | None = None
    source: CalendarSource = "google"


@dataclass(frozen=True)
class Calendar:
    id: str
    name: str
    color: str
    owner: str
    source: CalendarSource = "google"
    is_primary: bool = False


@dataclass(frozen=True)
class Reminder:
    id: str
    list_id: str
    title: str
    notes: str = ""
    due_at: str | None = None
    completed_at: str | None = None
    priority: ReminderPriority = "none"
    tags: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class ScheduledTask:
    id: str
    kind: str
    prompt_instructions: str
    trigger: dict[str, Any] = field(default_factory=dict)
    state: str = "active"
    output: dict[str, Any] | None = None
    subject: dict[str, Any] | None = None
    priority: str | None = None
    should_fire: dict[str, Any] | None = None
    completion_check: dict[str, Any] | None = None
    pipeline: dict[str, Any] | None = None
    respects_global_pause: bool = True
    metadata: dict[str, Any] = field(default_factory=dict)
    created_at: str = ""
    updated_at: str = ""


@dataclass(frozen=True)
class ReminderList:
    id: str
    name: str
    source: ReminderSource = "apple-reminders"
    last_reviewed_at: str | None = None


@dataclass(frozen=True)
class Note:
    id: str
    title: str
    body_markdown: str
    tags: list[str] = field(default_factory=list)
    created_at: str = ""
    updated_at: str = ""
    source: NoteSource = "apple-notes"


@dataclass(frozen=True)
class FinancialTransaction:
    id: str
    account_id: str
    amount_cents: int
    currency: str
    merchant: str
    category: str
    description: str
    posted_at: str
    is_pending: bool = False


@dataclass(frozen=True)
class FinancialAccount:
    id: str
    institution: str
    account_type: AccountType
    balance_cents: int
    currency: str
    last4: str


@dataclass(frozen=True)
class Subscription:
    id: str
    name: str
    monthly_cents: int
    billing_day: int
    next_charge_at: str
    status: SubscriptionStatus = "active"


@dataclass(frozen=True)
class HealthMetric:
    id: str
    metric_type: HealthMetricType
    value: float
    recorded_at: str
    source: HealthSource = "apple-health"


@dataclass(frozen=True)
class LocationPoint:
    id: str
    latitude: float
    longitude: float
    label: str | None
    recorded_at: str


WorkoutSource = Literal["apple-health", "fitbit", "oura", "manual", "garmin", "strava"]


@dataclass(frozen=True)
class WorkoutRecord:
    """A single workout session logged by the user."""

    id: str
    activity_type: str
    duration_minutes: int
    calories: int | None = None
    source: WorkoutSource = "manual"
    recorded_at: str = ""
    distance_km: float | None = None
    notes: str = ""


# Map enum -> dataclass — used by LifeWorld.add for type validation and
# by the JSON codec to reconstruct typed entities from plain dicts.
ENTITY_CLASS_FOR_KIND: dict[EntityKind, type] = {
    EntityKind.CONTACT: Contact,
    EntityKind.EMAIL: EmailMessage,
    EntityKind.EMAIL_THREAD: EmailThread,
    EntityKind.CHAT_MESSAGE: ChatMessage,
    EntityKind.CONVERSATION: Conversation,
    EntityKind.CALENDAR_EVENT: CalendarEvent,
    EntityKind.CALENDAR: Calendar,
    EntityKind.REMINDER: Reminder,
    EntityKind.REMINDER_LIST: ReminderList,
    EntityKind.NOTE: Note,
    EntityKind.TRANSACTION: FinancialTransaction,
    EntityKind.ACCOUNT: FinancialAccount,
    EntityKind.SUBSCRIPTION: Subscription,
    EntityKind.HEALTH_METRIC: HealthMetric,
    EntityKind.LOCATION_POINT: LocationPoint,
    EntityKind.SCHEDULED_TASK: ScheduledTask,
    EntityKind.WORKOUT: WorkoutRecord,
}
