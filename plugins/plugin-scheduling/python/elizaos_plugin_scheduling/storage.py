"""
Component-based persistence for scheduling data using elizaOS Components.

Mirrors the TypeScript storage layer with component-type keyed storage,
indexing for meetings by room and participant, and reminder registries.
"""

from __future__ import annotations

import uuid
from abc import ABC, abstractmethod
from typing import Any, Optional, Protocol, runtime_checkable

from .types import Availability, Meeting, MeetingStatus, Reminder, ReminderStatus, SchedulingRequest

# Component type prefixes
SCHEDULING_AVAILABILITY = "scheduling_availability"
SCHEDULING_MEETING = "scheduling_meeting"
SCHEDULING_REMINDER = "scheduling_reminder"
SCHEDULING_REQUEST = "scheduling_request"
SCHEDULING_MEETING_INDEX_ROOM = "scheduling_meeting_index:room"
SCHEDULING_MEETING_INDEX_PARTICIPANT = "scheduling_meeting_index:participant"
SCHEDULING_REMINDER_INDEX_MEETING = "scheduling_reminder_index:meeting"
REMINDER_REGISTRY = "scheduling_reminder_registry"


# ============================================================================
# RUNTIME PROTOCOL
# ============================================================================


@runtime_checkable
class Component(Protocol):
    """Minimal component protocol matching elizaOS Component."""

    id: str
    entity_id: str
    agent_id: str
    room_id: str
    world_id: str
    source_entity_id: str
    type: str
    created_at: int
    data: dict[str, Any]


@runtime_checkable
class AgentRuntime(Protocol):
    """Protocol for the elizaOS agent runtime that storage needs."""

    @property
    def agent_id(self) -> str: ...

    async def get_component(self, entity_id: str, component_type: str) -> Optional[Any]: ...

    async def create_component(self, component: Any) -> None: ...

    async def update_component(self, component: Any) -> None: ...

    async def delete_component(self, component_id: str) -> None: ...

    async def get_components(self, entity_id: str) -> list[Any]: ...


# ============================================================================
# INDEX HELPERS
# ============================================================================


async def _get_meeting_index(
    runtime: AgentRuntime, index_type: str, index_key: str
) -> dict[str, list[str]]:
    component_type = f"{index_type}:{index_key}"
    component = await runtime.get_component(runtime.agent_id, component_type)
    if not component:
        return {"meeting_ids": []}
    return component.data if isinstance(component.data, dict) else {"meeting_ids": []}


async def _save_meeting_index(
    runtime: AgentRuntime, index_type: str, index_key: str, index: dict[str, list[str]]
) -> None:
    component_type = f"{index_type}:{index_key}"
    existing = await runtime.get_component(runtime.agent_id, component_type)

    component_data = {
        "id": existing.id if existing else str(uuid.uuid4()),
        "entity_id": runtime.agent_id,
        "agent_id": runtime.agent_id,
        "room_id": str(uuid.uuid4()),
        "world_id": existing.world_id if existing else str(uuid.uuid4()),
        "source_entity_id": runtime.agent_id,
        "type": component_type,
        "created_at": existing.created_at if existing else _now_ms(),
        "data": index,
    }

    if existing:
        await runtime.update_component(component_data)
    else:
        await runtime.create_component(component_data)


async def _add_to_meeting_index(
    runtime: AgentRuntime, index_type: str, index_key: str, meeting_id: str
) -> None:
    index = await _get_meeting_index(runtime, index_type, index_key)
    if meeting_id not in index["meeting_ids"]:
        index["meeting_ids"].append(meeting_id)
        await _save_meeting_index(runtime, index_type, index_key, index)


async def _remove_from_meeting_index(
    runtime: AgentRuntime, index_type: str, index_key: str, meeting_id: str
) -> None:
    index = await _get_meeting_index(runtime, index_type, index_key)
    index["meeting_ids"] = [mid for mid in index["meeting_ids"] if mid != meeting_id]
    await _save_meeting_index(runtime, index_type, index_key, index)


async def _get_reminder_index(runtime: AgentRuntime, meeting_id: str) -> dict[str, list[str]]:
    component_type = f"{SCHEDULING_REMINDER_INDEX_MEETING}:{meeting_id}"
    component = await runtime.get_component(runtime.agent_id, component_type)
    return component.data if component else {"reminder_ids": []}


async def _save_reminder_index(
    runtime: AgentRuntime, meeting_id: str, index: dict[str, list[str]]
) -> None:
    component_type = f"{SCHEDULING_REMINDER_INDEX_MEETING}:{meeting_id}"
    existing = await runtime.get_component(runtime.agent_id, component_type)

    component_data = {
        "id": existing.id if existing else str(uuid.uuid4()),
        "entity_id": runtime.agent_id,
        "agent_id": runtime.agent_id,
        "room_id": str(uuid.uuid4()),
        "world_id": existing.world_id if existing else str(uuid.uuid4()),
        "source_entity_id": runtime.agent_id,
        "type": component_type,
        "created_at": existing.created_at if existing else _now_ms(),
        "data": index,
    }

    if existing:
        await runtime.update_component(component_data)
    else:
        await runtime.create_component(component_data)


async def _get_reminder_registry(runtime: AgentRuntime) -> dict[str, list[str]]:
    component = await runtime.get_component(runtime.agent_id, REMINDER_REGISTRY)
    return component.data if component else {"reminder_ids": []}


async def _save_reminder_registry(runtime: AgentRuntime, registry: dict[str, list[str]]) -> None:
    existing = await runtime.get_component(runtime.agent_id, REMINDER_REGISTRY)

    component_data = {
        "id": existing.id if existing else str(uuid.uuid4()),
        "entity_id": runtime.agent_id,
        "agent_id": runtime.agent_id,
        "room_id": str(uuid.uuid4()),
        "world_id": existing.world_id if existing else str(uuid.uuid4()),
        "source_entity_id": runtime.agent_id,
        "type": REMINDER_REGISTRY,
        "created_at": existing.created_at if existing else _now_ms(),
        "data": registry,
    }

    if existing:
        await runtime.update_component(component_data)
    else:
        await runtime.create_component(component_data)


def _now_ms() -> int:
    """Get current time in milliseconds."""
    import time
    return int(time.time() * 1000)


def _availability_to_dict(avail: Availability) -> dict[str, Any]:
    return {
        "time_zone": avail.time_zone,
        "weekly": [
            {"day": w.day.value, "start_minutes": w.start_minutes, "end_minutes": w.end_minutes}
            for w in avail.weekly
        ],
        "exceptions": [
            {
                "date": e.date,
                "unavailable": e.unavailable,
                "start_minutes": e.start_minutes,
                "end_minutes": e.end_minutes,
                "reason": e.reason,
            }
            for e in avail.exceptions
        ],
    }


def _dict_to_availability(data: dict[str, Any]) -> Availability:
    from .types import AvailabilityException, AvailabilityWindow, DayOfWeek

    return Availability(
        time_zone=data["time_zone"],
        weekly=[
            AvailabilityWindow(
                day=DayOfWeek(w["day"]),
                start_minutes=w["start_minutes"],
                end_minutes=w["end_minutes"],
            )
            for w in data.get("weekly", [])
        ],
        exceptions=[
            AvailabilityException(
                date=e["date"],
                unavailable=e.get("unavailable", False),
                start_minutes=e.get("start_minutes"),
                end_minutes=e.get("end_minutes"),
                reason=e.get("reason"),
            )
            for e in data.get("exceptions", [])
        ],
    )


def _meeting_to_dict(meeting: Meeting) -> dict[str, Any]:
    return {
        "id": meeting.id,
        "request_id": meeting.request_id,
        "room_id": meeting.room_id,
        "title": meeting.title,
        "description": meeting.description,
        "slot": {"start": meeting.slot.start, "end": meeting.slot.end, "time_zone": meeting.slot.time_zone},
        "location": {
            "type": meeting.location.type.value,
            "name": meeting.location.name,
            "address": meeting.location.address,
            "city": meeting.location.city,
            "place_id": meeting.location.place_id,
            "video_url": meeting.location.video_url,
            "phone_number": meeting.location.phone_number,
            "notes": meeting.location.notes,
        },
        "participants": [
            {
                "entity_id": p.entity_id,
                "name": p.name,
                "email": p.email,
                "phone": p.phone,
                "role": p.role.value,
                "confirmed": p.confirmed,
                "confirmed_at": p.confirmed_at,
                "decline_reason": p.decline_reason,
            }
            for p in meeting.participants
        ],
        "status": meeting.status.value,
        "reschedule_count": meeting.reschedule_count,
        "cancellation_reason": meeting.cancellation_reason,
        "created_at": meeting.created_at,
        "updated_at": meeting.updated_at,
        "notes": meeting.notes,
        "meta": meeting.meta,
    }


def _dict_to_meeting(data: dict[str, Any]) -> Meeting:
    from .types import (
        LocationType,
        MeetingLocation,
        MeetingParticipant,
        ParticipantRole,
        TimeSlot,
    )

    return Meeting(
        id=data["id"],
        request_id=data["request_id"],
        room_id=data["room_id"],
        title=data["title"],
        description=data.get("description"),
        slot=TimeSlot(
            start=data["slot"]["start"],
            end=data["slot"]["end"],
            time_zone=data["slot"]["time_zone"],
        ),
        location=MeetingLocation(
            type=LocationType(data["location"]["type"]),
            name=data["location"].get("name"),
            address=data["location"].get("address"),
            city=data["location"].get("city"),
            place_id=data["location"].get("place_id"),
            video_url=data["location"].get("video_url"),
            phone_number=data["location"].get("phone_number"),
            notes=data["location"].get("notes"),
        ),
        participants=[
            MeetingParticipant(
                entity_id=p["entity_id"],
                name=p["name"],
                email=p.get("email"),
                phone=p.get("phone"),
                role=ParticipantRole(p["role"]),
                confirmed=p.get("confirmed", False),
                confirmed_at=p.get("confirmed_at"),
                decline_reason=p.get("decline_reason"),
            )
            for p in data.get("participants", [])
        ],
        status=MeetingStatus(data.get("status", "proposed")),
        reschedule_count=data.get("reschedule_count", 0),
        cancellation_reason=data.get("cancellation_reason"),
        created_at=data.get("created_at", 0),
        updated_at=data.get("updated_at", 0),
        notes=data.get("notes"),
        meta=data.get("meta"),
    )


def _reminder_to_dict(reminder: Reminder) -> dict[str, Any]:
    return {
        "id": reminder.id,
        "meeting_id": reminder.meeting_id,
        "participant_id": reminder.participant_id,
        "scheduled_for": reminder.scheduled_for,
        "type": reminder.type.value,
        "message": reminder.message,
        "status": reminder.status.value,
        "sent_at": reminder.sent_at,
        "error": reminder.error,
        "created_at": reminder.created_at,
    }


def _dict_to_reminder(data: dict[str, Any]) -> Reminder:
    from .types import ReminderType

    return Reminder(
        id=data["id"],
        meeting_id=data["meeting_id"],
        participant_id=data["participant_id"],
        scheduled_for=data["scheduled_for"],
        type=ReminderType(data["type"]),
        message=data["message"],
        status=ReminderStatus(data.get("status", "pending")),
        sent_at=data.get("sent_at"),
        error=data.get("error"),
        created_at=data.get("created_at", 0),
    )


def _request_to_dict(req: SchedulingRequest) -> dict[str, Any]:
    return {
        "id": req.id,
        "room_id": req.room_id,
        "title": req.title,
        "description": req.description,
        "participants": [
            {
                "entity_id": p.entity_id,
                "name": p.name,
                "email": p.email,
                "phone": p.phone,
                "priority": p.priority,
                "availability": _availability_to_dict(p.availability),
            }
            for p in req.participants
        ],
        "constraints": {
            "min_duration_minutes": req.constraints.min_duration_minutes,
            "preferred_duration_minutes": req.constraints.preferred_duration_minutes,
            "max_days_out": req.constraints.max_days_out,
            "preferred_times": req.constraints.preferred_times,
            "preferred_days": [d.value for d in req.constraints.preferred_days] if req.constraints.preferred_days else None,
            "location_type": req.constraints.location_type.value if req.constraints.location_type else None,
            "location_constraint": req.constraints.location_constraint,
        },
        "urgency": req.urgency.value,
        "created_at": req.created_at,
        "max_proposals": req.max_proposals,
    }


def _dict_to_request(data: dict[str, Any]) -> SchedulingRequest:
    from .types import (
        DayOfWeek,
        LocationType,
        Participant,
        SchedulingConstraints,
        SchedulingUrgency,
    )

    constraints_data = data.get("constraints", {})
    pref_days = constraints_data.get("preferred_days")
    loc_type = constraints_data.get("location_type")

    return SchedulingRequest(
        id=data["id"],
        room_id=data["room_id"],
        title=data["title"],
        description=data.get("description"),
        participants=[
            Participant(
                entity_id=p["entity_id"],
                name=p["name"],
                email=p.get("email"),
                phone=p.get("phone"),
                priority=p.get("priority", 1),
                availability=_dict_to_availability(p["availability"]),
            )
            for p in data.get("participants", [])
        ],
        constraints=SchedulingConstraints(
            min_duration_minutes=constraints_data.get("min_duration_minutes", 30),
            preferred_duration_minutes=constraints_data.get("preferred_duration_minutes", 60),
            max_days_out=constraints_data.get("max_days_out", 7),
            preferred_times=constraints_data.get("preferred_times"),
            preferred_days=[DayOfWeek(d) for d in pref_days] if pref_days else None,
            location_type=LocationType(loc_type) if loc_type else None,
            location_constraint=constraints_data.get("location_constraint"),
        ),
        urgency=SchedulingUrgency(data.get("urgency", "flexible")),
        created_at=data.get("created_at", 0),
        max_proposals=data.get("max_proposals", 3),
    )


# ============================================================================
# STORAGE INTERFACES
# ============================================================================


class AvailabilityStorage:
    """Storage for participant availability."""

    def __init__(self, runtime: AgentRuntime) -> None:
        self._runtime = runtime

    async def get(self, entity_id: str) -> Optional[Availability]:
        component_type = f"{SCHEDULING_AVAILABILITY}:{entity_id}"
        component = await self._runtime.get_component(entity_id, component_type)
        if not component:
            return None
        return _dict_to_availability(component.data)

    async def save(self, entity_id: str, availability: Availability) -> None:
        component_type = f"{SCHEDULING_AVAILABILITY}:{entity_id}"
        existing = await self._runtime.get_component(entity_id, component_type)

        component_data = {
            "id": existing.id if existing else str(uuid.uuid4()),
            "entity_id": entity_id,
            "agent_id": self._runtime.agent_id,
            "room_id": str(uuid.uuid4()),
            "world_id": existing.world_id if existing else str(uuid.uuid4()),
            "source_entity_id": self._runtime.agent_id,
            "type": component_type,
            "created_at": existing.created_at if existing else _now_ms(),
            "data": _availability_to_dict(availability),
        }

        if existing:
            await self._runtime.update_component(component_data)
        else:
            await self._runtime.create_component(component_data)

    async def delete(self, entity_id: str) -> None:
        component_type = f"{SCHEDULING_AVAILABILITY}:{entity_id}"
        existing = await self._runtime.get_component(entity_id, component_type)
        if existing:
            await self._runtime.delete_component(existing.id)


class SchedulingRequestStorage:
    """Storage for scheduling requests."""

    def __init__(self, runtime: AgentRuntime) -> None:
        self._runtime = runtime

    async def get(self, request_id: str) -> Optional[SchedulingRequest]:
        component_type = f"{SCHEDULING_REQUEST}:{request_id}"
        component = await self._runtime.get_component(self._runtime.agent_id, component_type)
        if not component:
            return None
        return _dict_to_request(component.data)

    async def save(self, request: SchedulingRequest) -> None:
        component_type = f"{SCHEDULING_REQUEST}:{request.id}"
        existing = await self._runtime.get_component(self._runtime.agent_id, component_type)

        component_data = {
            "id": existing.id if existing else str(uuid.uuid4()),
            "entity_id": self._runtime.agent_id,
            "agent_id": self._runtime.agent_id,
            "room_id": request.room_id,
            "world_id": existing.world_id if existing else str(uuid.uuid4()),
            "source_entity_id": self._runtime.agent_id,
            "type": component_type,
            "created_at": existing.created_at if existing else _now_ms(),
            "data": _request_to_dict(request),
        }

        if existing:
            await self._runtime.update_component(component_data)
        else:
            await self._runtime.create_component(component_data)

    async def delete(self, request_id: str) -> None:
        component_type = f"{SCHEDULING_REQUEST}:{request_id}"
        existing = await self._runtime.get_component(self._runtime.agent_id, component_type)
        if existing:
            await self._runtime.delete_component(existing.id)

    async def get_by_room(self, room_id: str) -> list[SchedulingRequest]:
        components = await self._runtime.get_components(self._runtime.agent_id)
        requests: list[SchedulingRequest] = []
        for component in components:
            if hasattr(component, "type") and component.type.startswith(f"{SCHEDULING_REQUEST}:"):
                req = _dict_to_request(component.data)
                if req.room_id == room_id:
                    requests.append(req)
        return requests


class MeetingStorage:
    """Storage for meetings with room and participant indexing."""

    def __init__(self, runtime: AgentRuntime) -> None:
        self._runtime = runtime

    async def get(self, meeting_id: str) -> Optional[Meeting]:
        component_type = f"{SCHEDULING_MEETING}:{meeting_id}"
        component = await self._runtime.get_component(self._runtime.agent_id, component_type)
        if not component:
            return None
        return _dict_to_meeting(component.data)

    async def save(self, meeting: Meeting) -> None:
        component_type = f"{SCHEDULING_MEETING}:{meeting.id}"
        existing = await self._runtime.get_component(self._runtime.agent_id, component_type)

        component_data = {
            "id": existing.id if existing else str(uuid.uuid4()),
            "entity_id": self._runtime.agent_id,
            "agent_id": self._runtime.agent_id,
            "room_id": meeting.room_id,
            "world_id": existing.world_id if existing else str(uuid.uuid4()),
            "source_entity_id": self._runtime.agent_id,
            "type": component_type,
            "created_at": existing.created_at if existing else meeting.created_at,
            "data": _meeting_to_dict(meeting),
        }

        if existing:
            await self._runtime.update_component(component_data)
        else:
            await self._runtime.create_component(component_data)
            # Add to room index
            await _add_to_meeting_index(
                self._runtime, SCHEDULING_MEETING_INDEX_ROOM, meeting.room_id, meeting.id
            )
            # Add to participant indices
            for participant in meeting.participants:
                await _add_to_meeting_index(
                    self._runtime,
                    SCHEDULING_MEETING_INDEX_PARTICIPANT,
                    participant.entity_id,
                    meeting.id,
                )

    async def delete(self, meeting_id: str) -> None:
        component_type = f"{SCHEDULING_MEETING}:{meeting_id}"
        existing = await self._runtime.get_component(self._runtime.agent_id, component_type)

        if existing:
            meeting = _dict_to_meeting(existing.data)
            await _remove_from_meeting_index(
                self._runtime, SCHEDULING_MEETING_INDEX_ROOM, meeting.room_id, meeting_id
            )
            for participant in meeting.participants:
                await _remove_from_meeting_index(
                    self._runtime,
                    SCHEDULING_MEETING_INDEX_PARTICIPANT,
                    participant.entity_id,
                    meeting_id,
                )
            await self._runtime.delete_component(existing.id)

    async def get_by_room(self, room_id: str) -> list[Meeting]:
        index = await _get_meeting_index(self._runtime, SCHEDULING_MEETING_INDEX_ROOM, room_id)
        meetings: list[Meeting] = []
        for meeting_id in index["meeting_ids"]:
            component_type = f"{SCHEDULING_MEETING}:{meeting_id}"
            component = await self._runtime.get_component(self._runtime.agent_id, component_type)
            if component:
                meetings.append(_dict_to_meeting(component.data))
        return meetings

    async def get_upcoming_for_participant(self, entity_id: str) -> list[Meeting]:
        index = await _get_meeting_index(
            self._runtime, SCHEDULING_MEETING_INDEX_PARTICIPANT, entity_id
        )
        meetings: list[Meeting] = []
        now = _now_ms()

        for meeting_id in index["meeting_ids"]:
            component_type = f"{SCHEDULING_MEETING}:{meeting_id}"
            component = await self._runtime.get_component(self._runtime.agent_id, component_type)
            if component:
                meeting = _dict_to_meeting(component.data)
                from datetime import datetime, timezone as tz

                start_ms = int(datetime.fromisoformat(meeting.slot.start.replace("Z", "+00:00")).timestamp() * 1000)
                if start_ms > now and meeting.status != MeetingStatus.CANCELLED:
                    meetings.append(meeting)

        meetings.sort(key=lambda m: m.slot.start)
        return meetings


class ReminderStorage:
    """Storage for reminders with meeting indexing and due-query support."""

    def __init__(self, runtime: AgentRuntime) -> None:
        self._runtime = runtime

    async def get(self, reminder_id: str) -> Optional[Reminder]:
        component_type = f"{SCHEDULING_REMINDER}:{reminder_id}"
        component = await self._runtime.get_component(self._runtime.agent_id, component_type)
        if not component:
            return None
        return _dict_to_reminder(component.data)

    async def save(self, reminder: Reminder) -> None:
        component_type = f"{SCHEDULING_REMINDER}:{reminder.id}"
        existing = await self._runtime.get_component(self._runtime.agent_id, component_type)

        component_data = {
            "id": existing.id if existing else str(uuid.uuid4()),
            "entity_id": self._runtime.agent_id,
            "agent_id": self._runtime.agent_id,
            "room_id": str(uuid.uuid4()),
            "world_id": existing.world_id if existing else str(uuid.uuid4()),
            "source_entity_id": self._runtime.agent_id,
            "type": component_type,
            "created_at": existing.created_at if existing else reminder.created_at,
            "data": _reminder_to_dict(reminder),
        }

        if existing:
            await self._runtime.update_component(component_data)
        else:
            await self._runtime.create_component(component_data)
            # Add to meeting index
            index = await _get_reminder_index(self._runtime, reminder.meeting_id)
            if reminder.id not in index["reminder_ids"]:
                index["reminder_ids"].append(reminder.id)
                await _save_reminder_index(self._runtime, reminder.meeting_id, index)
            # Add to global registry
            registry = await _get_reminder_registry(self._runtime)
            if reminder.id not in registry["reminder_ids"]:
                registry["reminder_ids"].append(reminder.id)
                await _save_reminder_registry(self._runtime, registry)

    async def delete(self, reminder_id: str) -> None:
        component_type = f"{SCHEDULING_REMINDER}:{reminder_id}"
        existing = await self._runtime.get_component(self._runtime.agent_id, component_type)

        if existing:
            reminder = _dict_to_reminder(existing.data)
            # Remove from meeting index
            index = await _get_reminder_index(self._runtime, reminder.meeting_id)
            index["reminder_ids"] = [rid for rid in index["reminder_ids"] if rid != reminder_id]
            await _save_reminder_index(self._runtime, reminder.meeting_id, index)
            # Remove from global registry
            registry = await _get_reminder_registry(self._runtime)
            registry["reminder_ids"] = [rid for rid in registry["reminder_ids"] if rid != reminder_id]
            await _save_reminder_registry(self._runtime, registry)

            await self._runtime.delete_component(existing.id)

    async def get_by_meeting(self, meeting_id: str) -> list[Reminder]:
        index = await _get_reminder_index(self._runtime, meeting_id)
        reminders: list[Reminder] = []
        for reminder_id in index["reminder_ids"]:
            component_type = f"{SCHEDULING_REMINDER}:{reminder_id}"
            component = await self._runtime.get_component(self._runtime.agent_id, component_type)
            if component:
                reminders.append(_dict_to_reminder(component.data))
        return reminders

    async def get_due(self) -> list[Reminder]:
        registry = await _get_reminder_registry(self._runtime)
        now = _now_ms()
        due: list[Reminder] = []

        for reminder_id in registry["reminder_ids"]:
            component_type = f"{SCHEDULING_REMINDER}:{reminder_id}"
            component = await self._runtime.get_component(self._runtime.agent_id, component_type)
            if component:
                reminder = _dict_to_reminder(component.data)
                from datetime import datetime, timezone as tz

                scheduled_ms = int(
                    datetime.fromisoformat(reminder.scheduled_for.replace("Z", "+00:00")).timestamp() * 1000
                )
                if reminder.status == ReminderStatus.PENDING and scheduled_ms <= now:
                    due.append(reminder)

        return due


# ============================================================================
# FACTORY FUNCTIONS (matching TypeScript API)
# ============================================================================


def get_availability_storage(runtime: AgentRuntime) -> AvailabilityStorage:
    return AvailabilityStorage(runtime)


def get_scheduling_request_storage(runtime: AgentRuntime) -> SchedulingRequestStorage:
    return SchedulingRequestStorage(runtime)


def get_meeting_storage(runtime: AgentRuntime) -> MeetingStorage:
    return MeetingStorage(runtime)


def get_reminder_storage(runtime: AgentRuntime) -> ReminderStorage:
    return ReminderStorage(runtime)
