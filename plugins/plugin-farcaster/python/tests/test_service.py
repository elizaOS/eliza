from __future__ import annotations

import pytest

from elizaos_plugin_farcaster.actions.send_cast import SendCastAction
from elizaos_plugin_farcaster.config import FarcasterConfig
from elizaos_plugin_farcaster.providers.profile import ProfileProvider
from elizaos_plugin_farcaster.providers.timeline import TimelineProvider
from elizaos_plugin_farcaster.service import FarcasterService


@pytest.fixture
def service(mock_config: FarcasterConfig) -> FarcasterService:
    return FarcasterService(mock_config)


def test_service_creation(service: FarcasterService) -> None:
    assert service.config is not None
    assert service.fid == 12345


class TestSendCastAction:
    """Tests for SendCastAction."""

    @pytest.fixture
    def started_service(self, mock_config: FarcasterConfig) -> FarcasterService:
        """Return a service that appears started for validation."""
        svc = FarcasterService(mock_config)
        svc._running = True
        return svc

    @pytest.mark.asyncio
    async def test_validate_with_keyword(self, started_service: FarcasterService) -> None:
        """Test validation with matching keyword."""
        action = SendCastAction()
        message = {"content": {"text": "Please post this on Farcaster"}}
        result = await action.validate(message, started_service)
        assert result is True

    @pytest.mark.asyncio
    async def test_validate_without_keyword(self, started_service: FarcasterService) -> None:
        action = SendCastAction()
        message = {"content": {"text": "Hello world"}}
        result = await action.validate(message, started_service)
        assert result is False

    @pytest.mark.asyncio
    async def test_validate_no_service(self) -> None:
        """Test validation with no service."""
        action = SendCastAction()
        message = {"content": {"text": "Please post this on Farcaster"}}
        result = await action.validate(message, None)
        assert result is False

    @pytest.mark.asyncio
    async def test_validate_service_not_running(self, service: FarcasterService) -> None:
        """Test validation when service is not running."""
        action = SendCastAction()
        message = {"content": {"text": "Please post this on Farcaster"}}
        result = await action.validate(message, service)
        assert result is False


class TestProviders:
    @pytest.mark.asyncio
    async def test_profile_provider_error(
        self, service: FarcasterService, mock_config: FarcasterConfig
    ) -> None:
        provider = ProfileProvider(service, mock_config)
        result = await provider.get()
        # Will error because service not started and can't reach API
        assert "Error" in result

    @pytest.mark.asyncio
    async def test_timeline_provider_error(
        self, service: FarcasterService, mock_config: FarcasterConfig
    ) -> None:
        """Test timeline provider with error."""
        provider = TimelineProvider(service, mock_config)
        result = await provider.get()
        assert isinstance(result, str)
        # Will error because service not started
        assert "Error" in result

    def test_profile_provider_properties(
        self, service: FarcasterService, mock_config: FarcasterConfig
    ) -> None:
        """Test ProfileProvider name and description."""
        provider = ProfileProvider(service, mock_config)
        assert provider.name == "farcaster_profile"
        assert "Farcaster profile" in provider.description

    def test_timeline_provider_properties(
        self, service: FarcasterService, mock_config: FarcasterConfig
    ) -> None:
        """Test TimelineProvider name and description."""
        provider = TimelineProvider(service, mock_config)
        assert provider.name == "farcaster_timeline"
        assert "timeline" in provider.description
