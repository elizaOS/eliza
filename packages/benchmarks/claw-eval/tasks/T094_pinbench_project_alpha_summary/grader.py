from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class PinbenchProjectAlphaSummaryGrader(AbstractGrader):
    TECH_STACK = ["postgresql", "timescaledb", "fastapi", "react", "kafka", "flink", "redis", "dbt"]
    SECURITY_FINDINGS = ["cross-tenant", "websocket", "rate limit", "ssrf", "audit logging"]
    REQUIRED_SECTIONS = ["overview", "timeline", "risk", "client", "status"]

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
        reads = len([d for d in dispatches if d.tool_name == "gmail_get_message" and d.response_status < 400])

        # Original 6 checks
        checks = [
            "analytics dashboard" in lower,
            ("340k" in lower or "$340" in lower) and ("410k" in lower or "$410" in lower),
            ("may 6" in lower or "2026-05-06" in lower) and ("may 27" in lower or "2026-05-27" in lower),
            "security" in lower and ("cross-tenant" in lower or "websocket" in lower),
            "1.85m" in lower or "2.8m" in lower or "arr" in lower,
            "team appreciation lunch" not in lower and "techsummit" not in lower,
        ]

        # New checks
        # Tech stack coverage
        tech_count = sum(1 for t in self.TECH_STACK if t in lower)
        tech_score = 1.0 if tech_count >= 4 else 0.5 if tech_count >= 2 else 0.0

        # Security detail coverage
        sec_count = sum(1 for s in self.SECURITY_FINDINGS if s in lower)
        sec_score = 1.0 if sec_count >= 3 else 0.7 if sec_count >= 2 else 0.3 if sec_count >= 1 else 0.0

        # Required sections
        section_count = sum(1 for s in self.REQUIRED_SECTIONS if s in lower)
        section_score = section_count / len(self.REQUIRED_SECTIONS)

        all_checks_score = (sum(checks) / len(checks) + tech_score + sec_score + section_score) / 4
        read_score = min(reads / 9, 1.0)
        scores.completion = round((read_score + all_checks_score) / 2, 2)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len([m for m in messages if m.message.role == "assistant"])
        return scores
