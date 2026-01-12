from __future__ import annotations

import pytest

from elizaos_plugin_farcaster.config import FarcasterConfig
from elizaos_plugin_farcaster.service import (
    FarcasterService,
    ProfileProvider,
    SendCastAction,
    TimelineProvider,
)


@pytest.fixture
def service(mock_config: FarcasterConfig) -> FarcasterService:
    return FarcasterService(mock_config)


def test_service_creation(service: FarcasterService) -> None:
    assert service.service_type == "farcaster"
    assert service.description is not None
    assert service.capability_description is not None


@pytest.mark.asyncio
async def test_service_send_cast(service: FarcasterService) -> None:
    casts = await service.send_cast("Hello from service!")
    assert len(casts) == 1
    assert casts[0].text == "Hello from service!"


@pytest.mark.asyncio
async def test_service_health_check_no_start(service: FarcasterService) -> None:
    result = await service.health_check()
    assert isinstance(result.details, dict)


class TestSendCastAction:
    """Tests for SendCastAction."""

    @pytest.mark.asyncio
    async def test_validate_with_keyword(self, service: FarcasterService) -> None:
        """Test validation with matching keyword."""
        action = SendCastAction()
        result = await action.validate("Please post this on Farcaster", service)
        assert result is True

    @pytest.mark.asyncio
    async def test_validate_without_keyword(self, service: FarcasterService) -> None:
        action = SendCastAction()
        result = await action.validate("Hello world", service)
        assert result is False

    @pytest.mark.asyncio
    async def test_validate_no_service(self) -> None:
        """Test validation with no service."""
        action = SendCastAction()
        result = await action.validate("Please post this on Farcaster", None)
        assert result is False

    @pytest.mark.asyncio
    async def test_execute(self, service: FarcasterService) -> None:
        action = SendCastAction()
        casts = await action.execute("Test cast", service)
        assert len(casts) == 1


class TestProviders:
    @pytest.mark.asyncio
    async def test_profile_provider_error(
        self, service: FarcasterService, mock_config: FarcasterConfig
    ) -> None:
        provider = ProfileProvider(service, mock_config)
        result = await provider.get()
        # Will error because we can't reach API
        assert "Error" in result or "Farcaster Profile" in result

    @pytest.mark.asyncio
    async def test_timeline_provider_error(
        self, service: FarcasterService, mock_config: FarcasterConfig
    ) -> None:
        """Test timeline provider with error."""
        provider = TimelineProvider(service, mock_config)
        result = await provider.get()
        assert isinstance(result, str)
