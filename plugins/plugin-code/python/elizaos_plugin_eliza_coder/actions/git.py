from __future__ import annotations

from dataclasses import dataclass

from elizaos_plugin_eliza_coder.actions.common import ActionResult, Message, conversation_id
from elizaos_plugin_eliza_coder.service import CoderService


@dataclass
class GitAction:
    @property
    def name(self) -> str:
        return "GIT"

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

        args = str(state.get("args", "")).strip()
        if not args:
            return ActionResult(False, "Missing args.", "missing_args")

        res = await service.git(conversation_id(message), args)
        return ActionResult(res.success, res.stdout if res.success else res.stderr)
