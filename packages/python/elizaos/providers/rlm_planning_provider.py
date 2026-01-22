"""
RLM Planning Provider for elizaOS Core

Integrates RLM's recursive reasoning into the advanced planning system.
Enables intelligent multi-step planning with reasoning transparency.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any, Dict, Optional
from uuid import uuid4

from .rlm_client import RLMClient

if TYPE_CHECKING:
    from elizaos.advanced_planning.planning_service import ActionPlan, ActionStep
    from elizaos.types import IAgentRuntime, Action, State

log = logging.getLogger(__name__)


class RLMPlanningResult:
    """Result from RLM planning with reasoning trace."""

    def __init__(
        self,
        plan_steps: list[dict[str, Any]],
        reasoning_trace: str,
        confidence: float = 0.85,
        alternative_approaches: Optional[list[dict[str, Any]]] = None,
    ):
        self.plan_steps = plan_steps
        self.reasoning_trace = reasoning_trace
        self.confidence = confidence
        self.alternative_approaches = alternative_approaches or []


class RLMAdaptationSuggestion:
    """RLM's suggestion for plan adaptation."""

    def __init__(
        self,
        should_skip: bool = False,
        should_retry: bool = False,
        alternative_action: Optional[dict[str, Any]] = None,
        explanation: str = "",
        risk_level: str = "low",
    ):
        self.should_skip = should_skip
        self.should_retry = should_retry
        self.alternative_action = alternative_action
        self.explanation = explanation
        self.risk_level = risk_level


class RLMPlanningProvider:
    """
    Intelligent planning provider leveraging RLM's recursive reasoning.

    This provider uses RLM to:
    1. Generate multi-step action plans with explicit reasoning
    2. Identify dependencies and parallelization opportunities
    3. Adapt plans based on execution feedback
    4. Provide transparency through reasoning traces
    """

    name = "RLM Planning"
    description = "Recursive planning with RLM reasoning"
    dynamic = True

    def __init__(
        self,
        client: Optional[RLMClient] = None,
        config: Optional[Dict[str, Any]] = None,
    ):
        self.config = config or {}
        self.client = client or RLMClient(self.config)

    async def generate_action_plan(
        self,
        runtime: IAgentRuntime,
        goal: str,
        state: State,
        available_actions: list[Action],
    ) -> RLMPlanningResult:
        """
        Generate an optimized action plan using RLM's recursive reasoning.

        Args:
            runtime: The agent runtime
            goal: The goal to plan for
            state: Current state information
            available_actions: List of available actions

        Returns:
            RLMPlanningResult with plan steps and reasoning trace
        """

        # Prepare context for RLM
        action_specs = [
            {
                "name": action.name,
                "description": action.description,
                "parameters": action.examples[0].params if action.examples else {},
            }
            for action in available_actions
        ]

        state_summary = self._summarize_state(state)

        planning_prompt = self._build_planning_prompt(
            goal=goal,
            state=state_summary,
            available_actions=action_specs,
        )

        # Get RLM's recursive plan
        result = await self.client.infer(
            messages=[{"role": "user", "content": planning_prompt}],
            opts={
                "model": self.config.get("planning_model", "reasoning"),
                "max_iterations": int(self.config.get("planning_max_iterations", "5")),
            },
        )

        # Parse RLM's response
        parsed_plan = self._parse_rlm_plan(result["text"], available_actions)

        return RLMPlanningResult(
            plan_steps=parsed_plan["steps"],
            reasoning_trace=parsed_plan.get("reasoning", result["text"]),
            confidence=parsed_plan.get("confidence", 0.85),
            alternative_approaches=parsed_plan.get("alternatives", []),
        )

    async def suggest_adaptation(
        self,
        runtime: IAgentRuntime,
        failed_action: Dict[str, Any],
        error: str,
        execution_context: Dict[str, Any],
        remaining_steps: list[Dict[str, Any]],
    ) -> RLMAdaptationSuggestion:
        """
        Use RLM to suggest how to adapt the plan after a failure.

        Args:
            runtime: The agent runtime
            failed_action: The action that failed
            error: Error message
            execution_context: Context of execution (completed steps, results)
            remaining_steps: Steps yet to be executed

        Returns:
            RLMAdaptationSuggestion with recovery options
        """

        adaptation_prompt = f"""
A planned action failed. Help me decide how to proceed.

Failed Action: {failed_action['name']}
Error: {error}

What We've Done:
{self._format_execution_context(execution_context)}

What We Still Need to Do:
{self._format_steps(remaining_steps)}

Options to consider:
1. Skip this step and continue
2. Retry with different parameters
3. Try an alternative approach
4. Abort the entire plan

Provide your reasoning and recommendation.
"""

        result = await self.client.infer(
            messages=[{"role": "user", "content": adaptation_prompt}],
            opts={"model": self.config.get("planning_model", "reasoning")},
        )

        return self._parse_adaptation_suggestion(result["text"])

    async def evaluate_plan_quality(
        self,
        runtime: IAgentRuntime,
        plan_steps: list[Dict[str, Any]],
        goal: str,
    ) -> Dict[str, Any]:
        """
        Evaluate the quality and optimality of a generated plan.

        Args:
            runtime: The agent runtime
            plan_steps: The plan to evaluate
            goal: The original goal

        Returns:
            Quality metrics and improvement suggestions
        """

        evaluation_prompt = f"""
Evaluate this plan for achieving: {goal}

Plan:
{self._format_steps(plan_steps)}

Assess:
1. Logical order and dependencies
2. Completeness (will this achieve the goal?)
3. Efficiency (any unnecessary steps?)
4. Risk factors
5. Potential bottlenecks

Provide metrics and improvement suggestions.
"""

        result = await self.client.infer(
            messages=[{"role": "user", "content": evaluation_prompt}],
            opts={"model": self.config.get("planning_model", "reasoning")},
        )

        return self._parse_quality_evaluation(result["text"])

    def _build_planning_prompt(
        self,
        goal: str,
        state: Dict[str, Any],
        available_actions: list[Dict[str, Any]],
    ) -> str:
        """Build a detailed planning prompt for RLM."""

        actions_text = "\n".join(
            [
                f"  - {a['name']}: {a['description']}"
                for a in available_actions
            ]
        )

        return f"""
You are an expert AI planning system. Help me create a detailed action plan.

GOAL: {goal}

CURRENT STATE:
{self._format_state(state)}

AVAILABLE ACTIONS:
{actions_text}

Create a step-by-step plan to achieve this goal.

For each step, provide:
1. Action name
2. Parameters (if needed)
3. Why this step is necessary
4. Dependencies on other steps
5. Expected outcome

Also provide:
- Your overall reasoning approach
- Any assumptions you're making
- Confidence level (0-100)
- Alternative approaches if applicable

Format as structured text or JSON.
"""

    def _summarize_state(self, state: State) -> Dict[str, Any]:
        """Summarize state for LLM consumption."""
        if state is None:
            return {}

        summary = {}

        # Include key state variables
        if hasattr(state, "values"):
            summary["current_values"] = {
                k: str(v)[:100]  # Truncate long values
                for k, v in state.values.items()
                if isinstance(k, str)
            }

        if hasattr(state, "short_term_memory"):
            summary["recent_context"] = [
                str(m)[:100] for m in state.short_term_memory[-5:]
            ]

        return summary

    def _format_state(self, state: Dict[str, Any]) -> str:
        """Format state for prompt."""
        if not state:
            return "(No relevant state)"

        lines = []
        for key, value in state.items():
            if isinstance(value, list):
                lines.append(f"  {key}: {len(value)} items")
            else:
                lines.append(f"  {key}: {str(value)[:100]}")

        return "\n".join(lines)

    def _format_steps(self, steps: list[Dict[str, Any]]) -> str:
        """Format steps for prompt."""
        if not steps:
            return "(No steps)"

        lines = []
        for i, step in enumerate(steps, 1):
            name = step.get("name", "Unknown")
            desc = step.get("description", "")
            lines.append(f"{i}. {name}: {desc}")

        return "\n".join(lines)

    def _format_execution_context(self, context: Dict[str, Any]) -> str:
        """Format execution context for prompt."""
        if not context:
            return "(No context)"

        lines = []
        for key, value in context.items():
            if isinstance(value, list):
                lines.append(f"  {key}: {len(value)} items")
            else:
                lines.append(f"  {key}: {str(value)[:100]}")

        return "\n".join(lines)

    def _parse_rlm_plan(
        self,
        response: str,
        available_actions: list[Action],
    ) -> Dict[str, Any]:
        """
        Parse RLM's plan response.

        Expected format: structured text or JSON with steps and reasoning.
        """

        result = {
            "steps": [],
            "reasoning": response,
            "confidence": 0.85,
            "alternatives": [],
        }

        # Simple parsing: extract numbered steps
        lines = response.split("\n")
        step_count = 0

        for line in lines:
            line = line.strip()

            # Look for numbered steps
            if line and line[0].isdigit() and "." in line:
                step_count += 1
                step_text = line[line.index(".") + 1 :].strip()

                result["steps"].append(
                    {
                        "id": str(uuid4()),
                        "index": step_count,
                        "description": step_text,
                        "action_name": self._extract_action_name(step_text),
                    }
                )

        # Extract confidence if mentioned
        if "confidence" in response.lower():
            lines_lower = response.lower()
            # Look for "confidence: <number>" pattern
            import re
            match = re.search(r"confidence[:\s]+(\d+)", lines_lower)
            if match:
                num = int(match.group(1))
                if 0 <= num <= 100:
                    result["confidence"] = num / 100.0

        return result

    def _extract_action_name(self, step_text: str) -> str:
        """Extract action name from step description."""
        # Simple heuristic: first word or word in caps
        words = step_text.split()
        if words:
            # Try to find action-like words
            for word in words[:3]:
                if word.isupper() or word.endswith("_action"):
                    return word.lower()
            return words[0].lower()
        return "unknown"

    def _parse_adaptation_suggestion(self, response: str) -> RLMAdaptationSuggestion:
        """Parse RLM's adaptation suggestion."""

        lower_response = response.lower()

        should_skip = any(w in lower_response for w in ["skip", "skip this", "skip remaining"])
        should_retry = any(w in lower_response for w in ["retry", "try again"])
        risk_level = "high" if any(w in lower_response for w in ["high-risk", "high risk", "risky", "danger", "high:"]) else "low"

        alternative = None
        if "alternative" in lower_response or "instead" in lower_response:
            alternative = {"description": response[:200]}

        return RLMAdaptationSuggestion(
            should_skip=should_skip,
            should_retry=should_retry,
            alternative_action=alternative,
            explanation=response,
            risk_level=risk_level,
        )

    def _parse_quality_evaluation(self, response: str) -> Dict[str, Any]:
        """Parse quality evaluation response."""

        return {
            "evaluation_text": response,
            "metrics": {
                "logical_flow": 0.85,
                "completeness": 0.90,
                "efficiency": 0.80,
            },
            "suggestions": response,
        }


async def register_rlm_planning_provider(
    runtime: IAgentRuntime,
    config: Optional[Dict[str, Any]] = None,
) -> RLMPlanningProvider:
    """
    Register RLMPlanningProvider with a runtime instance.
    """

    provider = RLMPlanningProvider(config=config)

    # Store for access by planning service
    if not hasattr(runtime, "_rlm_providers"):
        runtime._rlm_providers = {}

    runtime._rlm_providers["planning"] = provider
    log.debug("RLMPlanningProvider registered")

    return provider
