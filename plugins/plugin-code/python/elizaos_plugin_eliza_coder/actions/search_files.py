from __future__ import annotations

from dataclasses import dataclass

from elizaos_plugin_eliza_coder.actions.common import ActionResult, Message, conversation_id
from elizaos_plugin_eliza_coder.service import CoderService, SearchMatch


@dataclass
class SearchFilesAction:
    @property
    def name(self) -> str:
        return "SEARCH_FILES"

    async def validate(self, _message: Message, _state: dict) -> bool:
        return True

    async def handler(
        self, message: Message, state: dict, service: CoderService | None = None
    ) -> ActionResult:
        if service is None:
            return ActionResult(False, "Coder service is not available.", "missing_service")

        pattern = str(state.get("pattern", "")).strip()
        dirpath = str(state.get("path", ".")).strip() or "."
        max_matches = (
            int(state.get("max_matches", 50)) if str(state.get("max_matches", "")).strip() else 50
        )

        if not pattern:
            return ActionResult(False, "Missing pattern.", "missing_pattern")

        ok, res = await service.search_files(
            conversation_id(message), pattern, dirpath, max_matches
        )
        if not ok:
            return ActionResult(False, str(res), "search_failed")
        matches = res if isinstance(res, list) else []
        if not matches:
            return ActionResult(True, f'No matches for "{pattern}".')
        lines = [f"{m.file}:L{m.line}: {m.content}" for m in matches if isinstance(m, SearchMatch)]
        return ActionResult(True, "\n".join(lines))
