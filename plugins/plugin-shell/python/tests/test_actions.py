"""Tests for shell plugin actions."""

import pytest

from elizaos_plugin_shell.actions import (
    ClearHistoryAction,
    ExecuteCommandAction,
    get_shell_action_names,
)


class TestExecuteCommandAction:
    """Tests for ExecuteCommandAction."""

    @pytest.fixture
    def action(self) -> ExecuteCommandAction:
        return ExecuteCommandAction()

    def test_action_name(self, action: ExecuteCommandAction) -> None:
        """Test action name."""
        assert action.name == "EXECUTE_COMMAND"

    def test_action_similes(self, action: ExecuteCommandAction) -> None:
        """Test action similes."""
        similes = action.similes
        assert "RUN_COMMAND" in similes
        assert "SHELL_COMMAND" in similes
        assert "EXEC" in similes

    def test_action_description(self, action: ExecuteCommandAction) -> None:
        """Test action description."""
        assert "shell command" in action.description.lower()
        assert "execute" in action.description.lower()

    @pytest.mark.asyncio
    async def test_validate_command_keywords(self, action: ExecuteCommandAction) -> None:
        """Test validation with command keywords."""
        assert await action.validate("run ls -la")
        assert await action.validate("execute the build command")
        assert await action.validate("show me files in directory")
        assert await action.validate("install package")

    @pytest.mark.asyncio
    async def test_validate_direct_commands(self, action: ExecuteCommandAction) -> None:
        """Test validation with direct commands."""
        assert await action.validate("ls -la")
        assert await action.validate("git status")
        assert await action.validate("npm install")
        assert await action.validate("brew install package")

    @pytest.mark.asyncio
    async def test_validate_non_command(self, action: ExecuteCommandAction) -> None:
        """Test validation with non-command messages."""
        assert not await action.validate("hello there")
        assert not await action.validate("what is the weather")

    @pytest.mark.asyncio
    async def test_handler_success(self, action: ExecuteCommandAction) -> None:
        """Test handler with valid parameters."""
        params = {
            "command": "ls -la",
            "conversation_id": "test-conv",
        }
        result = await action.handler(params)
        
        assert result["action"] == "EXECUTE_COMMAND"
        assert result["command"] == "ls -la"
        assert result["conversation_id"] == "test-conv"
        assert result["status"] == "pending_execution"

    @pytest.mark.asyncio
    async def test_handler_missing_command(self, action: ExecuteCommandAction) -> None:
        """Test handler with missing command."""
        params: dict[str, object] = {"conversation_id": "test-conv"}
        
        with pytest.raises(ValueError, match="Missing 'command' parameter"):
            await action.handler(params)

    def test_examples(self, action: ExecuteCommandAction) -> None:
        """Test action examples."""
        examples = action.examples
        assert len(examples) > 0
        assert all(ex.input for ex in examples)
        assert all(ex.output for ex in examples)


class TestClearHistoryAction:
    """Tests for ClearHistoryAction."""

    @pytest.fixture
    def action(self) -> ClearHistoryAction:
        return ClearHistoryAction()

    def test_action_name(self, action: ClearHistoryAction) -> None:
        """Test action name."""
        assert action.name == "CLEAR_HISTORY"

    def test_action_similes(self, action: ClearHistoryAction) -> None:
        """Test action similes."""
        similes = action.similes
        assert "RESET_HISTORY" in similes
        assert "FORGET_COMMANDS" in similes

    @pytest.mark.asyncio
    async def test_validate_clear_history(self, action: ClearHistoryAction) -> None:
        """Test validation with clear history requests."""
        assert await action.validate("clear the command history")
        assert await action.validate("reset my history")
        assert await action.validate("wipe the commands")
        assert await action.validate("forget all commands")

    @pytest.mark.asyncio
    async def test_validate_non_clear(self, action: ClearHistoryAction) -> None:
        """Test validation with non-clear messages."""
        assert not await action.validate("run ls")
        assert not await action.validate("show history")  # show, not clear
        assert not await action.validate("clear the screen")  # no history mention

    @pytest.mark.asyncio
    async def test_handler_success(self, action: ClearHistoryAction) -> None:
        """Test handler with valid parameters."""
        params = {"conversation_id": "test-conv"}
        result = await action.handler(params)
        
        assert result["action"] == "CLEAR_HISTORY"
        assert result["conversation_id"] == "test-conv"
        assert result["status"] == "history_cleared"

    @pytest.mark.asyncio
    async def test_handler_missing_conversation_id(self, action: ClearHistoryAction) -> None:
        """Test handler with missing conversation_id."""
        params: dict[str, object] = {}
        
        with pytest.raises(ValueError, match="Missing 'conversation_id' parameter"):
            await action.handler(params)


class TestActionRegistry:
    """Tests for action registry functions."""

    def test_get_shell_action_names(self) -> None:
        """Test getting all shell action names."""
        names = get_shell_action_names()
        assert "EXECUTE_COMMAND" in names
        assert "CLEAR_HISTORY" in names
        assert len(names) == 2
