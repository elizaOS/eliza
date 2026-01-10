"""
Goal Evaluator - Evaluates progress toward goals and objectives.

This evaluator assesses how well the agent is progressing toward
defined goals and objectives.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.types import Evaluator, ModelType

from elizaos_plugin_bootstrap.types import EvaluatorResult
from elizaos_plugin_bootstrap.utils.xml import parse_key_value_xml

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State


GOAL_EVALUATION_TEMPLATE = """# Task: Evaluate progress toward goals.

{{providers}}

# Current Goals:
{{goals}}

# Recent Actions:
{{recentActions}}

# Instructions:
Evaluate how well the recent actions are contributing to the defined goals.
Rate progress on a scale of 0-100 and provide specific feedback.

Respond using XML format like this:
<response>
    <thought>Your analysis of goal progress</thought>
    <progress>Numeric progress score 0-100</progress>
    <feedback>Specific feedback on what's working and what isn't</feedback>
    <next_steps>Suggested next steps to make progress</next_steps>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above."""


async def evaluate_goal_progress(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> EvaluatorResult:
    """
    Evaluate progress toward goals.

    Returns:
    - Progress score (0-100)
    - Specific feedback
    - Suggested next steps
    """
    if state is None:
        return EvaluatorResult(
            score=0,
            passed=False,
            reason="No state provided for evaluation",
            details={},
        )

    try:
        # Get goals from state or world
        goals: list[str] = []
        if state.values:
            goals_data = state.values.get("goals", [])
            if isinstance(goals_data, list):
                goals = [str(g) for g in goals_data]

        if not goals:
            return EvaluatorResult(
                score=100,
                passed=True,
                reason="No goals defined",
                details={"noGoals": True},
            )

        # Get recent actions from state
        recent_actions: list[str] = []
        if state.values:
            actions_data = state.values.get("recentActions", [])
            if isinstance(actions_data, list):
                recent_actions = [str(a) for a in actions_data]

        # Format goals and actions for prompt
        goals_text = "\n".join(f"- {goal}" for goal in goals)
        actions_text = (
            "\n".join(f"- {action}" for action in recent_actions)
            if recent_actions
            else "No recent actions"
        )

        prompt = runtime.compose_prompt(
            state=state,
            template=runtime.character.templates.get(
                "goalEvaluationTemplate", GOAL_EVALUATION_TEMPLATE
            ),
        )
        prompt = prompt.replace("{{goals}}", goals_text)
        prompt = prompt.replace("{{recentActions}}", actions_text)

        response_text = await runtime.use_model(ModelType.TEXT_LARGE, prompt=prompt)
        parsed_xml = parse_key_value_xml(response_text)

        if parsed_xml is None:
            raise ValueError("Failed to parse evaluation response")

        progress_str = str(parsed_xml.get("progress", "0"))
        try:
            progress = max(0, min(100, int(progress_str)))
        except ValueError:
            progress = 0

        thought = str(parsed_xml.get("thought", ""))
        feedback = str(parsed_xml.get("feedback", ""))
        next_steps = str(parsed_xml.get("next_steps", ""))

        # Determine if evaluation passed (progress >= 50)
        passed = progress >= 50

        return EvaluatorResult(
            score=progress,
            passed=passed,
            reason=feedback,
            details={
                "thought": thought,
                "feedback": feedback,
                "nextSteps": next_steps,
                "goalCount": len(goals),
                "actionCount": len(recent_actions),
            },
        )

    except Exception as error:
        runtime.logger.error(
            {
                "src": "evaluator:goal",
                "agentId": runtime.agent_id,
                "error": str(error),
            },
            "Error evaluating goal progress",
        )
        return EvaluatorResult(
            score=0,
            passed=False,
            reason=f"Evaluation error: {str(error)}",
            details={"error": str(error)},
        )


async def validate_goal_evaluation(
    runtime: IAgentRuntime,
    message: Memory,
) -> bool:
    """Validate that goal evaluation can be performed."""
    # Goals can always be evaluated
    return True


# Create the evaluator instance
goal_evaluator = Evaluator(
    name="GOAL",
    description="Evaluates progress toward defined goals and objectives",
    validate=validate_goal_evaluation,
    handler=evaluate_goal_progress,
    examples=[],  # Examples can be added later
)

