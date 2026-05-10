"""LLM-driven evaluator: simulates the user persona and judges live-mode satisfaction."""

from __future__ import annotations

from typing import TYPE_CHECKING

from .types import FirstQuestionFallback, MessageTurn, Scenario

if TYPE_CHECKING:
    from .lifeworld import LifeWorld


class LifeOpsEvaluator:
    """Plays the simulated user and judges agent satisfaction in LIVE mode.

    The evaluator model (typically Cerebras gpt-oss-120b) drives user turns.
    The judge model (typically Claude Opus) is intentionally different to
    avoid self-agreement bias in satisfaction judgments.
    """

    def __init__(self, evaluator_model: str, judge_model: str) -> None:
        self.evaluator_model = evaluator_model
        self.judge_model = judge_model

    async def simulate_user_turn(
        self,
        scenario: Scenario,
        history: list[MessageTurn],
        world_state: "LifeWorld",
    ) -> MessageTurn:
        """Generate the next user message in LIVE mode by prompting the evaluator model."""
        prompt = self._build_user_simulation_prompt(scenario, history, world_state)
        content = await self._call_llm(self.evaluator_model, prompt)
        return MessageTurn(role="user", content=content)

    async def judge_satisfaction(
        self,
        scenario: Scenario,
        history: list[MessageTurn],
        world_state: "LifeWorld",
    ) -> bool:
        """LIVE-mode only — ask the judge model whether the persona's instruction is satisfied."""
        prompt = self._build_judge_prompt(scenario, history, world_state)
        verdict = await self._call_llm(self.judge_model, prompt)
        return verdict.strip().upper().startswith("YES")

    async def apply_first_question_fallback(
        self,
        scenario: Scenario,
        agent_message: str,
    ) -> MessageTurn | None:
        """STATIC-mode only — return the canned answer if the agent opened with a clarifier.

        Returns None when the scenario has no fallback or the agent didn't
        actually ask a clarifying question.
        """
        fallback = scenario.first_question_fallback
        if fallback is None:
            return None
        if not self._looks_like_clarifying_question(agent_message, fallback):
            return None
        return MessageTurn(role="user", content=fallback.canned_answer)

    def _build_user_simulation_prompt(
        self,
        scenario: Scenario,
        history: list[MessageTurn],
        world_state: "LifeWorld",
    ) -> str:
        history_text = "\n".join(
            f"  {turn.role}: {turn.content}" for turn in history[-10:]
        )
        return (
            f"You are role-playing {scenario.persona.name}.\n"
            f"Background: {scenario.persona.background}\n"
            f"Communication style: {scenario.persona.communication_style}\n"
            f"Traits: {', '.join(scenario.persona.traits)}\n"
            f"Your underlying goal: {scenario.instruction}\n\n"
            f"Recent conversation:\n{history_text}\n\n"
            f"Respond as {scenario.persona.name} would. Stay in character."
        )

    def _build_judge_prompt(
        self,
        scenario: Scenario,
        history: list[MessageTurn],
        world_state: "LifeWorld",
    ) -> str:
        history_text = "\n".join(
            f"  {turn.role}: {turn.content}" for turn in history
        )
        return (
            f"Persona instruction: {scenario.instruction}\n\n"
            f"Conversation:\n{history_text}\n\n"
            "Has the assistant satisfied the persona's instruction? "
            "Respond with YES or NO followed by a one-sentence reason."
        )

    @staticmethod
    def _looks_like_clarifying_question(
        agent_message: str,
        fallback: FirstQuestionFallback,
    ) -> bool:
        text = (agent_message or "").strip()
        if not text:
            return False
        return "?" in text

    async def _call_llm(self, model: str, prompt: str) -> str:
        raise NotImplementedError(
            "LLM call wired in by Wave 1E (clients module)."
        )
