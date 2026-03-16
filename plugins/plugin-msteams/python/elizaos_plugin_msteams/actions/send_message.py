"""Send message actions for MS Teams."""

from abc import ABC, abstractmethod
from typing import Any

from pydantic import BaseModel


class ActionContext(BaseModel):
    """Context provided to action handlers."""

    message: dict[str, Any]
    conversation_id: str
    user_id: str
    tenant_id: str | None = None
    state: dict[str, Any]


class MSTeamsAction(ABC):
    """Base class for MS Teams actions."""

    @property
    @abstractmethod
    def name(self) -> str:
        """Returns the action name."""

    @property
    @abstractmethod
    def description(self) -> str:
        """Returns a description of the action."""

    @abstractmethod
    async def validate(self, context: ActionContext) -> bool:
        """Validates whether this action should be executed."""

    @abstractmethod
    async def execute(self, context: ActionContext) -> dict[str, Any]:
        """Executes the action and returns a result value."""


class SendMessageAction(MSTeamsAction):
    """Action that sends a message to an MS Teams conversation."""

    @property
    def name(self) -> str:
        return "SEND_MSTEAMS_MESSAGE"

    @property
    def description(self) -> str:
        return "Send a message to a Microsoft Teams conversation"

    async def validate(self, context: ActionContext) -> bool:
        source = context.message.get("source")
        return source == "msteams"

    async def execute(self, context: ActionContext) -> dict[str, Any]:
        response_text = context.state.get("response", {}).get("text", "")

        return {
            "action": self.name,
            "conversationId": context.conversation_id,
            "text": response_text,
            "replyToId": context.message.get("activityId"),
        }


class SendPollAction(MSTeamsAction):
    """Action that sends a poll to an MS Teams conversation."""

    @property
    def name(self) -> str:
        return "SEND_MSTEAMS_POLL"

    @property
    def description(self) -> str:
        return "Send a poll to a Microsoft Teams conversation"

    async def validate(self, context: ActionContext) -> bool:
        source = context.message.get("source")
        return source == "msteams"

    async def execute(self, context: ActionContext) -> dict[str, Any]:
        question = context.state.get("pollQuestion", "")
        options = context.state.get("pollOptions", [])
        max_selections = context.state.get("maxSelections", 1)

        return {
            "action": self.name,
            "conversationId": context.conversation_id,
            "question": question,
            "options": options,
            "maxSelections": max_selections,
        }


class SendAdaptiveCardAction(MSTeamsAction):
    """Action that sends an Adaptive Card to an MS Teams conversation."""

    @property
    def name(self) -> str:
        return "SEND_MSTEAMS_CARD"

    @property
    def description(self) -> str:
        return "Send an Adaptive Card to a Microsoft Teams conversation"

    async def validate(self, context: ActionContext) -> bool:
        source = context.message.get("source")
        return source == "msteams"

    async def execute(self, context: ActionContext) -> dict[str, Any]:
        card = context.state.get("cardContent", {})
        fallback_text = context.state.get("fallbackText", "")

        return {
            "action": self.name,
            "conversationId": context.conversation_id,
            "card": card,
            "fallbackText": fallback_text,
        }
