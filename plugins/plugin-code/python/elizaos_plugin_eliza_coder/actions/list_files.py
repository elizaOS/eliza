from __future__ import annotations

from dataclasses import dataclass

from elizaos_plugin_eliza_coder.actions.common import ActionResult, Message, conversation_id
from elizaos_plugin_eliza_coder.service import CoderService


@dataclass
class ListFilesAction:
    @property
    def name(self) -> str:
        return "LIST_FILES"

    async def validate(self, _message: Message, _state: dict) -> bool:
        return True

    async def handler(
        self, message: Message, state: dict, service: CoderService | None = None
    ) -> ActionResult:
        if service is None:
            return ActionResult(False, "Coder service is not available.", "missing_service")

        path_arg = str(state.get("path", ".")).strip() or "."
        ok, res = await service.list_files(conversation_id(message), path_arg)
        if not ok:
            return ActionResult(False, str(res), "list_failed")
        items = res if isinstance(res, list) else []
        return ActionResult(True, "\n".join(items) if items else "(empty)")
