"""
CloudContainerService — Manages container lifecycle through ElizaCloud API.

Handles creation, listing, status polling, health monitoring, and deletion
of ECS-backed containers. Deployments are async (CloudFormation takes 8-12
minutes), so `wait_for_deployment` polls with exponential backoff.
"""

from __future__ import annotations

import asyncio
import logging
import time

from elizaos_plugin_elizacloud.services.cloud_auth_service import CloudAuthService
from elizaos_plugin_elizacloud.types.cloud import (
    CloudContainer,
    ContainerHealthResponse,
    CreateContainerRequest,
    CreateContainerResponse,
    DEFAULT_CLOUD_CONFIG,
    PollingInfo,
)
from elizaos_plugin_elizacloud.utils.cloud_api import CloudApiClient

logger = logging.getLogger("elizacloud.container")


def _parse_container(data: dict[str, object]) -> CloudContainer:
    """Parse raw API dict into CloudContainer dataclass."""
    return CloudContainer(
        id=str(data.get("id", "")),
        name=str(data.get("name", "")),
        project_name=str(data.get("project_name", "")),
        description=data.get("description"),  # type: ignore[arg-type]
        organization_id=str(data.get("organization_id", "")),
        user_id=str(data.get("user_id", "")),
        status=str(data.get("status", "pending")),  # type: ignore[arg-type]
        image_tag=data.get("image_tag"),  # type: ignore[arg-type]
        port=int(data.get("port", 3000)),  # type: ignore[arg-type]
        desired_count=int(data.get("desired_count", 1)),  # type: ignore[arg-type]
        cpu=int(data.get("cpu", 1792)),  # type: ignore[arg-type]
        memory=int(data.get("memory", 1792)),  # type: ignore[arg-type]
        architecture=str(data.get("architecture", "arm64")),  # type: ignore[arg-type]
        environment_vars=dict(data.get("environment_vars", {})),  # type: ignore[arg-type]
        health_check_path=str(data.get("health_check_path", "/health")),
        load_balancer_url=data.get("load_balancer_url"),  # type: ignore[arg-type]
        ecr_repository_uri=data.get("ecr_repository_uri"),  # type: ignore[arg-type]
        ecr_image_tag=data.get("ecr_image_tag"),  # type: ignore[arg-type]
        cloudformation_stack_name=data.get("cloudformation_stack_name"),  # type: ignore[arg-type]
        billing_status=str(data.get("billing_status", "active")),  # type: ignore[arg-type]
        total_billed=str(data.get("total_billed", "0")),
        last_deployed_at=data.get("last_deployed_at"),  # type: ignore[arg-type]
        last_health_check=data.get("last_health_check"),  # type: ignore[arg-type]
        deployment_log=data.get("deployment_log"),  # type: ignore[arg-type]
        error_message=data.get("error_message"),  # type: ignore[arg-type]
        metadata=dict(data.get("metadata", {})),  # type: ignore[arg-type]
        created_at=str(data.get("created_at", "")),
        updated_at=str(data.get("updated_at", "")),
    )


class CloudContainerService:
    """ElizaCloud container provisioning and lifecycle management."""

    service_type = "CLOUD_CONTAINER"

    def __init__(self) -> None:
        self._auth_service: CloudAuthService | None = None
        self._tracked: dict[str, CloudContainer] = {}
        self._container_defaults = DEFAULT_CLOUD_CONFIG.container

    async def start(self, auth_service: CloudAuthService) -> None:
        """Initialize with a reference to the auth service."""
        self._auth_service = auth_service
        if not auth_service.is_authenticated():
            logger.warning("[CloudContainer] CloudAuthService not authenticated")
            return

        # Load existing containers
        containers = await self.list_containers()
        for c in containers:
            self._tracked[c.id] = c
        logger.info("[CloudContainer] Loaded %d existing container(s)", len(containers))

    async def stop(self) -> None:
        self._tracked.clear()

    def _get_client(self) -> CloudApiClient:
        if not self._auth_service:
            raise RuntimeError("CloudContainerService not initialized")
        return self._auth_service.get_client()

    # ─── CRUD ───────────────────────────────────────────────────────────────

    async def create_container(self, request: CreateContainerRequest) -> CreateContainerResponse:
        client = self._get_client()
        defs = self._container_defaults

        payload: dict[str, object] = {
            "name": request.name,
            "project_name": request.project_name,
            "description": request.description,
            "port": request.port or defs.default_port,
            "desired_count": request.desired_count or 1,
            "cpu": request.cpu or defs.default_cpu,
            "memory": request.memory or defs.default_memory,
            "environment_vars": request.environment_vars or {},
            "health_check_path": request.health_check_path or "/health",
            "ecr_image_uri": request.ecr_image_uri,
            "ecr_repository_uri": request.ecr_repository_uri,
            "image_tag": request.image_tag,
            "architecture": request.architecture or defs.default_architecture,
        }

        resp = await client.post("/containers", payload)
        raw_data = resp.get("data", {})
        if not isinstance(raw_data, dict):
            raw_data = {}
        container = _parse_container(raw_data)
        self._tracked[container.id] = container

        raw_polling = resp.get("polling", {})
        if not isinstance(raw_polling, dict):
            raw_polling = {}
        polling = PollingInfo(
            endpoint=str(raw_polling.get("endpoint", "")),
            interval_ms=int(raw_polling.get("intervalMs", 10000)),
            expected_duration_ms=int(raw_polling.get("expectedDurationMs", 600000)),
        )

        result = CreateContainerResponse(
            success=bool(resp.get("success")),
            data=container,
            message=str(resp.get("message", "")),
            credits_deducted=float(resp.get("creditsDeducted", 0)),
            credits_remaining=float(resp.get("creditsRemaining", 0)),
            stack_name=str(resp.get("stackName", "")),
            polling=polling,
        )

        logger.info(
            '[CloudContainer] Created container "%s" (id=%s, stack=%s)',
            request.name,
            container.id,
            result.stack_name,
        )
        return result

    async def list_containers(self) -> list[CloudContainer]:
        client = self._get_client()
        resp = await client.get("/containers")
        raw_list = resp.get("data", [])
        if not isinstance(raw_list, list):
            raw_list = []
        return [_parse_container(c) for c in raw_list if isinstance(c, dict)]

    async def get_container(self, container_id: str) -> CloudContainer:
        client = self._get_client()
        resp = await client.get(f"/containers/{container_id}")
        raw_data = resp.get("data", {})
        if not isinstance(raw_data, dict):
            raw_data = {}
        container = _parse_container(raw_data)
        self._tracked[container_id] = container
        return container

    async def delete_container(self, container_id: str) -> None:
        client = self._get_client()
        await client.delete(f"/containers/{container_id}")
        self._tracked.pop(container_id, None)
        logger.info("[CloudContainer] Deleted container %s", container_id)

    # ─── Deployment Polling ────────────────────────────────────────────────

    async def wait_for_deployment(
        self,
        container_id: str,
        timeout_s: float = 900.0,
    ) -> CloudContainer:
        """Poll until container reaches 'running' status, with exponential backoff."""
        deadline = time.monotonic() + timeout_s
        interval = 5.0
        max_interval = 30.0

        while time.monotonic() < deadline:
            container = await self.get_container(container_id)

            if container.status == "running":
                return container
            if container.status == "failed":
                raise RuntimeError(
                    f"Container deployment failed: {container.error_message or 'unknown error'}"
                )
            if container.status in ("stopped", "suspended"):
                raise RuntimeError(f"Container reached terminal state: {container.status}")

            await asyncio.sleep(interval)
            interval = min(interval * 1.5, max_interval)

        raise TimeoutError(f"Container deployment timed out after {timeout_s}s")

    # ─── Health Monitoring ─────────────────────────────────────────────────

    async def get_container_health(self, container_id: str) -> ContainerHealthResponse:
        client = self._get_client()
        resp = await client.get(f"/containers/{container_id}/health")
        raw_data = resp.get("data", {})
        if not isinstance(raw_data, dict):
            raw_data = {}
        from elizaos_plugin_elizacloud.types.cloud import ContainerHealthData

        health_data = ContainerHealthData(
            status=str(raw_data.get("status", "")),
            healthy=bool(raw_data.get("healthy", False)),
            last_check=raw_data.get("lastCheck"),  # type: ignore[arg-type]
            uptime=raw_data.get("uptime"),  # type: ignore[arg-type]
        )
        return ContainerHealthResponse(
            success=bool(resp.get("success")),
            data=health_data,
        )

    # ─── Accessors ─────────────────────────────────────────────────────────

    def get_tracked_containers(self) -> list[CloudContainer]:
        return list(self._tracked.values())

    def get_tracked_container(self, container_id: str) -> CloudContainer | None:
        return self._tracked.get(container_id)

    def is_container_running(self, container_id: str) -> bool:
        c = self._tracked.get(container_id)
        return c is not None and c.status == "running"

    def get_container_url(self, container_id: str) -> str | None:
        c = self._tracked.get(container_id)
        return c.load_balancer_url if c else None
