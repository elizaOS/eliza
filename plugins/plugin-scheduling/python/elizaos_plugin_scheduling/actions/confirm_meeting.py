"""
CONFIRM_MEETING action.

Confirms or declines meeting attendance.
"""

from __future__ import annotations

from typing import Any, Optional


# ============================================================================
# ACTION DEFINITION
# ============================================================================


def _validate_confirm_meeting(runtime: Any, message: Any) -> bool:
    """Validate if this message should trigger the CONFIRM_MEETING action."""
    text = (getattr(getattr(message, "content", None), "text", None) or "").lower()
    return (
        ("confirm" in text and "meeting" in text)
        or ("accept" in text and "meeting" in text)
        or ("decline" in text and "meeting" in text)
        or "rsvp" in text
        or "i'll be there" in text
        or "i can't make it" in text
    )


async def _handle_confirm_meeting(
    runtime: Any,
    message: Any,
    state: Any = None,
    options: Optional[dict[str, Any]] = None,
    callback: Any = None,
) -> dict[str, Any]:
    """Handle the CONFIRM_MEETING action."""
    from ..service import SchedulingService

    scheduling_service: Optional[SchedulingService] = None
    if hasattr(runtime, "get_service"):
        scheduling_service = runtime.get_service("SCHEDULING")

    if not scheduling_service:
        if callback:
            await callback({"text": "Scheduling service is not available. Please try again later."})
        return {"success": False}

    text = (getattr(getattr(message, "content", None), "text", None) or "").lower()
    is_confirming = any(
        kw in text for kw in ("confirm", "accept", "i'll be there", "yes")
    )

    entity_id = getattr(message, "entity_id", None)
    meetings = await scheduling_service.get_upcoming_meetings(entity_id)

    if not meetings:
        if callback:
            await callback({"text": "You don't have any upcoming meetings to confirm."})
        return {"success": False}

    from ..types import MeetingStatus

    pending = [m for m in meetings if m.status == MeetingStatus.PROPOSED]
    if not pending:
        if callback:
            await callback({"text": "All your upcoming meetings have already been confirmed."})
        return {"success": True}

    meeting = pending[0]

    if is_confirming:
        await scheduling_service.confirm_participant(meeting.id, entity_id)
        formatted_time = scheduling_service.format_slot(meeting.slot)
        if callback:
            await callback({
                "text": (
                    f'Great! I\'ve confirmed your attendance for "{meeting.title}" '
                    f"on {formatted_time}. You'll receive a calendar invite shortly."
                )
            })
    else:
        await scheduling_service.decline_participant(
            meeting.id, entity_id, "User declined via chat"
        )
        if callback:
            await callback({
                "text": (
                    f"I've noted that you can't make it to \"{meeting.title}\". "
                    "I'll let the other participants know and see if we can find another time."
                )
            })

    return {"success": True}


confirm_meeting_action: dict[str, Any] = {
    "name": "CONFIRM_MEETING",
    "similes": [
        "ACCEPT_MEETING",
        "CONFIRM_ATTENDANCE",
        "RSVP_YES",
        "DECLINE_MEETING",
        "CANCEL_ATTENDANCE",
    ],
    "description": "Confirm or decline attendance for a scheduled meeting",
    "validate": _validate_confirm_meeting,
    "handler": _handle_confirm_meeting,
    "examples": [
        [
            {
                "name": "{{user1}}",
                "content": {"text": "Yes, I'll be there for the meeting"},
            },
            {
                "name": "{{agentName}}",
                "content": {
                    "text": (
                        'Great! I\'ve confirmed your attendance for "Coffee Chat" '
                        "on Mon, Jan 20, 10:00 AM - 11:00 AM. "
                        "You'll receive a calendar invite shortly."
                    ),
                },
            },
        ],
        [
            {
                "name": "{{user1}}",
                "content": {"text": "I can't make the meeting, something came up"},
            },
            {
                "name": "{{agentName}}",
                "content": {
                    "text": (
                        "I've noted that you can't make it to \"Coffee Chat\". "
                        "I'll let the other participants know and see if we can find another time."
                    ),
                },
            },
        ],
    ],
}
