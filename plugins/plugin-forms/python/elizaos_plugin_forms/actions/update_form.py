import re
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
class UpdateFormAction:
    name: ClassVar[str] = "UPDATE_FORM"
    similes: ClassVar[list[str]] = ["FILL_FORM", "SUBMIT_FORM", "COMPLETE_FORM", "FORM_INPUT"]
    description: ClassVar[str] = (
        "Updates an active form with values extracted from the user message"
    )

    @staticmethod
    def contains_form_input(text: str) -> bool:
        lower = text.lower()

        if "my name is" in lower or "i am" in lower or "@" in lower:
            return True

        # Check for numbers (likely phone, age, etc.)
        if re.search(r"\d{2,}", lower):
            return True

        return len(text) > 5

    @staticmethod
    def validate(
        message_text: str, has_active_forms: bool = False, has_forms_service: bool = True
    ) -> bool:
        """Validate whether the action should be triggered."""
        if not has_forms_service:
            return False

        if not has_active_forms:
            return False

        return UpdateFormAction.contains_form_input(message_text)

    @staticmethod
    def examples() -> list[ActionExample]:
        return [
            ActionExample.user("I need to fill out a contact form"),
            ActionExample.assistant(
                "I'll help you with the contact form. Please provide your name to get started.",
                ["CREATE_FORM"],
            ),
            ActionExample.user("My name is John Smith"),
            ActionExample.assistant(
                "Thank you, John Smith. I've recorded your name. "
                "Now, please provide your email address.",
                ["UPDATE_FORM"],
            ),
            ActionExample.user("john.smith@example.com"),
            ActionExample.assistant(
                "Perfect! I've recorded your email as john.smith@example.com. "
                "The last field is optional - would you like to include a message?",
                ["UPDATE_FORM"],
            ),
        ]
