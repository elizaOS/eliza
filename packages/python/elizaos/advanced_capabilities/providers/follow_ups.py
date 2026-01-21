from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from elizaos.types import Provider, ProviderResult

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State


async def get_follow_ups_context(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> ProviderResult:
    from elizaos.bootstrap.services.follow_up import FollowUpService

    follow_up_service = runtime.get_service("follow_up")
    if not follow_up_service or not isinstance(follow_up_service, FollowUpService):
        return ProviderResult(text="", values={}, data={})

    upcoming = await follow_up_service.get_upcoming_follow_ups(days_ahead=7, include_overdue=True)

    if not upcoming:
        return ProviderResult(
            text="No upcoming follow-ups scheduled.", values={"followUpCount": 0}, data={}
        )

    now = datetime.now(UTC)

    overdue_items: list[dict[str, str]] = []
    upcoming_items: list[dict[str, str]] = []

    entities = await asyncio.gather(*(runtime.get_entity(str(task.entity_id)) for task in upcoming))
    for task, entity in zip(upcoming, entities, strict=False):
        scheduled = datetime.fromisoformat(task.scheduled_at.replace("Z", "+00:00"))
        name = entity.name if entity and entity.name else "Unknown"

        item = {
            "entityId": str(task.entity_id),
            "name": name,
            "scheduledAt": task.scheduled_at,
            "reason": task.reason,
            "priority": task.priority,
        }

        if scheduled < now:
            days_overdue = (now - scheduled).days
            item["daysOverdue"] = str(days_overdue)
            overdue_items.append(item)
        else:
            days_until = (scheduled - now).days
            item["daysUntil"] = str(days_until)
            upcoming_items.append(item)

    text_summary = f"You have {len(upcoming)} follow-up(s) scheduled:\n"

    if overdue_items:
        text_summary += f"\nOverdue ({len(overdue_items)}):\n"
        for item in overdue_items:
            text_summary += f"- {item['name']} ({item['daysOverdue']} days overdue)"
            if item.get("reason"):
                text_summary += f" - {item['reason']}"
            text_summary += "\n"

    if upcoming_items:
        text_summary += f"\nUpcoming ({len(upcoming_items)}):\n"
        for item in upcoming_items:
            days = int(item["daysUntil"])
            if days == 0:
                time_str = "today"
            elif days == 1:
                time_str = "tomorrow"
            else:
                time_str = f"in {days} days"
            text_summary += f"- {item['name']} ({time_str})"
            if item.get("reason"):
                text_summary += f" - {item['reason']}"
            text_summary += "\n"

    suggestions = await follow_up_service.get_follow_up_suggestions()
    if suggestions:
        text_summary += "\nSuggested follow-ups:\n"
        for s in suggestions[:3]:
            text_summary += (
                f"- {s.entity_name} ({s.days_since_last_contact} days since last contact)\n"
            )

    return ProviderResult(
        text=text_summary.strip(),
        values={
            "followUpCount": len(upcoming),
            "overdueCount": len(overdue_items),
            "upcomingCount": len(upcoming_items),
            "suggestionsCount": len(suggestions),
        },
        data={
            "followUpCount": len(upcoming),
            "overdueCount": len(overdue_items),
            "upcomingCount": len(upcoming_items),
            "suggestionsCount": len(suggestions),
        },
    )


follow_ups_provider = Provider(
    name="FOLLOW_UPS",
    description="Provides information about upcoming follow-ups and reminders",
    get=get_follow_ups_context,
    dynamic=True,
)
