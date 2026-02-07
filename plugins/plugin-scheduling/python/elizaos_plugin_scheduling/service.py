"""
Core scheduling service for multi-party coordination, availability
intersection, and calendar management.

Mirrors the TypeScript SchedulingService with identical slot-finding,
scoring, and meeting lifecycle logic.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from .config import DEFAULT_CONFIG, SchedulingServiceConfig
from .error import MeetingNotFoundError, ParticipantNotFoundError
from .ical import generate_ics
from .storage import (
    AgentRuntime,
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
    CalendarEvent,
    CalendarInvite,
    DayOfWeek,
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

logger = logging.getLogger("elizaos.scheduling")

# ============================================================================
# TIMEZONE HELPERS
# ============================================================================

# Day-of-week mapping from strftime %a abbreviation
_DAY_INDEX: dict[str, DayOfWeek] = {
    "Mon": DayOfWeek.MON,
    "Tue": DayOfWeek.TUE,
    "Wed": DayOfWeek.WED,
    "Thu": DayOfWeek.THU,
    "Fri": DayOfWeek.FRI,
    "Sat": DayOfWeek.SAT,
    "Sun": DayOfWeek.SUN,
}


def _get_zoned_parts(dt: datetime, time_zone: str) -> dict[str, Any]:
    """Get date/time parts in a specific time zone using zoneinfo."""
    try:
        from zoneinfo import ZoneInfo
    except ImportError:
        from backports.zoneinfo import ZoneInfo  # type: ignore[no-redef]

    zoned = dt.astimezone(ZoneInfo(time_zone))
    return {
        "year": zoned.year,
        "month": zoned.month,
        "day": zoned.day,
        "hour": zoned.hour,
        "minute": zoned.minute,
        "weekday": zoned.strftime("%a"),
    }


def _get_day_of_week(dt: datetime, time_zone: str) -> DayOfWeek:
    parts = _get_zoned_parts(dt, time_zone)
    return _DAY_INDEX.get(parts["weekday"], DayOfWeek.MON)


def _get_minutes_of_day(dt: datetime, time_zone: str) -> int:
    parts = _get_zoned_parts(dt, time_zone)
    return parts["hour"] * 60 + parts["minute"]


def _get_date_string(dt: datetime, time_zone: str) -> str:
    parts = _get_zoned_parts(dt, time_zone)
    return f"{parts['year']}-{parts['month']:02d}-{parts['day']:02d}"


def _date_from_minutes(date_str: str, minutes: int, time_zone: str) -> datetime:
    """Create a datetime from a date string and minutes-of-day in a timezone."""
    try:
        from zoneinfo import ZoneInfo
    except ImportError:
        from backports.zoneinfo import ZoneInfo  # type: ignore[no-redef]

    year, month, day = (int(x) for x in date_str.split("-"))
    hours = minutes // 60
    mins = minutes % 60
    local_dt = datetime(year, month, day, hours, mins, 0, tzinfo=ZoneInfo(time_zone))
    return local_dt.astimezone(timezone.utc)


def _add_days(dt: datetime, days: int) -> datetime:
    return dt + timedelta(days=days)


def _now_ms() -> int:
    import time
    return int(time.time() * 1000)


# ============================================================================
# SCHEDULING SERVICE
# ============================================================================


class SchedulingService:
    """Core scheduling service for multi-party coordination."""

    service_type = "SCHEDULING"

    def __init__(
        self,
        runtime: AgentRuntime,
        config: Optional[SchedulingServiceConfig] = None,
    ) -> None:
        self.runtime = runtime
        self.config = config or SchedulingServiceConfig()
        self.capability_description = (
            "Coordinates scheduling and calendar management across multiple participants"
        )

    @classmethod
    async def start(cls, runtime: AgentRuntime) -> "SchedulingService":
        service = cls(runtime)
        health = await service.health_check()
        if not health["healthy"]:
            logger.warning(
                "[SchedulingService] Started with warnings: %s",
                ", ".join(health["issues"]),
            )
        else:
            logger.info("[SchedulingService] Started for agent %s", runtime.agent_id)
        return service

    async def stop(self) -> None:
        logger.info("[SchedulingService] Stopped")

    async def health_check(self) -> dict[str, Any]:
        issues: list[str] = []
        if not hasattr(self.runtime, "get_component"):
            issues.append("Runtime missing get_component method")
        if not hasattr(self.runtime, "create_component"):
            issues.append("Runtime missing create_component method")
        return {"healthy": len(issues) == 0, "issues": issues}

    def get_scheduling_config(self) -> SchedulingServiceConfig:
        return SchedulingServiceConfig(
            default_reminder_minutes=list(self.config.default_reminder_minutes),
            max_proposals=self.config.max_proposals,
            default_max_days_out=self.config.default_max_days_out,
            min_meeting_duration=self.config.min_meeting_duration,
            default_meeting_duration=self.config.default_meeting_duration,
            auto_send_calendar_invites=self.config.auto_send_calendar_invites,
            auto_schedule_reminders=self.config.auto_schedule_reminders,
        )

    # ========================================================================
    # AVAILABILITY
    # ========================================================================

    async def save_availability(self, entity_id: str, availability: Availability) -> None:
        storage = get_availability_storage(self.runtime)
        await storage.save(entity_id, availability)

    async def get_availability(self, entity_id: str) -> Optional[Availability]:
        return await get_availability_storage(self.runtime).get(entity_id)

    def is_available_at(self, availability: Availability, date_time: datetime) -> bool:
        """Check if a participant is available at a specific datetime."""
        day = _get_day_of_week(date_time, availability.time_zone)
        minutes = _get_minutes_of_day(date_time, availability.time_zone)
        date_str = _get_date_string(date_time, availability.time_zone)

        # Check exceptions first
        for exc in availability.exceptions:
            if exc.date == date_str:
                if exc.unavailable:
                    return False
                if exc.start_minutes is not None and exc.end_minutes is not None:
                    return exc.start_minutes <= minutes < exc.end_minutes
                break

        # Check weekly availability
        return any(
            w.day == day and w.start_minutes <= minutes < w.end_minutes
            for w in availability.weekly
        )

    # ========================================================================
    # SCHEDULING REQUESTS
    # ========================================================================

    async def create_scheduling_request(
        self,
        room_id: str,
        title: str,
        participants: list[Participant],
        constraints: Optional[dict[str, Any]] = None,
        options: Optional[dict[str, Any]] = None,
    ) -> SchedulingRequest:
        constraints = constraints or {}
        options = options or {}

        request = SchedulingRequest(
            id=str(uuid.uuid4()),
            room_id=room_id,
            title=title,
            description=options.get("description"),
            participants=participants,
            constraints=SchedulingConstraints(
                min_duration_minutes=constraints.get(
                    "min_duration_minutes", self.config.min_meeting_duration
                ),
                preferred_duration_minutes=constraints.get(
                    "preferred_duration_minutes", self.config.default_meeting_duration
                ),
                max_days_out=constraints.get(
                    "max_days_out", self.config.default_max_days_out
                ),
                preferred_times=constraints.get("preferred_times"),
                preferred_days=constraints.get("preferred_days"),
                location_type=constraints.get("location_type"),
                location_constraint=constraints.get("location_constraint"),
            ),
            urgency=SchedulingUrgency(options.get("urgency", "flexible")),
            created_at=_now_ms(),
            max_proposals=self.config.max_proposals,
        )

        storage = get_scheduling_request_storage(self.runtime)
        await storage.save(request)
        logger.info(
            '[SchedulingService] Created scheduling request %s for "%s"',
            request.id,
            title,
        )
        return request

    # ========================================================================
    # SLOT FINDING
    # ========================================================================

    async def find_available_slots(self, request: SchedulingRequest) -> SchedulingResult:
        participants = request.participants
        constraints = request.constraints

        if not participants:
            return SchedulingResult(
                success=False,
                proposed_slots=[],
                failure_reason="No participants specified",
            )

        availabilities = [
            {"participant": p, "availability": p.availability} for p in participants
        ]

        reference_tz = availabilities[0]["availability"].time_zone
        now = datetime.now(timezone.utc)
        candidate_slots: list[TimeSlot] = []

        for day_offset in range(constraints.max_days_out):
            date = _add_days(now, day_offset)
            day = _get_day_of_week(date, reference_tz)

            if constraints.preferred_days and day not in constraints.preferred_days:
                continue

            date_str = _get_date_string(date, reference_tz)

            day_windows = self._find_day_intersection(
                availabilities, day, date_str, constraints.min_duration_minutes
            )

            for window in day_windows:
                slot_duration = constraints.preferred_duration_minutes
                start_minutes = window["start"]

                while start_minutes + slot_duration <= window["end"]:
                    if day_offset == 0:
                        current_minutes = _get_minutes_of_day(now, reference_tz)
                        if start_minutes < current_minutes + 30:
                            start_minutes += 30
                            continue

                    start_date = _date_from_minutes(date_str, start_minutes, reference_tz)
                    end_date = _date_from_minutes(
                        date_str, start_minutes + slot_duration, reference_tz
                    )

                    candidate_slots.append(
                        TimeSlot(
                            start=start_date.isoformat().replace("+00:00", "Z"),
                            end=end_date.isoformat().replace("+00:00", "Z"),
                            time_zone=reference_tz,
                        )
                    )

                    start_minutes += 30

        if not candidate_slots:
            conflicting = self._find_conflicting_participants(availabilities)
            return SchedulingResult(
                success=False,
                proposed_slots=[],
                failure_reason="No available time slots found within constraints",
                conflicting_participants=conflicting,
            )

        scored_slots = [self._score_slot(slot, request) for slot in candidate_slots]
        scored_slots.sort(key=lambda s: s.score, reverse=True)

        return SchedulingResult(
            success=True,
            proposed_slots=scored_slots[:3],
        )

    def _find_day_intersection(
        self,
        availabilities: list[dict[str, Any]],
        day: DayOfWeek,
        date_str: str,
        min_duration: int,
    ) -> list[dict[str, int]]:
        """Find the intersection of availability windows for a given day."""
        participant_windows: list[list[dict[str, int]]] = []

        for entry in availabilities:
            avail: Availability = entry["availability"]
            windows: list[dict[str, int]] = []

            # Check exceptions
            exc = next((e for e in avail.exceptions if e.date == date_str), None)
            if exc and exc.unavailable:
                participant_windows.append([])
                continue
            if exc and exc.start_minutes is not None and exc.end_minutes is not None:
                participant_windows.append(
                    [{"start": exc.start_minutes, "end": exc.end_minutes}]
                )
                continue

            for w in avail.weekly:
                if w.day == day:
                    windows.append({"start": w.start_minutes, "end": w.end_minutes})
            participant_windows.append(windows)

        if any(len(w) == 0 for w in participant_windows):
            return []

        intersection = participant_windows[0]

        for i in range(1, len(participant_windows)):
            new_intersection: list[dict[str, int]] = []
            for window_a in intersection:
                for window_b in participant_windows[i]:
                    start = max(window_a["start"], window_b["start"])
                    end = min(window_a["end"], window_b["end"])
                    if end - start >= min_duration:
                        new_intersection.append({"start": start, "end": end})
            intersection = new_intersection
            if not intersection:
                break

        return intersection

    def _find_conflicting_participants(
        self, availabilities: list[dict[str, Any]]
    ) -> list[str]:
        conflicting: list[str] = []

        for i in range(len(availabilities)):
            has_overlap_with_all = True
            for j in range(len(availabilities)):
                if i == j:
                    continue
                if not self._has_any_overlap(
                    availabilities[i]["availability"],
                    availabilities[j]["availability"],
                ):
                    has_overlap_with_all = False
                    break
            if not has_overlap_with_all:
                conflicting.append(availabilities[i]["participant"].entity_id)

        return conflicting

    def _has_any_overlap(self, a: Availability, b: Availability) -> bool:
        for window_a in a.weekly:
            for window_b in b.weekly:
                if window_a.day != window_b.day:
                    continue
                overlap_start = max(window_a.start_minutes, window_b.start_minutes)
                overlap_end = min(window_a.end_minutes, window_b.end_minutes)
                if overlap_end - overlap_start >= 30:
                    return True
        return False

    def _score_slot(self, slot: TimeSlot, request: SchedulingRequest) -> ProposedSlot:
        constraints = request.constraints
        urgency = request.urgency
        score = 100.0
        reasons: list[str] = []
        concerns: list[str] = []

        start_date = datetime.fromisoformat(slot.start.replace("Z", "+00:00"))
        minutes = _get_minutes_of_day(start_date, slot.time_zone)
        day = _get_day_of_week(start_date, slot.time_zone)

        # Time of day scoring
        if minutes < 12 * 60:
            time_of_day = "morning"
        elif minutes < 17 * 60:
            time_of_day = "afternoon"
        else:
            time_of_day = "evening"

        if constraints.preferred_times and time_of_day in constraints.preferred_times:
            score += 20
            reasons.append(f"Preferred time ({time_of_day})")

        # Day of week scoring
        if constraints.preferred_days and day in constraints.preferred_days:
            score += 15
            reasons.append(f"Preferred day ({day.value})")

        # Urgency scoring
        days_from_now = (start_date.timestamp() - datetime.now(timezone.utc).timestamp()) / 86400

        if urgency == SchedulingUrgency.URGENT:
            score -= days_from_now * 10
            if days_from_now < 2:
                reasons.append("Soon (urgent meeting)")
        elif urgency == SchedulingUrgency.SOON:
            score -= days_from_now * 5

        # Penalize very early or very late times
        if minutes < 9 * 60:
            score -= 15
            concerns.append("Early morning")
        elif minutes > 18 * 60:
            score -= 10
            concerns.append("Evening time")

        # Bonus for standard business hours
        if 10 * 60 <= minutes <= 16 * 60:
            score += 10
            reasons.append("Standard business hours")

        return ProposedSlot(
            slot=slot,
            score=max(0.0, score),
            reasons=reasons,
            concerns=concerns,
        )

    # ========================================================================
    # MEETING CRUD
    # ========================================================================

    async def create_meeting(
        self,
        request: SchedulingRequest,
        slot: TimeSlot,
        location: dict[str, Any],
    ) -> Meeting:
        from .types import LocationType

        participants = [
            MeetingParticipant(
                entity_id=p.entity_id,
                name=p.name,
                email=p.email,
                phone=p.phone,
                role=ParticipantRole.ORGANIZER if i == 0 else ParticipantRole.REQUIRED,
                confirmed=False,
            )
            for i, p in enumerate(request.participants)
        ]

        meeting = Meeting(
            id=str(uuid.uuid4()),
            request_id=request.id,
            room_id=request.room_id,
            title=request.title,
            description=request.description,
            slot=slot,
            location=MeetingLocation(
                type=LocationType(location.get("type", "virtual")),
                name=location.get("name"),
                address=location.get("address"),
                city=location.get("city"),
                video_url=location.get("video_url"),
                phone_number=location.get("phone_number"),
                notes=location.get("notes"),
            ),
            participants=participants,
            status=MeetingStatus.PROPOSED,
            reschedule_count=0,
            created_at=_now_ms(),
            updated_at=_now_ms(),
        )

        storage = get_meeting_storage(self.runtime)
        await storage.save(meeting)
        logger.info('[SchedulingService] Created meeting %s for "%s"', meeting.id, meeting.title)

        if self.config.auto_schedule_reminders:
            await self.schedule_reminders(meeting)

        return meeting

    async def get_meeting(self, meeting_id: str) -> Optional[Meeting]:
        return await get_meeting_storage(self.runtime).get(meeting_id)

    async def get_meetings_for_room(self, room_id: str) -> list[Meeting]:
        return await get_meeting_storage(self.runtime).get_by_room(room_id)

    async def get_upcoming_meetings(self, entity_id: str) -> list[Meeting]:
        return await get_meeting_storage(self.runtime).get_upcoming_for_participant(entity_id)

    async def confirm_participant(self, meeting_id: str, entity_id: str) -> Meeting:
        meeting = await self.get_meeting(meeting_id)
        if not meeting:
            raise MeetingNotFoundError(meeting_id)

        participant = next(
            (p for p in meeting.participants if p.entity_id == entity_id), None
        )
        if not participant:
            raise ParticipantNotFoundError(entity_id, meeting_id)

        participant.confirmed = True
        participant.confirmed_at = _now_ms()
        meeting.updated_at = _now_ms()

        all_confirmed = all(
            p.confirmed for p in meeting.participants if p.role != ParticipantRole.OPTIONAL
        )

        if all_confirmed and meeting.status == MeetingStatus.PROPOSED:
            meeting.status = MeetingStatus.CONFIRMED
            logger.info(
                "[SchedulingService] Meeting %s confirmed by all participants", meeting_id
            )
            if self.config.auto_send_calendar_invites:
                await self.send_calendar_invites(meeting)
                meeting.status = MeetingStatus.SCHEDULED

        storage = get_meeting_storage(self.runtime)
        await storage.save(meeting)
        return meeting

    async def decline_participant(
        self, meeting_id: str, entity_id: str, reason: Optional[str] = None
    ) -> Meeting:
        meeting = await self.get_meeting(meeting_id)
        if not meeting:
            raise MeetingNotFoundError(meeting_id)

        participant = next(
            (p for p in meeting.participants if p.entity_id == entity_id), None
        )
        if not participant:
            raise ParticipantNotFoundError(entity_id, meeting_id)

        participant.confirmed = False
        participant.decline_reason = reason
        meeting.updated_at = _now_ms()

        if participant.role != ParticipantRole.OPTIONAL:
            meeting.status = MeetingStatus.RESCHEDULING
            meeting.cancellation_reason = (
                f"{participant.name} declined: {reason or 'No reason given'}"
            )
            logger.info("[SchedulingService] Meeting %s needs rescheduling", meeting_id)

        storage = get_meeting_storage(self.runtime)
        await storage.save(meeting)
        return meeting

    async def cancel_meeting(
        self, meeting_id: str, reason: Optional[str] = None
    ) -> Meeting:
        meeting = await self.get_meeting(meeting_id)
        if not meeting:
            raise MeetingNotFoundError(meeting_id)

        meeting.status = MeetingStatus.CANCELLED
        meeting.cancellation_reason = reason
        meeting.updated_at = _now_ms()

        await self.cancel_reminders(meeting_id)

        storage = get_meeting_storage(self.runtime)
        await storage.save(meeting)
        logger.info("[SchedulingService] Meeting %s cancelled", meeting_id)
        return meeting

    async def update_meeting_status(
        self, meeting_id: str, status: MeetingStatus
    ) -> Meeting:
        meeting = await self.get_meeting(meeting_id)
        if not meeting:
            raise MeetingNotFoundError(meeting_id)

        meeting.status = status
        meeting.updated_at = _now_ms()

        storage = get_meeting_storage(self.runtime)
        await storage.save(meeting)
        return meeting

    async def reschedule_meeting(
        self, meeting_id: str, new_slot: TimeSlot, reason: Optional[str] = None
    ) -> Meeting:
        meeting = await self.get_meeting(meeting_id)
        if not meeting:
            raise MeetingNotFoundError(meeting_id)

        await self.cancel_reminders(meeting_id)

        meeting.slot = new_slot
        meeting.status = MeetingStatus.PROPOSED
        meeting.reschedule_count += 1
        meeting.cancellation_reason = reason
        meeting.updated_at = _now_ms()

        for p in meeting.participants:
            p.confirmed = False
            p.confirmed_at = None

        storage = get_meeting_storage(self.runtime)
        await storage.save(meeting)

        if self.config.auto_schedule_reminders:
            await self.schedule_reminders(meeting)

        logger.info(
            "[SchedulingService] Meeting %s rescheduled (count: %d)",
            meeting_id,
            meeting.reschedule_count,
        )
        return meeting

    # ========================================================================
    # CALENDAR INVITES
    # ========================================================================

    def generate_calendar_invite(
        self, meeting: Meeting, recipient_email: str, recipient_name: str
    ) -> CalendarInvite:
        organizer = next(
            (p for p in meeting.participants if p.role == ParticipantRole.ORGANIZER),
            None,
        )

        from .types import CalendarEventAttendee, CalendarEventOrganizer

        location_str: Optional[str] = None
        if meeting.location.type.value == "in_person":
            location_str = f"{meeting.location.name}, {meeting.location.address}"
        elif meeting.location.video_url:
            location_str = meeting.location.video_url

        event = CalendarEvent(
            uid=meeting.id,
            title=meeting.title,
            description=meeting.description,
            start=meeting.slot.start,
            end=meeting.slot.end,
            time_zone=meeting.slot.time_zone,
            location=location_str,
            organizer=(
                CalendarEventOrganizer(name=organizer.name, email=organizer.email)
                if organizer and organizer.email
                else None
            ),
            attendees=[
                CalendarEventAttendee(name=p.name, email=p.email, role=p.role)
                for p in meeting.participants
                if p.email
            ],
            url=meeting.location.video_url,
            reminder_minutes=list(self.config.default_reminder_minutes),
        )

        ics = generate_ics(event)

        return CalendarInvite(
            ics=ics,
            event=event,
            recipient_email=recipient_email,
            recipient_name=recipient_name,
        )

    async def send_calendar_invites(self, meeting: Meeting) -> list[CalendarInvite]:
        invites: list[CalendarInvite] = []

        for participant in meeting.participants:
            if not participant.email:
                logger.warning(
                    "[SchedulingService] Participant %s has no email - skipping invite",
                    participant.name,
                )
                continue

            invite = self.generate_calendar_invite(
                meeting, participant.email, participant.name
            )
            invites.append(invite)
            logger.info(
                "[SchedulingService] Generated calendar invite for %s (meeting %s)",
                participant.email,
                meeting.id,
            )

        return invites

    # ========================================================================
    # REMINDERS
    # ========================================================================

    async def schedule_reminders(self, meeting: Meeting) -> list[Reminder]:
        reminders: list[Reminder] = []
        meeting_time_ms = int(
            datetime.fromisoformat(meeting.slot.start.replace("Z", "+00:00")).timestamp() * 1000
        )

        for minutes_before in self.config.default_reminder_minutes:
            scheduled_ms = meeting_time_ms - minutes_before * 60 * 1000
            if scheduled_ms < _now_ms():
                continue

            scheduled_for = datetime.fromtimestamp(
                scheduled_ms / 1000, tz=timezone.utc
            ).isoformat().replace("+00:00", "Z")

            for participant in meeting.participants:
                if participant.phone:
                    reminder_type = ReminderType.SMS
                elif participant.email:
                    reminder_type = ReminderType.EMAIL
                else:
                    reminder_type = ReminderType.PUSH

                if minutes_before >= 1440:
                    time_label = f"{round(minutes_before / 1440)} day(s)"
                elif minutes_before >= 60:
                    time_label = f"{round(minutes_before / 60)} hour(s)"
                else:
                    time_label = f"{minutes_before} minutes"

                reminder = Reminder(
                    id=str(uuid.uuid4()),
                    meeting_id=meeting.id,
                    participant_id=participant.entity_id,
                    scheduled_for=scheduled_for,
                    type=reminder_type,
                    message=f'Reminder: "{meeting.title}" is in {time_label}',
                    status=ReminderStatus.PENDING,
                    created_at=_now_ms(),
                )
                reminders.append(reminder)

        storage = get_reminder_storage(self.runtime)
        for reminder in reminders:
            await storage.save(reminder)

        logger.debug(
            "[SchedulingService] Scheduled %d reminders for meeting %s",
            len(reminders),
            meeting.id,
        )
        return reminders

    async def get_due_reminders(self) -> list[Reminder]:
        return await get_reminder_storage(self.runtime).get_due()

    async def mark_reminder_sent(self, reminder_id: str) -> None:
        storage = get_reminder_storage(self.runtime)
        reminder = await storage.get(reminder_id)
        if not reminder:
            return
        reminder.status = ReminderStatus.SENT
        reminder.sent_at = _now_ms()
        await storage.save(reminder)

    async def cancel_reminders(self, meeting_id: str) -> None:
        storage = get_reminder_storage(self.runtime)
        reminders = await storage.get_by_meeting(meeting_id)
        for reminder in reminders:
            if reminder.status == ReminderStatus.PENDING:
                reminder.status = ReminderStatus.CANCELLED
                await storage.save(reminder)

    # ========================================================================
    # FORMATTING
    # ========================================================================

    def format_slot(self, slot: TimeSlot) -> str:
        """Format a time slot for display."""
        start = datetime.fromisoformat(slot.start.replace("Z", "+00:00"))
        end = datetime.fromisoformat(slot.end.replace("Z", "+00:00"))

        try:
            from zoneinfo import ZoneInfo
        except ImportError:
            from backports.zoneinfo import ZoneInfo  # type: ignore[no-redef]

        tz = ZoneInfo(slot.time_zone)
        start_local = start.astimezone(tz)
        end_local = end.astimezone(tz)

        date_str = start_local.strftime("%a, %b %-d")
        start_time = start_local.strftime("%-I:%M %p")
        end_time = end_local.strftime("%-I:%M %p")

        return f"{date_str}, {start_time} - {end_time}"
