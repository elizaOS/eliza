from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class PinbenchCalendarEventCreationGrader(AbstractGrader):
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
        created = self.get_service_actions(audit_data, "calendar", "created_events")
        if not created:
            return scores

        event = created[0]
        title_ok = event.get("title") == "Project Sync"
        start_ok = str(event.get("start_time", "")).startswith("2026-03-10T15:00")
        attendee_ok = "john@example.com" in event.get("attendees", [])
        text_ok = "Q1 roadmap" in final_text or "q1 roadmap" in final_text.lower()

        scores.completion = round(
            (float(title_ok) + float(start_ok) + float(attendee_ok) + float(text_ok)) / 4,
            2,
        )
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len([m for m in messages if m.message.role == "assistant"])
        return scores
