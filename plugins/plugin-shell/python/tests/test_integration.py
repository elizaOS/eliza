"""Integration tests for the Shell plugin."""

import pytest


class TestShellPluginStructure:
    """Tests for plugin structure."""

    def test_import_service(self) -> None:
        """Test that service can be imported."""
        from elizaos_plugin_shell import ShellService
        assert ShellService is not None

    def test_import_types(self) -> None:
        """Test that types can be imported."""
        from elizaos_plugin_shell import (
            ShellConfig,
            CommandResult,
            CommandHistoryEntry,
            FileOperation,
            FileOperationType,
        )
        assert ShellConfig is not None
        assert CommandResult is not None
        assert CommandHistoryEntry is not None
        assert FileOperation is not None
        assert FileOperationType is not None

    def test_import_utils(self) -> None:
        """Test that utils can be imported."""
        from elizaos_plugin_shell import (
            validate_path,
            is_safe_command,
            is_forbidden_command,
            extract_base_command,
            DEFAULT_FORBIDDEN_COMMANDS,
        )
        assert validate_path is not None
        assert is_safe_command is not None
        assert is_forbidden_command is not None
        assert extract_base_command is not None
        assert DEFAULT_FORBIDDEN_COMMANDS is not None

    def test_import_actions(self) -> None:
        """Test that actions can be imported."""
        from elizaos_plugin_shell import (
            ExecuteCommandAction,
            ClearHistoryAction,
        )
        assert ExecuteCommandAction is not None
        assert ClearHistoryAction is not None

    def test_import_providers(self) -> None:
        """Test that providers can be imported."""
        from elizaos_plugin_shell import ShellHistoryProvider
        assert ShellHistoryProvider is not None


class TestShellUtils:
    """Tests for shell utilities."""

    def test_is_safe_command(self) -> None:
        """Test safe command detection."""
        from elizaos_plugin_shell import is_safe_command
        
        # Safe commands
        assert is_safe_command("ls -la") is True
        assert is_safe_command("echo hello") is True
        assert is_safe_command("pwd") is True

    def test_is_unsafe_command(self) -> None:
        """Test unsafe command detection."""
        from elizaos_plugin_shell import is_safe_command
        
        # Unsafe commands
        assert is_safe_command("cd ../..") is False
        assert is_safe_command("echo $(whoami)") is False

    def test_extract_base_command(self) -> None:
        """Test base command extraction."""
        from elizaos_plugin_shell import extract_base_command
        
        assert extract_base_command("ls -la") == "ls"
        assert extract_base_command("echo hello world") == "echo"
        assert extract_base_command("git status") == "git"

    def test_is_forbidden_command(self) -> None:
        """Test forbidden command detection."""
        from elizaos_plugin_shell import is_forbidden_command
        
        forbidden = ["rm", "shutdown"]
        assert is_forbidden_command("rm test.txt", forbidden) is True
        assert is_forbidden_command("ls -la", forbidden) is False


class TestShellActions:
    """Tests for shell actions."""

    def test_execute_command_action_properties(self) -> None:
        """Test ExecuteCommandAction properties."""
        from elizaos_plugin_shell import ExecuteCommandAction
        
        action = ExecuteCommandAction()
        assert action.name == "EXECUTE_COMMAND"
        assert "RUN_COMMAND" in action.similes

    def test_clear_history_action_properties(self) -> None:
        """Test ClearHistoryAction properties."""
        from elizaos_plugin_shell import ClearHistoryAction
        
        action = ClearHistoryAction()
        assert action.name == "CLEAR_SHELL_HISTORY"

    @pytest.mark.asyncio
    async def test_execute_command_validation(self) -> None:
        """Test ExecuteCommandAction validation."""
        from elizaos_plugin_shell import ExecuteCommandAction
        
        action = ExecuteCommandAction()
        
        # Should validate command-related messages
        message = {"content": {"text": "run ls -la"}}
        assert await action.validate(message, {}) is True
        
        # Should not validate unrelated messages
        message = {"content": {"text": "hello world"}}
        assert await action.validate(message, {}) is False

    @pytest.mark.asyncio
    async def test_clear_history_validation(self) -> None:
        """Test ClearHistoryAction validation."""
        from elizaos_plugin_shell import ClearHistoryAction
        
        action = ClearHistoryAction()
        
        # Should validate clear history messages
        message = {"content": {"text": "clear my shell history"}}
        assert await action.validate(message, {}) is True
        
        # Should not validate unrelated messages
        message = {"content": {"text": "hello world"}}
        assert await action.validate(message, {}) is False


class TestShellProviders:
    """Tests for shell providers."""

    def test_shell_history_provider_properties(self) -> None:
        """Test ShellHistoryProvider properties."""
        from elizaos_plugin_shell import ShellHistoryProvider
        
        provider = ShellHistoryProvider()
        assert provider.name == "SHELL_HISTORY"
        assert provider.position == 99

    @pytest.mark.asyncio
    async def test_shell_history_provider_without_service(self) -> None:
        """Test provider returns error when no service."""
        from elizaos_plugin_shell import ShellHistoryProvider
        
        provider = ShellHistoryProvider()
        result = await provider.get({}, {}, None)
        
        assert "not available" in result.text.lower()
