"""UPDATE_PLAN action - update an existing plan's details."""

from __future__ import annotations

import json
import logging
import re
import time

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
    PlanStatus,
    decode_plan,
    encode_plan,
    format_plan,
)

logger = logging.getLogger(__name__)


async def validate(
    runtime: RuntimeProtocol, _message: Memory, _state: State | None = None
) -> bool:
    try:
        return runtime.get_memory_manager() is not None
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
        if not content:
            err = "Please describe what to update in the plan."
            if callback:
                await callback({"text": err, "source": content_data.get("source")})
            return {"text": err, "success": False}

        memories = await runtime.get_memories(
            {
                "roomId": message.get("roomId", ""),
                "tableName": PLUGIN_PLANS_TABLE,
                "count": 50,
            }
        )
        plan_memories = [m for m in memories if m.get("content", {}).get("source") == PLAN_SOURCE]

        if not plan_memories:
            err = "No plans found. Create a plan first with CREATE_PLAN."
            if callback:
                await callback({"text": err, "source": content_data.get("source")})
            return {"text": err, "success": False}

        # Find target plan
        target_mem = plan_memories[0]
        target_plan = decode_plan(target_mem.get("content", {}).get("text", ""))

        plan_id = str(options.get("planId", "")) if options else ""
        if plan_id:
            for mem in plan_memories:
                plan = decode_plan(mem.get("content", {}).get("text", ""))
                if plan and plan.id == plan_id:
                    target_mem = mem
                    target_plan = plan
                    break

        if not target_plan:
            err = "Could not find the plan to update."
            if callback:
                await callback({"text": err, "source": content_data.get("source")})
            return {"text": err, "success": False}

        # Apply updates
        new_title = str(options.get("title", "")) if options else ""
        new_desc = str(options.get("description", "")) if options else ""
        new_status = str(options.get("status", "")) if options else ""

        if new_title:
            target_plan.title = new_title
        if new_desc:
            target_plan.description = new_desc
        if new_status and new_status in [s.value for s in PlanStatus]:
            target_plan.status = PlanStatus(new_status)

        # Use LLM if no explicit params
        if not new_title and not new_desc and not new_status:
            prompt = (
                "Given this update request, determine what should change.\n"
                f'Request: "{content}"\n'
                f'Current title: "{target_plan.title}"\n'
                f'Current status: "{target_plan.status.value}"\n\n'
                "Return ONLY JSON with changed fields:\n"
                '{"title": "new", "description": "new", "status": "active|completed|archived"}'
            )
            response = await runtime.use_model("TEXT_LARGE", {"prompt": prompt})
            if response:
                try:
                    cleaned = re.sub(r"^```(?:json)?\n?", "", response)
                    cleaned = re.sub(r"\n?```$", "", cleaned).strip()
                    updates = json.loads(cleaned)
                    if updates.get("title"):
                        target_plan.title = updates["title"]
                    if updates.get("description"):
                        target_plan.description = updates["description"]
                    if updates.get("status") and updates["status"] in [
                        s.value for s in PlanStatus
                    ]:
                        target_plan.status = PlanStatus(updates["status"])
                except (json.JSONDecodeError, ValueError):
                    pass

        target_plan.updated_at = int(time.time() * 1000)

        # Save updated plan via runtime DB API
        mem_id = target_mem.get("id", "")
        if not mem_id:
            err = "Plan memory has no id."
            if callback:
                await callback({"text": err, "source": content_data.get("source")})
            return {"text": err, "success": False}

        await runtime.update_memory(
            {
                "id": mem_id,
                "content": {"text": encode_plan(target_plan), "source": PLAN_SOURCE},
                "createdAt": target_mem.get("createdAt", int(time.time() * 1000)),
            }
        )

        formatted = format_plan(target_plan)
        msg = f'Updated plan "{target_plan.title}".\n\n{formatted}'
        if callback:
            await callback({"text": msg, "source": content_data.get("source")})

        return {
            "text": msg,
            "success": True,
            "data": {
                "planId": target_plan.id,
                "title": target_plan.title,
                "status": target_plan.status.value,
            },
        }

    except Exception as error:
        logger.error("Failed to update plan: %s", error)
        err = f"Failed to update plan: {error}"
        if callback:
            await callback({"text": err, "source": message.get("content", {}).get("source")})
        return {"text": err, "success": False}


update_plan_action = create_action(
    name="UPDATE_PLAN",
    description="Update an existing plan's title, description, or status",
    similes=["update-plan", "modify-plan", "change-plan", "edit-plan"],
    examples=[
        [
            ActionExample(
                name="User", content={"text": "Update the launch plan to include testing"}
            ),
            ActionExample(
                name="Assistant",
                content={
                    "text": "I'll update the plan.",
                    "actions": ["UPDATE_PLAN"],
                },
            ),
        ],
    ],
    validate=validate,
    handler=handler,
)
