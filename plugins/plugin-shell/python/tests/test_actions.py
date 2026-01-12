import pytest

from elizaos_plugin_shell.actions import (
    ClearHistoryAction,
    ExecuteCommandAction,
    get_shell_action_names,
)


class TestExecuteCommandAction:
    @pytest.fixture
    def action(self) -> ExecuteCommandAction:
        return ExecuteCommandAction()

    def test_action_name(self, action: ExecuteCommandAction) -> None:
        assert action.name == "EXECUTE_COMMAND"

    def test_action_similes(self, action: ExecuteCommandAction) -> None:
        similes = action.similes
        assert "RUN_COMMAND" in similes
        assert "SHELL_COMMAND" in similes
        assert "EXEC" in similes

    def test_action_description(self, action: ExecuteCommandAction) -> None:
        assert "shell command" in action.description.lower()
        assert "execute" in action.description.lower()

    @pytest.mark.asyncio
    async def test_validate_command_keywords(self, action: ExecuteCommandAction) -> None:
        assert await action.validate("run ls -la")
        assert await action.validate("execute the build command")
        assert await action.validate("show me files in directory")
        assert await action.validate("install package")

    @pytest.mark.asyncio
    async def test_validate_direct_commands(self, action: ExecuteCommandAction) -> None:
        assert await action.validate("ls -la")
        assert await action.validate("git status")
        assert await action.validate("npm install")
        assert await action.validate("brew install package")

    @pytest.mark.asyncio
    async def test_validate_non_command(self, action: ExecuteCommandAction) -> None:
        assert not await action.validate("hello there")
        assert not await action.validate("what is the weather")

    @pytest.mark.asyncio
    async def test_handler_success(self, action: ExecuteCommandAction) -> None:
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
        params: dict[str, object] = {"conversation_id": "test-conv"}
        
        with pytest.raises(ValueError, match="Missing 'command' parameter"):
            await action.handler(params)

    def test_examples(self, action: ExecuteCommandAction) -> None:
        examples = action.examples
        assert len(examples) > 0
        assert all(ex.input for ex in examples)
        assert all(ex.output for ex in examples)


class TestClearHistoryAction:
    @pytest.fixture
    def action(self) -> ClearHistoryAction:
        return ClearHistoryAction()

    def test_action_name(self, action: ClearHistoryAction) -> None:
        assert action.name == "CLEAR_SHELL_HISTORY"

    def test_action_similes(self, action: ClearHistoryAction) -> None:
        similes = action.similes
        assert "RESET_SHELL" in similes
        assert "CLEAR_TERMINAL" in similes

    @pytest.mark.asyncio
    async def test_validate_clear_history(self, action: ClearHistoryAction) -> None:
        assert await action.validate("clear the command history")
        assert await action.validate("reset my history")
        assert await action.validate("wipe the commands")
        assert await action.validate("forget all commands")

    @pytest.mark.asyncio
    async def test_validate_non_clear(self, action: ClearHistoryAction) -> None:
        assert not await action.validate("run ls")
        assert not await action.validate("show history")
        assert not await action.validate("clear the screen")

    @pytest.mark.asyncio
    async def test_handler_success(self, action: ClearHistoryAction) -> None:
        params = {"conversation_id": "test-conv"}
        result = await action.handler(params)
        
        assert result["action"] == "CLEAR_SHELL_HISTORY"
        assert result["conversation_id"] == "test-conv"
        assert result["status"] == "history_cleared"

    @pytest.mark.asyncio
    async def test_handler_missing_conversation_id(self, action: ClearHistoryAction) -> None:
        params: dict[str, object] = {}
        
        with pytest.raises(ValueError, match="Missing 'conversation_id' parameter"):
            await action.handler(params)


class TestActionRegistry:
    def test_get_shell_action_names(self) -> None:
        names = get_shell_action_names()
        assert "EXECUTE_COMMAND" in names
        assert "CLEAR_SHELL_HISTORY" in names
        assert len(names) == 2
