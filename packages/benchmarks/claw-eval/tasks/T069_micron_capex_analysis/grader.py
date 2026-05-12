"""T43_micron_capex_analysis grader — judge + anchor scoring."""

from __future__ import annotations

import re
from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class MicronCapexGrader(AbstractGrader):
    """Grade Micron FY2025 CapEx cash flow analysis."""

    ANCHOR_GROUPS = [
        [r"17\.5", r"17,500"],                  # OCF
        [r"13\.8", r"13,800"],                  # CapEx
        [r"3\.7", r"3,700"],                    # FCF
        [r"1\.27"],                             # Coverage ratio
        [r"42\.6", r"42,553"],                  # Breakeven revenue
        [r"10%.*nand", r"nand.*10%", r"nand.*reduction"],  # NAND reduction
        [r"hbm.*packag", r"back.?end.*packag"],  # HBM packaging
        [r"idaho|new\s*york|boise"],            # New fab locations
        [r"2027|capacity.*delay"],              # Delayed capacity release
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

        search_calls = [d for d in dispatches if d.tool_name == "web_search" and d.response_status < 400]
        unique_searches = len({d.request_body.get("query", "") for d in search_calls})
        fetch_calls_count = len([d for d in dispatches if d.tool_name == "web_fetch" and d.response_status < 400])
        search_effort = min((unique_searches + fetch_calls_count) / 2, 1.0)

        judged = judge.evaluate(
            task.prompt.text,
            self.format_conversation(messages),
            self.summarize_actions(audit_data),
            task.judge_rubric,
        ).score
        scores.completion = round(min(1.0, 0.70 * judged + 0.30 * search_effort), 2)

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
