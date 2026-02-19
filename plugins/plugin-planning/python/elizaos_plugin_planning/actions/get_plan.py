"""GET_PLAN action - retrieve and display plan status."""

from __future__ import annotations

import json
import logging
import re

from elizaos_plugin_planning.actions.base import (
    ActionExample,
    ActionResult,
    HandlerCallback,
    Memory,
    RuntimeProtocol,
    State,
    create_action,
)
from elizaos_plugin_planning.types import (
    PLAN_SOURCE,
    PLUGIN_PLANS_TABLE,
    TaskStatus,
    decode_plan,
    format_plan,
    get_plan_progress,
)

logger = logging.getLogger(__name__)


async def validate(
    runtime: RuntimeProtocol, _message: Memory, _state: State | None = None
) -> bool:
    try:
        return callable(getattr(runtime, "get_memories", None))
    except Exception:
        return False


async def handler(
    runtime: RuntimeProtocol,
    message: Memory,
    _state: State | None = None,
    options: dict[str, str | list[str] | int | None] | None = None,
    callback: HandlerCallback | None = None,
) -> ActionResult:
    try:
        content_data = message.get("content", {})
        content = content_data.get("text", "")

        memories = await runtime.get_memories(
            {
                "roomId": message.get("roomId", ""),
                "tableName": PLUGIN_PLANS_TABLE,
                "count": 50,
            }
        )
        plan_memories = [m for m in memories if m.get("content", {}).get("source") == PLAN_SOURCE]

        if not plan_memories:
            msg = "No plans found. Create one with CREATE_PLAN."
            if callback:
                await callback({"text": msg, "source": content_data.get("source")})
            return {"text": msg, "success": True, "data": {"plans": [], "count": 0}}

        # Check for specific plan by ID or title
        plan_id = str(options.get("planId", "")) if options else ""
        plan_title = str(options.get("title", "")) if options else ""

        if plan_id or plan_title:
            for mem in plan_memories:
                plan = decode_plan(mem.get("content", {}).get("text", ""))
                if not plan:
                    continue
                if (plan_id and plan.id == plan_id) or (
                    plan_title and plan_title.lower() in plan.title.lower()
                ):
                    formatted = format_plan(plan)
                    if callback:
                        await callback({"text": formatted, "source": content_data.get("source")})
                    return {
                        "text": formatted,
                        "success": True,
                        "data": {
                            "planId": plan.id,
                            "title": plan.title,
                            "status": plan.status.value,
                            "progress": get_plan_progress(plan),
                            "taskCount": len(plan.tasks),
                        },
                    }

        # Show all plans summary
        summaries = []
        for mem in plan_memories:
            plan = decode_plan(mem.get("content", {}).get("text", ""))
            if not plan:
                continue
            progress = get_plan_progress(plan)
            completed = sum(1 for t in plan.tasks if t.status == TaskStatus.COMPLETED)
            summaries.append(
                f"- {plan.title} [{plan.status.value}] "
                f"{completed}/{len(plan.tasks)} tasks ({progress}%)"
            )

        count = len(summaries)
        text = f"Plans ({count}):\n" + "\n".join(summaries)

        if callback:
            await callback({"text": text, "source": content_data.get("source")})

        return {"text": text, "success": True, "data": {"count": count}}

    except Exception as error:
        logger.error("Failed to get plan: %s", error)
        err = f"Failed to get plan: {error}"
        if callback:
            await callback({"text": err, "source": message.get("content", {}).get("source")})
        return {"text": err, "success": False}


get_plan_action = create_action(
    name="GET_PLAN",
    description="Retrieve and display the current status of a plan",
    similes=["get-plan", "show-plan", "view-plan", "plan-status", "check-plan"],
    examples=[
        [
            ActionExample(name="User", content={"text": "Show me the website launch plan"}),
            ActionExample(
                name="Assistant",
                content={
                    "text": "Here's the current status of the plan.",
                    "actions": ["GET_PLAN"],
                },
            ),
        ],
    ],
    validate=validate,
    handler=handler,
)
