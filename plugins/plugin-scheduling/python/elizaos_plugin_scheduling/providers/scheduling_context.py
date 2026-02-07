"""
SCHEDULING_CONTEXT provider.

Provides the agent with context about upcoming meetings and scheduling requests.
"""

from __future__ import annotations

from typing import Any, Optional

from ..types import Meeting, MeetingStatus


def _format_meeting_for_context(meeting: Meeting, service: Any) -> str:
    """Format a meeting for display in context."""
    time_str = service.format_slot(meeting.slot)
    participants = ", ".join(p.name for p in meeting.participants)

    if meeting.location.type.value == "in_person":
        location_str = f"at {meeting.location.name}"
    elif meeting.location.type.value == "virtual":
        location_str = "virtual meeting"
    else:
        location_str = "phone call"

    return (
        f'- "{meeting.title}" on {time_str} ({location_str}) '
        f"with {participants} [{meeting.status.value}]"
    )


async def _get_scheduling_context(
    runtime: Any,
    message: Any,
    state: Any = None,
) -> dict[str, str]:
    """Get scheduling context for the agent."""
    from ..service import SchedulingService

    scheduling_service: Optional[SchedulingService] = None
    if hasattr(runtime, "get_service"):
        scheduling_service = runtime.get_service("SCHEDULING")

    if not scheduling_service:
        return {"text": ""}

    entity_id = getattr(message, "entity_id", None)
    if not entity_id:
        return {"text": ""}

    sections: list[str] = []

    try:
        meetings = await scheduling_service.get_upcoming_meetings(entity_id)

        if meetings:
            proposed = [m for m in meetings if m.status == MeetingStatus.PROPOSED]
            confirmed = [
                m
                for m in meetings
                if m.status in (MeetingStatus.CONFIRMED, MeetingStatus.SCHEDULED)
            ]

            if proposed:
                sections.append("Meetings pending confirmation:")
                for meeting in proposed[:3]:
                    sections.append(
                        _format_meeting_for_context(meeting, scheduling_service)
                    )

            if confirmed:
                sections.append("\nUpcoming confirmed meetings:")
                for meeting in confirmed[:5]:
                    sections.append(
                        _format_meeting_for_context(meeting, scheduling_service)
                    )

        availability = await scheduling_service.get_availability(entity_id)
        if availability:
            weekly_count = len(availability.weekly)
            exceptions_count = len(availability.exceptions)
            sections.append(
                f"\nUser has {weekly_count} recurring availability windows set "
                f"(timezone: {availability.time_zone})"
            )
            if exceptions_count > 0:
                sections.append(f"User has {exceptions_count} availability exceptions")
        else:
            sections.append("\nUser has not set their availability yet")

    except Exception:
        pass

    if not sections:
        return {"text": ""}

    return {"text": f"<scheduling_context>\n{chr(10).join(sections)}\n</scheduling_context>"}


scheduling_context_provider: dict[str, Any] = {
    "name": "SCHEDULING_CONTEXT",
    "description": "Provides context about upcoming meetings and scheduling requests",
    "get": _get_scheduling_context,
}
