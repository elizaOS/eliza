from __future__ import annotations

import asyncio
import logging
import shlex
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

from elizaos_plugin_eliza_coder.config import load_coder_config
from elizaos_plugin_eliza_coder.path_utils import (
    is_forbidden_command,
    is_safe_command,
    validate_path,
)
from elizaos_plugin_eliza_coder.types import (
    CommandHistoryEntry,
    CommandResult,
    FileOperation,
)

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class SearchMatch:
    file: str
    line: int
    content: str


class CoderService:
    def __init__(self) -> None:
        self._config = load_coder_config()
        self._cwd_by_conversation: dict[str, str] = {}
        self._history_by_conversation: dict[str, list[CommandHistoryEntry]] = {}
        self._max_history = 100

    @property
    def allowed_directory(self) -> str:
        return self._config.allowed_directory

    def get_current_directory(self, conversation_id: str) -> str:
        return self._cwd_by_conversation.get(conversation_id, self._config.allowed_directory)

    def _set_current_directory(self, conversation_id: str, directory: str) -> None:
        self._cwd_by_conversation[conversation_id] = directory

    def get_command_history(self, conversation_id: str, limit: int) -> list[CommandHistoryEntry]:
        if limit <= 0:
            return []
        return self._history_by_conversation.get(conversation_id, [])[-limit:]

    def _add_history(
        self,
        conversation_id: str,
        command: str,
        result: CommandResult,
        file_ops: list[FileOperation] | None = None,
    ) -> None:
        items = self._history_by_conversation.get(conversation_id, [])
        items.append(
            CommandHistoryEntry(
                timestamp=time.time(),
                working_directory=result.executed_in,
                command=command,
                stdout=result.stdout,
                stderr=result.stderr,
                exit_code=result.exit_code,
                file_operations=file_ops,
            )
        )
        if len(items) > self._max_history:
            items = items[-self._max_history :]
        self._history_by_conversation[conversation_id] = items

    def _ensure_enabled(self) -> str | None:
        if self._config.enabled:
            return None
        return "Coder plugin is disabled. Set CODER_ENABLED=true to enable."

    def _resolve_within(self, conversation_id: str, target: str) -> str | None:
        cwd = self.get_current_directory(conversation_id)
        return validate_path(target, self._config.allowed_directory, cwd)

    async def change_directory(self, conversation_id: str, target: str) -> CommandResult:
        disabled = self._ensure_enabled()
        if disabled:
            return CommandResult(
                success=False,
                stdout="",
                stderr=disabled,
                exit_code=1,
                error="Coder disabled",
                executed_in=self.get_current_directory(conversation_id),
            )

        resolved = self._resolve_within(conversation_id, target)
        if not resolved:
            return CommandResult(
                success=False,
                stdout="",
                stderr="Cannot navigate outside allowed directory",
                exit_code=1,
                error="Permission denied",
                executed_in=self.get_current_directory(conversation_id),
            )

        p = Path(resolved)
        if not p.is_dir():
            return CommandResult(
                success=False,
                stdout="",
                stderr="Not a directory",
                exit_code=1,
                error="Not a directory",
                executed_in=self.get_current_directory(conversation_id),
            )

        self._set_current_directory(conversation_id, resolved)
        return CommandResult(
            success=True,
            stdout=f"Changed directory to: {resolved}",
            stderr="",
            exit_code=0,
            executed_in=resolved,
        )

    async def read_file(self, conversation_id: str, filepath: str) -> tuple[bool, str]:
        disabled = self._ensure_enabled()
        if disabled:
            return False, disabled

        resolved = self._resolve_within(conversation_id, filepath)
        if not resolved:
            return False, "Cannot access path outside allowed directory"

        p = Path(resolved)
        if p.is_dir():
            return False, "Path is a directory"
        if not p.exists():
            return False, "File not found"
        return True, p.read_text(encoding="utf-8")

    async def write_file(
        self, conversation_id: str, filepath: str, content: str
    ) -> tuple[bool, str]:
        disabled = self._ensure_enabled()
        if disabled:
            return False, disabled

        resolved = self._resolve_within(conversation_id, filepath)
        if not resolved:
            return False, "Cannot access path outside allowed directory"

        p = Path(resolved)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
        return True, ""

    async def edit_file(
        self, conversation_id: str, filepath: str, old_str: str, new_str: str
    ) -> tuple[bool, str]:
        disabled = self._ensure_enabled()
        if disabled:
            return False, disabled

        resolved = self._resolve_within(conversation_id, filepath)
        if not resolved:
            return False, "Cannot access path outside allowed directory"

        p = Path(resolved)
        if not p.exists():
            return False, "File not found"
        content = p.read_text(encoding="utf-8")
        if old_str not in content:
            return False, "Could not find old_str in file"
        p.write_text(content.replace(old_str, new_str, 1), encoding="utf-8")
        return True, ""

    async def list_files(self, conversation_id: str, dirpath: str) -> tuple[bool, list[str] | str]:
        disabled = self._ensure_enabled()
        if disabled:
            return False, disabled

        resolved = self._resolve_within(conversation_id, dirpath)
        if not resolved:
            return False, "Cannot access path outside allowed directory"

        p = Path(resolved)
        if not p.exists():
            return False, "Directory not found"
        if not p.is_dir():
            return False, "Not a directory"

        items: list[str] = []
        for child in sorted(p.iterdir(), key=lambda x: x.name):
            if child.name.startswith("."):
                continue
            items.append(f"{child.name}/" if child.is_dir() else child.name)
        return True, items

    async def search_files(
        self, conversation_id: str, pattern: str, dirpath: str, max_matches: int
    ) -> tuple[bool, list[SearchMatch] | str]:
        disabled = self._ensure_enabled()
        if disabled:
            return False, disabled

        needle = pattern.strip()
        if not needle:
            return False, "Missing pattern"

        resolved = self._resolve_within(conversation_id, dirpath)
        if not resolved:
            return False, "Cannot access path outside allowed directory"

        limit = max(1, min(500, int(max_matches))) if max_matches > 0 else 50
        matches: list[SearchMatch] = []
        await self._search_dir(Path(resolved), needle.lower(), matches, limit)
        return True, matches

    async def _search_dir(
        self, dirpath: Path, needle_lower: str, matches: list[SearchMatch], limit: int
    ) -> None:
        if len(matches) >= limit:
            return
        for entry in sorted(dirpath.iterdir(), key=lambda x: x.name):
            if len(matches) >= limit:
                break
            if entry.name.startswith("."):
                continue
            if entry.is_dir():
                if entry.name in {"node_modules", "dist", "build", "coverage", ".git"}:
                    continue
                await self._search_dir(entry, needle_lower, matches, limit)
                continue
            if not entry.is_file():
                continue
            try:
                text = entry.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                continue
            for idx, line in enumerate(text.splitlines(), start=1):
                if len(matches) >= limit:
                    break
                if needle_lower in line.lower():
                    matches.append(
                        SearchMatch(
                            file=str(entry.relative_to(Path(self.allowed_directory))),
                            line=idx,
                            content=line.strip()[:240],
                        )
                    )

    async def execute_shell(self, conversation_id: str, command: str) -> CommandResult:
        disabled = self._ensure_enabled()
        if disabled:
            return CommandResult(
                success=False,
                stdout="",
                stderr=disabled,
                exit_code=1,
                error="Coder disabled",
                executed_in=self.get_current_directory(conversation_id),
            )

        trimmed = command.strip()
        if not trimmed:
            return CommandResult(
                success=False,
                stdout="",
                stderr="Invalid command",
                exit_code=1,
                error="Empty command",
                executed_in=self.get_current_directory(conversation_id),
            )

        if not is_safe_command(trimmed):
            return CommandResult(
                success=False,
                stdout="",
                stderr="Command contains forbidden patterns",
                exit_code=1,
                error="Security policy violation",
                executed_in=self.get_current_directory(conversation_id),
            )

        if is_forbidden_command(trimmed, self._config.forbidden_commands):
            return CommandResult(
                success=False,
                stdout="",
                stderr="Command is forbidden by security policy",
                exit_code=1,
                error="Forbidden command",
                executed_in=self.get_current_directory(conversation_id),
            )

        cwd = self.get_current_directory(conversation_id)
        use_shell = any(ch in trimmed for ch in [">", "<", "|"])
        try:
            if use_shell:
                cmd_args = ["sh", "-c", trimmed]
            else:
                cmd_args = shlex.split(trimmed)

            timeout_seconds = self._config.timeout_ms / 1000.0
            proc = await asyncio.wait_for(
                asyncio.create_subprocess_exec(
                    *cmd_args,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    cwd=cwd,
                ),
                timeout=timeout_seconds,
            )
            stdout_b, stderr_b = await asyncio.wait_for(
                proc.communicate(),
                timeout=timeout_seconds,
            )
            stdout = stdout_b.decode("utf-8", errors="replace")
            stderr = stderr_b.decode("utf-8", errors="replace")
            result = CommandResult(
                success=proc.returncode == 0,
                stdout=stdout,
                stderr=stderr,
                exit_code=proc.returncode,
                executed_in=cwd,
            )
            self._add_history(conversation_id, trimmed, result)
            return result
        except TimeoutError:
            result = CommandResult(
                success=False,
                stdout="",
                stderr="Command timed out",
                exit_code=None,
                error="Command execution timeout",
                executed_in=cwd,
            )
            self._add_history(conversation_id, trimmed, result)
            return result

    async def git(self, conversation_id: str, args: str) -> CommandResult:
        return await self.execute_shell(conversation_id, f"git {args}")
