"""
REALM Benchmark Providers.

These providers inject task context into the agent's state,
enabling the agent to understand the planning task it needs to solve.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.types import Provider, ProviderResult

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State

# Global task context storage (set by REALMAgent before processing messages)
_current_task_context: dict[str, object] | None = None


def set_task_context(context: dict[str, object] | None) -> None:
    """Set the current task context for providers to access."""
    global _current_task_context
    _current_task_context = context


def get_task_context() -> dict[str, object] | None:
    """Get the current task context."""
    return _current_task_context


async def get_realm_task(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> ProviderResult:
    """
    Provider that injects REALM task information into the agent's context.
    
    This provides:
    - Task name, description, and category
    - Goal to accomplish
    - Available tools
    - Constraints and requirements
    """
    _ = runtime
    _ = message
    _ = state

    context = get_task_context()
    if not context:
        return ProviderResult(
            text="",
            values={},
            data={},
        )

    task_name = context.get("task_name", "Unknown")
    task_description = context.get("task_description", "")
    task_category = context.get("task_category", "unknown")
    task_goal = context.get("task_goal", "")
    available_tools = context.get("available_tools", [])
    constraints = context.get("constraints", {})
    requirements = context.get("requirements", [])
    max_steps = context.get("max_steps", 10)

    # Build text representation for the prompt
    tools_list = available_tools if isinstance(available_tools, list) else []
    tools_text = "\n".join(f"  - {tool}" for tool in tools_list)

    constraints_dict = constraints if isinstance(constraints, dict) else {}
    constraints_text = "\n".join(f"  - {k}: {v}" for k, v in constraints_dict.items())

    requirements_list = requirements if isinstance(requirements, list) else []
    requirements_text = "\n".join(f"  - {req}" for req in requirements_list)

    text = f"""# REALM Planning Task

## Task: {task_name}
**Category:** {task_category}
**Description:** {task_description}

## Goal
{task_goal}

## Available Tools
{tools_text if tools_text else "  None specified"}

## Constraints
{constraints_text if constraints_text else "  None specified"}

## Requirements
{requirements_text if requirements_text else "  None specified"}

## Limits
- Maximum steps: {max_steps}
"""

    return ProviderResult(
        text=text,
        values={
            "taskName": str(task_name),
            "taskCategory": str(task_category),
            "taskGoal": str(task_goal),
            "availableTools": ", ".join(str(t) for t in tools_list),
            "maxSteps": int(max_steps) if isinstance(max_steps, int) else 10,
        },
        data={
            "task": {
                "name": task_name,
                "description": task_description,
                "category": task_category,
                "goal": task_goal,
                "available_tools": tools_list,
                "constraints": constraints_dict,
                "requirements": requirements_list,
                "max_steps": max_steps,
            }
        },
    )


async def get_planning_state(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> ProviderResult:
    """
    Provider that injects the current planning state (executed steps, outcomes).
    
    This allows the agent to understand what has been done so far
    and adapt its plan accordingly.
    """
    _ = runtime
    _ = message
    _ = state

    context = get_task_context()
    if not context:
        return ProviderResult(text="", values={}, data={})

    executed_steps = context.get("executed_steps", [])
    current_plan = context.get("current_plan", [])
    adaptation_count = context.get("adaptation_count", 0)

    steps_list = executed_steps if isinstance(executed_steps, list) else []
    plan_list = current_plan if isinstance(current_plan, list) else []

    if not steps_list:
        text = "# Planning State\nNo steps have been executed yet."
    else:
        steps_text = ""
        for i, step in enumerate(steps_list):
            if isinstance(step, dict):
                action = step.get("action", "unknown")
                success = step.get("success", False)
                observation = step.get("observation", "")
                status = "✓" if success else "✗"
                steps_text += f"  {i + 1}. [{status}] {action}: {observation}\n"
            else:
                steps_text += f"  {i + 1}. {step}\n"

        text = f"""# Planning State

## Executed Steps ({len(steps_list)} completed)
{steps_text}

## Remaining Plan
{len(plan_list) - len(steps_list)} steps remaining

## Adaptations Made
{adaptation_count} plan adaptations have been made
"""

    return ProviderResult(
        text=text,
        values={
            "executedSteps": len(steps_list),
            "remainingSteps": max(0, len(plan_list) - len(steps_list)),
            "adaptationCount": int(adaptation_count) if isinstance(adaptation_count, int) else 0,
        },
        data={
            "planning_state": {
                "executed_steps": steps_list,
                "current_plan": plan_list,
                "adaptation_count": adaptation_count,
            }
        },
    )


# Define providers
realm_task_provider = Provider(
    name="REALM_TASK",
    description="Provides REALM benchmark task information including goal, tools, and constraints",
    get=get_realm_task,
    position=10,  # Load early to set context
)

planning_state_provider = Provider(
    name="PLANNING_STATE",
    description="Provides current planning execution state including completed steps",
    get=get_planning_state,
    position=11,  # Load after task context
)

REALM_PROVIDERS = [realm_task_provider, planning_state_provider]
