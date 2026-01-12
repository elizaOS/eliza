
from dataclasses import dataclass, field
from typing import ClassVar

FORM_TYPES: dict[str, list[str]] = {
    "contact": ["contact", "reach out", "get in touch", "message"],
    "feedback": ["feedback", "review", "opinion", "suggestion"],
    "application": ["apply", "application", "job", "position"],
    "survey": ["survey", "questionnaire", "poll"],
    "registration": ["register", "sign up", "enroll", "join"],
}


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
class CreateFormAction:
    name: ClassVar[str] = "CREATE_FORM"
    similes: ClassVar[list[str]] = ["START_FORM", "NEW_FORM", "INIT_FORM", "BEGIN_FORM"]
    description: ClassVar[str] = "Creates a new form from a template or custom definition"

    @staticmethod
    def extract_form_type(text: str) -> str | None:
        lower = text.lower()
        for form_type, keywords in FORM_TYPES.items():
            if any(k in lower for k in keywords):
                return form_type
        return None

    @staticmethod
    def validate(
        message_text: str, has_active_forms: bool = False, has_forms_service: bool = True
    ) -> bool:
        if not has_forms_service:
            return False

        text = message_text.lower()

        return (
            "form" in text
            or "fill out" in text
            or "fill in" in text
            or "questionnaire" in text
            or "survey" in text
            or "contact" in text
            or "application" in text
        )

    @staticmethod
    def examples() -> list[ActionExample]:
        return [
            ActionExample.user("I need to fill out a contact form"),
            ActionExample.assistant(
                "I've created a new contact form for you. Basic contact information form\n\n"
                "Let's start with Basic Information.\n\n"
                "Please provide the following information:\n"
                "- Name: Your full name\n"
                "- Email: Your email address",
                ["CREATE_FORM"],
            ),
        ]
