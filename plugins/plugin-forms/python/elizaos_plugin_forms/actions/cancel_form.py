from dataclasses import dataclass, field
from typing import ClassVar


@dataclass
class ActionExample:
    role: str
    text: str
    actions: list[str] = field(default_factory=list)

    @classmethod
    def user(cls, text: str) -> "ActionExample":
        return cls(role="user", text=text, actions=[])

    @classmethod
    def assistant(cls, text: str, actions: list[str]) -> "ActionExample":
        return cls(role="assistant", text=text, actions=actions)


@dataclass
class CancelFormAction:
    name: ClassVar[str] = "CANCEL_FORM"
    similes: ClassVar[list[str]] = ["ABORT_FORM", "STOP_FORM", "QUIT_FORM", "EXIT_FORM"]
    description: ClassVar[str] = "Cancels an active form"

    @staticmethod
    def wants_cancel(text: str) -> bool:
        lower = text.lower()

        return (
            "cancel" in lower
            or "stop" in lower
            or "abort" in lower
            or "quit" in lower
            or "exit" in lower
            or "nevermind" in lower
            or "never mind" in lower
            or ("don't" in lower and "want" in lower)
        )

    @staticmethod
    def validate(
        message_text: str, has_active_forms: bool = False, has_forms_service: bool = True
    ) -> bool:
        if not has_forms_service:
            return False

        if not has_active_forms:
            return False

        return CancelFormAction.wants_cancel(message_text)

    @staticmethod
    def examples() -> list[ActionExample]:
        return [
            ActionExample.user("Actually, cancel the form"),
            ActionExample.assistant(
                "I've cancelled the contact form. Is there anything else I can help you with?",
                ["CANCEL_FORM"],
            ),
            ActionExample.user("Never mind, I don't want to fill this out"),
            ActionExample.assistant(
                "I've cancelled the form. Is there anything else I can help you with?",
                ["CANCEL_FORM"],
            ),
        ]
