from dataclasses import dataclass

from elizaos_plugin_shell.service import ShellService


@dataclass
class ActionExample:
    user_message: str
    agent_response: str


@dataclass
class ActionResult:
    success: bool
    text: str
    data: dict | None = None
    error: str | None = None


class ExecuteCommandAction:
    COMMAND_KEYWORDS = [
        "run",
        "execute",
        "command",
        "shell",
        "install",
        "brew",
        "npm",
        "create",
        "file",
        "directory",
        "folder",
        "list",
        "show",
        "system",
        "info",
        "check",
        "status",
        "cd",
        "ls",
        "mkdir",
        "echo",
        "cat",
        "touch",
        "git",
        "build",
        "test",
    ]

    DIRECT_COMMANDS = [
        "brew",
        "npm",
        "apt",
        "git",
        "ls",
        "cd",
        "echo",
        "cat",
        "touch",
        "mkdir",
        "rm",
        "mv",
        "cp",
    ]

    @property
    def name(self) -> str:
        return "EXECUTE_COMMAND"

    @property
    def similes(self) -> list[str]:
        return [
            "RUN_COMMAND",
            "SHELL_COMMAND",
            "TERMINAL_COMMAND",
            "EXEC",
            "RUN",
            "EXECUTE",
            "CREATE_FILE",
            "WRITE_FILE",
            "MAKE_FILE",
            "INSTALL",
            "BREW_INSTALL",
            "NPM_INSTALL",
            "APT_INSTALL",
        ]

    @property
    def description(self) -> str:
        return (
            "Execute shell commands including brew install, npm install, apt-get, "
            "system commands, file operations, directory navigation, and scripts."
        )

    def _has_command_keyword(self, text: str) -> bool:
        lower = text.lower()
        return any(kw in lower for kw in self.COMMAND_KEYWORDS)

    def _has_direct_command(self, text: str) -> bool:
        lower = text.lower()
        for cmd in self.DIRECT_COMMANDS:
            if lower.startswith(cmd) and (len(lower) == len(cmd) or lower[len(cmd)] == " "):
                return True
        return False

    async def validate(self, message: dict, state: dict) -> bool:
        text = message.get("content", {}).get("text", "")
        return self._has_command_keyword(text) or self._has_direct_command(text)

    async def handler(
        self,
        message: dict,
        state: dict,
        service: ShellService | None = None,
    ) -> ActionResult:
        if service is None:
            return ActionResult(
                success=False,
                text="Shell service is not available.",
                error="Shell service is not available",
            )

        text = message.get("content", {}).get("text", "")
        command = self._extract_command_from_text(text)

        if not command:
            return ActionResult(
                success=False,
                text="Could not determine which command to execute. Please specify a shell command.",
                error="Could not extract command",
            )

        conversation_id = message.get("room_id") or message.get("agent_id")
        result = await service.execute_command(command, conversation_id)

        if result.success:
            output = (
                f"Output:\n```\n{result.stdout}\n```"
                if result.stdout
                else "Command completed with no output."
            )
            response_text = f"Command executed successfully in {result.executed_in}\n\n{output}"
        else:
            response_text = (
                f"Command failed with exit code {result.exit_code} in {result.executed_in}\n\n"
            )
            if result.stderr:
                response_text += f"Error output:\n```\n{result.stderr}\n```"

        return ActionResult(
            success=result.success,
            text=response_text,
            data={
                "command": command,
                "exit_code": result.exit_code,
                "stdout": result.stdout,
                "stderr": result.stderr,
            },
            error=None if result.success else result.stderr,
        )

    def _extract_command_from_text(self, text: str) -> str:
        lower = text.lower()

        direct_commands = [
            "ls",
            "cd",
            "pwd",
            "echo",
            "cat",
            "mkdir",
            "rm",
            "mv",
            "cp",
            "git",
            "npm",
            "brew",
            "apt",
        ]

        for cmd in direct_commands:
            if lower.startswith(cmd):
                return text
            if f"run {cmd}" in lower:
                pos = lower.find(f"run {cmd}")
                return text[pos + 4 :].strip()
            if f"execute {cmd}" in lower:
                pos = lower.find(f"execute {cmd}")
                return text[pos + 8 :].strip()

        if "run " in lower:
            pos = lower.find("run ")
            return text[pos + 4 :].strip()
        if "execute " in lower:
            pos = lower.find("execute ")
            return text[pos + 8 :].strip()

        if "list" in lower and ("file" in lower or "director" in lower):
            return "ls -la"
        if "git status" in lower or ("check" in lower and "git" in lower):
            return "git status"
        if "current director" in lower or "where am i" in lower:
            return "pwd"

        return ""

    def examples(self) -> list[ActionExample]:
        return [
            ActionExample(
                user_message="run ls -la",
                agent_response="I'll execute that command for you.",
            ),
            ActionExample(
                user_message="show me what files are in this directory",
                agent_response="I'll list the files in the current directory.",
            ),
            ActionExample(
                user_message="check the git status",
                agent_response="I'll check the git repository status.",
            ),
            ActionExample(
                user_message="create a file called hello.txt",
                agent_response="I'll create hello.txt for you.",
            ),
        ]
