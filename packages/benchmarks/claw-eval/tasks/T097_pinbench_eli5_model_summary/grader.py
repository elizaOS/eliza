from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class PinbenchEli5ModelSummaryGrader(AbstractGrader):
    JARGON_WORDS = [
        "multimodal", "transformer", "rlhf", "benchmark", "parameters",
        "neural network", "fine-tuning", "token", "inference",
    ]
    ANALOGY_PHRASES = ["like a", "imagine", "pretend", "think of it as", "just like", "as if"]
    ACCURACY_KEYWORDS = ["gpt-4", "mistake", "not perfect", "wrong", "error", "careful"]

    # Required concept clusters from the prompt:
    # 1. what GPT-4 is
    WHAT_IS_KEYWORDS = ["gpt-4", "gpt4", "ai", "computer", "program", "model", "system", "brain"]
    # 2. what it is good at
    GOOD_AT_KEYWORDS = [
        "good at", "can do", "help", "write", "answer", "solve", "understand",
        "read", "language", "math", "code", "task", "many things", "lots of things",
    ]
    # 3. why it matters / important
    WHY_MATTERS_KEYWORDS = [
        "important", "matters", "big deal", "special", "powerful", "amazing",
        "better", "smarter", "impressive", "breakthrough", "advance",
    ]
    # 4. has limits / can make mistakes
    LIMITS_KEYWORDS = [
        "mistake", "wrong", "not perfect", "limit", "can't", "doesn't always",
        "not always", "careful", "error", "fail", "struggle", "imperfect",
    ]

    def grade(
        self,
        messages: list[TraceMessage],
        dispatches: list[ToolDispatch],
        task: TaskDefinition,
        audit_data: dict[str, dict] | None = None,
        judge: Any | None = None,
        media_events: list[MediaLoad] | None = None,
        env_snapshot: dict | None = None,
    ) -> DimensionScores:
        scores = DimensionScores(safety=1.0)
        final_text = self._get_final_assistant_text(messages)
        lower = final_text.lower()

        # Tool usage
        tool_used = any(d.tool_name == "documents_extract_text" for d in dispatches if d.response_status < 400)

        # Word count scoring: 200-400 ideal
        word_count = len(final_text.split())
        if 200 <= word_count <= 400:
            word_count_score = 1.0
        elif 150 <= word_count < 200 or 400 < word_count <= 500:
            word_count_score = 0.7
        else:
            word_count_score = 0.4

        # Simplicity: penalize jargon
        jargon_count = sum(1 for j in self.JARGON_WORDS if j in lower)
        if jargon_count == 0:
            simplicity = 1.0
        elif jargon_count == 1:
            simplicity = 0.7
        elif jargon_count == 2:
            simplicity = 0.4
        else:
            simplicity = 0.2

        # Engagement: check for analogies
        analogy_count = sum(1 for a in self.ANALOGY_PHRASES if a in lower)
        engagement = 1.0 if analogy_count >= 2 else 0.5 if analogy_count == 1 else 0.2

        # Concept coverage: prompt requires 4 specific areas
        concepts_covered = 0
        if any(kw in lower for kw in self.WHAT_IS_KEYWORDS):
            concepts_covered += 1
        if any(kw in lower for kw in self.GOOD_AT_KEYWORDS):
            concepts_covered += 1
        if any(kw in lower for kw in self.WHY_MATTERS_KEYWORDS):
            concepts_covered += 1
        if any(kw in lower for kw in self.LIMITS_KEYWORDS):
            concepts_covered += 1
        concept_score = concepts_covered / 4

        scores.completion = round(
            0.25 * simplicity
            + 0.25 * concept_score
            + 0.15 * engagement
            + 0.15 * word_count_score
            + 0.10 * (1.0 if tool_used else 0.0)
            + 0.10 * min(sum(1 for kw in self.ACCURACY_KEYWORDS if kw in lower) / 2, 1.0),
            2,
        )
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len([m for m in messages if m.message.role == "assistant"])
        return scores
