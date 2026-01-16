from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
from google.protobuf.json_format import MessageToDict

from elizaos.bootstrap.autonomy import (
    AUTONOMY_SERVICE_TYPE,
    AutonomyService,
    admin_chat_provider,
    autonomy_status_provider,
    send_to_admin_action,
)
from elizaos.bootstrap.autonomy.types import AutonomyStatus
from elizaos.types.memory import Memory
from elizaos.types.primitives import Content, as_uuid

TEST_AGENT_ID = "00000000-0000-0000-0000-000000000001"
TEST_ROOM_ID = "00000000-0000-0000-0000-000000000002"
TEST_ENTITY_ID = "00000000-0000-0000-0000-000000000003"
TEST_MESSAGE_ID = "00000000-0000-0000-0000-000000000004"
OTHER_ROOM_ID = "00000000-0000-0000-0000-000000000005"
AUTONOMOUS_ROOM_ID = "00000000-0000-0000-0000-000000000006"


@pytest.fixture
def test_runtime():
    runtime = MagicMock()
    runtime.agent_id = as_uuid(TEST_AGENT_ID)
    runtime.character = MagicMock()
    runtime.character.name = "Test Agent"

    runtime.ensure_world_exists = AsyncMock()
    runtime.ensure_room_exists = AsyncMock()
    runtime.add_participant = AsyncMock()
    runtime.get_entity_by_id = AsyncMock(return_value=MagicMock(id=TEST_AGENT_ID))
    runtime.get_memories = AsyncMock(return_value=[])
    runtime.emit_event = AsyncMock()
    runtime.create_memory = AsyncMock(return_value="memory-id")

    runtime.get_setting = MagicMock(return_value=None)
    runtime.set_setting = MagicMock()
    runtime.enable_autonomy = False

    runtime.logger = MagicMock()
    runtime.logger.info = MagicMock()
    runtime.logger.debug = MagicMock()
    runtime.logger.error = MagicMock()
    runtime.logger.warn = MagicMock()

    return runtime


@pytest.fixture
def test_memory():
    return Memory(
        id=as_uuid(TEST_MESSAGE_ID),
        room_id=as_uuid(TEST_ROOM_ID),
        entity_id=as_uuid(TEST_ENTITY_ID),
        agent_id=as_uuid(TEST_AGENT_ID),
        content=Content(text="Test message"),
        created_at=1234567890,
    )


class TestAutonomyService:
    def test_service_type(self):
        assert AutonomyService.service_type == AUTONOMY_SERVICE_TYPE
        assert AutonomyService.service_type == "AUTONOMY"

    @pytest.mark.asyncio
    async def test_start_creates_service(self, test_runtime):
        service = await AutonomyService.start(test_runtime)

        assert service is not None
        assert isinstance(service, AutonomyService)
        assert service.is_loop_running() is False
        assert service.get_loop_interval() == 30000
        assert service.get_autonomous_room_id() is not None

    @pytest.mark.asyncio
    async def test_auto_start_when_enabled(self, test_runtime):
        test_runtime.enable_autonomy = True

        service = await AutonomyService.start(test_runtime)

        assert service.is_loop_running() is True

        await service.stop_loop()

    @pytest.mark.asyncio
    async def test_ensure_context_on_initialization(self, test_runtime):
        _ = await AutonomyService.start(test_runtime)

        test_runtime.ensure_world_exists.assert_called_once()
        test_runtime.ensure_room_exists.assert_called_once()
        test_runtime.add_participant.assert_called_once()

        world_call = test_runtime.ensure_world_exists.call_args[0][0]
        assert world_call.name == "Autonomy World"
        assert world_call.metadata is not None
        assert (
            MessageToDict(world_call.metadata, preserving_proto_field_name=False).get("type")
            == "autonomy"
        )

        room_call = test_runtime.ensure_room_exists.call_args[0][0]
        assert room_call.name == "Autonomous Thoughts"
        assert room_call.source == "autonomy-service"

    @pytest.mark.asyncio
    async def test_start_stop_loop(self, test_runtime):
        service = await AutonomyService.start(test_runtime)

        assert service.is_loop_running() is False

        await service.start_loop()
        assert service.is_loop_running() is True
        assert test_runtime.enable_autonomy is True

        await service.stop_loop()
        assert service.is_loop_running() is False
        assert test_runtime.enable_autonomy is False

    @pytest.mark.asyncio
    async def test_no_double_start(self, test_runtime):
        service = await AutonomyService.start(test_runtime)

        await service.start_loop()
        call_count = test_runtime.set_setting.call_count

        await service.start_loop()
        assert test_runtime.set_setting.call_count == call_count

        await service.stop_loop()

    @pytest.mark.asyncio
    async def test_no_double_stop(self, test_runtime):
        service = await AutonomyService.start(test_runtime)

        call_count = test_runtime.set_setting.call_count
        await service.stop_loop()
        assert test_runtime.set_setting.call_count == call_count

    @pytest.mark.asyncio
    async def test_interval_configuration(self, test_runtime):
        service = await AutonomyService.start(test_runtime)

        service.set_loop_interval(60000)
        assert service.get_loop_interval() == 60000

    @pytest.mark.asyncio
    async def test_interval_minimum_enforced(self, test_runtime):
        service = await AutonomyService.start(test_runtime)

        service.set_loop_interval(1000)
        assert service.get_loop_interval() == 5000

    @pytest.mark.asyncio
    async def test_interval_maximum_enforced(self, test_runtime):
        service = await AutonomyService.start(test_runtime)

        service.set_loop_interval(1000000)
        assert service.get_loop_interval() == 600000

    @pytest.mark.asyncio
    async def test_target_room_context_dedupes_by_earliest_created_at(self, test_runtime):
        service = await AutonomyService.start(test_runtime)
        target_room_id = as_uuid(OTHER_ROOM_ID)
        test_runtime.get_setting = MagicMock(return_value=str(target_room_id))

        dup_id = as_uuid(TEST_MESSAGE_ID)
        older = Memory(
            id=dup_id,
            room_id=target_room_id,
            entity_id=as_uuid(TEST_ENTITY_ID),
            agent_id=as_uuid(TEST_AGENT_ID),
            content=Content(text="old"),
            created_at=10,
        )
        newer = Memory(
            id=dup_id,
            room_id=target_room_id,
            entity_id=as_uuid(TEST_ENTITY_ID),
            agent_id=as_uuid(TEST_AGENT_ID),
            content=Content(text="new"),
            created_at=20,
        )

        async def get_memories(params):
            if params["tableName"] == "memories":
                return [newer]
            return [older]

        test_runtime.get_memories = AsyncMock(side_effect=get_memories)

        context = await service._get_target_room_context_text()
        assert "old" in context
        assert "new" not in context

    @pytest.mark.asyncio
    async def test_enable_autonomy(self, test_runtime):
        service = await AutonomyService.start(test_runtime)

        await service.enable_autonomy()

        assert test_runtime.enable_autonomy is True
        assert service.is_loop_running() is True

        await service.stop_loop()

    @pytest.mark.asyncio
    async def test_disable_autonomy(self, test_runtime):
        service = await AutonomyService.start(test_runtime)

        await service.enable_autonomy()
        await service.disable_autonomy()

        assert test_runtime.enable_autonomy is False
        assert service.is_loop_running() is False

    @pytest.mark.asyncio
    async def test_get_status(self, test_runtime):
        test_runtime.enable_autonomy = True
        service = await AutonomyService.start(test_runtime)

        status = service.get_status()

        assert isinstance(status, AutonomyStatus)
        assert status.enabled is True
        assert status.running is True
        assert status.thinking is False
        assert status.interval == 30000
        assert status.autonomous_room_id is not None

    @pytest.mark.asyncio
    async def test_last_autonomous_thought_uses_latest_created_at(self, test_runtime):
        service = await AutonomyService.start(test_runtime)
        test_runtime.enable_autonomy = True
        test_runtime.get_setting = MagicMock(return_value=None)

        older = Memory(
            id=as_uuid("12345678-1234-1234-1234-123456789010"),
            room_id=service.get_autonomous_room_id(),
            entity_id=as_uuid(TEST_AGENT_ID),
            agent_id=as_uuid(TEST_AGENT_ID),
            content=Content(text="older", metadata={"isAutonomous": True}),
            created_at=10,
        )
        newer = Memory(
            id=as_uuid("12345678-1234-1234-1234-123456789011"),
            room_id=service.get_autonomous_room_id(),
            entity_id=as_uuid(TEST_AGENT_ID),
            agent_id=as_uuid(TEST_AGENT_ID),
            content=Content(text="newer", metadata={"isAutonomous": True}),
            created_at=20,
        )

        test_runtime.get_memories = AsyncMock(return_value=[older, newer])

        await service._perform_autonomous_think()

        assert test_runtime.emit_event.called is True
        payload = test_runtime.emit_event.call_args[0][1]
        msg = payload.get("message")
        assert msg is not None
        assert "newer" in (msg.content.text or "")

        await service.stop_loop()

    @pytest.mark.asyncio
    async def test_thinking_guard_initial_state(self, test_runtime):
        service = await AutonomyService.start(test_runtime)

        assert service.is_thinking_in_progress() is False
        assert service.get_status().thinking is False

    @pytest.mark.asyncio
    async def test_thinking_guard_prevents_overlap(self, test_runtime):
        service = await AutonomyService.start(test_runtime)

        service._is_thinking = True

        assert service.is_thinking_in_progress() is True
        assert service.get_status().thinking is True

        service._is_thinking = False
        assert service.is_thinking_in_progress() is False


class TestSendToAdminAction:
    def test_action_metadata(self):
        assert send_to_admin_action.name == "SEND_TO_ADMIN"
        assert send_to_admin_action.description is not None
        assert send_to_admin_action.examples is not None
        assert len(send_to_admin_action.examples) > 0

    @pytest.mark.asyncio
    async def test_validate_in_autonomous_room(self, test_runtime, test_memory):
        mock_service = MagicMock(spec=AutonomyService)
        mock_service.get_autonomous_room_id = MagicMock(return_value=test_memory.room_id)
        test_runtime.get_service = MagicMock(return_value=mock_service)
        test_runtime.get_setting = MagicMock(return_value="admin-user-id")

        test_memory.content = Content(text="Tell admin about this update")

        is_valid = await send_to_admin_action.validate_fn(test_runtime, test_memory)
        assert is_valid is True

    @pytest.mark.asyncio
    async def test_validate_not_in_autonomous_room(self, test_runtime, test_memory):
        mock_service = MagicMock(spec=AutonomyService)
        mock_service.get_autonomous_room_id = MagicMock(return_value=as_uuid(OTHER_ROOM_ID))
        test_runtime.get_service = MagicMock(return_value=mock_service)
        test_runtime.get_setting = MagicMock(return_value="admin-user-id")

        is_valid = await send_to_admin_action.validate_fn(test_runtime, test_memory)
        assert is_valid is False

    @pytest.mark.asyncio
    async def test_validate_no_admin_configured(self, test_runtime, test_memory):
        mock_service = MagicMock(spec=AutonomyService)
        mock_service.get_autonomous_room_id = MagicMock(return_value=test_memory.room_id)
        test_runtime.get_service = MagicMock(return_value=mock_service)
        test_runtime.get_setting = MagicMock(return_value=None)

        is_valid = await send_to_admin_action.validate_fn(test_runtime, test_memory)
        assert is_valid is False


class TestAdminChatProvider:
    def test_provider_metadata(self):
        assert admin_chat_provider.name == "ADMIN_CHAT_HISTORY"
        assert admin_chat_provider.description is not None

    @pytest.mark.asyncio
    async def test_returns_empty_when_no_service(self, test_runtime, test_memory):
        test_runtime.get_service = MagicMock(return_value=None)

        result = await admin_chat_provider.get(test_runtime, test_memory, {})

        assert result.text == ""

    @pytest.mark.asyncio
    async def test_returns_empty_when_not_in_autonomous_room(self, test_runtime, test_memory):
        mock_service = MagicMock(spec=AutonomyService)
        mock_service.get_autonomous_room_id = MagicMock(return_value=as_uuid(OTHER_ROOM_ID))
        test_runtime.get_service = MagicMock(return_value=mock_service)

        result = await admin_chat_provider.get(test_runtime, test_memory, {})

        assert result.text == ""

    @pytest.mark.asyncio
    async def test_indicates_no_admin_configured(self, test_runtime, test_memory):
        mock_service = MagicMock(spec=AutonomyService)
        mock_service.get_autonomous_room_id = MagicMock(return_value=test_memory.room_id)
        test_runtime.get_service = MagicMock(return_value=mock_service)
        test_runtime.get_setting = MagicMock(return_value=None)

        result = await admin_chat_provider.get(test_runtime, test_memory, {})

        assert "No admin user configured" in result.text
        assert result.data == {"adminConfigured": False}


class TestAutonomyStatusProvider:
    def test_provider_metadata(self):
        assert autonomy_status_provider.name == "AUTONOMY_STATUS"
        assert autonomy_status_provider.description is not None

    @pytest.mark.asyncio
    async def test_returns_empty_when_no_service(self, test_runtime, test_memory):
        test_runtime.get_service = MagicMock(return_value=None)

        result = await autonomy_status_provider.get(test_runtime, test_memory, {})

        assert result.text == ""

    @pytest.mark.asyncio
    async def test_returns_empty_in_autonomous_room(self, test_runtime, test_memory):
        mock_service = MagicMock(spec=AutonomyService)
        mock_service.get_autonomous_room_id = MagicMock(return_value=test_memory.room_id)
        test_runtime.get_service = MagicMock(return_value=mock_service)

        result = await autonomy_status_provider.get(test_runtime, test_memory, {})

        assert result.text == ""

    @pytest.mark.asyncio
    async def test_shows_running_status(self, test_runtime, test_memory):
        mock_service = MagicMock(spec=AutonomyService)
        mock_service.get_autonomous_room_id = MagicMock(return_value=as_uuid(AUTONOMOUS_ROOM_ID))
        mock_service.is_loop_running = MagicMock(return_value=True)
        mock_service.get_loop_interval = MagicMock(return_value=30000)
        test_runtime.get_service = MagicMock(return_value=mock_service)
        test_runtime.get_setting = MagicMock(return_value=True)

        result = await autonomy_status_provider.get(test_runtime, test_memory, {})

        assert "AUTONOMY_STATUS" in result.text
        assert "running autonomously" in result.text
        assert result.data["serviceRunning"] is True
        assert result.data["status"] == "running"

    @pytest.mark.asyncio
    async def test_shows_disabled_status(self, test_runtime, test_memory):
        mock_service = MagicMock(spec=AutonomyService)
        mock_service.get_autonomous_room_id = MagicMock(return_value=as_uuid(AUTONOMOUS_ROOM_ID))
        mock_service.is_loop_running = MagicMock(return_value=False)
        mock_service.get_loop_interval = MagicMock(return_value=30000)
        test_runtime.get_service = MagicMock(return_value=mock_service)
        test_runtime.get_setting = MagicMock(return_value=False)

        result = await autonomy_status_provider.get(test_runtime, test_memory, {})

        assert "autonomy disabled" in result.text
        assert result.data["status"] == "disabled"


class TestAutonomyIntegration:
    def test_exports_all_components(self):
        from elizaos.bootstrap.autonomy import (
            AUTONOMY_SERVICE_TYPE,
            AutonomyService,
            admin_chat_provider,
            autonomy_status_provider,
            send_to_admin_action,
        )

        assert AutonomyService is not None
        assert AUTONOMY_SERVICE_TYPE == "AUTONOMY"
        assert send_to_admin_action is not None
        assert admin_chat_provider is not None
        assert autonomy_status_provider is not None
