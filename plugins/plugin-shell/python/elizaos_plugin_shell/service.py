from __future__ import annotations

import asyncio
import logging
import os
import shlex
import subprocess
import time

from elizaos_plugin_shell.path_utils import (
    is_forbidden_command,
    is_safe_command,
    validate_path,
)
from elizaos_plugin_shell.types import (
    CommandHistoryEntry,
    CommandResult,
    FileOperation,
    FileOperationType,
    ShellConfig,
)

logger = logging.getLogger(__name__)


class ShellService:
    def __init__(self, config: ShellConfig) -> None:
        self._config = config
        self._current_directory = config.allowed_directory
        self._command_history: dict[str, list[CommandHistoryEntry]] = {}
        self._max_history_per_conversation = 100
        logger.info("Shell service initialized with history tracking")

    @property
    def current_directory(self) -> str:
        return self._current_directory

    @property
    def allowed_directory(self) -> str:
        return self._config.allowed_directory

    async def execute_command(
        self,
        command: str,
        conversation_id: str | None = None,
    ) -> CommandResult:
        if not self._config.enabled:
            return CommandResult(
                success=False,
                stdout="",
                stderr="Shell plugin is disabled. Set SHELL_ENABLED=true to enable.",
                exit_code=1,
                error="Shell plugin disabled",
                executed_in=self._current_directory,
            )

        if not command or not isinstance(command, str):
            return CommandResult(
                success=False,
                stdout="",
                stderr="Invalid command",
                exit_code=1,
                error="Command must be a non-empty string",
                executed_in=self._current_directory,
            )

        trimmed_command = command.strip()

        if not is_safe_command(trimmed_command):
            return CommandResult(
                success=False,
                stdout="",
                stderr="Command contains forbidden patterns",
                exit_code=1,
                error="Security policy violation",
                executed_in=self._current_directory,
            )

        if is_forbidden_command(trimmed_command, self._config.forbidden_commands):
            return CommandResult(
                success=False,
                stdout="",
                stderr="Command is forbidden by security policy",
                exit_code=1,
                error="Forbidden command",
                executed_in=self._current_directory,
            )

        if trimmed_command.startswith("cd "):
            result = await self._handle_cd_command(trimmed_command)
            self._add_to_history(conversation_id, trimmed_command, result)
            return result

        result = await self._run_command(trimmed_command)

        if result.success:
            file_ops = self._detect_file_operations(trimmed_command, self._current_directory)
            self._add_to_history(conversation_id, trimmed_command, result, file_ops)
        else:
            self._add_to_history(conversation_id, trimmed_command, result)

        return result

    async def _handle_cd_command(self, command: str) -> CommandResult:
        parts = command.split()
        if len(parts) < 2:
            self._current_directory = self._config.allowed_directory
            return CommandResult(
                success=True,
                stdout=f"Changed directory to: {self._current_directory}",
                stderr="",
                exit_code=0,
                executed_in=self._current_directory,
            )

        target_path = " ".join(parts[1:])
        validated_path = validate_path(
            target_path,
            self._config.allowed_directory,
            self._current_directory,
        )

        if not validated_path:
            return CommandResult(
                success=False,
                stdout="",
                stderr="Cannot navigate outside allowed directory",
                exit_code=1,
                error="Permission denied",
                executed_in=self._current_directory,
            )

        self._current_directory = validated_path
        return CommandResult(
            success=True,
            stdout=f"Changed directory to: {self._current_directory}",
            stderr="",
            exit_code=0,
            executed_in=self._current_directory,
        )

    async def _run_command(self, command: str) -> CommandResult:
        use_shell = any(char in command for char in [">", "<", "|"])

        try:
            if use_shell:
                cmd_args = ["sh", "-c", command]
                logger.info(
                    f'Executing shell command: sh -c "{command}" in {self._current_directory}'
                )
            else:
                cmd_args = shlex.split(command)
                logger.info(f"Executing command: {' '.join(cmd_args)} in {self._current_directory}")

            timeout_seconds = self._config.timeout / 1000.0

            try:
                process = await asyncio.wait_for(
                    asyncio.create_subprocess_exec(
                        *cmd_args,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        cwd=self._current_directory,
                        env=os.environ.copy(),
                    ),
                    timeout=timeout_seconds,
                )
                stdout_bytes, stderr_bytes = await asyncio.wait_for(
                    process.communicate(),
                    timeout=timeout_seconds,
                )

                stdout = stdout_bytes.decode("utf-8", errors="replace")
                stderr = stderr_bytes.decode("utf-8", errors="replace")

                return CommandResult(
                    success=process.returncode == 0,
                    stdout=stdout,
                    stderr=stderr,
                    exit_code=process.returncode,
                    executed_in=self._current_directory,
                )

            except TimeoutError:
                return CommandResult(
                    success=False,
                    stdout="",
                    stderr="Command timed out",
                    exit_code=None,
                    error="Command execution timeout",
                    executed_in=self._current_directory,
                )

        except FileNotFoundError:
            return CommandResult(
                success=False,
                stdout="",
                stderr=f"Command not found: {cmd_args[0]}",
                exit_code=127,
                error="Command not found",
                executed_in=self._current_directory,
            )
        except Exception as e:
            return CommandResult(
                success=False,
                stdout="",
                stderr=str(e),
                exit_code=1,
                error="Failed to execute command",
                executed_in=self._current_directory,
            )

    def _add_to_history(
        self,
        conversation_id: str | None,
        command: str,
        result: CommandResult,
        file_operations: list[FileOperation] | None = None,
    ) -> None:
        if not conversation_id:
            return

        entry = CommandHistoryEntry(
            command=command,
            stdout=result.stdout,
            stderr=result.stderr,
            exit_code=result.exit_code,
            timestamp=time.time(),
            working_directory=result.executed_in,
            file_operations=file_operations,
        )

        if conversation_id not in self._command_history:
            self._command_history[conversation_id] = []

        history = self._command_history[conversation_id]
        history.append(entry)

        if len(history) > self._max_history_per_conversation:
            self._command_history[conversation_id] = history[1:]

    def _detect_file_operations(
        self,
        command: str,
        cwd: str,
    ) -> list[FileOperation] | None:
        import re

        operations = []
        parts = command.strip().split()
        cmd = parts[0].lower() if parts else ""

        def resolve_path(path: str) -> str:
            if os.path.isabs(path):
                return path
            return os.path.join(cwd, path)

        if cmd == "touch" and len(parts) > 1:
            operations.append(
                FileOperation(
                    type=FileOperationType.CREATE,
                    target=resolve_path(parts[1]),
                )
            )
        elif cmd == "echo" and ">" in command:
            match = re.search(r">\s*([^\s]+)$", command)
            if match:
                operations.append(
                    FileOperation(
                        type=FileOperationType.WRITE,
                        target=resolve_path(match.group(1)),
                    )
                )
        elif cmd == "mkdir" and len(parts) > 1:
            operations.append(
                FileOperation(
                    type=FileOperationType.MKDIR,
                    target=resolve_path(parts[1]),
                )
            )
        elif cmd == "cat" and len(parts) > 1 and ">" not in command:
            operations.append(
                FileOperation(
                    type=FileOperationType.READ,
                    target=resolve_path(parts[1]),
                )
            )
        elif cmd == "mv" and len(parts) > 2:
            operations.append(
                FileOperation(
                    type=FileOperationType.MOVE,
                    target=resolve_path(parts[1]),
                    secondary_target=resolve_path(parts[2]),
                )
            )
        elif cmd == "cp" and len(parts) > 2:
            operations.append(
                FileOperation(
                    type=FileOperationType.COPY,
                    target=resolve_path(parts[1]),
                    secondary_target=resolve_path(parts[2]),
                )
            )

        return operations if operations else None

    def get_command_history(
        self,
        conversation_id: str,
        limit: int | None = None,
    ) -> list[CommandHistoryEntry]:
        history = self._command_history.get(conversation_id, [])
        if limit and limit > 0:
            return history[-limit:]
        return history

    def clear_command_history(self, conversation_id: str) -> None:
        if conversation_id in self._command_history:
            del self._command_history[conversation_id]
        logger.info(f"Cleared command history for conversation: {conversation_id}")

    def get_current_directory(self, conversation_id: str | None = None) -> str:
        return self._current_directory

    def get_allowed_directory(self) -> str:
        return self._config.allowed_directory
