"""Tests for cloud services — integration tests that work without API credentials."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from elizaos_plugin_elizacloud.services.cloud_auth_service import (
    CloudAuthService,
    _derive_device_id,
    _detect_platform,
)
from elizaos_plugin_elizacloud.services.cloud_backup_service import (
    CloudBackupService,
    _format_bytes,
    _parse_snapshot,
)
from elizaos_plugin_elizacloud.services.cloud_bridge_service import (
    ActiveConnection,
    CloudBridgeService,
)
from elizaos_plugin_elizacloud.services.cloud_container_service import (
    CloudContainerService,
    _parse_container,
)
from elizaos_plugin_elizacloud.utils.cloud_api import CloudApiClient


# ─── CloudAuthService ────────────────────────────────────────────────────────


class TestCloudAuthService:
    def test_initial_state(self) -> None:
        svc = CloudAuthService()
        assert svc.is_authenticated() is False
        assert svc.get_credentials() is None
        assert svc.get_user_id() is None
        assert svc.get_organization_id() is None

    def test_get_client_returns_api_client(self) -> None:
        svc = CloudAuthService()
        client = svc.get_client()
        assert isinstance(client, CloudApiClient)
        assert "elizacloud.ai" in client.base_url

    @pytest.mark.asyncio
    async def test_start_without_credentials(self) -> None:
        svc = CloudAuthService()
        await svc.start({})
        assert svc.is_authenticated() is False

    @pytest.mark.asyncio
    async def test_start_with_valid_api_key(self) -> None:
        svc = CloudAuthService()
        with patch.object(svc, "_validate_api_key", return_value=True):
            await svc.start({
                "ELIZAOS_CLOUD_API_KEY": "test-key-123",
                "ELIZAOS_CLOUD_USER_ID": "user-abc",
                "ELIZAOS_CLOUD_ORG_ID": "org-def",
            })
        assert svc.is_authenticated() is True
        assert svc.get_api_key() == "test-key-123"
        assert svc.get_user_id() == "user-abc"
        assert svc.get_organization_id() == "org-def"

    @pytest.mark.asyncio
    async def test_start_with_invalid_api_key_no_cloud_enabled(self) -> None:
        svc = CloudAuthService()
        with patch.object(svc, "_validate_api_key", return_value=False):
            await svc.start({"ELIZAOS_CLOUD_API_KEY": "bad-key"})
        assert svc.is_authenticated() is False

    @pytest.mark.asyncio
    async def test_stop_clears_credentials(self) -> None:
        svc = CloudAuthService()
        with patch.object(svc, "_validate_api_key", return_value=True):
            await svc.start({"ELIZAOS_CLOUD_API_KEY": "test-key"})
        assert svc.is_authenticated() is True
        await svc.stop()
        assert svc.is_authenticated() is False

    @pytest.mark.asyncio
    async def test_device_auth_flow(self) -> None:
        svc = CloudAuthService()
        mock_resp: dict[str, object] = {
            "success": True,
            "data": {
                "apiKey": "new-key",
                "userId": "new-user",
                "organizationId": "new-org",
                "credits": 5.0,
                "isNew": True,
            },
        }
        with patch.object(svc.client, "post_unauthenticated", return_value=mock_resp):
            creds = await svc.authenticate_with_device()

        assert creds.api_key == "new-key"
        assert creds.user_id == "new-user"
        assert svc.is_authenticated() is True


class TestAuthHelpers:
    def test_derive_device_id_is_deterministic(self) -> None:
        id1 = _derive_device_id()
        id2 = _derive_device_id()
        assert id1 == id2
        assert len(id1) == 64  # SHA-256 hex

    def test_detect_platform(self) -> None:
        plat = _detect_platform()
        assert plat in ("macos", "windows", "linux", "web")


# ─── CloudContainerService ───────────────────────────────────────────────────


class TestCloudContainerService:
    def _make_service(self) -> tuple[CloudContainerService, CloudAuthService]:
        svc = CloudContainerService()
        auth = CloudAuthService()
        auth._credentials = MagicMock()
        auth._client = MagicMock(spec=CloudApiClient)
        return svc, auth

    @pytest.mark.asyncio
    async def test_list_containers_parses_response(self) -> None:
        svc, auth = self._make_service()
        auth._client.get = AsyncMock(return_value={
            "success": True,
            "data": [
                {
                    "id": "c-1",
                    "name": "agent-1",
                    "project_name": "proj-1",
                    "status": "running",
                    "port": 3000,
                    "desired_count": 1,
                    "cpu": 1792,
                    "memory": 1792,
                    "architecture": "arm64",
                    "environment_vars": {},
                    "health_check_path": "/health",
                    "billing_status": "active",
                    "total_billed": "5.00",
                    "metadata": {},
                },
            ],
        })
        svc._auth_service = auth
        containers = await svc.list_containers()
        assert len(containers) == 1
        assert containers[0].id == "c-1"
        assert containers[0].status == "running"

    @pytest.mark.asyncio
    async def test_create_container_request_construction(self) -> None:
        svc, auth = self._make_service()
        auth._client.post = AsyncMock(return_value={
            "success": True,
            "data": {
                "id": "c-new",
                "name": "new-agent",
                "project_name": "proj",
                "status": "pending",
                "port": 3000,
                "desired_count": 1,
                "cpu": 1792,
                "memory": 1792,
                "architecture": "arm64",
                "environment_vars": {},
                "health_check_path": "/health",
                "billing_status": "active",
                "total_billed": "0",
                "metadata": {},
            },
            "message": "Created",
            "creditsDeducted": 5.0,
            "creditsRemaining": 95.0,
            "stackName": "stack-new",
            "polling": {
                "endpoint": "/containers/c-new",
                "intervalMs": 10000,
                "expectedDurationMs": 600000,
            },
        })
        svc._auth_service = auth

        from elizaos_plugin_elizacloud.types.cloud import CreateContainerRequest

        req = CreateContainerRequest(
            name="new-agent",
            project_name="proj",
            ecr_image_uri="elizaos/agent:latest",
        )
        resp = await svc.create_container(req)

        assert resp.success is True
        assert resp.data.id == "c-new"
        assert resp.credits_deducted == 5.0
        assert resp.stack_name == "stack-new"

        # Verify request payload sent to API
        call_args = auth._client.post.call_args
        assert call_args[0][0] == "/containers"
        payload = call_args[0][1]
        assert payload["name"] == "new-agent"
        assert payload["project_name"] == "proj"

    @pytest.mark.asyncio
    async def test_delete_container_removes_tracking(self) -> None:
        svc, auth = self._make_service()
        auth._client.delete = AsyncMock(return_value={"success": True})
        svc._auth_service = auth
        svc._tracked["c-1"] = MagicMock()

        await svc.delete_container("c-1")
        assert "c-1" not in svc._tracked

    def test_accessors(self) -> None:
        svc = CloudContainerService()
        assert svc.get_tracked_containers() == []
        assert svc.get_tracked_container("x") is None
        assert svc.is_container_running("x") is False
        assert svc.get_container_url("x") is None


class TestParseContainer:
    def test_minimal_data(self) -> None:
        c = _parse_container({"id": "c-1", "name": "test"})
        assert c.id == "c-1"
        assert c.name == "test"
        assert c.status == "pending"  # default

    def test_full_data(self) -> None:
        c = _parse_container({
            "id": "c-2",
            "name": "agent",
            "project_name": "proj",
            "status": "running",
            "port": 8080,
            "load_balancer_url": "https://lb.example.com",
        })
        assert c.status == "running"
        assert c.port == 8080
        assert c.load_balancer_url == "https://lb.example.com"


# ─── CloudBridgeService ─────────────────────────────────────────────────────


class TestCloudBridgeService:
    @pytest.mark.asyncio
    async def test_connect_and_disconnect(self) -> None:
        svc = CloudBridgeService()
        auth = CloudAuthService()
        await svc.start(auth)

        await svc.connect("c-1")
        assert svc.get_connection_state("c-1") == "connected"
        assert "c-1" in svc.get_connected_container_ids()

        await svc.disconnect("c-1")
        assert svc.get_connection_state("c-1") == "disconnected"
        assert svc.get_connected_container_ids() == []

    @pytest.mark.asyncio
    async def test_double_connect_is_idempotent(self) -> None:
        svc = CloudBridgeService()
        await svc.start(CloudAuthService())

        await svc.connect("c-1")
        await svc.connect("c-1")  # Should not fail
        assert svc.get_connection_state("c-1") == "connected"

    def test_get_connection_info(self) -> None:
        svc = CloudBridgeService()
        assert svc.get_connection_info("nonexistent") is None

    def test_on_message_handler(self) -> None:
        svc = CloudBridgeService()
        messages: list[object] = []

        def handler(msg: object) -> None:
            messages.append(msg)

        unsub = svc.on_message("c-1", handler)
        assert callable(unsub)

        # Unsubscribe
        unsub()

    @pytest.mark.asyncio
    async def test_send_notification_requires_connection(self) -> None:
        svc = CloudBridgeService()
        await svc.start(CloudAuthService())

        with pytest.raises(RuntimeError, match="Not connected"):
            svc.send_notification("c-1", "test", {})

    @pytest.mark.asyncio
    async def test_stop_disconnects_all(self) -> None:
        svc = CloudBridgeService()
        await svc.start(CloudAuthService())
        await svc.connect("c-1")
        await svc.connect("c-2")

        await svc.stop()
        assert svc.get_connected_container_ids() == []


# ─── CloudBackupService ─────────────────────────────────────────────────────


class TestCloudBackupService:
    def _make_service(self) -> tuple[CloudBackupService, CloudAuthService]:
        svc = CloudBackupService()
        auth = CloudAuthService()
        auth._credentials = MagicMock()
        auth._client = MagicMock(spec=CloudApiClient)
        return svc, auth

    @pytest.mark.asyncio
    async def test_create_snapshot_parses_response(self) -> None:
        svc, auth = self._make_service()
        auth._client.post = AsyncMock(return_value={
            "success": True,
            "data": {
                "id": "snap-1",
                "containerId": "c-1",
                "organizationId": "org-1",
                "snapshotType": "manual",
                "storageUrl": "s3://bucket/snap-1.tar.gz",
                "sizeBytes": 2048,
                "agentConfig": {},
                "metadata": {"trigger": "test"},
                "created_at": "2025-01-01T00:00:00Z",
            },
        })
        await svc.start(auth)

        snap = await svc.create_snapshot("c-1", "manual", {"trigger": "test"})
        assert snap.id == "snap-1"
        assert snap.size_bytes == 2048

    @pytest.mark.asyncio
    async def test_list_snapshots(self) -> None:
        svc, auth = self._make_service()
        auth._client.get = AsyncMock(return_value={
            "success": True,
            "data": [
                {"id": "s1", "snapshotType": "auto", "sizeBytes": 100, "created_at": "2025-01-01"},
                {"id": "s2", "snapshotType": "manual", "sizeBytes": 200, "created_at": "2025-01-02"},
            ],
        })
        await svc.start(auth)

        snaps = await svc.list_snapshots("c-1")
        assert len(snaps) == 2
        assert snaps[0].id == "s1"

    @pytest.mark.asyncio
    async def test_restore_snapshot(self) -> None:
        svc, auth = self._make_service()
        auth._client.post = AsyncMock(return_value={"success": True, "message": "Restored"})
        await svc.start(auth)

        await svc.restore_snapshot("c-1", "snap-1")
        auth._client.post.assert_called_once_with(
            "/agent-state/c-1/restore",
            {"snapshotId": "snap-1"},
        )

    def test_auto_backup_scheduling(self) -> None:
        svc = CloudBackupService()
        assert svc.is_auto_backup_scheduled("c-1") is False
        assert svc.get_last_backup_time("c-1") is None

    @pytest.mark.asyncio
    async def test_cancel_auto_backup(self) -> None:
        svc = CloudBackupService()
        # Should not raise even if nothing is scheduled
        svc.cancel_auto_backup("c-1")


class TestBackupHelpers:
    def test_format_bytes(self) -> None:
        assert _format_bytes(500) == "500 B"
        assert _format_bytes(1024) == "1.0 KB"
        assert _format_bytes(1024 * 1024) == "1.0 MB"
        assert _format_bytes(1024 * 1024 * 1024) == "1.0 GB"
        assert _format_bytes(2048) == "2.0 KB"

    def test_parse_snapshot(self) -> None:
        snap = _parse_snapshot({
            "id": "s-1",
            "containerId": "c-1",
            "snapshotType": "auto",
            "sizeBytes": 1024,
            "created_at": "2025-01-01",
        })
        assert snap.id == "s-1"
        assert snap.container_id == "c-1"
        assert snap.snapshot_type == "auto"
