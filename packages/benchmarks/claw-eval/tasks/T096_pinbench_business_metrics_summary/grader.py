from __future__ import annotations

import re
from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class PinbenchBusinessMetricsSummaryGrader(AbstractGrader):
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
        text = self._get_final_assistant_text(messages)
        lowered = text.lower()
        compact = text.replace(",", "").replace("$", "")

        checks = [
            bool(re.search(r"\b119900(?:\.0+)?\b", compact)),
            bool(re.search(r"\b47960(?:\.0+)?\b", compact)),
            bool(re.search(r"\b3775\b", compact)),
            "east" in lowered and bool(re.search(r"\b33075(?:\.0+)?\b", compact)),
            "widget b" in lowered and bool(re.search(r"\b47400(?:\.0+)?\b", compact)),
            bool(re.search(r"\b15430(?:\.0+)?\b", compact)),
            "engineering" in lowered and bool(re.search(r"\b7680(?:\.0+)?\b", compact)),
            "alice chen" in lowered and bool(re.search(r"\b5400(?:\.0+)?\b", compact)),
            any(term in lowered for term in ["budget", "under budget", "over budget", "variance"]),
            "insight" in lowered or "overall" in lowered,
        ]

        scores.completion = round(sum(checks) / len(checks), 2)
        scores.robustness = 1.0
        scores.efficiency_turns = len([m for m in messages if m.message.role == "assistant"])
        return scores
