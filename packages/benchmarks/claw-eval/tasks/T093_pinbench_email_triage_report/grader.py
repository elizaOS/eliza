from __future__ import annotations

import re
from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class PinbenchEmailTriageReportGrader(AbstractGrader):
    # Email identifiers to check coverage
    EMAIL_IDENTIFIERS = [
        "outage", "war room", "bigclient", "mike chen", "flash sale",
        "saastools", "password rotation", "security", "code review",
        "sprint", "standup", "newsletter", "team lunch", "appreciation",
    ]

    CATEGORY_TERMS = [
        "incident", "client", "internal", "admin",
        "code-review", "code review", "automated", "newsletter", "spam",
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
        read_count = len([d for d in dispatches if d.tool_name == "gmail_get_message" and d.response_status < 400])

        # Original 5 checks
        required_hits = [
            "p0" in lower and ("outage" in lower or "war room" in lower),
            "bigclient" in lower or "mike chen" in lower,
            "p4" in lower and ("saastools" in lower or "flash sale" in lower),
            "alert" in lower and ("incident" in lower or "outage" in lower),
            "summary" in lower or "plan" in lower or "top priorities" in lower,
        ]

        # New checks
        # Coverage: how many distinct email identifiers are mentioned
        email_coverage = sum(1 for eid in self.EMAIL_IDENTIFIERS if eid in lower) / len(self.EMAIL_IDENTIFIERS)

        # Category terms present
        cat_count = sum(1 for term in self.CATEGORY_TERMS if term in lower)
        categories_present = 1.0 if cat_count >= 5 else cat_count / 5

        # Priority sorting: P0 should appear before P4
        p0_pos = lower.find("p0")
        p4_pos = lower.find("p4")
        sorted_by_priority = 1.0 if (p0_pos >= 0 and p4_pos >= 0 and p0_pos < p4_pos) else 0.0

        # Security alert priority check
        security_near_priority = 0.0
        for pattern in [r"(password rotation|security).{0,80}(p[012])", r"(p[012]).{0,80}(password rotation|security)"]:
            if re.search(pattern, lower):
                security_near_priority = 1.0
                break

        # Code review priority check
        code_review_priority = 0.0
        for pattern in [r"code review.{0,80}p[23]", r"p[23].{0,80}code review"]:
            if re.search(pattern, lower):
                code_review_priority = 1.0
                break

        all_checks = required_hits + [
            email_coverage >= 0.5,
            categories_present >= 0.6,
            sorted_by_priority > 0,
            security_near_priority > 0,
            code_review_priority > 0,
        ]

        read_score = min(read_count / 13, 1.0)
        check_score = sum(1.0 if c else 0.0 for c in all_checks) / len(all_checks)
        scores.completion = round((read_score + check_score) / 2, 2)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len([m for m in messages if m.message.role == "assistant"])
        return scores
