"""LifeWorld: stateful in-memory database of the user's life surface.

Modeled after tau-bench's `data.py` pattern: dicts of entities keyed by id,
with domain helpers (send_email, create_event, ...) that scenarios mutate.

Determinism contract:
- `state_hash()` returns the same SHA-256 for identical state regardless
  of insertion order. We sort all dicts by key at serialize time.
- All time-sensitive operations consume `world.now_iso` (the in-world
  clock supplied at construction), never `datetime.now()`. Tests stay
  stable across wall-clock time.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, fields, is_dataclass, replace
from typing import Any

from .entities import (
    ENTITY_CLASS_FOR_KIND,
    Calendar,
    CalendarEvent,
    ChatMessage,
    Contact,
    Conversation,
    EmailMessage,
    EmailThread,
    EntityKind,
    FinancialAccount,
    FinancialTransaction,
    HealthMetric,
    LocationPoint,
    Note,
    Reminder,
    ReminderList,
    ScheduledTask,
    Subscription,
    WorkoutRecord,
)


@dataclass(frozen=True)
class WorldSnapshot:
    """Frozen deep copy of LifeWorld state.

    Stored as plain dict-of-dicts so it can be hashed, serialized, and
    diffed without re-instantiating dataclasses.
    """

    seed: int
    now_iso: str
    stores: dict[str, dict[str, dict[str, Any]]]


class LifeWorld:
    # Maps every EntityKind to its attribute name on the LifeWorld instance.
    # Kept explicit (not f"{kind.value}s") because plurals are irregular.
    _STORE_FOR_KIND: dict[EntityKind, str] = {
        EntityKind.CONTACT: "contacts",
        EntityKind.EMAIL: "emails",
        EntityKind.EMAIL_THREAD: "email_threads",
        EntityKind.CHAT_MESSAGE: "chat_messages",
        EntityKind.CONVERSATION: "conversations",
        EntityKind.CALENDAR_EVENT: "calendar_events",
        EntityKind.CALENDAR: "calendars",
        EntityKind.REMINDER: "reminders",
        EntityKind.REMINDER_LIST: "reminder_lists",
        EntityKind.NOTE: "notes",
        EntityKind.TRANSACTION: "transactions",
        EntityKind.ACCOUNT: "accounts",
        EntityKind.SUBSCRIPTION: "subscriptions",
        EntityKind.HEALTH_METRIC: "health_metrics",
        EntityKind.LOCATION_POINT: "location_points",
        EntityKind.SCHEDULED_TASK: "scheduled_tasks",
        EntityKind.WORKOUT: "workouts",
    }

    def __init__(self, *, seed: int, now_iso: str) -> None:
        self.seed: int = seed
        self.now_iso: str = now_iso

        self.contacts: dict[str, Contact] = {}
        self.emails: dict[str, EmailMessage] = {}
        self.email_threads: dict[str, EmailThread] = {}
        self.chat_messages: dict[str, ChatMessage] = {}
        self.conversations: dict[str, Conversation] = {}
        self.calendar_events: dict[str, CalendarEvent] = {}
        self.calendars: dict[str, Calendar] = {}
        self.reminders: dict[str, Reminder] = {}
        self.reminder_lists: dict[str, ReminderList] = {}
        self.notes: dict[str, Note] = {}
        self.transactions: dict[str, FinancialTransaction] = {}
        self.accounts: dict[str, FinancialAccount] = {}
        self.subscriptions: dict[str, Subscription] = {}
        self.health_metrics: dict[str, HealthMetric] = {}
        self.location_points: dict[str, LocationPoint] = {}
        self.scheduled_tasks: dict[str, ScheduledTask] = {}
        self.workouts: dict[str, WorkoutRecord] = {}

    # ---------------------------------------------------------------- CRUD

    def _store(self, kind: EntityKind) -> dict[str, Any]:
        return getattr(self, self._STORE_FOR_KIND[kind])

    def add(self, kind: EntityKind, entity: Any) -> None:
        expected = ENTITY_CLASS_FOR_KIND[kind]
        if not isinstance(entity, expected):
            raise TypeError(
                f"add({kind.value}) expects {expected.__name__}, got {type(entity).__name__}"
            )
        store = self._store(kind)
        if entity.id in store:
            raise ValueError(f"{kind.value} id already exists: {entity.id}")
        store[entity.id] = entity

    def get(self, kind: EntityKind, entity_id: str) -> Any | None:
        return self._store(kind).get(entity_id)

    def update(self, kind: EntityKind, entity_id: str, **patches: Any) -> Any:
        store = self._store(kind)
        current = store.get(entity_id)
        if current is None:
            raise KeyError(f"{kind.value} not found: {entity_id}")
        valid_fields = {f.name for f in fields(current)}
        unknown = set(patches) - valid_fields
        if unknown:
            raise ValueError(f"unknown fields for {kind.value}: {sorted(unknown)}")
        updated = replace(current, **patches)
        store[entity_id] = updated
        return updated

    def delete(self, kind: EntityKind, entity_id: str) -> None:
        store = self._store(kind)
        if entity_id not in store:
            raise KeyError(f"{kind.value} not found: {entity_id}")
        del store[entity_id]

    # ----------------------------------------------------------- Email helpers

    def send_email(
        self,
        *,
        message_id: str,
        thread_id: str,
        from_email: str,
        to_emails: list[str],
        subject: str,
        body_plain: str,
        cc_emails: list[str] | None = None,
        attachments: list[str] | None = None,
        labels: list[str] | None = None,
    ) -> EmailMessage:
        msg = EmailMessage(
            id=message_id,
            thread_id=thread_id,
            folder="sent",
            from_email=from_email,
            to_emails=list(to_emails),
            cc_emails=list(cc_emails or []),
            subject=subject,
            body_plain=body_plain,
            sent_at=self.now_iso,
            received_at=None,
            is_read=True,
            is_starred=False,
            labels=list(labels or []),
            attachments=list(attachments or []),
        )
        self.add(EntityKind.EMAIL, msg)
        thread = self.email_threads.get(thread_id)
        if thread is None:
            participants = sorted({from_email, *to_emails, *(cc_emails or [])})
            self.add(
                EntityKind.EMAIL_THREAD,
                EmailThread(
                    id=thread_id,
                    subject=subject,
                    message_ids=[message_id],
                    participants=participants,
                    last_activity_at=self.now_iso,
                ),
            )
        else:
            self.update(
                EntityKind.EMAIL_THREAD,
                thread_id,
                message_ids=[*thread.message_ids, message_id],
                last_activity_at=self.now_iso,
            )
        return msg

    def mark_read(self, message_id: str) -> EmailMessage:
        return self.update(EntityKind.EMAIL, message_id, is_read=True)

    def archive_email(self, message_id: str) -> EmailMessage:
        return self.update(EntityKind.EMAIL, message_id, folder="archive")

    def star_email(self, message_id: str, *, starred: bool = True) -> EmailMessage:
        return self.update(EntityKind.EMAIL, message_id, is_starred=starred)

    def trash_email(self, message_id: str) -> EmailMessage:
        return self.update(EntityKind.EMAIL, message_id, folder="trash")

    # -------------------------------------------------------- Calendar helpers

    def create_calendar_event(
        self,
        *,
        event_id: str,
        calendar_id: str,
        title: str,
        start: str,
        end: str,
        description: str = "",
        location: str | None = None,
        attendees: list[str] | None = None,
        all_day: bool = False,
        recurrence_rule: str | None = None,
    ) -> CalendarEvent:
        if calendar_id not in self.calendars:
            raise KeyError(f"unknown calendar_id: {calendar_id}")
        cal = self.calendars[calendar_id]
        event = CalendarEvent(
            id=event_id,
            calendar_id=calendar_id,
            title=title,
            description=description,
            location=location,
            start=start,
            end=end,
            all_day=all_day,
            attendees=list(attendees or []),
            status="confirmed",
            visibility="default",
            recurrence_rule=recurrence_rule,
            source=cal.source,
        )
        self.add(EntityKind.CALENDAR_EVENT, event)
        return event

    def cancel_event(self, event_id: str) -> CalendarEvent:
        return self.update(EntityKind.CALENDAR_EVENT, event_id, status="cancelled")

    def move_event(self, event_id: str, *, start: str, end: str) -> CalendarEvent:
        return self.update(EntityKind.CALENDAR_EVENT, event_id, start=start, end=end)

    # -------------------------------------------------------- Reminder helpers

    def create_reminder(
        self,
        *,
        reminder_id: str,
        list_id: str,
        title: str,
        notes: str = "",
        due_at: str | None = None,
        priority: str = "none",
        tags: list[str] | None = None,
    ) -> Reminder:
        if list_id not in self.reminder_lists:
            raise KeyError(f"unknown reminder list: {list_id}")
        reminder = Reminder(
            id=reminder_id,
            list_id=list_id,
            title=title,
            notes=notes,
            due_at=due_at,
            completed_at=None,
            priority=priority,  # type: ignore[arg-type]
            tags=list(tags or []),
        )
        self.add(EntityKind.REMINDER, reminder)
        return reminder

    def complete_reminder(self, reminder_id: str) -> Reminder:
        return self.update(
            EntityKind.REMINDER, reminder_id, completed_at=self.now_iso
        )

    def snooze_reminder(self, reminder_id: str, *, new_due_at: str) -> Reminder:
        """Push a reminder's due time. Used for the LIFE_SNOOZE umbrella subaction."""
        return self.update(EntityKind.REMINDER, reminder_id, due_at=new_due_at)

    def touch_reminder_list_reviewed(self, list_id: str) -> ReminderList:
        """Stamp last_reviewed_at on a reminder list. Used by LIFE_REVIEW."""
        return self.update(EntityKind.REMINDER_LIST, list_id, last_reviewed_at=self.now_iso)

    # ----------------------------------------------------- Subscription helpers

    def cancel_subscription(self, subscription_id: str) -> Subscription:
        """Mark a subscription as cancelled. Used by MONEY_SUBSCRIPTION_CANCEL."""
        return self.update(
            EntityKind.SUBSCRIPTION, subscription_id, status="cancelled"
        )

    # ------------------------------------------------------- Health helpers

    def log_health_metric(
        self,
        *,
        metric_id: str,
        metric_type: str,
        value: float,
        recorded_at: str | None = None,
        source: str = "manual",
    ) -> HealthMetric:
        """Add a health metric reading. Used by LIFE_CREATE kind=health_metric."""
        metric = HealthMetric(
            id=metric_id,
            metric_type=metric_type,  # type: ignore[arg-type]
            value=value,
            recorded_at=recorded_at or self.now_iso,
            source=source,  # type: ignore[arg-type]
        )
        self.add(EntityKind.HEALTH_METRIC, metric)
        return metric

    # ------------------------------------------------------------ Chat helpers

    def send_message(
        self,
        *,
        message_id: str,
        conversation_id: str,
        from_handle: str,
        to_handles: list[str],
        text: str,
        attachments: list[str] | None = None,
    ) -> ChatMessage:
        conv = self.conversations.get(conversation_id)
        if conv is None:
            raise KeyError(f"unknown conversation: {conversation_id}")
        msg = ChatMessage(
            id=message_id,
            channel=conv.channel,
            conversation_id=conversation_id,
            from_handle=from_handle,
            to_handles=list(to_handles),
            text=text,
            sent_at=self.now_iso,
            is_read=True,
            is_outgoing=True,
            attachments=list(attachments or []),
        )
        self.add(EntityKind.CHAT_MESSAGE, msg)
        self.update(
            EntityKind.CONVERSATION,
            conversation_id,
            last_activity_at=self.now_iso,
        )
        return msg

    def ensure_synthetic_conversation(
        self,
        *,
        conversation_id: str,
        channel: str,
        participants: list[str],
        title: str | None = None,
        is_group: bool = False,
    ) -> Conversation:
        """Get-or-create a conversation deterministically.

        Used by the MESSAGE umbrella `send` subaction when the scenario
        targets a contact by name (no pre-existing conversation id).
        Scenarios that pass an explicit `roomId` skip this path.
        """
        existing = self.conversations.get(conversation_id)
        if existing is not None:
            return existing
        conv = Conversation(
            id=conversation_id,
            channel=channel,  # type: ignore[arg-type]
            participants=list(participants),
            title=title,
            last_activity_at=self.now_iso,
            is_group=is_group,
        )
        self.add(EntityKind.CONVERSATION, conv)
        return conv

    # ----------------------------------------------------------- Mail draft

    def create_draft_email(
        self,
        *,
        message_id: str,
        thread_id: str,
        from_email: str,
        to_emails: list[str],
        subject: str,
        body_plain: str,
    ) -> EmailMessage:
        """Create a draft email reply. Used by MESSAGE.draft_reply (gmail)."""
        msg = EmailMessage(
            id=message_id,
            thread_id=thread_id,
            folder="drafts",
            from_email=from_email,
            to_emails=list(to_emails),
            cc_emails=[],
            subject=subject,
            body_plain=body_plain,
            sent_at=self.now_iso,
            received_at=None,
            is_read=True,
        )
        self.add(EntityKind.EMAIL, msg)
        return msg

    # ------------------------------------------------------------ Note helpers

    def create_note(
        self,
        *,
        note_id: str,
        title: str,
        body_markdown: str,
        tags: list[str] | None = None,
        source: str = "apple-notes",
    ) -> Note:
        note = Note(
            id=note_id,
            title=title,
            body_markdown=body_markdown,
            tags=list(tags or []),
            created_at=self.now_iso,
            updated_at=self.now_iso,
            source=source,  # type: ignore[arg-type]
        )
        self.add(EntityKind.NOTE, note)
        return note

    # ---------------------------------------------------- Workout helpers

    def log_workout(
        self,
        *,
        workout_id: str,
        activity_type: str,
        duration_minutes: int,
        calories: int | None = None,
        source: str = "manual",
        distance_km: float | None = None,
        notes: str = "",
    ) -> WorkoutRecord:
        workout = WorkoutRecord(
            id=workout_id,
            activity_type=activity_type,
            duration_minutes=duration_minutes,
            calories=calories,
            source=source,  # type: ignore[arg-type]
            recorded_at=self.now_iso,
            distance_km=distance_km,
            notes=notes,
        )
        self.add(EntityKind.WORKOUT, workout)
        return workout

    # ---------------------------------------------------- ScheduledTask helpers

    def create_scheduled_task(
        self,
        *,
        task_id: str,
        kind: str,
        prompt_instructions: str,
        trigger: dict[str, Any] | None = None,
        output: dict[str, Any] | None = None,
        subject: dict[str, Any] | None = None,
        priority: str | None = None,
        should_fire: dict[str, Any] | None = None,
        completion_check: dict[str, Any] | None = None,
        pipeline: dict[str, Any] | None = None,
        respects_global_pause: bool = True,
        metadata: dict[str, Any] | None = None,
        state: str = "active",
    ) -> ScheduledTask:
        task = ScheduledTask(
            id=task_id,
            kind=kind,
            prompt_instructions=prompt_instructions,
            trigger=dict(trigger or {}),
            state=state,
            output=dict(output) if isinstance(output, dict) else output,
            subject=dict(subject) if isinstance(subject, dict) else subject,
            priority=priority,
            should_fire=dict(should_fire) if isinstance(should_fire, dict) else should_fire,
            completion_check=(
                dict(completion_check)
                if isinstance(completion_check, dict)
                else completion_check
            ),
            pipeline=dict(pipeline) if isinstance(pipeline, dict) else pipeline,
            respects_global_pause=respects_global_pause,
            metadata=dict(metadata or {}),
            created_at=self.now_iso,
            updated_at=self.now_iso,
        )
        self.add(EntityKind.SCHEDULED_TASK, task)
        return task

    def update_scheduled_task(self, task_id: str, **patches: Any) -> ScheduledTask:
        patches.setdefault("updated_at", self.now_iso)
        return self.update(EntityKind.SCHEDULED_TASK, task_id, **patches)

    # -------------------------------------------------- Snapshot / serialize

    def snapshot(self) -> WorldSnapshot:
        stores: dict[str, dict[str, dict[str, Any]]] = {}
        for kind in EntityKind:
            store = self._store(kind)
            stores[kind.value] = {
                eid: asdict(entity) for eid, entity in store.items()
            }
        return WorldSnapshot(
            seed=self.seed,
            now_iso=self.now_iso,
            stores=stores,
        )

    def restore(self, snapshot: WorldSnapshot) -> None:
        self.seed = snapshot.seed
        self.now_iso = snapshot.now_iso
        for kind in EntityKind:
            store = self._store(kind)
            store.clear()
            cls = ENTITY_CLASS_FOR_KIND[kind]
            raw = snapshot.stores.get(kind.value, {})
            for eid, payload in raw.items():
                store[eid] = _construct_dataclass(cls, payload)

    def to_json(self) -> str:
        snap = self.snapshot()
        # Sort keys at every level so identical state always serializes
        # to identical bytes regardless of insertion order.
        document = {
            "seed": snap.seed,
            "now_iso": snap.now_iso,
            "stores": {
                kind: dict(sorted(snap.stores[kind].items()))
                for kind in sorted(snap.stores)
            },
        }
        return json.dumps(document, sort_keys=True, separators=(",", ":"))

    @classmethod
    def from_json(cls, s: str) -> LifeWorld:
        document = json.loads(s)
        world = cls(seed=int(document["seed"]), now_iso=str(document["now_iso"]))
        stores_raw: dict[str, dict[str, dict[str, Any]]] = document["stores"]
        for kind in EntityKind:
            target = world._store(kind)
            payloads = stores_raw.get(kind.value, {})
            entity_cls = ENTITY_CLASS_FOR_KIND[kind]
            for eid, payload in payloads.items():
                target[eid] = _construct_dataclass(entity_cls, payload)
        return world

    def state_hash(self) -> str:
        return hashlib.sha256(self.to_json().encode("utf-8")).hexdigest()

    def counts(self) -> dict[str, int]:
        return {kind.value: len(self._store(kind)) for kind in EntityKind}


def _construct_dataclass(cls: type, payload: dict[str, Any]) -> Any:
    """Rebuild a dataclass from a plain dict, dropping unknown fields.

    Tolerating unknown fields lets stale snapshots load even if the schema
    grew. Required fields are still enforced by the dataclass __init__.
    """
    if not is_dataclass(cls):
        raise TypeError(f"{cls!r} is not a dataclass")
    valid = {f.name for f in fields(cls)}
    return cls(**{k: v for k, v in payload.items() if k in valid})
