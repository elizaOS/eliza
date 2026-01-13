from dataclasses import dataclass

from elizaos_plugin_shell.service import ShellService


@dataclass
class ActionExample:
    user_message: str
    agent_response: str


@dataclass
class ActionResult:
    success: bool
    text: str
    data: dict | None = None
    error: str | None = None


class ClearHistoryAction:
    CLEAR_KEYWORDS = ["clear", "reset", "delete", "remove", "clean", "wipe", "forget"]
    HISTORY_KEYWORDS = ["history", "terminal", "shell", "command", "commands"]

    @property
    def name(self) -> str:
        return "CLEAR_SHELL_HISTORY"

    @property
    def similes(self) -> list[str]:
        return ["RESET_SHELL", "CLEAR_TERMINAL", "CLEAR_HISTORY", "RESET_HISTORY"]

    @property
    def description(self) -> str:
        return "Clears the recorded history of shell commands for the current conversation"

    def _has_clear_keyword(self, text: str) -> bool:
        lower = text.lower()
        return any(kw in lower for kw in self.CLEAR_KEYWORDS)

    def _has_history_keyword(self, text: str) -> bool:
        lower = text.lower()
        return any(kw in lower for kw in self.HISTORY_KEYWORDS)

    async def validate(self, message: dict, state: dict) -> bool:
        text = message.get("content", {}).get("text", "")
        return self._has_clear_keyword(text) and self._has_history_keyword(text)

    async def handler(
        self,
        message: dict,
        state: dict,
        service: ShellService | None = None,
    ) -> ActionResult:
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
