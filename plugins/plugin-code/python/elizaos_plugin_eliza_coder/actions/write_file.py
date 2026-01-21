from __future__ import annotations

from dataclasses import dataclass

from elizaos_plugin_eliza_coder.actions.common import ActionResult, Message, conversation_id
from elizaos_plugin_eliza_coder.service import CoderService


@dataclass
class WriteFileAction:
    @property
    def name(self) -> str:
        return "WRITE_FILE"

    async def validate(self, _message: Message, _state: dict) -> bool:
        return True

    async def handler(
        self, message: Message, state: dict, service: CoderService | None = None
    ) -> ActionResult:
        if service is None:
            return ActionResult(False, "Coder service is not available.", "missing_service")

        filepath = str(state.get("filepath", "")).strip()
        content = str(state.get("content", ""))
        if not filepath:
            return ActionResult(False, "Missing filepath.", "missing_filepath")

        ok, err = await service.write_file(conversation_id(message), filepath, content)
        if not ok:
            return ActionResult(False, err, "write_failed")
        return ActionResult(True, f"Wrote {filepath} ({len(content)} chars)")
