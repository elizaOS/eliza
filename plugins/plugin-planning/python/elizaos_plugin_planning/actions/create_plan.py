"""CREATE_PLAN action - create a new plan with tasks."""

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
    Plan,
    PlanStatus,
    Task,
    TaskStatus,
    encode_plan,
    format_plan,
    generate_plan_id,
    generate_task_id,
)

logger = logging.getLogger(__name__)


async def validate(
    runtime: RuntimeProtocol, _message: Memory, _state: State | None = None
) -> bool:
    try:
        return callable(getattr(runtime, "create_memory", None))
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
            err = "Please describe what you want to plan."
            if callback:
                await callback({"text": err, "source": content_data.get("source")})
            return {"text": err, "success": False}

        title = str(options.get("title", "")) if options else ""
        description = str(options.get("description", "")) if options else ""
        task_defs: list[dict[str, str | list[str]]] = (
            list(options.get("tasks", []))  # type: ignore[arg-type]
            if options and options.get("tasks")
            else []
        )

        # Use LLM to generate plan if not explicit
        if not title or not task_defs:
            prompt = (
                "Create a structured plan from this request. "
                "Return ONLY a JSON object (no markdown):\n"
                '{"title": "Plan title", "description": "Plan goal", '
                '"tasks": [{"title": "Task 1", "description": "What to do"}]}\n\n'
                f'User request: "{content}"'
            )
            response = await runtime.use_model("TEXT_LARGE", {"prompt": prompt})
            if response:
                try:
                    cleaned = re.sub(r"^```(?:json)?\n?", "", response)
                    cleaned = re.sub(r"\n?```$", "", cleaned).strip()
                    parsed = json.loads(cleaned)
                    title = title or parsed.get("title", content[:80])
                    description = description or parsed.get("description", content)
                    if not task_defs and isinstance(parsed.get("tasks"), list):
                        task_defs = parsed["tasks"]
                except (json.JSONDecodeError, ValueError) as e:
                    logger.warning("Failed to parse plan: %s", e)
                    title = title or (content[:77] + "..." if len(content) > 80 else content)
                    description = description or content

        if not title:
            title = content[:77] + "..." if len(content) > 80 else content

        now = int(time.time() * 1000)
        tasks = [
            Task(
                id=generate_task_id(i),
                title=str(td.get("title", f"Task {i + 1}") if isinstance(td, dict) else str(td)),
                description=str(td.get("description", "") if isinstance(td, dict) else ""),
                status=TaskStatus.PENDING,
                order=i + 1,
                dependencies=(
                    list(td.get("dependencies", []))
                    if isinstance(td, dict) and td.get("dependencies")
                    else []
                ),
                assignee=None,
                created_at=now,
                completed_at=None,
            )
            for i, td in enumerate(task_defs)
        ]

        plan = Plan(
            id=generate_plan_id(),
            title=title,
            description=description,
            status=PlanStatus.ACTIVE,
            tasks=tasks,
            created_at=now,
            updated_at=now,
            metadata={},
        )

        encoded = encode_plan(plan)
        entity_id = message.get("entityId") or message.get("userId", "")
        entry: Memory = {
            "agentId": runtime.agent_id,
            "roomId": message.get("roomId", ""),
            "userId": entity_id,
            "content": {"text": encoded, "source": PLAN_SOURCE},
            "createdAt": now,
        }

        await runtime.create_memory(entry, PLUGIN_PLANS_TABLE, True)

        formatted = format_plan(plan)
        task_count = len(tasks)
        suffix = "" if task_count == 1 else "s"
        success_msg = f'Created plan "{plan.title}" with {task_count} task{suffix}.\n\n{formatted}'

        if callback:
            await callback({"text": success_msg, "source": content_data.get("source")})

        return {
            "text": success_msg,
            "success": True,
            "data": {"planId": plan.id, "title": plan.title, "taskCount": task_count},
        }

    except Exception as error:
        logger.error("Failed to create plan: %s", error)
        err = f"Failed to create plan: {error}"
        if callback:
            await callback({"text": err, "source": message.get("content", {}).get("source")})
        return {"text": err, "success": False}


create_plan_action = create_action(
    name="CREATE_PLAN",
    description="Create a new plan with tasks to accomplish a goal",
    similes=["create-plan", "new-plan", "make-plan", "plan-this", "organize-tasks"],
    examples=[
        [
            ActionExample(name="User", content={"text": "Create a plan for launching the website"}),
            ActionExample(
                name="Assistant",
                content={
                    "text": "I'll create a launch plan with key tasks.",
                    "actions": ["CREATE_PLAN"],
                },
            ),
        ],
    ],
    validate=validate,
    handler=handler,
)
