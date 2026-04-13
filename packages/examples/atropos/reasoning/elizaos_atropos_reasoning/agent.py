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
            return await self._reason_with_eliza(state)
        return self._reason_with_heuristics(state)

    def _reason_with_heuristics(self, state: StepResult) -> Response:
        """Use simple heuristics (placeholder)."""
        # This is a fallback - real reasoning requires LLM
        return Response(
            answer="I need more information to solve this.",
            reasoning="Heuristic mode cannot solve this problem.",
        )

    async def _reason_with_eliza(self, state: StepResult, *, trajectory_step_id: str | None = None) -> Response:
        """Use canonical ElizaOS message pipeline for reasoning."""
        if self._runtime is None:
            return self._reason_with_heuristics(state)

        try:
            from elizaos_atropos_shared.canonical_eliza import run_with_context
            from elizaos_atropos_reasoning.eliza_plugin import (
                REASONING_STORE,
                ReasoningDecisionContext,
            )

            result, ctx = await run_with_context(
                self._runtime,
                REASONING_STORE,
                ReasoningDecisionContext(state=state),
                source="atropos_reasoning",
                text="Solve the problem and provide the final answer.",
                trajectory_step_id=trajectory_step_id,
            )
            chosen_answer = ctx.chosen_answer

            response_text = result.response_content.text if result.response_content else ""
            answer = extract_answer_from_text(chosen_answer or response_text)

            steps: list[str] = []
            for line in response_text.split("\n"):
                t = line.strip()
                if t:
                    steps.append(t)

            return Response(answer=answer, reasoning=response_text, steps=steps)

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
