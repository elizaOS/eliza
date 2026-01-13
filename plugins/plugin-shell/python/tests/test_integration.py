import pytest


class TestShellPluginStructure:
    def test_import_service(self) -> None:
        from elizaos_plugin_shell import ShellService

        assert ShellService is not None

    def test_import_types(self) -> None:
        from elizaos_plugin_shell import (
            CommandHistoryEntry,
            CommandResult,
            FileOperation,
            FileOperationType,
            ShellConfig,
        )

        assert ShellConfig is not None
        assert CommandResult is not None
        assert CommandHistoryEntry is not None
        assert FileOperation is not None
        assert FileOperationType is not None

    def test_import_utils(self) -> None:
        from elizaos_plugin_shell import (
            DEFAULT_FORBIDDEN_COMMANDS,
            extract_base_command,
            is_forbidden_command,
            is_safe_command,
            validate_path,
        )

        assert validate_path is not None
        assert is_safe_command is not None
        assert is_forbidden_command is not None
        assert extract_base_command is not None
        assert DEFAULT_FORBIDDEN_COMMANDS is not None

    def test_import_actions(self) -> None:
        from elizaos_plugin_shell import (
            ClearHistoryAction,
            ExecuteCommandAction,
        )

        assert ExecuteCommandAction is not None
        assert ClearHistoryAction is not None

    def test_import_providers(self) -> None:
        from elizaos_plugin_shell import ShellHistoryProvider

        assert ShellHistoryProvider is not None


class TestShellUtils:
    def test_is_safe_command(self) -> None:
        from elizaos_plugin_shell import is_safe_command

        assert is_safe_command("ls -la") is True
        assert is_safe_command("echo hello") is True
        assert is_safe_command("pwd") is True

    def test_is_unsafe_command(self) -> None:
        from elizaos_plugin_shell import is_safe_command

        assert is_safe_command("cd ../..") is False
        assert is_safe_command("echo $(whoami)") is False

    def test_extract_base_command(self) -> None:
        from elizaos_plugin_shell import extract_base_command

        assert extract_base_command("ls -la") == "ls"
        assert extract_base_command("echo hello world") == "echo"
        assert extract_base_command("git status") == "git"

    def test_is_forbidden_command(self) -> None:
        from elizaos_plugin_shell import is_forbidden_command

        forbidden = ["rm", "shutdown"]
        assert is_forbidden_command("rm test.txt", forbidden) is True
        assert is_forbidden_command("ls -la", forbidden) is False


class TestShellActions:
    def test_execute_command_action_properties(self) -> None:
        from elizaos_plugin_shell import ExecuteCommandAction

        action = ExecuteCommandAction()
        assert action.name == "EXECUTE_COMMAND"
        assert "RUN_COMMAND" in action.similes

    def test_clear_history_action_properties(self) -> None:
        from elizaos_plugin_shell import ClearHistoryAction

        action = ClearHistoryAction()
        assert action.name == "CLEAR_SHELL_HISTORY"

    @pytest.mark.asyncio
    async def test_execute_command_validation(self) -> None:
        from elizaos_plugin_shell import ExecuteCommandAction

        action = ExecuteCommandAction()

        message = {"content": {"text": "run ls -la"}}
        assert await action.validate(message, {}) is True

        message = {"content": {"text": "hello world"}}
        assert await action.validate(message, {}) is False

    @pytest.mark.asyncio
    async def test_clear_history_validation(self) -> None:
        from elizaos_plugin_shell import ClearHistoryAction

        action = ClearHistoryAction()

        message = {"content": {"text": "clear my shell history"}}
        assert await action.validate(message, {}) is True

        message = {"content": {"text": "hello world"}}
        assert await action.validate(message, {}) is False


class TestShellProviders:
    def test_shell_history_provider_properties(self) -> None:
        from elizaos_plugin_shell import ShellHistoryProvider

        provider = ShellHistoryProvider()
        assert provider.name == "SHELL_HISTORY"
        assert provider.position == 99

    @pytest.mark.asyncio
    async def test_shell_history_provider_without_service(self) -> None:
        from elizaos_plugin_shell import ShellHistoryProvider

        provider = ShellHistoryProvider()
        result = await provider.get({}, {}, None)

        assert "not available" in result.text.lower()
