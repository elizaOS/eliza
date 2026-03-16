"""Plan status provider - provides current plan status and task progress."""

from __future__ import annotations

from elizaos_plugin_planning.providers.base import Provider, ProviderResult
from elizaos_plugin_planning.types import (
    PLAN_SOURCE,
    PLAN_STATUS_LABELS,
    PLUGIN_PLANS_TABLE,
    TaskStatus,
    decode_plan,
    get_plan_progress,
)


async def get_plan_status(runtime: object, message: object, _state: object) -> ProviderResult:
    try:
        get_memories = getattr(runtime, "get_memories", None)
        if not callable(get_memories):
            return ProviderResult(text="Runtime get_memories is not available")

        msg_dict = message if isinstance(message, dict) else {}
        room_id = msg_dict.get("roomId", "")

        memories = await get_memories(
            {"roomId": room_id, "tableName": PLUGIN_PLANS_TABLE, "count": 50}
        )

        plan_memories = [
            m for m in memories if m.get("content", {}).get("source") == PLAN_SOURCE
        ]

        if not plan_memories:
            return ProviderResult(text="No active plans")

        summaries = []
        plan_data = []

        for mem in plan_memories:
            plan = decode_plan(mem.get("content", {}).get("text", ""))
            if not plan:
                continue

            progress = get_plan_progress(plan)
            status_label = PLAN_STATUS_LABELS.get(plan.status, plan.status.value)
            completed = sum(1 for t in plan.tasks if t.status == TaskStatus.COMPLETED)
            in_progress = [t.title for t in plan.tasks if t.status == TaskStatus.IN_PROGRESS]

            summary = (
                f"- {plan.title} [{status_label}] {progress}% "
                f"({completed}/{len(plan.tasks)} tasks)"
            )
            if in_progress:
                summary += f"\n  In progress: {', '.join(in_progress)}"

            next_pending = next(
                (t for t in plan.tasks if t.status == TaskStatus.PENDING), None
            )
            if next_pending:
                summary += f"\n  Next: {next_pending.title}"

            summaries.append(summary)
            plan_data.append(
                {
                    "id": plan.id,
                    "title": plan.title,
                    "status": plan.status.value,
                    "progress": progress,
                    "taskCount": len(plan.tasks),
                    "completedCount": completed,
                }
            )

        if not summaries:
            return ProviderResult(text="No active plans")

        count = len(summaries)
        text = f"Active Plans ({count}):\n" + "\n".join(summaries)

        return ProviderResult(text=text, data={"plans": plan_data, "count": count})

    except Exception:
        return ProviderResult(text="Error retrieving plan status")


plan_status_provider = Provider(
    name="PLAN_STATUS",
    description="Provides current plan status and task progress for active plans",
    get=get_plan_status,
)
