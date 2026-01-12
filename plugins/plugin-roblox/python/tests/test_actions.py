import pytest

from elizaos_plugin_roblox.actions import (
    ExecuteGameActionAction,
    GetPlayerInfoAction,
    SendGameMessageAction,
    get_roblox_action_names,
)


class TestSendGameMessageAction:
    @pytest.fixture
    def action(self) -> SendGameMessageAction:
        return SendGameMessageAction()

    def test_action_name(self, action: SendGameMessageAction) -> None:
        assert action.name == "SEND_ROBLOX_MESSAGE"

    def test_action_similes(self, action: SendGameMessageAction) -> None:
        assert "GAME_MESSAGE" in action.similes
        assert "BROADCAST_MESSAGE" in action.similes

    @pytest.mark.asyncio
    async def test_validate_send_message(self, action: SendGameMessageAction) -> None:
        assert await action.validate("send a message to game players")
        assert await action.validate("tell everyone in roblox")
        assert not await action.validate("hello world")

    @pytest.mark.asyncio
    async def test_handler_success(self, action: SendGameMessageAction) -> None:
        params = {"content": "Hello players!"}
        result = await action.handler(params)

        assert result["action"] == "SEND_ROBLOX_MESSAGE"
        assert result["content"] == "Hello players!"

    @pytest.mark.asyncio
    async def test_handler_missing_content(self, action: SendGameMessageAction) -> None:
        with pytest.raises(ValueError, match="Missing 'content' parameter"):
            await action.handler({})


class TestExecuteGameActionAction:
    @pytest.fixture
    def action(self) -> ExecuteGameActionAction:
        return ExecuteGameActionAction()

    def test_action_name(self, action: ExecuteGameActionAction) -> None:
        assert action.name == "EXECUTE_ROBLOX_ACTION"

    @pytest.mark.asyncio
    async def test_validate_execute_action(self, action: ExecuteGameActionAction) -> None:
        assert await action.validate("trigger an event in the game")
        assert await action.validate("spawn a monster in roblox")
        assert not await action.validate("hello world")

    @pytest.mark.asyncio
    async def test_handler_success(self, action: ExecuteGameActionAction) -> None:
        params = {"action_name": "start_fireworks", "parameters": {"duration": 10}}
        result = await action.handler(params)

        assert result["action"] == "EXECUTE_ROBLOX_ACTION"
        assert result["action_name"] == "start_fireworks"


class TestGetPlayerInfoAction:
    @pytest.fixture
    def action(self) -> GetPlayerInfoAction:
        return GetPlayerInfoAction()

    def test_action_name(self, action: GetPlayerInfoAction) -> None:
        assert action.name == "GET_ROBLOX_PLAYER_INFO"

    @pytest.mark.asyncio
    async def test_validate_player_info(self, action: GetPlayerInfoAction) -> None:
        assert await action.validate("who is player123")
        assert await action.validate("lookup player info")
        assert not await action.validate("hello world")

    @pytest.mark.asyncio
    async def test_handler_success(self, action: GetPlayerInfoAction) -> None:
        params = {"identifier": "player123"}
        result = await action.handler(params)

        assert result["action"] == "GET_ROBLOX_PLAYER_INFO"
        assert result["identifier"] == "player123"


class TestActionRegistry:
    def test_get_roblox_action_names(self) -> None:
        names = get_roblox_action_names()
        assert "SEND_ROBLOX_MESSAGE" in names
        assert "EXECUTE_ROBLOX_ACTION" in names
        assert "GET_ROBLOX_PLAYER_INFO" in names
        assert len(names) == 3
