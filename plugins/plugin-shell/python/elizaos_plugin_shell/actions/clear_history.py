"""Clear history action for the shell plugin."""

from dataclasses import dataclass
from typing import Optional

from elizaos_plugin_shell.service import ShellService


@dataclass
class ActionExample:
    """Example for an action."""

    user_message: str
    agent_response: str


@dataclass
class ActionResult:
    """Result of an action execution."""

    success: bool
    text: str
    data: Optional[dict] = None
    error: Optional[str] = None


class ClearHistoryAction:
    """Action to clear shell command history."""

    CLEAR_KEYWORDS = ["clear", "reset", "delete", "remove", "clean"]
    HISTORY_KEYWORDS = ["history", "terminal", "shell", "command"]

    @property
    def name(self) -> str:
        """Get the action name."""
        return "CLEAR_SHELL_HISTORY"

    @property
    def similes(self) -> list[str]:
        """Get action similes (alternative names)."""
        return ["RESET_SHELL", "CLEAR_TERMINAL", "CLEAR_HISTORY", "RESET_HISTORY"]

    @property
    def description(self) -> str:
        """Get action description."""
        return "Clears the recorded history of shell commands for the current conversation"

    def _has_clear_keyword(self, text: str) -> bool:
        """Check if text contains clear keywords."""
        lower = text.lower()
        return any(kw in lower for kw in self.CLEAR_KEYWORDS)

    def _has_history_keyword(self, text: str) -> bool:
        """Check if text contains history keywords."""
        lower = text.lower()
        return any(kw in lower for kw in self.HISTORY_KEYWORDS)

    async def validate(self, message: dict, state: dict) -> bool:
        """Validate if this action should be executed for the given message."""
        text = message.get("content", {}).get("text", "")
        return self._has_clear_keyword(text) and self._has_history_keyword(text)

    async def handler(
        self,
        message: dict,
        state: dict,
        service: Optional[ShellService] = None,
    ) -> ActionResult:
        """Execute the action."""
        if service is None:
            return ActionResult(
                success=False,
                text="Shell service is not available.",
                error="Shell service is not available",
            )

        conversation_id = message.get("room_id") or message.get("agent_id") or "default"
        service.clear_command_history(conversation_id)

        return ActionResult(
            success=True,
            text="Shell command history has been cleared.",
        )

    def examples(self) -> list[ActionExample]:
        """Get usage examples."""
        return [
            ActionExample(
                user_message="clear my shell history",
                agent_response="Shell command history has been cleared.",
            ),
            ActionExample(
                user_message="reset the terminal history",
                agent_response="Shell command history has been cleared.",
            ),
            ActionExample(
                user_message="delete command history",
                agent_response="Shell command history has been cleared.",
            ),
        ]
