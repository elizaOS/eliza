"""
PROVISION_CLOUD_AGENT — Deploys an elizaOS agent to ElizaCloud.

Creates a container, waits for deployment, connects bridge, starts backup.
"""

from __future__ import annotations

import logging
import re
from typing import TypedDict

from elizaos_plugin_elizacloud.services.cloud_auth_service import CloudAuthService
from elizaos_plugin_elizacloud.services.cloud_backup_service import CloudBackupService
from elizaos_plugin_elizacloud.services.cloud_bridge_service import CloudBridgeService
from elizaos_plugin_elizacloud.services.cloud_container_service import CloudContainerService
from elizaos_plugin_elizacloud.types.cloud import CreateContainerRequest, DEFAULT_CLOUD_CONFIG
from elizaos_plugin_elizacloud.utils.forwarded_settings import collect_env_vars

logger = logging.getLogger("elizacloud.actions.provision")


class ActionResult(TypedDict, total=False):
    success: bool
    error: str | None
    text: str | None
    data: dict[str, object] | None


class ServiceRegistry:
    """Holds references to cloud services for actions to use."""

    def __init__(
        self,
        auth: CloudAuthService | None = None,
        containers: CloudContainerService | None = None,
        bridge: CloudBridgeService | None = None,
        backup: CloudBackupService | None = None,
        settings: dict[str, str | None] | None = None,
    ) -> None:
        self.auth = auth
        self.containers = containers
        self.bridge = bridge
        self.backup = backup
        self.settings = settings or {}


def _extract_params(
    message_text: str,
    message_metadata: dict[str, object] | None = None,
    options: dict[str, object] | None = None,
) -> dict[str, object]:
    if options and len(options) > 0:
        return options
    if message_metadata and message_metadata.get("actionParams"):
        params = message_metadata["actionParams"]
        return params if isinstance(params, dict) else {}
    # Regex fallback from free-text
    name_match = re.search(r'name[:\s]+["\']?([^"\',\s]+)["\']?', message_text, re.IGNORECASE)
    project_match = re.search(
        r'project[:\s]+["\']?([^"\',\s]+)["\']?', message_text, re.IGNORECASE
    )
    return {
        "name": name_match.group(1).strip() if name_match else None,
        "project_name": project_match.group(1).strip() if project_match else None,
    }


provision_cloud_agent_action: dict[str, object] = {
    "name": "PROVISION_CLOUD_AGENT",
    "description": (
        "Deploy an elizaOS agent to ElizaCloud. Provisions a container, "
        "waits for deployment, connects the bridge, and starts auto-backup."
    ),
    "similes": [
        "deploy agent to cloud",
        "launch cloud agent",
        "start remote agent",
        "provision container",
    ],
    "tags": ["cloud", "container", "deployment"],
    "parameters": [
        {
            "name": "name",
            "description": "Human-readable name for the cloud agent",
            "required": True,
            "schema": {"type": "string"},
        },
        {
            "name": "project_name",
            "description": "Unique project identifier (lowercase, no spaces)",
            "required": True,
            "schema": {"type": "string"},
        },
        {
            "name": "description",
            "description": "Optional description",
            "required": False,
            "schema": {"type": "string"},
        },
        {
            "name": "environment_vars",
            "description": "Additional environment variables",
            "required": False,
            "schema": {"type": "object"},
        },
        {
            "name": "auto_backup",
            "description": "Enable periodic auto-backup (default: true)",
            "required": False,
            "schema": {"type": "boolean"},
        },
    ],
}


async def validate_provision(registry: ServiceRegistry) -> bool:
    """Check that the auth service is authenticated."""
    return registry.auth is not None and registry.auth.is_authenticated()


async def handle_provision(
    registry: ServiceRegistry,
    message_text: str = "",
    message_metadata: dict[str, object] | None = None,
    options: dict[str, object] | None = None,
) -> ActionResult:
    """Handle the PROVISION_CLOUD_AGENT action."""
    auth = registry.auth
    containers = registry.containers
    bridge = registry.bridge
    backup = registry.backup

    if not auth or not auth.is_authenticated() or not containers:
        return ActionResult(
            success=False,
            error="ElizaCloud not authenticated or container service unavailable",
        )

    params = _extract_params(message_text, message_metadata, options)
    if not params.get("name") or not params.get("project_name"):
        return ActionResult(
            success=False,
            error="Missing required parameters: name and project_name",
        )

    defs = DEFAULT_CLOUD_CONFIG.container
    env_vars = collect_env_vars(registry.settings)
    extra_env = params.get("environment_vars")
    if isinstance(extra_env, dict):
        env_vars.update({str(k): str(v) for k, v in extra_env.items()})

    request = CreateContainerRequest(
        name=str(params["name"]),
        project_name=str(params["project_name"]),
        description=str(params["description"]) if params.get("description") else None,
        port=defs.default_port,
        cpu=defs.default_cpu,
        memory=defs.default_memory,
        architecture=defs.default_architecture,
        ecr_image_uri=defs.default_image,
        environment_vars=env_vars,
        health_check_path="/health",
    )

    created = await containers.create_container(request)
    container_id = created.data.id

    running = await containers.wait_for_deployment(container_id)

    if bridge:
        await bridge.connect(container_id)
        logger.info("[PROVISION] Bridge connected to %s", container_id)

    auto_backup = params.get("auto_backup") is not False
    if auto_backup and backup:
        backup.schedule_auto_backup(container_id)

    return ActionResult(
        success=True,
        text=f'Cloud agent "{params["name"]}" deployed',
        data={
            "containerId": container_id,
            "containerUrl": running.load_balancer_url,
            "status": running.status,
            "creditsDeducted": created.credits_deducted,
            "creditsRemaining": created.credits_remaining,
            "bridgeConnected": (
                bridge.get_connection_state(container_id) == "connected" if bridge else False
            ),
            "autoBackupEnabled": auto_backup,
        },
    )
