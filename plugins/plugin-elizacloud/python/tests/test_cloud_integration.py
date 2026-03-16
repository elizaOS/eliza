"""
End-to-end integration tests for ElizaCloud plugin flows.

These tests simulate full workflows without API keys by mocking
the underlying HTTP calls. They verify the orchestration between
actions, services, and providers.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

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
    handle_provision,
    validate_provision,
)
from elizaos_plugin_elizacloud.actions.resume_agent import (
    handle_resume,
    validate_resume,
)
from elizaos_plugin_elizacloud.cloud_providers.cloud_status import get_cloud_status
from elizaos_plugin_elizacloud.cloud_providers.container_health import get_container_health
from elizaos_plugin_elizacloud.cloud_providers.credit_balance import get_credit_balance
from elizaos_plugin_elizacloud.services.cloud_auth_service import CloudAuthService
from elizaos_plugin_elizacloud.services.cloud_backup_service import CloudBackupService
from elizaos_plugin_elizacloud.services.cloud_bridge_service import CloudBridgeService
from elizaos_plugin_elizacloud.services.cloud_container_service import CloudContainerService
from elizaos_plugin_elizacloud.types.cloud import (
    CloudApiError,
    CloudApiErrorBody,
    InsufficientCreditsError,
)
from elizaos_plugin_elizacloud.utils.cloud_api import CloudApiClient


def _mock_registry(
    authenticated: bool = True,
    with_containers: bool = True,
    with_bridge: bool = True,
    with_backup: bool = True,
) -> ServiceRegistry:
    """Build a fully mocked ServiceRegistry for integration testing."""
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


def _mock_container(
    container_id: str = "c-1",
    name: str = "my-agent",
    status: str = "running",
    url: str = "https://lb.example.com",
    billing_status: str = "active",
) -> MagicMock:
    """Build a mock CloudContainer."""
    c = MagicMock()
    c.id = container_id
    c.name = name
    c.status = status
    c.load_balancer_url = url
    c.billing_status = billing_status
    return c


# ─── E2E: Provision -> Freeze -> Resume Cycle ───────────────────────────────


class TestProvisionFreezeResumeCycle:
    """Simulate a full lifecycle: provision an agent, freeze it, then resume."""

    @pytest.mark.asyncio
    async def test_full_lifecycle(self) -> None:
        reg = _mock_registry()

        # ── Step 1: Provision ──
        provisioned = _mock_container("c-new", "my-agent", "running")

        mock_create_resp = MagicMock()
        mock_create_resp.data = provisioned
        mock_create_resp.credits_deducted = 5.0
        mock_create_resp.credits_remaining = 95.0

        assert reg.containers is not None
        reg.containers.create_container = AsyncMock(return_value=mock_create_resp)
        reg.containers.wait_for_deployment = AsyncMock(return_value=provisioned)

        assert reg.bridge is not None
        reg.bridge.connect = AsyncMock()
        reg.bridge.get_connection_state = MagicMock(return_value="connected")

        assert reg.backup is not None
        reg.backup.schedule_auto_backup = MagicMock()

        provision_result = await handle_provision(
            reg, options={"name": "my-agent", "project_name": "test-proj"},
        )

        assert provision_result["success"] is True
        assert provision_result["data"]["containerId"] == "c-new"
        assert provision_result["data"]["autoBackupEnabled"] is True

        # ── Step 2: Freeze ──
        running_container = _mock_container("c-new", "my-agent", "running")
        reg.containers.get_container = AsyncMock(return_value=running_container)
        reg.containers.delete_container = AsyncMock()

        mock_snap = MagicMock()
        mock_snap.id = "snap-freeze-1"
        reg.backup.create_snapshot = AsyncMock(return_value=mock_snap)
        reg.backup.cancel_auto_backup = MagicMock()

        reg.bridge.disconnect = AsyncMock()

        freeze_result = await handle_freeze(reg, options={"containerId": "c-new"})

        assert freeze_result["success"] is True
        assert freeze_result["data"]["snapshotId"] == "snap-freeze-1"

        # ── Step 3: Resume ──
        resumed_container = _mock_container("c-resumed", "my-agent-restored", "running")

        mock_resume_create = MagicMock()
        mock_resume_create.data = resumed_container
        mock_resume_create.credits_deducted = 5.0
        mock_resume_create.credits_remaining = 85.0

        reg.containers.create_container = AsyncMock(return_value=mock_resume_create)
        reg.containers.wait_for_deployment = AsyncMock(return_value=resumed_container)
        reg.containers.list_containers = AsyncMock(return_value=[])

        reg.backup.list_snapshots = AsyncMock(return_value=[mock_snap])
        reg.bridge.connect = AsyncMock()

        resume_result = await handle_resume(
            reg, options={"name": "my-agent-restored", "project_name": "test-proj"},
        )

        assert resume_result["success"] is True
        assert resume_result["data"]["containerId"] == "c-resumed"


# ─── E2E: Credit Check Workflow ──────────────────────────────────────────────


class TestCreditCheckWorkflow:
    """End-to-end credit checking scenarios."""

    @pytest.mark.asyncio
    async def test_healthy_credits_no_containers(self) -> None:
        """User has plenty of credits and no running containers."""
        reg = _mock_registry()
        assert reg.auth is not None
        reg.auth.get_client.return_value.get = AsyncMock(
            return_value={"data": {"balance": 100.0}}
        )
        assert reg.containers is not None
        reg.containers.get_tracked_containers.return_value = []

        result = await handle_check_credits(reg)
        assert result["success"] is True
        assert result["data"]["balance"] == 100.0
        assert result["data"]["runningContainers"] == 0
        assert result["data"]["dailyCost"] == 0
        assert "100.00" in result["text"]

    @pytest.mark.asyncio
    async def test_low_credits_with_containers(self) -> None:
        """User has low credits with multiple running containers."""
        reg = _mock_registry()
        assert reg.auth is not None
        reg.auth.get_client.return_value.get = AsyncMock(
            return_value={"data": {"balance": 3.0}}
        )
        c1 = _mock_container("c-1", "agent-1", "running")
        c2 = _mock_container("c-2", "agent-2", "running")
        c3 = _mock_container("c-3", "agent-3", "stopped")

        assert reg.containers is not None
        reg.containers.get_tracked_containers.return_value = [c1, c2, c3]

        result = await handle_check_credits(reg)
        assert result["success"] is True
        data = result["data"]
        assert data["runningContainers"] == 2
        assert data["dailyCost"] == 2 * DAILY_COST_PER_CONTAINER
        # With low balance, the text should show a warning
        assert "3.00" in result["text"]

    @pytest.mark.asyncio
    async def test_credit_check_unauthenticated(self) -> None:
        """Credit check fails gracefully when not authenticated."""
        reg = _mock_registry(authenticated=False)
        assert await validate_check_credits(reg) is False

    @pytest.mark.asyncio
    async def test_detailed_credit_check_with_history(self) -> None:
        """Detailed credit check includes transaction history."""
        reg = _mock_registry()
        assert reg.auth is not None
        mock_client = MagicMock()
        mock_client.get = AsyncMock(side_effect=[
            {"data": {"balance": 50.0}},
            {
                "data": {
                    "totalSpent": 50.0,
                    "totalAdded": 100.0,
                    "recentTransactions": [
                        {
                            "amount": -5.0,
                            "description": "Container deployment",
                            "created_at": "2025-01-15",
                        },
                        {
                            "amount": 100.0,
                            "description": "Credit purchase",
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
        text = result["text"]
        assert "Total spent" in text
        assert "Container deployment" in text
        assert "Credit purchase" in text


# ─── E2E: Provision Error Scenarios ──────────────────────────────────────────


class TestProvisionErrors:
    @pytest.mark.asyncio
    async def test_provision_missing_name(self) -> None:
        reg = _mock_registry()
        result = await handle_provision(reg, options={"project_name": "proj"})
        assert result["success"] is False
        assert "Missing required" in str(result.get("error", ""))

    @pytest.mark.asyncio
    async def test_provision_missing_project(self) -> None:
        reg = _mock_registry()
        result = await handle_provision(reg, options={"name": "agent"})
        assert result["success"] is False
        assert "Missing required" in str(result.get("error", ""))

    @pytest.mark.asyncio
    async def test_provision_unauthenticated(self) -> None:
        reg = _mock_registry(authenticated=False)
        result = await handle_provision(
            reg, options={"name": "agent", "project_name": "proj"},
        )
        assert result["success"] is False

    @pytest.mark.asyncio
    async def test_provision_no_container_service(self) -> None:
        reg = _mock_registry(with_containers=False)
        result = await handle_provision(
            reg, options={"name": "agent", "project_name": "proj"},
        )
        assert result["success"] is False


# ─── E2E: Freeze Error Scenarios ─────────────────────────────────────────────


class TestFreezeErrors:
    @pytest.mark.asyncio
    async def test_freeze_no_container_id(self) -> None:
        reg = _mock_registry()
        result = await handle_freeze(reg)
        assert result["success"] is False

    @pytest.mark.asyncio
    async def test_freeze_stopped_container(self) -> None:
        """Cannot freeze a container that is not running."""
        reg = _mock_registry()
        stopped = _mock_container("c-1", "agent", "stopped")

        assert reg.containers is not None
        reg.containers.get_container = AsyncMock(return_value=stopped)

        result = await handle_freeze(reg, options={"containerId": "c-1"})
        assert result["success"] is False
        assert "not running" in str(result.get("error", "")).lower()

    @pytest.mark.asyncio
    async def test_freeze_unauthenticated(self) -> None:
        reg = _mock_registry(authenticated=False)
        assert await validate_freeze(reg) is False


# ─── E2E: Resume Error Scenarios ─────────────────────────────────────────────


class TestResumeErrors:
    @pytest.mark.asyncio
    async def test_resume_missing_params(self) -> None:
        reg = _mock_registry()
        result = await handle_resume(reg, options={})
        assert result["success"] is False
        assert "Missing required" in str(result.get("error", ""))

    @pytest.mark.asyncio
    async def test_resume_unauthenticated(self) -> None:
        reg = _mock_registry(authenticated=False)
        assert await validate_resume(reg) is False


# ─── E2E: Provider Pipeline ─────────────────────────────────────────────────


class TestProviderPipeline:
    """Test the cloud providers as they'd be called in an agent loop."""

    @pytest.mark.asyncio
    async def test_full_provider_pipeline(self) -> None:
        """Simulate calling all providers in sequence for agent context."""
        auth = MagicMock(spec=CloudAuthService)
        auth.is_authenticated.return_value = True
        auth.get_client.return_value = MagicMock()

        c1 = _mock_container("c-1", "agent-1", "running")
        c2 = _mock_container("c-2", "agent-2", "running")
        container_svc = MagicMock(spec=CloudContainerService)
        container_svc.get_tracked_containers.return_value = [c1, c2]

        bridge_svc = MagicMock(spec=CloudBridgeService)
        bridge_svc.get_connected_container_ids.return_value = ["c-1"]

        # 1) Cloud status
        status_result = await get_cloud_status(
            auth=auth,
            container_svc=container_svc,
            bridge_svc=bridge_svc,
        )
        assert "2 container(s)" in status_result["text"]
        assert status_result["values"]["runningContainers"] == 2

        # 2) Credit balance
        import elizaos_plugin_elizacloud.cloud_providers.credit_balance as cb_mod
        cb_mod._cache = None
        cb_mod._cache_at = 0.0

        auth.get_client.return_value.get = AsyncMock(
            return_value={"data": {"balance": 75.0}}
        )
        credit_result = await get_credit_balance(auth=auth)
        assert "75.00" in credit_result["text"]
        assert credit_result["values"]["cloudCredits"] == 75.0

        # 3) Container health
        health_result = await get_container_health(
            auth=auth,
            container_svc=container_svc,
        )
        assert "2/2 healthy" in health_result["text"]

    @pytest.mark.asyncio
    async def test_provider_pipeline_unauthenticated(self) -> None:
        """When not authenticated, providers return empty/error info."""
        auth = MagicMock(spec=CloudAuthService)
        auth.is_authenticated.return_value = False

        status_result = await get_cloud_status(auth=auth)
        assert "Not authenticated" in status_result["text"]

        credit_result = await get_credit_balance(auth=auth)
        assert credit_result["text"] == ""

        health_result = await get_container_health(auth=auth)
        assert health_result["text"] == ""


# ─── E2E: Service Lifecycle ──────────────────────────────────────────────────


class TestServiceLifecycle:
    """Test service start/stop cycle."""

    @pytest.mark.asyncio
    async def test_auth_service_lifecycle(self) -> None:
        """CloudAuthService can start and stop cleanly."""
        svc = CloudAuthService()
        assert svc.is_authenticated() is False

        await svc.start({})
        assert svc.is_authenticated() is False  # No credentials provided

        await svc.stop()
        assert svc.is_authenticated() is False

    @pytest.mark.asyncio
    async def test_bridge_service_lifecycle(self) -> None:
        """CloudBridgeService handles connect/disconnect cycle."""
        svc = CloudBridgeService()
        await svc.start(CloudAuthService())

        # Connect two containers
        await svc.connect("c-1")
        await svc.connect("c-2")
        assert len(svc.get_connected_container_ids()) == 2

        # Stop disconnects all
        await svc.stop()
        assert len(svc.get_connected_container_ids()) == 0

    @pytest.mark.asyncio
    async def test_backup_service_snapshot_and_list(self) -> None:
        """CloudBackupService can create and list snapshots."""
        svc = CloudBackupService()
        auth = CloudAuthService()
        auth._credentials = MagicMock()
        auth._client = MagicMock(spec=CloudApiClient)

        # Mock create snapshot
        auth._client.post = AsyncMock(return_value={
            "success": True,
            "data": {
                "id": "snap-test",
                "containerId": "c-1",
                "organizationId": "org-1",
                "snapshotType": "manual",
                "storageUrl": "s3://bucket/snap.tar.gz",
                "sizeBytes": 4096,
                "agentConfig": {},
                "metadata": {},
                "created_at": "2025-01-01",
            },
        })
        await svc.start(auth)
        snap = await svc.create_snapshot("c-1", "manual", {})
        assert snap.id == "snap-test"

        # Mock list snapshots
        auth._client.get = AsyncMock(return_value={
            "success": True,
            "data": [
                {
                    "id": "snap-test",
                    "snapshotType": "manual",
                    "sizeBytes": 4096,
                    "created_at": "2025-01-01",
                },
            ],
        })
        snaps = await svc.list_snapshots("c-1")
        assert len(snaps) == 1


# ─── E2E: Error Propagation ─────────────────────────────────────────────────


class TestErrorPropagation:
    def test_cloud_api_error_propagation(self) -> None:
        """CloudApiError carries status code and body through."""
        body = CloudApiErrorBody(success=False, error="Server error")
        err = CloudApiError(500, body)
        assert err.status_code == 500
        assert str(err) == "Server error"

    def test_insufficient_credits_propagation(self) -> None:
        """InsufficientCreditsError is a subclass of CloudApiError."""
        body = CloudApiErrorBody(
            success=False,
            error="Insufficient credits",
            required_credits=15.0,
        )
        err = InsufficientCreditsError(body)
        assert err.status_code == 402
        assert err.required_credits == 15.0
        assert isinstance(err, CloudApiError)

    @pytest.mark.asyncio
    async def test_provision_propagates_api_error(self) -> None:
        """If container creation throws, the exception propagates."""
        reg = _mock_registry()
        assert reg.containers is not None
        reg.containers.create_container = AsyncMock(
            side_effect=Exception("Connection refused")
        )

        with pytest.raises(Exception, match="Connection refused"):
            await handle_provision(
                reg, options={"name": "agent", "project_name": "proj"},
            )


# ─── E2E: Validation Gate Tests ──────────────────────────────────────────────


class TestValidationGates:
    """Ensure all actions gate on authentication."""

    @pytest.mark.asyncio
    async def test_all_validations_reject_unauthenticated(self) -> None:
        reg = _mock_registry(authenticated=False)

        assert await validate_provision(reg) is False
        assert await validate_freeze(reg) is False
        assert await validate_resume(reg) is False
        assert await validate_check_credits(reg) is False

    @pytest.mark.asyncio
    async def test_all_validations_accept_authenticated(self) -> None:
        reg = _mock_registry(authenticated=True)

        assert await validate_provision(reg) is True
        assert await validate_freeze(reg) is True
        assert await validate_resume(reg) is True
        assert await validate_check_credits(reg) is True
