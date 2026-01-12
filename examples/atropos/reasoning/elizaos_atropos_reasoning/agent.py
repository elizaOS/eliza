"""
ElizaOS agent for Reasoning Gym environment.
"""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

from elizaos_atropos_reasoning.types import (
    Response,
    StepResult,
    EpisodeResult,
    TrainingStats,
)
from elizaos_atropos_reasoning.evaluator import extract_answer_from_text

if TYPE_CHECKING:
    from elizaos.runtime import AgentRuntime
    from elizaos.types.primitives import UUID


class ReasoningAgent:
    """
    ElizaOS-powered reasoning agent.
    
    Uses LLM to solve reasoning problems with chain-of-thought prompting.
    
    Example:
        >>> runtime = AgentRuntime(plugins=[get_openai_plugin()])
        >>> await runtime.initialize()
        >>> agent = ReasoningAgent(runtime)
        >>> response = await agent.reason(step_result)
    """

    def __init__(
        self,
        runtime: AgentRuntime | None = None,
        use_llm: bool = True,
        agent_id: UUID | None = None,
    ) -> None:
        """
        Initialize the reasoning agent.
        
        Args:
            runtime: ElizaOS AgentRuntime
            use_llm: Whether to use LLM for reasoning
            agent_id: Optional agent ID
        """
        self._runtime = runtime
        self._use_llm = use_llm
        self._agent_id = agent_id or str(uuid.uuid4())
        self._stats = TrainingStats()

    @property
    def stats(self) -> TrainingStats:
        """Get training statistics."""
        return self._stats

    @property
    def agent_id(self) -> str:
        """Get agent ID."""
        return str(self._agent_id)

    async def reason(self, state: StepResult) -> Response:
        """
        Generate a response to the current problem.
        
        Args:
            state: Current step result with problem
            
        Returns:
            Response with answer and reasoning
        """
        if self._use_llm and self._runtime is not None:
            return await self._reason_with_llm(state)
        return self._reason_with_heuristics(state)

    def _reason_with_heuristics(self, state: StepResult) -> Response:
        """Use simple heuristics (placeholder)."""
        # This is a fallback - real reasoning requires LLM
        return Response(
            answer="I need more information to solve this.",
            reasoning="Heuristic mode cannot solve this problem.",
        )

    async def _reason_with_llm(self, state: StepResult) -> Response:
        """Use LLM for reasoning."""
        if self._runtime is None:
            return self._reason_with_heuristics(state)

        problem = state.problem

        # Build chain-of-thought prompt
        prompt = f"""Solve this {problem.task_type.value} problem step by step.

PROBLEM:
{problem.question}

INSTRUCTIONS:
1. Think through the problem step by step
2. Show your reasoning clearly
3. State your final answer explicitly

{f"Previous feedback: {state.feedback}" if state.attempts > 0 else ""}

Think step by step, then provide your answer:
"""

        try:
            from elizaos.types.model import ModelType

            result = await self._runtime.use_model(
                ModelType.TEXT_LARGE.value,
                {"prompt": prompt, "maxTokens": 500, "temperature": 0.3},
            )

            response_text = str(result).strip()

            # Extract answer from response
            answer = extract_answer_from_text(response_text)

            # Parse reasoning steps
            steps = []
            for line in response_text.split("\n"):
                line = line.strip()
                if line and not line.startswith("ANSWER"):
                    steps.append(line)

            return Response(
                answer=answer,
                reasoning=response_text,
                steps=steps,
            )

        except Exception:
            return self._reason_with_heuristics(state)

    def record_episode(self, result: EpisodeResult) -> None:
        """Record an episode result."""
        self._stats.record_episode(result)

    def reset_stats(self) -> None:
        """Reset training statistics."""
        self._stats = TrainingStats()

    def get_summary(self) -> str:
        """Get agent summary."""
        return (
            f"Reasoning Agent Summary\n"
            f"=======================\n"
            f"Mode: {'LLM-based' if self._use_llm else 'Heuristic'}\n"
            f"{self._stats}"
        )
