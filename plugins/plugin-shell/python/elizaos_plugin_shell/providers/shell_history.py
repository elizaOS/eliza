from dataclasses import dataclass

from elizaos_plugin_shell.service import ShellService

MAX_OUTPUT_LENGTH = 8000
TRUNCATE_SEGMENT_LENGTH = 4000


@dataclass
class ProviderResult:
    values: dict
    text: str
    data: dict


class ShellHistoryProvider:
    @property
    def name(self) -> str:
        return "SHELL_HISTORY"

    @property
    def description(self) -> str:
        return (
            "Provides recent shell command history, current working directory, "
            "and file operations within the restricted environment"
        )

    @property
    def position(self) -> int:
        return 99

    async def get(
        self,
        message: dict,
        state: dict,
        service: ShellService | None = None,
    ) -> ProviderResult:
        if service is None:
            return ProviderResult(
                values={
                    "shellHistory": "Shell service is not available",
                    "currentWorkingDirectory": "N/A",
                    "allowedDirectory": "N/A",
                },
                text="# Shell Status\n\nShell service is not available",
                data={
                    "historyCount": 0,
                    "cwd": "N/A",
                    "allowedDir": "N/A",
                },
            )

        conversation_id = message.get("room_id") or message.get("agent_id") or "default"

        history = service.get_command_history(conversation_id, limit=10)
        cwd = service.get_current_directory(conversation_id)
        allowed_dir = service.get_allowed_directory()

        if not history:
            history_text = "No commands in history."
        else:
            history_entries = []
            for entry in history:
                entry_str = f"[{entry.timestamp}] {entry.working_directory}> {entry.command}"

                if entry.stdout:
                    stdout = entry.stdout
                    if len(stdout) > MAX_OUTPUT_LENGTH:
                        stdout = (
                            f"{stdout[:TRUNCATE_SEGMENT_LENGTH]}\n"
                            f"  ... [TRUNCATED] ...\n"
                            f"  {stdout[-TRUNCATE_SEGMENT_LENGTH:]}"
                        )
                    entry_str += f"\n  Output: {stdout}"

                if entry.stderr:
                    stderr = entry.stderr
                    if len(stderr) > MAX_OUTPUT_LENGTH:
                        stderr = (
                            f"{stderr[:TRUNCATE_SEGMENT_LENGTH]}\n"
                            f"  ... [TRUNCATED] ...\n"
                            f"  {stderr[-TRUNCATE_SEGMENT_LENGTH:]}"
                        )
                    entry_str += f"\n  Error: {stderr}"

                entry_str += f"\n  Exit Code: {entry.exit_code}"

                if entry.file_operations:
                    entry_str += "\n  File Operations:"
                    for op in entry.file_operations:
                        if op.secondary_target:
                            entry_str += f"\n    - {op.type}: {op.target} → {op.secondary_target}"
                        else:
                            entry_str += f"\n    - {op.type}: {op.target}"

                history_entries.append(entry_str)

            history_text = "\n\n".join(history_entries)

        recent_file_ops = []
        for entry in history:
            if entry.file_operations:
                recent_file_ops.extend(entry.file_operations)
        recent_file_ops = recent_file_ops[:5]

        file_ops_text = ""
        if recent_file_ops:
            ops_strs = []
            for op in recent_file_ops:
                if op.secondary_target:
                    ops_strs.append(f"- {op.type}: {op.target} → {op.secondary_target}")
                else:
                    ops_strs.append(f"- {op.type}: {op.target}")
            file_ops_text = "\n\n# Recent File Operations\n\n" + "\n".join(ops_strs)

        text = (
            f"Current Directory: {cwd}\n"
            f"Allowed Directory: {allowed_dir}\n\n"
            f"# Shell History (Last 10)\n\n{history_text}{file_ops_text}"
        )

        return ProviderResult(
            values={
                "shellHistory": history_text,
                "currentWorkingDirectory": str(cwd),
                "allowedDirectory": str(allowed_dir),
            },
            text=text,
            data={
                "historyCount": len(history),
                "cwd": str(cwd),
                "allowedDir": str(allowed_dir),
            },
        )
