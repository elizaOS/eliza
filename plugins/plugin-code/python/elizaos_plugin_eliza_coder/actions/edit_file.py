from __future__ import annotations

from dataclasses import dataclass

from elizaos_plugin_eliza_coder.actions.common import ActionResult, Message, conversation_id
from elizaos_plugin_eliza_coder.service import CoderService


@dataclass
class EditFileAction:
    @property
    def name(self) -> str:
        return "EDIT_FILE"

    async def validate(self, _message: Message, _state: dict) -> bool:
        return True

    async def handler(
        self, message: Message, state: dict, service: CoderService | None = None
    ) -> ActionResult:
        if service is None:
            return ActionResult(False, "Coder service is not available.", "missing_service")

        filepath = str(state.get("filepath", "")).strip()
        old_str = str(state.get("old_str", ""))
        new_str = str(state.get("new_str", ""))
        if not filepath or not old_str:
            return ActionResult(False, "Missing filepath or old_str.", "missing_args")

        ok, err = await service.edit_file(conversation_id(message), filepath, old_str, new_str)
        if not ok:
            return ActionResult(False, err, "edit_failed")
        return ActionResult(True, f"Edited {filepath}")
