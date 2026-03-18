"""
SCHEDULE_MEETING action.

Finds available slots and proposes meeting times based on user availability.
"""

from __future__ import annotations

import re
from typing import Any, Optional

from ..types import Participant, ProposedSlot, TimeSlot


# ============================================================================
# HELPERS
# ============================================================================


def parse_meeting_request(text: str) -> dict[str, Any]:
    """Parse natural language meeting request into structured data."""
    normalized = text.lower()
    result: dict[str, Any] = {}

    # Try to extract a title
    title_match = re.search(
        r"(?:schedule|book|arrange|set up|plan)\s+(?:a\s+)?(?:meeting|call|chat)\s+"
        r"(?:about|for|regarding|to discuss)\s+[\"']?([^\"'\n.]+)[\"']?",
        text,
        re.IGNORECASE,
    )
    if title_match:
        result["title"] = title_match.group(1).strip()

    # Extract duration
    duration_match = re.search(r"(\d+)\s*(?:minute|min|hour|hr)", normalized)
    if duration_match:
        duration = int(duration_match.group(1))
        if "hour" in normalized or "hr" in normalized:
            duration *= 60
        result["duration"] = duration

    # Extract urgency
    if any(w in normalized for w in ("urgent", "asap", "immediately")):
        result["urgency"] = "urgent"
    elif any(w in normalized for w in ("soon", "this week")):
        result["urgency"] = "soon"
    else:
        result["urgency"] = "flexible"

    return result


def format_proposed_slots(slots: list[ProposedSlot]) -> str:
    """Format proposed slots for display."""
    if not slots:
        return "I couldn't find any available time slots."

    from datetime import datetime

    try:
        from zoneinfo import ZoneInfo
    except ImportError:
        from backports.zoneinfo import ZoneInfo  # type: ignore[no-redef]

    formatted: list[str] = []
    for index, proposal in enumerate(slots):
        start = datetime.fromisoformat(proposal.slot.start.replace("Z", "+00:00"))
        end = datetime.fromisoformat(proposal.slot.end.replace("Z", "+00:00"))

        tz = ZoneInfo(proposal.slot.time_zone)
        start_local = start.astimezone(tz)
        end_local = end.astimezone(tz)

        date_str = start_local.strftime("%a, %b %-d at %-I:%M%p").replace("AM", "am").replace("PM", "pm")
        end_str = end_local.strftime("%-I:%M%p").replace("AM", "am").replace("PM", "pm")

        entry = f"{index + 1}. {date_str} - {end_str}"
        if proposal.reasons:
            entry += f" ({proposal.reasons[0]})"
        formatted.append(entry)

    return (
        "Here are some times that work:\n\n"
        + "\n".join(formatted)
        + "\n\nWhich option works best for you? Just say the number."
    )


# ============================================================================
# VALIDATE / HANDLER (defined before action dict so they can be referenced)
# ============================================================================


def _validate_schedule_meeting(runtime: Any, message: Any) -> bool:
    """Validate if this message should trigger the SCHEDULE_MEETING action."""
    text = (getattr(getattr(message, "content", None), "text", None) or "").lower()
    return any(
        kw in text
        for kw in ("schedule", "book", "arrange", "set up", "plan")
    ) or ("meet" in text and "nice to meet" not in text)


async def _handle_schedule_meeting(
    runtime: Any,
    message: Any,
    state: Any = None,
    options: Optional[dict[str, Any]] = None,
    callback: Any = None,
) -> dict[str, Any]:
    """Handle the SCHEDULE_MEETING action."""
    from ..service import SchedulingService

    scheduling_service: Optional[SchedulingService] = None
    if hasattr(runtime, "get_service"):
        scheduling_service = runtime.get_service("SCHEDULING")

    if not scheduling_service:
        if callback:
            await callback({"text": "Scheduling service is not available. Please try again later."})
        return {"success": False}

    entity_id = getattr(message, "entity_id", None)
    room_id = getattr(message, "room_id", None)

    if not entity_id or not room_id:
        if callback:
            await callback({"text": "I could not identify the conversation context. Please try again."})
        return {"success": False}

    text = getattr(getattr(message, "content", None), "text", "") or ""
    parsed = parse_meeting_request(text)

    user_availability = await scheduling_service.get_availability(entity_id)
    if not user_availability or not user_availability.weekly:
        if callback:
            await callback({
                "text": "I don't have your availability yet. Tell me when you're free, e.g. \"weekdays 9am-5pm\""
            })
        return {"success": False}

    participants = [Participant(entity_id=entity_id, name="You", availability=user_availability)]

    title = parsed.get("title", "Meeting")
    urgency = parsed.get("urgency", "flexible")
    duration = parsed.get("duration", 30)

    request = await scheduling_service.create_scheduling_request(
        room_id,
        title,
        participants,
        constraints={
            "preferred_duration_minutes": duration,
            "max_days_out": 3 if urgency == "urgent" else 7 if urgency == "soon" else 14,
        },
        options={"urgency": urgency},
    )

    result = await scheduling_service.find_available_slots(request)
    if not result.success or not result.proposed_slots:
        if callback:
            await callback({
                "text": result.failure_reason or "No available slots found. Try expanding your availability?"
            })
        return {"success": False}

    if callback:
        await callback({"text": format_proposed_slots(result.proposed_slots)})

    return {
        "success": True,
        "data": {
            "request_id": request.id,
            "proposed_slots": result.proposed_slots,
        },
    }


# ============================================================================
# ACTION DEFINITION
# ============================================================================


schedule_meeting_action: dict[str, Any] = {
    "name": "SCHEDULE_MEETING",
    "similes": [
        "BOOK_MEETING",
        "ARRANGE_MEETING",
        "SET_UP_MEETING",
        "PLAN_MEETING",
        "CREATE_MEETING",
    ],
    "description": "Schedule a meeting between multiple participants by finding a suitable time slot",
    "validate": _validate_schedule_meeting,
    "handler": _handle_schedule_meeting,
    "examples": [
        [
            {
                "name": "{{user1}}",
                "content": {"text": "Can you schedule a meeting for me?"},
            },
            {
                "name": "{{agentName}}",
                "content": {
                    "text": (
                        "Here are some times that work:\n\n"
                        "1. Mon, Jan 20 at 10:00am - 10:30am (Standard business hours)\n"
                        "2. Mon, Jan 20 at 2:00pm - 2:30pm (Standard business hours)\n"
                        "3. Tue, Jan 21 at 9:00am - 9:30am (Preferred time)\n\n"
                        "Which option works best for you? Just say the number."
                    ),
                },
            },
        ],
        [
            {
                "name": "{{user1}}",
                "content": {"text": "I'd like to set up a call for next week"},
            },
            {
                "name": "{{agentName}}",
                "content": {
                    "text": (
                        "Here are some times that work:\n\n"
                        "1. Mon, Jan 20 at 10:00am - 10:30am (Standard business hours)\n"
                        "2. Tue, Jan 21 at 2:00pm - 2:30pm (Preferred day)\n"
                        "3. Wed, Jan 22 at 11:00am - 11:30am (Standard business hours)\n\n"
                        "Which option works best for you? Just say the number."
                    ),
                },
            },
        ],
    ],
}
