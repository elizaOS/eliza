"""
Tests for Autonomy Module - Python implementation.

Tests the autonomous operation capabilities including:
- AutonomyService lifecycle and loop management
- send_to_admin_action validation
- admin_chat_provider and autonomy_status_provider
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from elizaos.bootstrap.autonomy import (
    AUTONOMY_SERVICE_TYPE,
    AutonomyService,
    admin_chat_provider,
    autonomy_status_provider,
    send_to_admin_action,
)
from elizaos.bootstrap.autonomy.types import AutonomyStatus
from elizaos.types.memory import Memory
from elizaos.types.primitives import UUID, as_uuid, Content


# Test UUIDs
TEST_AGENT_ID = "00000000-0000-0000-0000-000000000001"
TEST_ROOM_ID = "00000000-0000-0000-0000-000000000002"
TEST_ENTITY_ID = "00000000-0000-0000-0000-000000000003"
TEST_MESSAGE_ID = "00000000-0000-0000-0000-000000000004"
OTHER_ROOM_ID = "00000000-0000-0000-0000-000000000005"
AUTONOMOUS_ROOM_ID = "00000000-0000-0000-0000-000000000006"


@pytest.fixture
def mock_runtime():
    """Create a mock runtime for testing."""
    runtime = MagicMock()
    runtime.agent_id = as_uuid(TEST_AGENT_ID)
    runtime.character = MagicMock()
    runtime.character.name = "Test Agent"
    
    # Setup async mocks
    runtime.ensure_world_exists = AsyncMock()
    runtime.ensure_room_exists = AsyncMock()
    runtime.add_participant = AsyncMock()
    runtime.get_entity_by_id = AsyncMock(return_value=MagicMock(id=TEST_AGENT_ID))
    runtime.get_memories = AsyncMock(return_value=[])
    runtime.emit_event = AsyncMock()
    runtime.create_memory = AsyncMock(return_value="memory-id")
    
    # Settings
    runtime.get_setting = MagicMock(return_value=None)
    runtime.set_setting = MagicMock()
    
    # Logger
    runtime.logger = MagicMock()
    runtime.logger.info = MagicMock()
    runtime.logger.debug = MagicMock()
    runtime.logger.error = MagicMock()
    runtime.logger.warn = MagicMock()
    
    return runtime


@pytest.fixture
def mock_memory():
    """Create a mock memory for testing."""
    return Memory(
        id=as_uuid(TEST_MESSAGE_ID),
        room_id=as_uuid(TEST_ROOM_ID),
        entity_id=as_uuid(TEST_ENTITY_ID),
        agent_id=as_uuid(TEST_AGENT_ID),
        content=Content(text="Test message"),
        created_at=1234567890,
    )


class TestAutonomyService:
    """Tests for AutonomyService."""
    
    def test_service_type(self):
        """Should have correct service type."""
        assert AutonomyService.service_type == AUTONOMY_SERVICE_TYPE
        assert AutonomyService.service_type == "AUTONOMY"
    
    @pytest.mark.asyncio
    async def test_start_creates_service(self, mock_runtime):
        """Should create service instance with default values."""
        service = await AutonomyService.start(mock_runtime)
        
        assert service is not None
        assert isinstance(service, AutonomyService)
        assert service.is_loop_running() is False
        assert service.get_loop_interval() == 30000
        assert service.get_autonomous_room_id() is not None
    
    @pytest.mark.asyncio
    async def test_auto_start_when_enabled(self, mock_runtime):
        """Should auto-start loop when AUTONOMY_ENABLED is true."""
        mock_runtime.get_setting = MagicMock(return_value=True)
        
        service = await AutonomyService.start(mock_runtime)
        
        assert service.is_loop_running() is True
        mock_runtime.set_setting.assert_called_with("AUTONOMY_ENABLED", True)
        
        # Cleanup
        await service.stop_loop()
    
    @pytest.mark.asyncio
    async def test_auto_start_when_enabled_string(self, mock_runtime):
        """Should auto-start loop when AUTONOMY_ENABLED is 'true' string."""
        mock_runtime.get_setting = MagicMock(return_value="true")
        
        service = await AutonomyService.start(mock_runtime)
        
        assert service.is_loop_running() is True
        
        # Cleanup
        await service.stop_loop()
    
    @pytest.mark.asyncio
    async def test_ensure_context_on_initialization(self, mock_runtime):
        """Should ensure world and room exist on initialization."""
        service = await AutonomyService.start(mock_runtime)
        
        mock_runtime.ensure_world_exists.assert_called_once()
        mock_runtime.ensure_room_exists.assert_called_once()
        mock_runtime.add_participant.assert_called_once()
        
        # Verify world call
        world_call = mock_runtime.ensure_world_exists.call_args[0][0]
        assert world_call.name == "Autonomy World"
        assert world_call.metadata is not None
        assert world_call.metadata.model_dump().get("type") == "autonomy"
        
        # Verify room call
        room_call = mock_runtime.ensure_room_exists.call_args[0][0]
        assert room_call.name == "Autonomous Thoughts"
        assert room_call.source == "autonomy-service"
    
    @pytest.mark.asyncio
    async def test_start_stop_loop(self, mock_runtime):
        """Should start and stop loop correctly."""
        service = await AutonomyService.start(mock_runtime)
        
        # Initially not running
        assert service.is_loop_running() is False
        
        # Start loop
        await service.start_loop()
        assert service.is_loop_running() is True
        mock_runtime.set_setting.assert_called_with("AUTONOMY_ENABLED", True)
        
        # Stop loop
        await service.stop_loop()
        assert service.is_loop_running() is False
        mock_runtime.set_setting.assert_called_with("AUTONOMY_ENABLED", False)
    
    @pytest.mark.asyncio
    async def test_no_double_start(self, mock_runtime):
        """Should not start loop if already running."""
        service = await AutonomyService.start(mock_runtime)
        
        await service.start_loop()
        call_count = mock_runtime.set_setting.call_count
        
        await service.start_loop()
        assert mock_runtime.set_setting.call_count == call_count
        
        # Cleanup
        await service.stop_loop()
    
    @pytest.mark.asyncio
    async def test_no_double_stop(self, mock_runtime):
        """Should not attempt stop if loop not running."""
        service = await AutonomyService.start(mock_runtime)
        
        call_count = mock_runtime.set_setting.call_count
        await service.stop_loop()
        assert mock_runtime.set_setting.call_count == call_count
    
    @pytest.mark.asyncio
    async def test_interval_configuration(self, mock_runtime):
        """Should set and get loop interval."""
        service = await AutonomyService.start(mock_runtime)
        
        service.set_loop_interval(60000)
        assert service.get_loop_interval() == 60000
    
    @pytest.mark.asyncio
    async def test_interval_minimum_enforced(self, mock_runtime):
        """Should enforce minimum interval of 5000ms."""
        service = await AutonomyService.start(mock_runtime)
        
        service.set_loop_interval(1000)
        assert service.get_loop_interval() == 5000
    
    @pytest.mark.asyncio
    async def test_interval_maximum_enforced(self, mock_runtime):
        """Should enforce maximum interval of 600000ms."""
        service = await AutonomyService.start(mock_runtime)
        
        service.set_loop_interval(1000000)
        assert service.get_loop_interval() == 600000
    
    @pytest.mark.asyncio
    async def test_enable_autonomy(self, mock_runtime):
        """Should enable autonomy via enable_autonomy()."""
        service = await AutonomyService.start(mock_runtime)
        
        await service.enable_autonomy()
        
        mock_runtime.set_setting.assert_called_with("AUTONOMY_ENABLED", True)
        assert service.is_loop_running() is True
        
        # Cleanup
        await service.stop_loop()
    
    @pytest.mark.asyncio
    async def test_disable_autonomy(self, mock_runtime):
        """Should disable autonomy via disable_autonomy()."""
        service = await AutonomyService.start(mock_runtime)
        
        await service.enable_autonomy()
        await service.disable_autonomy()
        
        mock_runtime.set_setting.assert_called_with("AUTONOMY_ENABLED", False)
        assert service.is_loop_running() is False
    
    @pytest.mark.asyncio
    async def test_get_status(self, mock_runtime):
        """Should return correct status via get_status()."""
        mock_runtime.get_setting = MagicMock(return_value=True)
        service = await AutonomyService.start(mock_runtime)
        
        status = service.get_status()
        
        assert isinstance(status, AutonomyStatus)
        assert status.enabled is True
        assert status.running is True
        assert status.thinking is False  # Initially not thinking
        assert status.interval == 30000
        assert status.autonomous_room_id is not None
        
        # Cleanup
        await service.stop_loop()
    
    @pytest.mark.asyncio
    async def test_thinking_guard_initial_state(self, mock_runtime):
        """Should initially not be thinking."""
        service = await AutonomyService.start(mock_runtime)
        
        assert service.is_thinking_in_progress() is False
        assert service.get_status().thinking is False
    
    @pytest.mark.asyncio
    async def test_thinking_guard_prevents_overlap(self, mock_runtime):
        """Should skip iteration if previous is still running."""
        service = await AutonomyService.start(mock_runtime)
        
        # Manually set thinking flag to simulate in-progress thought
        service._is_thinking = True
        
        # Verify thinking state is tracked
        assert service.is_thinking_in_progress() is True
        assert service.get_status().thinking is True
        
        # Reset thinking flag
        service._is_thinking = False
        assert service.is_thinking_in_progress() is False


class TestSendToAdminAction:
    """Tests for send_to_admin_action."""
    
    def test_action_metadata(self):
        """Should have correct action metadata."""
        assert send_to_admin_action.name == "SEND_TO_ADMIN"
        assert send_to_admin_action.description is not None
        assert send_to_admin_action.examples is not None
        assert len(send_to_admin_action.examples) > 0
    
    @pytest.mark.asyncio
    async def test_validate_in_autonomous_room(self, mock_runtime, mock_memory):
        """Should validate only in autonomous room."""
        mock_service = MagicMock(spec=AutonomyService)
        mock_service.get_autonomous_room_id = MagicMock(return_value=mock_memory.room_id)
        mock_runtime.get_service = MagicMock(return_value=mock_service)
        mock_runtime.get_setting = MagicMock(return_value="admin-user-id")
        
        # Update message to contain admin-related keywords
        mock_memory.content = Content(text="Tell admin about this update")
        
        is_valid = await send_to_admin_action.validate_fn(mock_runtime, mock_memory)
        assert is_valid is True
    
    @pytest.mark.asyncio
    async def test_validate_not_in_autonomous_room(self, mock_runtime, mock_memory):
        """Should not validate when not in autonomous room."""
        mock_service = MagicMock(spec=AutonomyService)
        mock_service.get_autonomous_room_id = MagicMock(return_value=as_uuid(OTHER_ROOM_ID))
        mock_runtime.get_service = MagicMock(return_value=mock_service)
        mock_runtime.get_setting = MagicMock(return_value="admin-user-id")
        
        is_valid = await send_to_admin_action.validate_fn(mock_runtime, mock_memory)
        assert is_valid is False
    
    @pytest.mark.asyncio
    async def test_validate_no_admin_configured(self, mock_runtime, mock_memory):
        """Should not validate when ADMIN_USER_ID is not configured."""
        mock_service = MagicMock(spec=AutonomyService)
        mock_service.get_autonomous_room_id = MagicMock(return_value=mock_memory.room_id)
        mock_runtime.get_service = MagicMock(return_value=mock_service)
        mock_runtime.get_setting = MagicMock(return_value=None)
        
        is_valid = await send_to_admin_action.validate_fn(mock_runtime, mock_memory)
        assert is_valid is False


class TestAdminChatProvider:
    """Tests for admin_chat_provider."""
    
    def test_provider_metadata(self):
        """Should have correct provider metadata."""
        assert admin_chat_provider.name == "ADMIN_CHAT_HISTORY"
        assert admin_chat_provider.description is not None
    
    @pytest.mark.asyncio
    async def test_returns_empty_when_no_service(self, mock_runtime, mock_memory):
        """Should return empty result when autonomy service not available."""
        mock_runtime.get_service = MagicMock(return_value=None)
        
        result = await admin_chat_provider.get(mock_runtime, mock_memory, {})
        
        assert result.text == ""
    
    @pytest.mark.asyncio
    async def test_returns_empty_when_not_in_autonomous_room(self, mock_runtime, mock_memory):
        """Should return empty result when not in autonomous room."""
        mock_service = MagicMock(spec=AutonomyService)
        mock_service.get_autonomous_room_id = MagicMock(return_value=as_uuid(OTHER_ROOM_ID))
        mock_runtime.get_service = MagicMock(return_value=mock_service)
        
        result = await admin_chat_provider.get(mock_runtime, mock_memory, {})
        
        assert result.text == ""
    
    @pytest.mark.asyncio
    async def test_indicates_no_admin_configured(self, mock_runtime, mock_memory):
        """Should indicate when no admin is configured."""
        mock_service = MagicMock(spec=AutonomyService)
        mock_service.get_autonomous_room_id = MagicMock(return_value=mock_memory.room_id)
        mock_runtime.get_service = MagicMock(return_value=mock_service)
        mock_runtime.get_setting = MagicMock(return_value=None)
        
        result = await admin_chat_provider.get(mock_runtime, mock_memory, {})
        
        assert "No admin user configured" in result.text
        assert result.data == {"adminConfigured": False}


class TestAutonomyStatusProvider:
    """Tests for autonomy_status_provider."""
    
    def test_provider_metadata(self):
        """Should have correct provider metadata."""
        assert autonomy_status_provider.name == "AUTONOMY_STATUS"
        assert autonomy_status_provider.description is not None
    
    @pytest.mark.asyncio
    async def test_returns_empty_when_no_service(self, mock_runtime, mock_memory):
        """Should return empty result when autonomy service not available."""
        mock_runtime.get_service = MagicMock(return_value=None)
        
        result = await autonomy_status_provider.get(mock_runtime, mock_memory, {})
        
        assert result.text == ""
    
    @pytest.mark.asyncio
    async def test_returns_empty_in_autonomous_room(self, mock_runtime, mock_memory):
        """Should not show status in autonomous room."""
        mock_service = MagicMock(spec=AutonomyService)
        mock_service.get_autonomous_room_id = MagicMock(return_value=mock_memory.room_id)
        mock_runtime.get_service = MagicMock(return_value=mock_service)
        
        result = await autonomy_status_provider.get(mock_runtime, mock_memory, {})
        
        assert result.text == ""
    
    @pytest.mark.asyncio
    async def test_shows_running_status(self, mock_runtime, mock_memory):
        """Should show running status correctly."""
        mock_service = MagicMock(spec=AutonomyService)
        mock_service.get_autonomous_room_id = MagicMock(return_value=as_uuid(AUTONOMOUS_ROOM_ID))
        mock_service.is_loop_running = MagicMock(return_value=True)
        mock_service.get_loop_interval = MagicMock(return_value=30000)
        mock_runtime.get_service = MagicMock(return_value=mock_service)
        mock_runtime.get_setting = MagicMock(return_value=True)
        
        result = await autonomy_status_provider.get(mock_runtime, mock_memory, {})
        
        assert "AUTONOMY_STATUS" in result.text
        assert "running autonomously" in result.text
        assert result.data["serviceRunning"] is True
        assert result.data["status"] == "running"
    
    @pytest.mark.asyncio
    async def test_shows_disabled_status(self, mock_runtime, mock_memory):
        """Should show disabled status correctly."""
        mock_service = MagicMock(spec=AutonomyService)
        mock_service.get_autonomous_room_id = MagicMock(return_value=as_uuid(AUTONOMOUS_ROOM_ID))
        mock_service.is_loop_running = MagicMock(return_value=False)
        mock_service.get_loop_interval = MagicMock(return_value=30000)
        mock_runtime.get_service = MagicMock(return_value=mock_service)
        mock_runtime.get_setting = MagicMock(return_value=False)
        
        result = await autonomy_status_provider.get(mock_runtime, mock_memory, {})
        
        assert "autonomy disabled" in result.text
        assert result.data["status"] == "disabled"


class TestAutonomyIntegration:
    """Integration tests for autonomy module."""
    
    def test_exports_all_components(self):
        """Should export all components from autonomy module."""
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

