from __future__ import annotations

from dataclasses import dataclass

from elizaos_plugin_eliza_coder.actions.common import ActionResult, Message, conversation_id
from elizaos_plugin_eliza_coder.service import CoderService


@dataclass
class ReadFileAction:
    @property
    def name(self) -> str:
        return "READ_FILE"

    async def validate(self, _message: Message, _state: dict) -> bool:
        return True

    async def handler(
        self, message: Message, _state: dict, service: CoderService | None = None
    ) -> ActionResult:
        if service is None:
            return ActionResult(False, "Coder service is not available.", "missing_service")

        text = (message.get("content", {}) or {}).get("text", "")
        filepath = ""
        if '"' in text:
            parts = text.split('"')
            if len(parts) >= 2:
                filepath = parts[1]

        if not filepath:
            return ActionResult(False, "Missing filepath.", "missing_filepath")

        ok, out = await service.read_file(conversation_id(message), filepath)
        if not ok:
            return ActionResult(False, out, "read_failed")
        return ActionResult(True, out)
