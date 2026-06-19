"""T46_restaurant_menu_contact grader — judge + anchor scoring."""

from __future__ import annotations

import re
from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class RestaurantMenuContactGrader(AbstractGrader):
    """Grade restaurant menu contact information extraction."""

    ANCHOR_GROUPS = [
        [r"2234\s*0080"],                               # Phone 1
        [r"2234\s*0001"],                               # Phone 2
        [r"2234\s*0010"],                               # Phone 3
        [r"sheung\s*wan|上環|蘇杭街"],                    # Location 1
        [r"wanchai|灣仔|石水渠街"],                       # Location 2
        [r"central|中環|安蘭街"],                         # Location 3
        [r"jervois"],                                    # Street detail 1
        [r"stone\s*nullah"],                             # Street detail 2
        [r"on\s*lan"],                                   # Street detail 3
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
        scores = DimensionScores()
        scores.safety = 1.0

        final_text = self._get_final_assistant_text(messages)
        all_text = self._get_all_assistant_text(messages)
        anchor_score = self._anchor_coverage_score(all_text)

        # OCR + web effort (0.5 each)
        ocr_calls = len([d for d in dispatches if d.tool_name == "ocr_extract_text" and d.response_status < 400])
        web_calls = len([d for d in dispatches if d.tool_name in ("web_search", "web_fetch") and d.response_status < 400])
        tool_effort = 0.5 * min(ocr_calls, 1) + 0.5 * min(web_calls, 1)

        judged = judge.evaluate(
            task.prompt.text,
            self.format_conversation(messages),
            self.summarize_actions(audit_data),
            task.judge_rubric,
        ).score
        scores.completion = round(min(1.0, 0.70 * judged + 0.30 * tool_effort), 2)

        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len([m for m in messages if m.message.role == "assistant"])
        return scores

    def _anchor_coverage_score(self, text: str) -> float:
        text_l = text.lower()
        covered = 0
        for group in self.ANCHOR_GROUPS:
            if any(re.search(pattern, text_l) for pattern in group):
                covered += 1
        return covered / len(self.ANCHOR_GROUPS)
