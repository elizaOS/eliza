"""Tests for cloud providers — integration tests that work without API credentials."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from elizaos_plugin_elizacloud.cloud_providers.cloud_status import get_cloud_status
from elizaos_plugin_elizacloud.cloud_providers.container_health import get_container_health
from elizaos_plugin_elizacloud.cloud_providers.credit_balance import (
    _format_balance,
    get_credit_balance,
)
from elizaos_plugin_elizacloud.services.cloud_auth_service import CloudAuthService
from elizaos_plugin_elizacloud.services.cloud_bridge_service import CloudBridgeService
from elizaos_plugin_elizacloud.services.cloud_container_service import CloudContainerService


def _mock_auth(authenticated: bool = True) -> CloudAuthService:
    auth = MagicMock(spec=CloudAuthService)
    auth.is_authenticated.return_value = authenticated
    auth.get_client.return_value = MagicMock()
    return auth


def _mock_container_svc(containers: list[MagicMock] | None = None) -> CloudContainerService:
    svc = MagicMock(spec=CloudContainerService)
    svc.get_tracked_containers.return_value = containers or []
    return svc


def _mock_bridge_svc(connected: list[str] | None = None) -> CloudBridgeService:
    svc = MagicMock(spec=CloudBridgeService)
    svc.get_connected_container_ids.return_value = connected or []
    return svc


# ─── Cloud Status Provider ───────────────────────────────────────────────────


class TestCloudStatusProvider:
    @pytest.mark.asyncio
    async def test_unauthenticated(self) -> None:
        result = await get_cloud_status(auth=_mock_auth(False))
        assert "Not authenticated" in result["text"]
        assert result.get("values", {}).get("cloudAuthenticated") is False

    @pytest.mark.asyncio
    async def test_no_containers(self) -> None:
        result = await get_cloud_status(
            auth=_mock_auth(),
            container_svc=_mock_container_svc([]),
            bridge_svc=_mock_bridge_svc([]),
        )
        assert "0 container(s)" in result["text"]
        assert result.get("values", {}).get("runningContainers") == 0

    @pytest.mark.asyncio
    async def test_with_containers(self) -> None:
        c1 = MagicMock()
        c1.id, c1.name, c1.status = "c-1", "agent-1", "running"
        c1.load_balancer_url, c1.billing_status = "https://lb.example.com", "active"

        c2 = MagicMock()
        c2.id, c2.name, c2.status = "c-2", "agent-2", "deploying"
        c2.load_balancer_url, c2.billing_status = None, "active"

        result = await get_cloud_status(
            auth=_mock_auth(),
            container_svc=_mock_container_svc([c1, c2]),
            bridge_svc=_mock_bridge_svc(["c-1"]),
        )
        assert "2 container(s)" in result["text"]
        values = result.get("values", {})
        assert values.get("runningContainers") == 1
        assert values.get("deployingContainers") == 1
        assert "(bridged)" in result["text"]


# ─── Credit Balance Provider ────────────────────────────────────────────────


class TestCreditBalanceProvider:
    @pytest.mark.asyncio
    async def test_unauthenticated(self) -> None:
        result = await get_credit_balance(auth=_mock_auth(False))
        assert result["text"] == ""

    @pytest.mark.asyncio
    async def test_fetches_balance(self) -> None:
        # Reset cache
        import elizaos_plugin_elizacloud.cloud_providers.credit_balance as mod
        mod._cache = None
        mod._cache_at = 0.0

        auth = _mock_auth()
        auth.get_client.return_value.get = AsyncMock(
            return_value={"data": {"balance": 15.5}}
        )

        result = await get_credit_balance(auth=auth)
        assert "15.50" in result["text"]
        assert result.get("values", {}).get("cloudCredits") == 15.5
        assert result.get("values", {}).get("cloudCreditsLow") is False

    @pytest.mark.asyncio
    async def test_low_balance_warning(self) -> None:
        import elizaos_plugin_elizacloud.cloud_providers.credit_balance as mod
        mod._cache = None
        mod._cache_at = 0.0

        auth = _mock_auth()
        auth.get_client.return_value.get = AsyncMock(
            return_value={"data": {"balance": 1.5}}
        )

        result = await get_credit_balance(auth=auth)
        assert "(LOW)" in result["text"]
        assert result.get("values", {}).get("cloudCreditsLow") is True

    @pytest.mark.asyncio
    async def test_critical_balance(self) -> None:
        import elizaos_plugin_elizacloud.cloud_providers.credit_balance as mod
        mod._cache = None
        mod._cache_at = 0.0

        auth = _mock_auth()
        auth.get_client.return_value.get = AsyncMock(
            return_value={"data": {"balance": 0.3}}
        )

        result = await get_credit_balance(auth=auth)
        assert "(CRITICAL)" in result["text"]
        assert result.get("values", {}).get("cloudCreditsCritical") is True

    def test_format_balance_helper(self) -> None:
        result = _format_balance(50.0)
        assert "$50.00" in result["text"]
        assert result["values"]["cloudCreditsLow"] is False

        result = _format_balance(0.1)
        assert "(CRITICAL)" in result["text"]


# ─── Container Health Provider ──────────────────────────────────────────────


class TestContainerHealthProvider:
    @pytest.mark.asyncio
    async def test_unauthenticated(self) -> None:
        result = await get_container_health(auth=_mock_auth(False))
        assert result["text"] == ""

    @pytest.mark.asyncio
    async def test_no_running_containers(self) -> None:
        result = await get_container_health(
            auth=_mock_auth(),
            container_svc=_mock_container_svc([]),
        )
        assert "No running containers" in result["text"]

    @pytest.mark.asyncio
    async def test_healthy_containers(self) -> None:
        c1 = MagicMock()
        c1.id, c1.name, c1.status, c1.billing_status = "c-1", "agent-1", "running", "active"
        c2 = MagicMock()
        c2.id, c2.name, c2.status, c2.billing_status = "c-2", "agent-2", "running", "active"

        result = await get_container_health(
            auth=_mock_auth(),
            container_svc=_mock_container_svc([c1, c2]),
        )
        assert "2/2 healthy" in result["text"]
        assert result.get("values", {}).get("healthyContainers") == 2

    @pytest.mark.asyncio
    async def test_unhealthy_container(self) -> None:
        c1 = MagicMock()
        c1.id, c1.name, c1.status, c1.billing_status = "c-1", "agent-1", "running", "active"
        c2 = MagicMock()
        c2.id, c2.name, c2.status, c2.billing_status = "c-2", "agent-2", "running", "suspended"

        result = await get_container_health(
            auth=_mock_auth(),
            container_svc=_mock_container_svc([c1, c2]),
        )
        assert "1/2 healthy" in result["text"]
        assert result.get("values", {}).get("unhealthyContainers") == 1
        assert "UNHEALTHY" in result["text"]
