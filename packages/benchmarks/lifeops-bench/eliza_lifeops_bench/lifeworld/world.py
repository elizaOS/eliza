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
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .entities import (
    ENTITY_CLASS_FOR_KIND,
    Calendar,
    CalendarEvent,
    CalendarTimeProposal,
    ChatChannel,
    ChatDraft,
    ChatMessage,
    Contact,
    Conversation,
    EmailFolder,
    EmailMessage,
    EmailThread,
    EntityKind,
    FinancialAccount,
    FinancialTransaction,
    FocusBlock,
    FocusPermissionRequest,
    HealthMetric,
    InteractionRecord,
    LocationPoint,
    MessageSource,
    MessageTriagePolicy,
    Note,
    Reminder,
    ReminderList,
    ScheduledTask,
    Subscription,
    TravelHold,
    TravelOffer,
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
        EntityKind.CHAT_DRAFT: "chat_drafts",
        EntityKind.CONVERSATION: "conversations",
        EntityKind.MESSAGE_TRIAGE_POLICY: "message_triage_policies",
        EntityKind.INTERACTION_RECORD: "interaction_records",
        EntityKind.FOCUS_BLOCK: "focus_blocks",
        EntityKind.FOCUS_PERMISSION_REQUEST: "focus_permission_requests",
        EntityKind.TRAVEL_OFFER: "travel_offers",
        EntityKind.TRAVEL_HOLD: "travel_holds",
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
    _OMIT_WHEN_EMPTY = frozenset(
        {
            EntityKind.CHAT_DRAFT,
            EntityKind.MESSAGE_TRIAGE_POLICY,
            EntityKind.INTERACTION_RECORD,
            EntityKind.FOCUS_BLOCK,
            EntityKind.FOCUS_PERMISSION_REQUEST,
            EntityKind.TRAVEL_OFFER,
            EntityKind.TRAVEL_HOLD,
        }
    )

    def __init__(self, *, seed: int, now_iso: str) -> None:
        self.seed: int = seed
        self.now_iso: str = now_iso
        self._mutation_revision: int = 0

        self.contacts: dict[str, Contact] = {}
        self.emails: dict[str, EmailMessage] = {}
        self.email_threads: dict[str, EmailThread] = {}
        self.chat_messages: dict[str, ChatMessage] = {}
        self.chat_drafts: dict[str, ChatDraft] = {}
        self.conversations: dict[str, Conversation] = {}
        self.message_triage_policies: dict[str, MessageTriagePolicy] = {}
        self.interaction_records: dict[str, InteractionRecord] = {}
        self.focus_blocks: dict[str, FocusBlock] = {}
        self.focus_permission_requests: dict[str, FocusPermissionRequest] = {}
        self.travel_offers: dict[str, TravelOffer] = {}
        self.travel_holds: dict[str, TravelHold] = {}
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
        self._mutation_revision += 1

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
        self._mutation_revision += 1
        return updated

    def delete(self, kind: EntityKind, entity_id: str) -> None:
        store = self._store(kind)
        if entity_id not in store:
            raise KeyError(f"{kind.value} not found: {entity_id}")
        del store[entity_id]
        self._mutation_revision += 1

    @property
    def mutation_revision(self) -> int:
        """Monotonic in-process mutation counter used by the corpus audit."""
        return self._mutation_revision

    def fork(self, *, now_iso: str | None = None) -> LifeWorld:
        """Create isolated stores while sharing frozen records between audit runs."""
        forked = LifeWorld(seed=self.seed, now_iso=now_iso or self.now_iso)
        for kind in EntityKind:
            forked._store(kind).update(self._store(kind))
        forked._mutation_revision = self._mutation_revision
        return forked

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

    def update_calendar_preferences(
        self,
        *,
        calendar_id: str,
        preferences: dict[str, Any],
        expected_version: int | None = None,
    ) -> tuple[Calendar, bool]:
        """Merge owner preferences with optimistic concurrency and replay safety."""
        calendar = self.calendars.get(calendar_id)
        if calendar is None:
            raise KeyError(f"unknown calendar_id: {calendar_id}")
        if (
            expected_version is not None
            and expected_version != calendar.preferences_version
        ):
            raise ValueError(
                "calendar preference version conflict: "
                f"expected {expected_version}, found {calendar.preferences_version}"
            )
        merged = {**calendar.preferences, **preferences}
        if merged == calendar.preferences:
            return calendar, True
        updated = self.update(
            EntityKind.CALENDAR,
            calendar_id,
            preferences=merged,
            preferences_version=calendar.preferences_version + 1,
            preferences_updated_at=self.now_iso,
        )
        return updated, False

    def propose_calendar_times(
        self,
        *,
        window_start: str,
        window_end: str,
        duration_minutes: int,
        slot_count: int,
        calendar_ids: list[str] | None = None,
        time_zone: str | None = None,
    ) -> list[CalendarTimeProposal]:
        """Project deterministic free slots from events and owner preferences."""
        start = _parse_aware_datetime(window_start, field="window_start")
        end = _parse_aware_datetime(window_end, field="window_end")
        if start >= end:
            raise ValueError("calendar proposal window_start must be before window_end")
        if duration_minutes <= 0 or duration_minutes > 24 * 60:
            raise ValueError(
                "calendar proposal duration_minutes must be between 1 and 1440"
            )
        if slot_count <= 0 or slot_count > 50:
            raise ValueError("calendar proposal slot_count must be between 1 and 50")

        selected_ids = list(dict.fromkeys(calendar_ids or sorted(self.calendars)))
        missing_ids = [item for item in selected_ids if item not in self.calendars]
        if missing_ids:
            raise KeyError(f"unknown calendar ids: {missing_ids}")
        if not selected_ids:
            raise ValueError("calendar proposal requires at least one calendar")

        preferences: dict[str, Any] = {}
        for calendar_id in selected_ids:
            preferences.update(self.calendars[calendar_id].preferences)
        zone_name = time_zone or preferences.get("timeZone") or "UTC"
        if not isinstance(zone_name, str) or not zone_name:
            raise ValueError("calendar proposal timeZone must be a non-empty string")
        try:
            local_zone = ZoneInfo(zone_name)
        except ZoneInfoNotFoundError as exc:
            raise ValueError(
                f"unknown calendar proposal timeZone: {zone_name}"
            ) from exc

        busy: list[tuple[datetime, datetime]] = []
        for event in self.calendar_events.values():
            if event.calendar_id not in selected_ids or event.status == "cancelled":
                continue
            event_start = _parse_aware_datetime(
                event.start, field=f"event {event.id} start"
            )
            event_end = _parse_aware_datetime(event.end, field=f"event {event.id} end")
            busy.append((event_start, event_end))

        step = timedelta(minutes=15)
        duration = timedelta(minutes=duration_minutes)
        cursor = start
        proposals: list[CalendarTimeProposal] = []
        while cursor + duration <= end and len(proposals) < slot_count:
            candidate_end = cursor + duration
            if _calendar_candidate_matches_preferences(
                cursor,
                candidate_end,
                preferences=preferences,
                local_zone=local_zone,
            ) and not any(
                cursor < busy_end and candidate_end > busy_start
                for busy_start, busy_end in busy
            ):
                start_iso = _datetime_to_iso(cursor)
                end_iso = _datetime_to_iso(candidate_end)
                digest = hashlib.sha256(
                    json.dumps(
                        {
                            "calendar_ids": selected_ids,
                            "start": start_iso,
                            "end": end_iso,
                        },
                        sort_keys=True,
                        separators=(",", ":"),
                    ).encode("utf-8")
                ).hexdigest()[:12]
                proposals.append(
                    CalendarTimeProposal(
                        id=f"calendar_slot_{digest}",
                        start=start_iso,
                        end=end_iso,
                        duration_minutes=duration_minutes,
                        calendar_ids=selected_ids,
                    )
                )
            cursor += step
        return proposals

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
        schedule: dict[str, Any] | None = None,
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
            schedule=dict(schedule or {}),
        )
        self.add(EntityKind.REMINDER, reminder)
        return reminder

    def complete_reminder(self, reminder_id: str) -> Reminder:
        return self.update(EntityKind.REMINDER, reminder_id, completed_at=self.now_iso)

    def snooze_reminder(self, reminder_id: str, *, new_due_at: str) -> Reminder:
        """Push a reminder's due time. Used for the LIFE_SNOOZE umbrella subaction."""
        return self.update(EntityKind.REMINDER, reminder_id, due_at=new_due_at)

    def touch_reminder_list_reviewed(self, list_id: str) -> ReminderList:
        """Stamp last_reviewed_at on a reminder list. Used by LIFE_REVIEW."""
        return self.update(
            EntityKind.REMINDER_LIST, list_id, last_reviewed_at=self.now_iso
        )

    # ----------------------------------------------------- Subscription helpers

    def cancel_subscription(self, subscription_id: str) -> Subscription:
        """Mark a subscription as cancelled. Used by MONEY_SUBSCRIPTION_CANCEL."""
        return self.update(EntityKind.SUBSCRIPTION, subscription_id, status="cancelled")

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

    def create_chat_draft(
        self,
        *,
        draft_id: str,
        channel: ChatChannel | None,
        target: str,
        target_kind: str,
        conversation_id: str | None,
        text: str | None,
        requires_confirmation: bool,
        privacy_constraints: list[str] | None = None,
        directives: dict[str, Any] | None = None,
    ) -> tuple[ChatDraft, bool]:
        """Persist an unsent chat draft and make identical retries idempotent."""
        candidate = ChatDraft(
            id=draft_id,
            channel=channel,
            target=target,
            target_kind=target_kind,
            conversation_id=conversation_id,
            text=text,
            requires_confirmation=requires_confirmation,
            privacy_constraints=list(privacy_constraints or []),
            directives=dict(directives or {}),
            created_at=self.now_iso,
            updated_at=self.now_iso,
        )
        existing = self.chat_drafts.get(draft_id)
        if existing is not None:
            if (
                replace(existing, created_at=self.now_iso, updated_at=self.now_iso)
                != candidate
            ):
                raise ValueError(f"chat draft idempotency conflict: {draft_id}")
            return existing, True
        self.add(EntityKind.CHAT_DRAFT, candidate)
        return candidate, False

    def create_message_triage_policy(
        self,
        *,
        policy_id: str,
        directive: str,
        sources: list[MessageSource],
        folder: EmailFolder | None,
    ) -> tuple[MessageTriagePolicy, bool]:
        """Persist a structured triage rule and make identical retries idempotent."""
        candidate = MessageTriagePolicy(
            id=policy_id,
            directive=directive,
            sources=list(sources),
            folder=folder,
            created_at=self.now_iso,
            updated_at=self.now_iso,
        )
        existing = self.message_triage_policies.get(policy_id)
        if existing is not None:
            if (
                replace(existing, created_at=self.now_iso, updated_at=self.now_iso)
                != candidate
            ):
                raise ValueError(
                    f"message triage policy idempotency conflict: {policy_id}"
                )
            return existing, True
        self.add(EntityKind.MESSAGE_TRIAGE_POLICY, candidate)
        return candidate, False

    def create_interaction_record(
        self,
        *,
        record_id: str,
        entity_id: str | None,
        subject_name: str,
        notes: str,
        channel: MessageSource | None,
        occurred_at: str,
        source_name_mismatch: bool,
    ) -> tuple[InteractionRecord, bool]:
        """Persist a relationship interaction and make identical retries idempotent."""
        candidate = InteractionRecord(
            id=record_id,
            entity_id=entity_id,
            subject_name=subject_name,
            notes=notes,
            channel=channel,
            occurred_at=occurred_at,
            created_at=self.now_iso,
            source_name_mismatch=source_name_mismatch,
        )
        existing = self.interaction_records.get(record_id)
        if existing is not None:
            if replace(existing, created_at=self.now_iso) != candidate:
                raise ValueError(
                    f"interaction record idempotency conflict: {record_id}"
                )
            return existing, True
        self.add(EntityKind.INTERACTION_RECORD, candidate)
        return candidate, False

    # -------------------------------------------------------- Focus helpers

    def create_focus_permission_request(
        self,
        *,
        request_id: str,
        hostnames: list[str],
        package_names: list[str],
        reason: str,
        confirmation_required: bool,
        no_bypass: bool,
        mode: str | None,
    ) -> tuple[FocusPermissionRequest, bool]:
        """Persist an approval request while making identical retries idempotent."""
        candidate = FocusPermissionRequest(
            id=request_id,
            hostnames=list(hostnames),
            package_names=list(package_names),
            status="pending",
            reason=reason,
            confirmation_required=confirmation_required,
            no_bypass=no_bypass,
            created_at=self.now_iso,
            updated_at=self.now_iso,
            mode=mode,
        )
        existing = self.focus_permission_requests.get(request_id)
        if existing is not None:
            if (
                replace(
                    existing,
                    status="pending",
                    updated_at=candidate.updated_at,
                )
                != candidate
            ):
                raise ValueError(f"focus permission idempotency conflict: {request_id}")
            return existing, True
        self.add(EntityKind.FOCUS_PERMISSION_REQUEST, candidate)
        return candidate, False

    def create_focus_block(
        self,
        *,
        block_id: str,
        hostnames: list[str],
        package_names: list[str],
        status: str,
        mode: str | None,
        duration_minutes: int | None,
        schedule: dict[str, Any] | None,
        exceptions: list[dict[str, Any]],
        policy: str | None,
        permission_request_id: str | None,
        expires_at: str | None,
    ) -> tuple[FocusBlock, bool]:
        """Persist an enforcement rule while making identical retries idempotent."""
        if status not in {"active", "scheduled"}:
            raise ValueError(f"invalid initial focus block status: {status}")
        candidate = FocusBlock(
            id=block_id,
            hostnames=list(hostnames),
            package_names=list(package_names),
            status=status,  # type: ignore[arg-type]
            created_at=self.now_iso,
            updated_at=self.now_iso,
            mode=mode,
            duration_minutes=duration_minutes,
            schedule=dict(schedule) if schedule is not None else None,
            exceptions=[dict(item) for item in exceptions],
            policy=policy,
            permission_request_id=permission_request_id,
            expires_at=expires_at,
        )
        existing = self.focus_blocks.get(block_id)
        if existing is not None:
            if (
                replace(
                    existing,
                    status=candidate.status,
                    updated_at=candidate.updated_at,
                    released_at=None,
                    release_reason=None,
                )
                != candidate
            ):
                raise ValueError(f"focus block idempotency conflict: {block_id}")
            return existing, True
        self.add(EntityKind.FOCUS_BLOCK, candidate)
        return candidate, False

    def release_focus_blocks(
        self,
        block_ids: list[str],
        *,
        reason: str,
    ) -> tuple[list[FocusBlock], list[FocusBlock]]:
        """Release existing rules and report already-released retries separately."""
        unique_ids = list(dict.fromkeys(block_ids))
        missing = [
            block_id for block_id in unique_ids if block_id not in self.focus_blocks
        ]
        if missing:
            raise KeyError(f"focus block not found: {missing}")
        released: list[FocusBlock] = []
        replayed: list[FocusBlock] = []
        for block_id in unique_ids:
            current = self.focus_blocks[block_id]
            if current.status == "released":
                replayed.append(current)
                continue
            released.append(
                self.update(
                    EntityKind.FOCUS_BLOCK,
                    block_id,
                    status="released",
                    updated_at=self.now_iso,
                    released_at=self.now_iso,
                    release_reason=reason,
                )
            )
        return released, replayed

    # ------------------------------------------------------- Travel helpers

    def create_travel_hold(
        self,
        *,
        hold_id: str,
        offer: TravelOffer,
        passengers: int,
        approval_required: bool,
        approval_queue: str | None,
    ) -> tuple[TravelHold, bool]:
        """Reserve an offer without converting the reservation into a booking."""
        candidate = TravelHold(
            id=hold_id,
            offer_id=offer.id,
            kind=offer.kind,
            destination=offer.destination,
            passengers=passengers,
            status="awaiting_approval" if approval_required else "held",
            approval_required=approval_required,
            created_at=self.now_iso,
            updated_at=self.now_iso,
            origin=offer.origin,
            departure_date=offer.departure_date,
            return_date=offer.return_date,
            hotel_check_in=offer.hotel_check_in,
            approval_queue=approval_queue,
        )
        existing = self.travel_holds.get(hold_id)
        if existing is not None:
            if existing != candidate:
                raise ValueError(f"travel hold idempotency conflict: {hold_id}")
            return existing, True
        self.add(EntityKind.TRAVEL_HOLD, candidate)
        return candidate, False

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
        recorded_at: str | None = None,
        distance_km: float | None = None,
        notes: str = "",
    ) -> WorkoutRecord:
        workout = WorkoutRecord(
            id=workout_id,
            activity_type=activity_type,
            duration_minutes=duration_minutes,
            calories=calories,
            source=source,  # type: ignore[arg-type]
            recorded_at=recorded_at or self.now_iso,
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
            should_fire=(
                dict(should_fire) if isinstance(should_fire, dict) else should_fire
            ),
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
            stores[kind.value] = {eid: asdict(entity) for eid, entity in store.items()}
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
        self._mutation_revision += 1

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
                if snap.stores[kind] or EntityKind(kind) not in self._OMIT_WHEN_EMPTY
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


def _parse_aware_datetime(value: str, *, field: str) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be a non-empty ISO date/time")
    normalized = value.strip()
    if normalized.endswith("Z"):
        normalized = normalized[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise ValueError(f"{field} must be a valid ISO date/time: {value!r}") from exc
    if parsed.tzinfo is None:
        raise ValueError(f"{field} must include a timezone offset")
    return parsed.astimezone(timezone.utc)


def _datetime_to_iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_local_minute(value: Any, *, field: str) -> int | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"{field} must use HH:MM local time")
    pieces = value.split(":")
    if len(pieces) != 2 or not all(piece.isdigit() for piece in pieces):
        raise ValueError(f"{field} must use HH:MM local time")
    hour, minute = (int(piece) for piece in pieces)
    if hour > 23 or minute > 59:
        raise ValueError(f"{field} must use HH:MM local time")
    return hour * 60 + minute


def _minute_in_window(
    minute: int,
    *,
    start: int,
    end: int,
    include_end: bool,
) -> bool:
    if start <= end:
        return start <= minute <= end if include_end else start <= minute < end
    return (
        minute >= start or minute <= end
        if include_end
        else minute >= start or minute < end
    )


def _calendar_candidate_matches_preferences(
    start: datetime,
    end: datetime,
    *,
    preferences: dict[str, Any],
    local_zone: ZoneInfo,
) -> bool:
    local_start = start.astimezone(local_zone)
    local_end = end.astimezone(local_zone)
    start_minute = local_start.hour * 60 + local_start.minute
    end_minute = local_end.hour * 60 + local_end.minute

    preferred_start = _parse_local_minute(
        preferences.get("preferredStartLocal"),
        field="preferredStartLocal",
    )
    preferred_end = _parse_local_minute(
        preferences.get("preferredEndLocal"),
        field="preferredEndLocal",
    )
    if preferred_start is not None and start_minute < preferred_start:
        return False
    if preferred_end is not None and end_minute > preferred_end:
        return False

    blackouts = preferences.get("blackoutWindows", [])
    if not isinstance(blackouts, list):
        raise ValueError("blackoutWindows must be a list")
    for index, blackout in enumerate(blackouts):
        if not isinstance(blackout, dict):
            raise ValueError(f"blackoutWindows[{index}] must be an object")
        days = blackout.get("daysOfWeek")
        if days is not None:
            if not isinstance(days, list) or any(
                isinstance(day, bool) or not isinstance(day, int) or day < 1 or day > 7
                for day in days
            ):
                raise ValueError(
                    f"blackoutWindows[{index}].daysOfWeek must contain ISO weekdays 1-7"
                )
            if local_start.isoweekday() not in days:
                continue
        blackout_start = _parse_local_minute(
            blackout.get("startLocal"),
            field=f"blackoutWindows[{index}].startLocal",
        )
        blackout_end = _parse_local_minute(
            blackout.get("endLocal"),
            field=f"blackoutWindows[{index}].endLocal",
        )
        # Anchor-only blackouts are structural preferences that cannot reject
        # a concrete slot until an anchor resolver supplies an actual window.
        if blackout_start is None or blackout_end is None:
            continue
        if _minute_in_window(
            start_minute,
            start=blackout_start,
            end=blackout_end,
            include_end=False,
        ) or _minute_in_window(
            end_minute,
            start=blackout_start,
            end=blackout_end,
            include_end=True,
        ):
            return False
    return True


def _construct_dataclass(cls: type, payload: dict[str, Any]) -> Any:
    """Rebuild a dataclass from a plain dict, dropping unknown fields.

    Tolerating unknown fields lets stale snapshots load even if the schema
    grew. Required fields are still enforced by the dataclass __init__.
    """
    if not is_dataclass(cls):
        raise TypeError(f"{cls!r} is not a dataclass")
    valid = {f.name for f in fields(cls)}
    return cls(**{k: v for k, v in payload.items() if k in valid})
