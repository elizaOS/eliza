"""COMPLETE_TASK action - mark a task within a plan as completed."""

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
    PLUGIN_PLANS_TABLE,
    PlanStatus,
    TaskStatus,
    decode_plan,
    encode_plan,
    format_plan,
    get_plan_progress,
)

logger = logging.getLogger(__name__)


async def validate(
    runtime: RuntimeProtocol, _message: Memory, _state: State | None = None
) -> bool:
    try:
        return callable(getattr(runtime, "get_memories", None)) and callable(
            getattr(runtime, "update_memory", None)
        )
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
            err = "Please specify which task to complete."
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
            err = "No plans found. Create a plan first."
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
            err = "Could not find the plan."
            if callback:
                await callback({"text": err, "source": content_data.get("source")})
            return {"text": err, "success": False}

        # Find the task
        task_index = -1
        task_id = str(options.get("taskId", "")) if options else ""
        task_title = str(options.get("taskTitle", "")) if options else ""

        if task_id:
            for i, t in enumerate(target_plan.tasks):
                if t.id == task_id:
                    task_index = i
                    break
        elif task_title:
            for i, t in enumerate(target_plan.tasks):
                if t.title.lower() == task_title.lower():
                    task_index = i
                    break
        else:
            # Use LLM to identify task
            descriptions = [f'{i}: "{t.title}" ({t.status.value})' for i, t in enumerate(target_plan.tasks)]
            prompt = (
                f"Which task should be marked as completed?\n"
                f'Request: "{content}"\n\n'
                f'Tasks in plan "{target_plan.title}":\n'
                + "\n".join(descriptions)
                + '\n\nReturn ONLY: {"index": <number or -1>}'
            )
            response = await runtime.use_model("TEXT_LARGE", {"prompt": prompt})
            if response:
                try:
                    cleaned = re.sub(r"^```(?:json)?\n?", "", response)
                    cleaned = re.sub(r"\n?```$", "", cleaned).strip()
                    match = json.loads(cleaned)
                    task_index = int(match.get("index", -1))
                except (json.JSONDecodeError, ValueError):
                    task_index = -1

        if task_index < 0 or task_index >= len(target_plan.tasks):
            err = "Could not identify which task to complete. Please be more specific."
            if callback:
                await callback({"text": err, "source": content_data.get("source")})
            return {"text": err, "success": False}

        task = target_plan.tasks[task_index]
        if task.status == TaskStatus.COMPLETED:
            msg = f'Task "{task.title}" is already completed.'
            if callback:
                await callback({"text": msg, "source": content_data.get("source")})
            return {"text": msg, "success": True}

        # Mark as completed
        now = int(time.time() * 1000)
        task.status = TaskStatus.COMPLETED
        task.completed_at = now
        target_plan.updated_at = now

        progress = get_plan_progress(target_plan)
        if progress == 100:
            target_plan.status = PlanStatus.COMPLETED

        # Save via runtime DB API
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
                "createdAt": target_mem.get("createdAt", now),
            }
        )

        formatted = format_plan(target_plan)
        note = " All tasks completed - plan is now finished!" if progress == 100 else ""
        msg = f'Completed task "{task.title}" ({progress}% done).{note}\n\n{formatted}'

        if callback:
            await callback({"text": msg, "source": content_data.get("source")})

        return {
            "text": msg,
            "success": True,
            "data": {
                "planId": target_plan.id,
                "taskId": task.id,
                "taskTitle": task.title,
                "progress": progress,
                "planCompleted": progress == 100,
            },
        }

    except Exception as error:
        logger.error("Failed to complete task: %s", error)
        err = f"Failed to complete task: {error}"
        if callback:
            await callback({"text": err, "source": message.get("content", {}).get("source")})
        return {"text": err, "success": False}


complete_task_action = create_action(
    name="COMPLETE_TASK",
    description="Mark a specific task within a plan as completed",
    similes=["complete-task", "finish-task", "done-task", "mark-done", "task-done"],
    examples=[
        [
            ActionExample(name="User", content={"text": "Mark the database setup as done"}),
            ActionExample(
                name="Assistant",
                content={
                    "text": "I'll mark that task as completed.",
                    "actions": ["COMPLETE_TASK"],
                },
            ),
        ],
    ],
    validate=validate,
    handler=handler,
)
