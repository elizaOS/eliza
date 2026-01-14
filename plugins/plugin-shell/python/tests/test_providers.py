from unittest.mock import MagicMock

import pytest

from elizaos_plugin_shell.providers import (
    ShellHistoryProvider,
    get_shell_provider_names,
)
from elizaos_plugin_shell.types import (
    CommandHistoryEntry,
    FileOperation,
    FileOperationType,
)


class TestShellHistoryProvider:
    @pytest.fixture
    def provider(self) -> ShellHistoryProvider:
        return ShellHistoryProvider()

    def test_provider_name(self, provider: ShellHistoryProvider) -> None:
        assert provider.name == "SHELL_HISTORY"

    def test_provider_description(self, provider: ShellHistoryProvider) -> None:
        assert "history" in provider.description.lower()
        assert "command" in provider.description.lower()

    def test_provider_position(self, provider: ShellHistoryProvider) -> None:
        assert provider.position == 99

    @pytest.mark.asyncio
    async def test_get_provider_data_no_service(self, provider: ShellHistoryProvider) -> None:
        """Test provider returns appropriate values when no service is available."""
        message = {"room_id": "test-conv", "agent_id": "test-agent"}
        state: dict = {}

        result = await provider.get(message, state, service=None)

        assert "shellHistory" in result.values
        assert "currentWorkingDirectory" in result.values
        assert "allowedDirectory" in result.values
        assert result.data["historyCount"] == 0

    @pytest.mark.asyncio
    async def test_get_provider_data_with_service(self, provider: ShellHistoryProvider) -> None:
        """Test provider returns history from service."""
        mock_service = MagicMock()
        mock_service.get_command_history.return_value = []
        mock_service.get_current_directory.return_value = "/home/user"
        mock_service.get_allowed_directory.return_value = "/home/user"

        message = {"room_id": "test-conv"}
        state: dict = {}

        result = await provider.get(message, state, service=mock_service)

        assert result.values["currentWorkingDirectory"] == "/home/user"
        assert result.values["allowedDirectory"] == "/home/user"
        assert "No commands in history" in result.values["shellHistory"]

    @pytest.mark.asyncio
    async def test_get_provider_data_with_history(self, provider: ShellHistoryProvider) -> None:
        """Test provider formats history entries correctly."""
        history = [
            CommandHistoryEntry(
                command="ls -la",
                stdout="file1.txt\nfile2.txt",
                stderr="",
                exit_code=0,
                timestamp=1234567890.0,
                working_directory="/home/user",
            ),
        ]

        mock_service = MagicMock()
        mock_service.get_command_history.return_value = history
        mock_service.get_current_directory.return_value = "/home/user"
        mock_service.get_allowed_directory.return_value = "/home/user"

        message = {"room_id": "test-conv"}
        state: dict = {}

        result = await provider.get(message, state, service=mock_service)

        assert "ls -la" in result.values["shellHistory"]
        assert "file1.txt" in result.values["shellHistory"]
        assert "Exit Code: 0" in result.values["shellHistory"]
        assert result.data["historyCount"] == 1

    @pytest.mark.asyncio
    async def test_get_provider_data_with_file_operations(
        self, provider: ShellHistoryProvider
    ) -> None:
        """Test provider includes file operations in output."""
        history = [
            CommandHistoryEntry(
                command="touch test.txt",
                stdout="",
                stderr="",
                exit_code=0,
                timestamp=1234567890.0,
                working_directory="/home/user",
                file_operations=[
                    FileOperation(
                        type=FileOperationType.CREATE,
                        target="/home/user/test.txt",
                    ),
                ],
            ),
        ]

        mock_service = MagicMock()
        mock_service.get_command_history.return_value = history
        mock_service.get_current_directory.return_value = "/home/user"
        mock_service.get_allowed_directory.return_value = "/home/user"

        message = {"room_id": "test-conv"}
        state: dict = {}

        result = await provider.get(message, state, service=mock_service)

        assert "File Operations" in result.text
        assert "CREATE" in result.text


class TestProviderRegistry:
    def test_get_shell_provider_names(self) -> None:
        names = get_shell_provider_names()
        assert "SHELL_HISTORY" in names
        assert len(names) == 1
