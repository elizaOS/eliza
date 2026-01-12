from unittest.mock import patch

import pytest

from elizaos_plugin_shell import ShellConfig, ShellService
from elizaos_plugin_shell.types import CommandResult


class TestShellHistory:
    @pytest.fixture
    def config(self) -> ShellConfig:
        return ShellConfig(
            enabled=True,
            allowed_directory="/test/allowed",
            timeout=30000,
            forbidden_commands=["rm", "rmdir"],
        )

    @pytest.fixture
    def service(self, config: ShellConfig) -> ShellService:
        return ShellService(config)

    @pytest.mark.asyncio
    async def test_tracks_command_history(self, service: ShellService) -> None:
        conversation_id = "test-conversation-1"

        mock_result = CommandResult(
            success=True,
            stdout="file1.txt\nfile2.txt",
            stderr="",
            exit_code=0,
            executed_in="/test/allowed",
        )

        async def mock_run_command(cmd: str) -> CommandResult:
            return mock_result

        with patch.object(service, "_run_command", mock_run_command):
            await service.execute_command("ls", conversation_id)

            history = service.get_command_history(conversation_id)
            assert len(history) == 1
            assert history[0].command == "ls"
            assert history[0].exit_code == 0

    @pytest.mark.asyncio
    async def test_clears_history(self, service: ShellService) -> None:
        conversation_id = "test-conversation-2"

        mock_result = CommandResult(
            success=True,
            stdout="output",
            stderr="",
            exit_code=0,
            executed_in="/test/allowed",
        )

        async def mock_run_command(cmd: str) -> CommandResult:
            return mock_result

        with patch.object(service, "_run_command", mock_run_command):
            await service.execute_command("ls", conversation_id)
            await service.execute_command("pwd", conversation_id)

            assert len(service.get_command_history(conversation_id)) == 2

            service.clear_command_history(conversation_id)
            assert len(service.get_command_history(conversation_id)) == 0

    @pytest.mark.asyncio
    async def test_separate_history_per_conversation(self, service: ShellService) -> None:
        conv1 = "conv-1"
        conv2 = "conv-2"

        mock_result = CommandResult(
            success=True,
            stdout="output",
            stderr="",
            exit_code=0,
            executed_in="/test/allowed",
        )

        async def mock_run_command(cmd: str) -> CommandResult:
            return mock_result

        with patch.object(service, "_run_command", mock_run_command):
            await service.execute_command("ls", conv1)
            await service.execute_command("pwd", conv2)
            await service.execute_command("echo test", conv1)

            history1 = service.get_command_history(conv1)
            history2 = service.get_command_history(conv2)

            assert len(history1) == 2
            assert history1[0].command == "ls"
            assert history1[1].command == "echo test"

            assert len(history2) == 1
            assert history2[0].command == "pwd"


class TestShellDisabled:
    @pytest.mark.asyncio
    async def test_returns_error_when_disabled(self) -> None:
        config = ShellConfig(
            enabled=False,
            allowed_directory="/test",
            timeout=30000,
            forbidden_commands=[],
        )
        service = ShellService(config)

        result = await service.execute_command("ls")
        assert result.success is False
        assert "disabled" in result.stderr.lower()


class TestSecurityValidation:
    @pytest.fixture
    def config(self) -> ShellConfig:
        return ShellConfig(
            enabled=True,
            allowed_directory="/test/allowed",
            timeout=30000,
            forbidden_commands=["shutdown", "reboot"],
        )

    @pytest.fixture
    def service(self, config: ShellConfig) -> ShellService:
        return ShellService(config)

    @pytest.mark.asyncio
    async def test_rejects_forbidden_commands(self, service: ShellService) -> None:
        result = await service.execute_command("shutdown now")
        assert result.success is False
        assert "forbidden" in result.stderr.lower()

    @pytest.mark.asyncio
    async def test_rejects_path_traversal(self, service: ShellService) -> None:
        result = await service.execute_command("cd ../../../etc")
        assert result.success is False
