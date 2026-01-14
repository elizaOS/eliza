from __future__ import annotations

from dataclasses import dataclass
from typing import ClassVar

from elizaos_plugin_experience.service import ExperienceService
from elizaos_plugin_experience.types import ExperienceQuery


@dataclass
class ExperienceProvider:
    name: ClassVar[str] = "EXPERIENCE"
    description: ClassVar[str] = (
        "Provides relevant past experiences and learnings for the current context"
    )

    @staticmethod
    def get(service: ExperienceService, *, message_text: str) -> str:
        if len(message_text.strip()) < 10:
            return ""

        experiences = service.query_experiences(
            ExperienceQuery(
                query=message_text,
                limit=5,
                min_confidence=0.6,
                min_importance=0.5,
            )
        )

        if not experiences:
            return ""

        lines = []
        for idx, exp in enumerate(experiences, start=1):
            lines.append(
                f"Experience {idx}: In {exp.domain} context, when {exp.context}, I learned: {exp.learning}"
            )

        return "[RELEVANT EXPERIENCES]\n" + "\n".join(lines) + "\n[/RELEVANT EXPERIENCES]"
