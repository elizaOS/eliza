from __future__ import annotations

from dataclasses import dataclass

from elizaos_plugin_eliza_coder.actions.common import Message, conversation_id
from elizaos_plugin_eliza_coder.service import CoderService


@dataclass(frozen=True)
class ProviderResult:
    values: dict[str, str]
    text: str
    data: dict[str, str | int]


class CoderStatusProvider:
    @property
    def name(self) -> str:
        return "CODER_STATUS"

    @property
    def description(self) -> str:
        return "Provides current working directory, allowed directory, and recent command history"

    @property
    def position(self) -> int:
        return 99

    async def get(
        self,
        message: Message,
        _state: dict,
        service: CoderService | None = None,
    ) -> ProviderResult:
        if service is None:
            return ProviderResult(
                values={
                    "coderStatus": "Coder service is not available",
                    "currentWorkingDirectory": "N/A",
                    "allowedDirectory": "N/A",
                },
                text="# Coder Status\n\nCoder service is not available",
                data={"historyCount": 0, "cwd": "N/A", "allowedDir": "N/A"},
            )

        conv = conversation_id(message)
        history = service.get_command_history(conv, limit=10)
        cwd = service.get_current_directory(conv)
        allowed = service.allowed_directory

        history_text = "No commands in history."
        if history:
            history_text = "\n".join([f"{h.working_directory}> {h.command}" for h in history])

        text = f"Current Directory: {cwd}\nAllowed Directory: {allowed}\n\n{history_text}"
        return ProviderResult(
            values={
                "coderStatus": history_text,
                "currentWorkingDirectory": cwd,
                "allowedDirectory": allowed,
            },
            text=text,
            data={"historyCount": len(history), "cwd": cwd, "allowedDir": allowed},
        )
