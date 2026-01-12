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
        message = {"content": {"text": "run ls -la"}}
        state: dict[str, object] = {}
        assert await action.validate(message, state)

        message = {"content": {"text": "execute the build command"}}
        assert await action.validate(message, state)

        message = {"content": {"text": "show me files in directory"}}
        assert await action.validate(message, state)

        message = {"content": {"text": "install package"}}
        assert await action.validate(message, state)

    @pytest.mark.asyncio
    async def test_validate_direct_commands(self, action: ExecuteCommandAction) -> None:
        state: dict[str, object] = {}

        message = {"content": {"text": "ls -la"}}
        assert await action.validate(message, state)

        message = {"content": {"text": "git status"}}
        assert await action.validate(message, state)

        message = {"content": {"text": "npm install"}}
        assert await action.validate(message, state)

        message = {"content": {"text": "brew install package"}}
        assert await action.validate(message, state)

    @pytest.mark.asyncio
    async def test_validate_non_command(self, action: ExecuteCommandAction) -> None:
        state: dict[str, object] = {}

        message = {"content": {"text": "hello there"}}
        assert not await action.validate(message, state)

        message = {"content": {"text": "what is the weather"}}
        assert not await action.validate(message, state)

    @pytest.mark.asyncio
    async def test_handler_without_service(self, action: ExecuteCommandAction) -> None:
        message = {
            "content": {"text": "ls -la"},
            "room_id": "test-conv",
        }
        state: dict[str, object] = {}

        result = await action.handler(message, state, service=None)

        assert not result.success
        assert "not available" in result.text.lower()

    def test_examples(self, action: ExecuteCommandAction) -> None:
        examples = action.examples()
        assert len(examples) > 0
        assert all(ex.user_message for ex in examples)
        assert all(ex.agent_response for ex in examples)


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
        state: dict[str, object] = {}

        message = {"content": {"text": "clear the command history"}}
        assert await action.validate(message, state)

        message = {"content": {"text": "reset my history"}}
        assert await action.validate(message, state)

        message = {"content": {"text": "wipe the commands"}}
        assert await action.validate(message, state)

        message = {"content": {"text": "forget all commands"}}
        assert await action.validate(message, state)

    @pytest.mark.asyncio
    async def test_validate_non_clear(self, action: ClearHistoryAction) -> None:
        state: dict[str, object] = {}

        message = {"content": {"text": "run ls"}}
        assert not await action.validate(message, state)

        message = {"content": {"text": "show history"}}
        assert not await action.validate(message, state)

        message = {"content": {"text": "clear the screen"}}
        assert not await action.validate(message, state)

    @pytest.mark.asyncio
    async def test_handler_without_service(self, action: ClearHistoryAction) -> None:
        message = {"content": {"text": "clear history"}, "room_id": "test-conv"}
        state: dict[str, object] = {}

        result = await action.handler(message, state, service=None)

        assert not result.success
        assert "not available" in result.text.lower()


class TestActionRegistry:
    def test_get_shell_action_names(self) -> None:
        names = get_shell_action_names()
        assert "EXECUTE_COMMAND" in names
        assert "CLEAR_SHELL_HISTORY" in names
        assert len(names) == 2
