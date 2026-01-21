from __future__ import annotations

from dataclasses import dataclass

from elizaos_plugin_eliza_coder.actions.common import ActionResult, Message, conversation_id
from elizaos_plugin_eliza_coder.service import CoderService


@dataclass
class ExecuteShellAction:
    @property
    def name(self) -> str:
        return "EXECUTE_SHELL"

    async def validate(self, _message: Message, _state: dict) -> bool:
        return True

    async def handler(
        self,
        message: Message,
        state: dict,
        service: CoderService | None = None,
    ) -> ActionResult:
        if service is None:
            return ActionResult(False, "Coder service is not available.", "missing_service")

        cmd = str(state.get("command", "")).strip()
        if not cmd:
            return ActionResult(False, "Missing command.", "missing_command")

        res = await service.execute_shell(conversation_id(message), cmd)
        return ActionResult(res.success, res.stdout if res.success else res.stderr)
