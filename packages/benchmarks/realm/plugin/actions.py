"""
REALM Benchmark Actions.

These actions enable the agent to generate and execute plans
for REALM benchmark tasks using the full ElizaOS action system.
"""

from __future__ import annotations

import json
import re
from typing import TYPE_CHECKING

from elizaos.types import (
    Action,
    ActionExample,
    ActionParameter,
    ActionParameterSchema,
    ActionResult,
    Content,
    ModelType,
)

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State

from .providers import get_task_context, set_task_context


# ============================================================================
# GENERATE_PLAN Action
# ============================================================================


async def validate_generate_plan(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> bool:
    """Validate that a planning task is available."""
    _ = runtime
    _ = message
    _ = state
    context = get_task_context()
    return context is not None and "task_goal" in context


async def handle_generate_plan(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
    options: HandlerOptions | None = None,
    callback: HandlerCallback | None = None,
    responses: list[Memory] | None = None,
) -> ActionResult:
    """
    Generate a plan for the current REALM task.
    
    This action uses the LLM to generate a sequence of steps
    using the available tools to accomplish the task goal.
    """
    _ = options
    _ = responses

    context = get_task_context()
    if not context:
        return ActionResult(
            text="No task context available for planning",
            success=False,
            error="Missing task context",
        )

    # Compose state with task context
    state = await runtime.compose_state(
        message,
        ["REALM_TASK", "PLANNING_STATE", "CHARACTER"],
    )

    # Get task details from context
    task_goal = context.get("task_goal", "")
    available_tools = context.get("available_tools", [])
    max_steps = context.get("max_steps", 10)

    tools_list = available_tools if isinstance(available_tools, list) else []
    tools_desc = "\n".join(f"- {tool}" for tool in tools_list)

    # Build planning prompt
    prompt = f"""You are solving a REALM benchmark planning task.

{state.text if state and state.text else ""}

Generate a step-by-step plan using ONLY the available tools.
Each step should accomplish part of the goal.

GOAL: {task_goal}

AVAILABLE TOOLS:
{tools_desc}

INSTRUCTIONS:
1. Analyze the goal carefully
2. Break it down into actionable steps
3. Each step MUST use one of the available tools
4. Order steps logically (dependencies first)
5. Keep the plan concise (max {max_steps} steps)

Respond with ONLY a JSON array of planned steps:
[
  {{"action": "tool_name", "description": "what this step accomplishes", "parameters": {{}}}},
  {{"action": "tool_name2", "description": "next step", "parameters": {{}}}}
]

JSON ONLY - no markdown, no explanation:"""

    try:
        response = await runtime.use_model(
            ModelType.TEXT_LARGE,
            {
                "prompt": prompt,
                "system": "You are a planning AI. Return ONLY valid JSON arrays. No markdown, no code fences, no explanation.",
                "temperature": 0.3,
                "maxTokens": 512,
            },
        )

        response_text = str(response).strip()
        plan = _parse_plan_json(response_text, tools_list)

        if not plan:
            return ActionResult(
                text="Failed to generate a valid plan",
                success=False,
                error="Plan parsing failed",
                data={"raw_response": response_text[:500]},
            )

        # Store plan in context for execution
        context["current_plan"] = plan
        context["executed_steps"] = []
        set_task_context(context)

        plan_text = "\n".join(
            f"  {i + 1}. {step.get('action', 'unknown')}: {step.get('description', '')}"
            for i, step in enumerate(plan)
        )

        result_text = f"Generated plan with {len(plan)} steps:\n{plan_text}"

        if callback:
            await callback(Content(text=result_text, actions=["GENERATE_PLAN"]))

        return ActionResult(
            text=result_text,
            success=True,
            values={
                "planGenerated": True,
                "planSteps": len(plan),
            },
            data={
                "actionName": "GENERATE_PLAN",
                "plan": plan,
                "step_count": len(plan),
            },
        )

    except Exception as e:
        return ActionResult(
            text=f"Plan generation failed: {str(e)}",
            success=False,
            error=str(e),
        )


def _parse_plan_json(response: str, available_tools: list[str]) -> list[dict[str, object]]:
    """Parse JSON plan from LLM response."""
    if not response.strip():
        return []

    # Try to find JSON array in response
    json_patterns = [
        r"```json\s*(.*?)```",
        r"```\s*(.*?)```",
        r"\[\s*\{.*?\}\s*\]",
    ]

    json_text: str | None = None
    for pattern in json_patterns:
        match = re.search(pattern, response, re.DOTALL)
        if match:
            json_text = match.group(1) if "```" in pattern else match.group(0)
            break

    if not json_text:
        # Try the whole response
        json_text = response

    # Clean up JSON
    json_text = json_text.strip()
    if not json_text.startswith("["):
        start = json_text.find("[")
        end = json_text.rfind("]")
        if start != -1 and end != -1:
            json_text = json_text[start : end + 1]

    # Remove trailing commas
    json_text = re.sub(r",\s*([\]}])", r"\1", json_text)

    try:
        parsed = json.loads(json_text)
    except json.JSONDecodeError:
        return []

    # Handle wrapped responses like {"actions": [...]}
    if isinstance(parsed, dict):
        parsed = parsed.get("actions") or parsed.get("plan") or parsed.get("steps")

    if not isinstance(parsed, list):
        return []

    # Validate and normalize plan steps
    plan: list[dict[str, object]] = []
    for item in parsed:
        if not isinstance(item, dict):
            continue

        action_name = item.get("action") or item.get("tool") or item.get("name")
        if not action_name or not isinstance(action_name, str):
            continue

        # Verify action is in available tools
        if action_name not in available_tools:
            continue

        plan.append({
            "action": action_name,
            "description": str(item.get("description", "")),
            "parameters": item.get("parameters", {}),
        })

    return plan


generate_plan_action = Action(
    name="GENERATE_PLAN",
    description=(
        "Generate a step-by-step plan to accomplish a REALM benchmark task. "
        "Analyzes the goal and available tools to create an executable plan."
    ),
    similes=["PLAN", "CREATE_PLAN", "MAKE_PLAN", "PLANNING"],
    validate=validate_generate_plan,
    handler=handle_generate_plan,
    examples=[
        [
            ActionExample(
                name="{{user1}}",
                content=Content(text="Plan how to book a flight and hotel for a trip to Paris"),
            ),
            ActionExample(
                name="{{agent}}",
                content=Content(
                    text="I'll create a plan using the available tools...",
                    actions=["GENERATE_PLAN"],
                ),
            ),
        ],
    ],
)


# ============================================================================
# EXECUTE_STEP Action
# ============================================================================


async def validate_execute_step(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> bool:
    """Validate that there's a plan with remaining steps."""
    _ = runtime
    _ = message
    _ = state
    context = get_task_context()
    if not context:
        return False

    current_plan = context.get("current_plan", [])
    executed_steps = context.get("executed_steps", [])

    if not isinstance(current_plan, list) or not isinstance(executed_steps, list):
        return False

    return len(executed_steps) < len(current_plan)


async def handle_execute_step(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
    options: HandlerOptions | None = None,
    callback: HandlerCallback | None = None,
    responses: list[Memory] | None = None,
) -> ActionResult:
    """
    Execute the next step in the current plan.
    
    This action simulates executing the next planned step
    and records the result.
    """
    _ = options
    _ = responses

    context = get_task_context()
    if not context:
        return ActionResult(
            text="No task context available",
            success=False,
            error="Missing task context",
        )

    current_plan = context.get("current_plan", [])
    executed_steps = context.get("executed_steps", [])

    if not isinstance(current_plan, list):
        current_plan = []
    if not isinstance(executed_steps, list):
        executed_steps = []

    step_index = len(executed_steps)
    if step_index >= len(current_plan):
        return ActionResult(
            text="All plan steps have been executed",
            success=True,
            values={"planComplete": True},
            data={"actionName": "EXECUTE_STEP", "complete": True},
        )

    step = current_plan[step_index]
    if not isinstance(step, dict):
        return ActionResult(
            text="Invalid step format",
            success=False,
            error="Step is not a dictionary",
        )

    action_name = step.get("action", "unknown")
    description = step.get("description", "")

    # Simulate step execution with deterministic outcome
    # In a real implementation, this would call actual tools
    import hashlib

    task_id = context.get("task_id", "unknown")
    seed_material = f"{task_id}:{action_name}:{step_index}".encode("utf-8")
    digest = hashlib.sha256(seed_material).digest()
    value = int.from_bytes(digest[:8], byteorder="big", signed=False)
    success_rate = 0.80  # 80% success rate for simulation
    step_success = (value / 2**64) < success_rate

    observation = (
        f"Successfully executed {action_name}: {description}"
        if step_success
        else f"Failed to execute {action_name}"
    )

    # Record executed step
    executed_step = {
        "action": action_name,
        "description": description,
        "success": step_success,
        "observation": observation,
        "step_number": step_index + 1,
    }
    executed_steps.append(executed_step)

    # Update context
    context["executed_steps"] = executed_steps
    set_task_context(context)

    result_text = f"Step {step_index + 1}/{len(current_plan)}: {observation}"

    if callback:
        await callback(Content(text=result_text, actions=["EXECUTE_STEP"]))

    return ActionResult(
        text=result_text,
        success=step_success,
        values={
            "stepExecuted": step_index + 1,
            "totalSteps": len(current_plan),
            "stepSuccess": step_success,
        },
        data={
            "actionName": "EXECUTE_STEP",
            "step": executed_step,
            "remaining": len(current_plan) - len(executed_steps),
        },
    )


execute_step_action = Action(
    name="EXECUTE_STEP",
    description=(
        "Execute the next step in the current plan. "
        "Runs the planned action and records the outcome."
    ),
    similes=["RUN_STEP", "DO_STEP", "NEXT_STEP", "EXECUTE"],
    validate=validate_execute_step,
    handler=handle_execute_step,
    examples=[
        [
            ActionExample(
                name="{{user1}}",
                content=Content(text="Execute the next step in the plan"),
            ),
            ActionExample(
                name="{{agent}}",
                content=Content(
                    text="Executing step 1: Search for flights...",
                    actions=["EXECUTE_STEP"],
                ),
            ),
        ],
    ],
)


# ============================================================================
# ADAPT_PLAN Action
# ============================================================================


async def validate_adapt_plan(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> bool:
    """Validate that there's a plan that can be adapted."""
    _ = runtime
    _ = message
    _ = state
    context = get_task_context()
    if not context:
        return False

    current_plan = context.get("current_plan", [])
    return isinstance(current_plan, list) and len(current_plan) > 0


async def handle_adapt_plan(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
    options: HandlerOptions | None = None,
    callback: HandlerCallback | None = None,
    responses: list[Memory] | None = None,
) -> ActionResult:
    """
    Adapt the current plan based on execution results.
    
    This action modifies the plan when steps fail or
    when the situation requires a different approach.
    """
    _ = options
    _ = responses

    context = get_task_context()
    if not context:
        return ActionResult(
            text="No task context available",
            success=False,
            error="Missing task context",
        )

    current_plan = context.get("current_plan", [])
    executed_steps = context.get("executed_steps", [])
    adaptation_count = context.get("adaptation_count", 0)
    available_tools = context.get("available_tools", [])

    if not isinstance(current_plan, list):
        current_plan = []
    if not isinstance(executed_steps, list):
        executed_steps = []
    if not isinstance(adaptation_count, int):
        adaptation_count = 0
    if not isinstance(available_tools, list):
        available_tools = []

    # Find failed steps
    failed_steps = [s for s in executed_steps if isinstance(s, dict) and not s.get("success", True)]

    if not failed_steps:
        return ActionResult(
            text="No failed steps to adapt to",
            success=True,
            data={"actionName": "ADAPT_PLAN", "adapted": False},
        )

    # Compose state with execution history
    state = await runtime.compose_state(
        message,
        ["REALM_TASK", "PLANNING_STATE", "CHARACTER"],
    )

    # Build adaptation prompt
    last_failure = failed_steps[-1]
    failed_action = last_failure.get("action", "unknown") if isinstance(last_failure, dict) else "unknown"
    remaining_plan = current_plan[len(executed_steps):]

    tools_desc = "\n".join(f"- {tool}" for tool in available_tools)

    prompt = f"""The plan encountered a failure and needs adaptation.

{state.text if state and state.text else ""}

FAILED STEP: {failed_action}
REASON: {last_failure.get('observation', 'Unknown') if isinstance(last_failure, dict) else 'Unknown'}

REMAINING PLAN STEPS:
{json.dumps(remaining_plan, indent=2)}

AVAILABLE TOOLS:
{tools_desc}

Generate an adapted plan to recover from this failure.
Return ONLY a JSON array of the remaining steps needed.

JSON ONLY - no markdown, no explanation:"""

    try:
        response = await runtime.use_model(
            ModelType.TEXT_LARGE,
            {
                "prompt": prompt,
                "system": "You are a planning AI. Return ONLY valid JSON arrays. No markdown, no code fences.",
                "temperature": 0.4,
                "maxTokens": 384,
            },
        )

        response_text = str(response).strip()
        adapted_plan = _parse_plan_json(response_text, available_tools)

        if adapted_plan:
            # Rebuild full plan with executed steps + adapted remaining
            new_plan = []
            for step in executed_steps:
                if isinstance(step, dict):
                    new_plan.append({
                        "action": step.get("action", "unknown"),
                        "description": step.get("description", ""),
                        "parameters": step.get("parameters", {}),
                    })
            new_plan.extend(adapted_plan)

            context["current_plan"] = new_plan
            context["adaptation_count"] = adaptation_count + 1
            set_task_context(context)

            result_text = f"Plan adapted. Added {len(adapted_plan)} new steps to replace remaining plan."
        else:
            result_text = "Could not generate adapted plan, continuing with original"
            context["adaptation_count"] = adaptation_count + 1
            set_task_context(context)

        if callback:
            await callback(Content(text=result_text, actions=["ADAPT_PLAN"]))

        return ActionResult(
            text=result_text,
            success=True,
            values={
                "planAdapted": bool(adapted_plan),
                "adaptationCount": adaptation_count + 1,
            },
            data={
                "actionName": "ADAPT_PLAN",
                "adapted_steps": adapted_plan,
                "adaptation_count": adaptation_count + 1,
            },
        )

    except Exception as e:
        return ActionResult(
            text=f"Plan adaptation failed: {str(e)}",
            success=False,
            error=str(e),
        )


adapt_plan_action = Action(
    name="ADAPT_PLAN",
    description=(
        "Adapt the current plan based on execution failures or new information. "
        "Modifies remaining steps to recover from issues."
    ),
    similes=["MODIFY_PLAN", "CHANGE_PLAN", "REPLAN", "ADJUST_PLAN"],
    validate=validate_adapt_plan,
    handler=handle_adapt_plan,
    examples=[
        [
            ActionExample(
                name="{{user1}}",
                content=Content(text="The flight booking failed, please adapt the plan"),
            ),
            ActionExample(
                name="{{agent}}",
                content=Content(
                    text="I'll adapt the plan to handle the booking failure...",
                    actions=["ADAPT_PLAN"],
                ),
            ),
        ],
    ],
)


# ============================================================================
# COMPLETE_TASK Action
# ============================================================================


async def validate_complete_task(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> bool:
    """Validate that there's a task that can be completed."""
    _ = runtime
    _ = message
    _ = state
    context = get_task_context()
    return context is not None


async def handle_complete_task(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
    options: HandlerOptions | None = None,
    callback: HandlerCallback | None = None,
    responses: list[Memory] | None = None,
) -> ActionResult:
    """
    Mark the current task as complete and summarize results.
    
    This action finalizes the planning task and produces
    a summary of what was accomplished.
    """
    _ = runtime
    _ = options
    _ = responses

    context = get_task_context()
    if not context:
        return ActionResult(
            text="No task context available",
            success=False,
            error="Missing task context",
        )

    executed_steps = context.get("executed_steps", [])
    current_plan = context.get("current_plan", [])
    task_name = context.get("task_name", "Unknown")
    task_goal = context.get("task_goal", "")

    if not isinstance(executed_steps, list):
        executed_steps = []
    if not isinstance(current_plan, list):
        current_plan = []

    successful_steps = sum(
        1 for s in executed_steps
        if isinstance(s, dict) and s.get("success", False)
    )
    total_steps = len(executed_steps)
    success_rate = successful_steps / total_steps if total_steps > 0 else 0.0

    # Determine overall success
    plan_complete = len(executed_steps) >= len(current_plan)
    overall_success = success_rate >= 0.7 and plan_complete

    summary = f"""# Task Completion Summary

## Task: {task_name}
**Goal:** {task_goal}

## Results
- Steps executed: {total_steps}
- Successful: {successful_steps}
- Success rate: {success_rate:.1%}
- Plan complete: {"Yes" if plan_complete else "No"}
- Overall status: {"SUCCESS" if overall_success else "PARTIAL/FAILED"}

## Execution Details
"""

    for i, step in enumerate(executed_steps):
        if isinstance(step, dict):
            status = "✓" if step.get("success", False) else "✗"
            action = step.get("action", "unknown")
            obs = step.get("observation", "")
            summary += f"{i + 1}. [{status}] {action}: {obs}\n"

    if callback:
        await callback(Content(text=summary, actions=["COMPLETE_TASK"]))

    return ActionResult(
        text=summary,
        success=overall_success,
        values={
            "taskComplete": True,
            "overallSuccess": overall_success,
            "successRate": success_rate,
            "stepsExecuted": total_steps,
        },
        data={
            "actionName": "COMPLETE_TASK",
            "summary": {
                "task_name": task_name,
                "task_goal": task_goal,
                "total_steps": total_steps,
                "successful_steps": successful_steps,
                "success_rate": success_rate,
                "overall_success": overall_success,
            },
            "executed_steps": executed_steps,
        },
    )


complete_task_action = Action(
    name="COMPLETE_TASK",
    description=(
        "Mark the current planning task as complete and generate a summary. "
        "Evaluates overall success based on step outcomes."
    ),
    similes=["FINISH_TASK", "END_TASK", "TASK_DONE", "SUMMARIZE"],
    validate=validate_complete_task,
    handler=handle_complete_task,
    examples=[
        [
            ActionExample(
                name="{{user1}}",
                content=Content(text="The plan has been executed, please summarize"),
            ),
            ActionExample(
                name="{{agent}}",
                content=Content(
                    text="Here's the task completion summary...",
                    actions=["COMPLETE_TASK"],
                ),
            ),
        ],
    ],
)


# Export all actions
REALM_ACTIONS = [
    generate_plan_action,
    execute_step_action,
    adapt_plan_action,
    complete_task_action,
]
