from __future__ import annotations

import re
from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class PinbenchHumanizeBlogGrader(AbstractGrader):
    BAD_PHRASES = [
        "furthermore",
        "it is important to note",
        "it is worth mentioning",
        "in today's fast-paced world",
        "in conclusion",
        "moreover",
        "additionally",
        "it is essential",
    ]
    GOOD_TOPICS = ["priorit", "distraction", "time block", "break", "work-life"]
    CONTRACTIONS = ["don't", "can't", "it's", "you'll", "we're", "isn't", "won't", "they're"]

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
        final_lower = final_text.lower()

        topic_score = sum(1 for topic in self.GOOD_TOPICS if topic in final_lower) / len(self.GOOD_TOPICS)
        bad_count = sum(1 for phrase in self.BAD_PHRASES if phrase in final_lower)
        natural_score = 1.0 if bad_count == 0 else 0.6 if bad_count <= 1 else 0.2

        contraction_count = sum(1 for c in self.CONTRACTIONS if c in final_lower)
        contraction_bonus = 1.0 if contraction_count >= 3 else 0.5 if contraction_count >= 1 else 0.2

        length_score = 1.0 if len(final_text) >= 1200 else 0.5

        scores.completion = round(
            0.35 * ((natural_score + contraction_bonus) / 2)
            + 0.25 * topic_score
            + 0.25 * 1.0
            + 0.15 * length_score,
            2,
        )
        scores.robustness = 1.0
        scores.efficiency_turns = len([m for m in messages if m.message.role == "assistant"])
        return scores
