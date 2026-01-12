"""Tests for shell plugin providers."""

import pytest

from elizaos_plugin_shell.providers import (
    ShellHistoryProvider,
    get_shell_provider_names,
)
from elizaos_plugin_shell.providers.shell_history import ProviderParams
from elizaos_plugin_shell.types import (
    CommandHistoryEntry,
    FileOperation,
    FileOperationType,
)


class TestShellHistoryProvider:
    """Tests for ShellHistoryProvider."""

    @pytest.fixture
    def provider(self) -> ShellHistoryProvider:
        return ShellHistoryProvider()

    def test_provider_name(self, provider: ShellHistoryProvider) -> None:
        """Test provider name."""
        assert provider.name == "SHELL_HISTORY"

    def test_provider_description(self, provider: ShellHistoryProvider) -> None:
        """Test provider description."""
        assert "history" in provider.description.lower()
        assert "command" in provider.description.lower()

    def test_provider_position(self, provider: ShellHistoryProvider) -> None:
        """Test provider position."""
        assert provider.position == 99

    def test_format_empty_history(self, provider: ShellHistoryProvider) -> None:
        """Test formatting empty history."""
        history: list[CommandHistoryEntry] = []
        formatted = ShellHistoryProvider.format_history(history)
        assert formatted == "No commands in history."

    def test_format_history_with_entries(self, provider: ShellHistoryProvider) -> None:
        """Test formatting history with entries."""
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
        
        formatted = ShellHistoryProvider.format_history(history)
        assert "ls -la" in formatted
        assert "file1.txt" in formatted
        assert "Exit Code: 0" in formatted

    def test_format_history_with_file_operations(self, provider: ShellHistoryProvider) -> None:
        """Test formatting history with file operations."""
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
        
        formatted = ShellHistoryProvider.format_history(history)
        assert "File Operations" in formatted
        assert "CREATE" in formatted
        assert "test.txt" in formatted

    def test_format_file_operations_empty(self, provider: ShellHistoryProvider) -> None:
        """Test formatting file operations when empty."""
        history: list[CommandHistoryEntry] = []
        formatted = ShellHistoryProvider.format_file_operations(history)
        assert formatted == ""

    def test_format_file_operations_with_entries(self, provider: ShellHistoryProvider) -> None:
        """Test formatting file operations."""
        history = [
            CommandHistoryEntry(
                command="mv a.txt b.txt",
                stdout="",
                stderr="",
                exit_code=0,
                timestamp=1234567890.0,
                working_directory="/home/user",
                file_operations=[
                    FileOperation(
                        type=FileOperationType.MOVE,
                        target="a.txt",
                        secondary_target="b.txt",
                    ),
                ],
            ),
        ]
        
        formatted = ShellHistoryProvider.format_file_operations(history)
        assert "Recent File Operations" in formatted
        assert "MOVE" in formatted
        assert "a.txt" in formatted
        assert "b.txt" in formatted

    @pytest.mark.asyncio
    async def test_get_provider_data(self, provider: ShellHistoryProvider) -> None:
        """Test getting provider data."""
        params = ProviderParams(
            conversation_id="test-conv",
            agent_id="test-agent",
        )
        
        result = await provider.get(params)
        
        assert "shellHistory" in result.values
        assert "currentWorkingDirectory" in result.values
        assert "allowedDirectory" in result.values
        assert "Current Directory" in result.text
        assert result.data["historyCount"] == 0


class TestProviderRegistry:
    """Tests for provider registry functions."""

    def test_get_shell_provider_names(self) -> None:
        """Test getting all shell provider names."""
        names = get_shell_provider_names()
        assert "SHELL_HISTORY" in names
        assert len(names) == 1
