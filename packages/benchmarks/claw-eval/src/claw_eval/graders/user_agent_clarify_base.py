"""Base grader for multi-turn user-agent clarification tasks (80/20 weighting)."""

from __future__ import annotations

from typing import Any

from ..models.task import TaskDefinition
from ..models.trace import DimensionScores, ToolDispatch, TraceMessage
from .base import AbstractGrader


class UserAgentClarifyGraderBase(AbstractGrader):
    """Base grader for tasks that use a simulated user agent.

    Scoring:
    - 80% final answer quality (evaluated by LLM judge)
    - 20% clarification quality (evaluated by LLM judge)

    Subclasses must define:
    - DOMAIN: str — domain description (e.g. "房贷提前还款")
    - MUST_ASK: list[str] — key information points the agent should ask about
    - CLARIFICATION_RUBRIC: str — judge rubric for clarification phase
    - FINAL_ANSWER_RUBRIC: str — judge rubric for final answer phase
    """

    DOMAIN: str = ""
    MUST_ASK: list[str] = []
    CLARIFICATION_RUBRIC: str = ""
    FINAL_ANSWER_RUBRIC: str = ""

    def grade(
        self,
        messages: list[TraceMessage],
        dispatches: list[ToolDispatch],
        task: TaskDefinition,
        audit_data: dict[str, dict] | None = None,
        judge: Any | None = None,
        media_events: Any = None,
        env_snapshot: dict | None = None,
    ) -> DimensionScores:
        scores = DimensionScores()
        scores.safety = 1.0
        scores.robustness = 1.0

        if judge is None:
            return scores

        full_conversation = self.format_conversation_detailed(
            messages, include_tool_use=True, include_tool_result=True,
        )
        clarify_conversation, _ = self._split_phases(messages)
        prompt_text = task.prompt.text

        # 1. Clarification quality (20%)
        clarify_score = 0.0
        if self.CLARIFICATION_RUBRIC and clarify_conversation:
            try:
                result = judge.evaluate(
                    prompt_text,
                    clarify_conversation,
                    "",
                    self.CLARIFICATION_RUBRIC,
                )
                clarify_score = result.score
                print(f"[grader] clarification score: {clarify_score:.2f} — {result.reasoning[:200]}")
            except Exception as exc:
                print(f"[grader] clarification judge failed: {exc}")

        # 2. Final answer quality (80%)
        answer_score = 0.0
        if self.FINAL_ANSWER_RUBRIC:
            try:
                result = judge.evaluate(
                    prompt_text,
                    full_conversation,
                    "",
                    self.FINAL_ANSWER_RUBRIC,
                )
                answer_score = result.score
                print(f"[grader] final answer score: {answer_score:.2f} — {result.reasoning[:200]}")
            except Exception as exc:
                print(f"[grader] final answer judge failed: {exc}")

        scores.completion = round(0.20 * clarify_score + 0.80 * answer_score, 4)
        print(f"[grader] weighted completion: {scores.completion:.4f} "
              f"(clarify={clarify_score:.2f}*0.2 + answer={answer_score:.2f}*0.8)")

        # Efficiency
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )

        return scores

    @staticmethod
    def _split_phases(messages: list[TraceMessage]) -> tuple[str, str]:
        """Split messages into clarification phase and answer phase.

        The split point is the last [user_agent] message.
        Returns (clarification_conversation, answer_conversation).
        """
        last_ua_idx = -1
        for i, m in enumerate(messages):
            if m.message.role == "user" and m.message.text.startswith("[user_agent]"):
                last_ua_idx = i

        if last_ua_idx < 0:
            # No user agent messages — entire conversation is the answer phase
            full = AbstractGrader.format_conversation(messages)
            return "", full

        clarify_lines = []
        answer_lines = []
        for i, m in enumerate(messages):
            role = m.message.role.upper()
            text = m.message.text
            if not text:
                continue
            line = f"[{role}]: {text}"
            if i <= last_ua_idx:
                clarify_lines.append(line)
            else:
                answer_lines.append(line)

        return "\n".join(clarify_lines), "\n".join(answer_lines)
