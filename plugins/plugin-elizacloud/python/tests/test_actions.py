"""Tests for cloud actions — integration tests that work without API credentials."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from elizaos_plugin_elizacloud.actions.check_credits import (
    DAILY_COST_PER_CONTAINER,
    handle_check_credits,
    validate_check_credits,
)
from elizaos_plugin_elizacloud.actions.freeze_agent import (
    handle_freeze,
    validate_freeze,
)
from elizaos_plugin_elizacloud.actions.provision_agent import (
    ServiceRegistry,
    _extract_params,
    handle_provision,
    validate_provision,
)
from elizaos_plugin_elizacloud.actions.resume_agent import (
    handle_resume,
    validate_resume,
)
from elizaos_plugin_elizacloud.services.cloud_auth_service import CloudAuthService
from elizaos_plugin_elizacloud.services.cloud_backup_service import CloudBackupService
from elizaos_plugin_elizacloud.services.cloud_bridge_service import CloudBridgeService
from elizaos_plugin_elizacloud.services.cloud_container_service import CloudContainerService


def _mock_registry(
    authenticated: bool = True,
    with_containers: bool = True,
    with_bridge: bool = True,
    with_backup: bool = True,
) -> ServiceRegistry:
    auth = MagicMock(spec=CloudAuthService)
    auth.is_authenticated.return_value = authenticated
    auth.get_client.return_value = MagicMock()

    containers = MagicMock(spec=CloudContainerService) if with_containers else None
    bridge = MagicMock(spec=CloudBridgeService) if with_bridge else None
    backup = MagicMock(spec=CloudBackupService) if with_backup else None

    return ServiceRegistry(
        auth=auth,
        containers=containers,
        bridge=bridge,
        backup=backup,
        settings={},
    )


# ─── Validation Tests ────────────────────────────────────────────────────────


class TestValidation:
    @pytest.mark.asyncio
    async def test_provision_validate_requires_auth(self) -> None:
        reg = _mock_registry(authenticated=False)
        assert await validate_provision(reg) is False

    @pytest.mark.asyncio
    async def test_provision_validate_passes_when_authed(self) -> None:
        reg = _mock_registry(authenticated=True)
        assert await validate_provision(reg) is True

    @pytest.mark.asyncio
    async def test_freeze_validate_requires_auth(self) -> None:
        reg = _mock_registry(authenticated=False)
        assert await validate_freeze(reg) is False

    @pytest.mark.asyncio
    async def test_resume_validate_requires_auth(self) -> None:
        reg = _mock_registry(authenticated=False)
        assert await validate_resume(reg) is False

    @pytest.mark.asyncio
    async def test_check_credits_validate_requires_auth(self) -> None:
        reg = _mock_registry(authenticated=False)
        assert await validate_check_credits(reg) is False


# ─── Parameter Extraction ────────────────────────────────────────────────────


class TestExtractParams:
    def test_from_options(self) -> None:
        params = _extract_params("", None, {"name": "my-agent", "project_name": "proj"})
        assert params["name"] == "my-agent"
        assert params["project_name"] == "proj"

    def test_from_metadata(self) -> None:
        params = _extract_params(
            "",
            {"actionParams": {"name": "agent-1", "project_name": "proj-1"}},
        )
        assert params["name"] == "agent-1"

    def test_from_free_text(self) -> None:
        params = _extract_params("Deploy name: my-agent project: test-proj")
        assert params["name"] == "my-agent"
        assert params["project_name"] == "test-proj"

    def test_free_text_no_match(self) -> None:
        params = _extract_params("just some random text")
        assert params["name"] is None
        assert params["project_name"] is None


# ─── Provision Action ────────────────────────────────────────────────────────


class TestProvisionAction:
    @pytest.mark.asyncio
    async def test_missing_params_returns_error(self) -> None:
        reg = _mock_registry()
        result = await handle_provision(reg, options={})
        assert result["success"] is False
        assert "Missing required" in str(result.get("error", ""))

    @pytest.mark.asyncio
    async def test_not_authenticated_returns_error(self) -> None:
        reg = _mock_registry(authenticated=False)
        result = await handle_provision(
            reg, options={"name": "test", "project_name": "proj"},
        )
        assert result["success"] is False
        assert "not authenticated" in str(result.get("error", "")).lower()

    @pytest.mark.asyncio
    async def test_successful_provision(self) -> None:
        reg = _mock_registry()
        # Mock container creation response
        mock_container = MagicMock()
        mock_container.id = "c-new"
        mock_container.load_balancer_url = "https://lb.example.com"
        mock_container.status = "running"

        mock_create_resp = MagicMock()
        mock_create_resp.data = mock_container
        mock_create_resp.credits_deducted = 5.0
        mock_create_resp.credits_remaining = 95.0

        assert reg.containers is not None
        reg.containers.create_container = AsyncMock(return_value=mock_create_resp)
        reg.containers.wait_for_deployment = AsyncMock(return_value=mock_container)

        assert reg.bridge is not None
        reg.bridge.connect = AsyncMock()
        reg.bridge.get_connection_state = MagicMock(return_value="connected")

        assert reg.backup is not None
        reg.backup.schedule_auto_backup = MagicMock()

        result = await handle_provision(
            reg, options={"name": "my-agent", "project_name": "test-proj"},
        )

        assert result["success"] is True
        assert result.get("data", {}).get("containerId") == "c-new"
        assert result.get("data", {}).get("autoBackupEnabled") is True


# ─── Freeze Action ───────────────────────────────────────────────────────────


class TestFreezeAction:
    @pytest.mark.asyncio
    async def test_missing_container_id(self) -> None:
        reg = _mock_registry()
        result = await handle_freeze(reg)
        assert result["success"] is False
        assert "containerId" in str(result.get("error", ""))

    @pytest.mark.asyncio
    async def test_container_not_running(self) -> None:
        reg = _mock_registry()
        mock_container = MagicMock()
        mock_container.status = "stopped"
        mock_container.name = "test-agent"
        assert reg.containers is not None
        reg.containers.get_container = AsyncMock(return_value=mock_container)

        result = await handle_freeze(reg, options={"containerId": "c-1"})
        assert result["success"] is False
        assert "not running" in str(result.get("error", "")).lower()

    @pytest.mark.asyncio
    async def test_successful_freeze(self) -> None:
        reg = _mock_registry()
        mock_container = MagicMock()
        mock_container.status = "running"
        mock_container.name = "my-agent"

        assert reg.containers is not None
        reg.containers.get_container = AsyncMock(return_value=mock_container)
        reg.containers.delete_container = AsyncMock()

        mock_snap = MagicMock()
        mock_snap.id = "snap-123"
        assert reg.backup is not None
        reg.backup.create_snapshot = AsyncMock(return_value=mock_snap)
        reg.backup.cancel_auto_backup = MagicMock()

        assert reg.bridge is not None
        reg.bridge.disconnect = AsyncMock()

        result = await handle_freeze(reg, options={"containerId": "c-1"})
        assert result["success"] is True
        assert result.get("data", {}).get("snapshotId") == "snap-123"


# ─── Resume Action ───────────────────────────────────────────────────────────


class TestResumeAction:
    @pytest.mark.asyncio
    async def test_missing_params(self) -> None:
        reg = _mock_registry()
        result = await handle_resume(reg, options={})
        assert result["success"] is False
        assert "Missing required" in str(result.get("error", ""))

    @pytest.mark.asyncio
    async def test_successful_resume(self) -> None:
        reg = _mock_registry()
        mock_container = MagicMock()
        mock_container.id = "c-resumed"
        mock_container.load_balancer_url = "https://lb.example.com"

        mock_create = MagicMock()
        mock_create.data = mock_container
        mock_create.credits_deducted = 5.0
        mock_create.credits_remaining = 90.0

        assert reg.containers is not None
        reg.containers.create_container = AsyncMock(return_value=mock_create)
        reg.containers.wait_for_deployment = AsyncMock(return_value=mock_container)

        assert reg.backup is not None
        reg.backup.list_snapshots = AsyncMock(return_value=[])
        reg.backup.schedule_auto_backup = MagicMock()
        reg.containers.list_containers = AsyncMock(return_value=[])

        assert reg.bridge is not None
        reg.bridge.connect = AsyncMock()

        result = await handle_resume(
            reg, options={"name": "restored-agent", "project_name": "proj"},
        )
        assert result["success"] is True
        assert result.get("data", {}).get("containerId") == "c-resumed"


# ─── Check Credits Action ───────────────────────────────────────────────────


class TestCheckCreditsAction:
    @pytest.mark.asyncio
    async def test_basic_balance_check(self) -> None:
        reg = _mock_registry()
        assert reg.auth is not None
        reg.auth.get_client.return_value.get = AsyncMock(
            return_value={"data": {"balance": 42.50}}
        )
        assert reg.containers is not None
        reg.containers.get_tracked_containers.return_value = []

        result = await handle_check_credits(reg)
        assert result["success"] is True
        assert result.get("data", {}).get("balance") == 42.50
        assert "42.50" in str(result.get("text", ""))

    @pytest.mark.asyncio
    async def test_balance_with_running_containers(self) -> None:
        reg = _mock_registry()
        assert reg.auth is not None
        reg.auth.get_client.return_value.get = AsyncMock(
            return_value={"data": {"balance": 10.0}}
        )
        mock_c1 = MagicMock()
        mock_c1.status = "running"
        mock_c2 = MagicMock()
        mock_c2.status = "running"
        mock_c3 = MagicMock()
        mock_c3.status = "stopped"

        assert reg.containers is not None
        reg.containers.get_tracked_containers.return_value = [mock_c1, mock_c2, mock_c3]

        result = await handle_check_credits(reg)
        data = result.get("data", {})
        assert data.get("runningContainers") == 2
        assert data.get("dailyCost") == 2 * DAILY_COST_PER_CONTAINER

    @pytest.mark.asyncio
    async def test_detailed_mode(self) -> None:
        reg = _mock_registry()
        assert reg.auth is not None
        mock_client = MagicMock()
        mock_client.get = AsyncMock(side_effect=[
            {"data": {"balance": 20.0}},
            {
                "data": {
                    "totalSpent": 80.0,
                    "totalAdded": 100.0,
                    "recentTransactions": [
                        {
                            "amount": -5.0,
                            "description": "Container deploy",
                            "created_at": "2025-01-01",
                        },
                    ],
                },
            },
        ])
        reg.auth.get_client.return_value = mock_client
        assert reg.containers is not None
        reg.containers.get_tracked_containers.return_value = []

        result = await handle_check_credits(reg, options={"detailed": True})
        assert result["success"] is True
        text = str(result.get("text", ""))
        assert "Total spent" in text
        assert "Container deploy" in text
