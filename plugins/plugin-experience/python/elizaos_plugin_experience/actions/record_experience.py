from __future__ import annotations

from dataclasses import dataclass, field
from typing import ClassVar

from elizaos_plugin_experience.service import ExperienceService
from elizaos_plugin_experience.types import Experience


@dataclass
class ActionExample:
    role: str
    text: str
    actions: list[str] = field(default_factory=list)

    @classmethod
    def user(cls, text: str) -> ActionExample:
        return cls(role="user", text=text, actions=[])

    @classmethod
    def assistant(cls, text: str, actions: list[str]) -> ActionExample:
        return cls(role="assistant", text=text, actions=actions)


@dataclass
class RecordExperienceAction:
    name: ClassVar[str] = "RECORD_EXPERIENCE"
    similes: ClassVar[list[str]] = ["REMEMBER", "SAVE_EXPERIENCE", "NOTE_LEARNING"]
    description: ClassVar[str] = "Manually record a learning experience"

    @staticmethod
    def validate(message_text: str) -> bool:
        text = message_text.lower()
        return ("remember" in text) or ("record" in text) or ("note" in text)

    @staticmethod
    def examples() -> list[ActionExample]:
        return [
            ActionExample.user(
                "Remember that installing dependencies is required for Python scripts",
            ),
            ActionExample.assistant(
                "I'll record that experience.",
                ["RECORD_EXPERIENCE"],
            ),
        ]

    @staticmethod
    def handler(service: ExperienceService, *, agent_id: str, message_text: str) -> Experience:
        return service.record_experience(
            agent_id=agent_id,
            context="manual",
            action="record_experience",
            result="recorded",
            learning=message_text,
            domain="general",
            tags=["manual"],
            confidence=0.9,
            importance=0.6,
        )
