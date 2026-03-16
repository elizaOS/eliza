from __future__ import annotations

from dataclasses import dataclass

from elizaos_plugin_eliza_coder.actions.common import ActionResult, Message, conversation_id
from elizaos_plugin_eliza_coder.service import CoderService


@dataclass
class ChangeDirectoryAction:
    @property
    def name(self) -> str:
        return "CHANGE_DIRECTORY"

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

        target = str(state.get("path", "")).strip()
        if not target:
            return ActionResult(False, "Missing path.", "missing_path")

        result = await service.change_directory(conversation_id(message), target)
        return ActionResult(result.success, result.stdout if result.success else result.stderr)
