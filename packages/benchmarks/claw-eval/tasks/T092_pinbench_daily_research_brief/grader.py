from __future__ import annotations

import re
from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class PinbenchDailyResearchBriefGrader(AbstractGrader):
    ACTION_KEYWORDS = ["follow-up", "action", "recommendation", "next step"]

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

        # Tool usage scoring
        rss_list_count = sum(1 for d in dispatches if d.tool_name == "rss_list_articles" and d.response_status < 400)
        rss_get_count = sum(1 for d in dispatches if d.tool_name == "rss_get_article" and d.response_status < 400)
        tool_score = (min(rss_list_count / 1, 1.0) + min(rss_get_count / 3, 1.0)) / 2

        # Keyword hits
        keyword_targets = ["executive summary"] + self.ACTION_KEYWORDS
        keyword_hits = sum(1 for kw in keyword_targets if kw in lower) / len(keyword_targets)

        # Structure: section headings
        heading_count = len(re.findall(r"^#{1,3}\s+", final_text, re.MULTILINE))
        structure_score = 1.0 if heading_count >= 3 else 0.5 if heading_count >= 1 else 0.0

        # Word count scoring: 500-800 ideal
        word_count = len(final_text.split())
        if 500 <= word_count <= 800:
            word_count_score = 1.0
        elif 400 <= word_count < 500 or 800 < word_count <= 1000:
            word_count_score = 0.7
        else:
            word_count_score = 0.4

        # Length threshold
        length_ok = 1.0 if len(final_text) >= 2000 else 0.5

        scores.completion = round(
            0.30 * tool_score
            + 0.25 * keyword_hits
            + 0.20 * structure_score
            + 0.15 * word_count_score
            + 0.10 * length_ok,
            2,
        )
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len([m for m in messages if m.message.role == "assistant"])
        return scores
