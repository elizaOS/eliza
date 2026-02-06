"""
RESUME_CLOUD_AGENT — Restore a frozen agent from snapshot.

Re-provisions the container, restores state from the most recent (or
specified) snapshot, reconnects bridge, resumes auto-backup.
"""

from __future__ import annotations

import logging

from elizaos_plugin_elizacloud.actions.provision_agent import ActionResult, ServiceRegistry
from elizaos_plugin_elizacloud.types.cloud import (
    AgentSnapshot,
    CreateContainerRequest,
    DEFAULT_CLOUD_CONFIG,
)
from elizaos_plugin_elizacloud.utils.forwarded_settings import collect_env_vars

logger = logging.getLogger("elizacloud.actions.resume")


def _extract_params(
    message_metadata: dict[str, object] | None = None,
    options: dict[str, object] | None = None,
) -> dict[str, object]:
    if options and len(options) > 0:
        return options
    if message_metadata and message_metadata.get("actionParams"):
        params = message_metadata["actionParams"]
        return params if isinstance(params, dict) else {}
    return {}


async def _find_latest_project_snapshot(
    backup,  # noqa: ANN001 – CloudBackupService
    containers,  # noqa: ANN001 – CloudContainerService
    project_name: str,
) -> AgentSnapshot | None:
    all_containers = await containers.list_containers()
    project_ids = [c.id for c in all_containers if c.project_name == project_name]
    snapshots: list[AgentSnapshot] = []
    for cid in project_ids:
        snapshots.extend(await backup.list_snapshots(cid))
    snapshots.sort(key=lambda s: s.created_at, reverse=True)
    return snapshots[0] if snapshots else None


resume_cloud_agent_action: dict[str, object] = {
    "name": "RESUME_CLOUD_AGENT",
    "description": (
        "Resume a frozen cloud agent from snapshot. Re-provisions, "
        "restores state, reconnects bridge."
    ),
    "similes": ["resume agent", "unfreeze agent", "restart cloud agent", "restore agent"],
    "tags": ["cloud", "container", "restore"],
    "parameters": [
        {
            "name": "name",
            "description": "Name for the restored agent",
            "required": True,
            "schema": {"type": "string"},
        },
        {
            "name": "project_name",
            "description": "Project identifier (must match original)",
            "required": True,
            "schema": {"type": "string"},
        },
        {
            "name": "snapshotId",
            "description": "Specific snapshot ID (defaults to latest)",
            "required": False,
            "schema": {"type": "string"},
        },
        {
            "name": "environment_vars",
            "description": "Additional environment variables",
            "required": False,
            "schema": {"type": "object"},
        },
    ],
}


async def validate_resume(registry: ServiceRegistry) -> bool:
    return registry.auth is not None and registry.auth.is_authenticated()


async def handle_resume(
    registry: ServiceRegistry,
    message_text: str = "",
    message_metadata: dict[str, object] | None = None,
    options: dict[str, object] | None = None,
) -> ActionResult:
    """Handle the RESUME_CLOUD_AGENT action."""
    container_svc = registry.containers
    bridge = registry.bridge
    backup = registry.backup

    if not container_svc:
        return ActionResult(success=False, error="Container service unavailable")

    params = _extract_params(message_metadata, options)
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
        port=defs.default_port,
        cpu=defs.default_cpu,
        memory=defs.default_memory,
        architecture=defs.default_architecture,
        ecr_image_uri=defs.default_image,
        environment_vars=env_vars,
        health_check_path="/health",
    )

    created = await container_svc.create_container(request)
    container_id = created.data.id

    running = await container_svc.wait_for_deployment(container_id)

    # Restore from snapshot
    restored_id: str | None = None
    if backup:
        explicit = params.get("snapshotId")
        if explicit:
            await backup.restore_snapshot(container_id, str(explicit))
            restored_id = str(explicit)
        else:
            latest = await _find_latest_project_snapshot(
                backup, container_svc, str(params["project_name"])
            )
            if latest:
                await backup.restore_snapshot(container_id, latest.id)
                restored_id = latest.id
        backup.schedule_auto_backup(container_id)

    if bridge:
        await bridge.connect(container_id)

    return ActionResult(
        success=True,
        text=f'Cloud agent "{params["name"]}" resumed',
        data={
            "containerId": container_id,
            "containerUrl": running.load_balancer_url,
            "restoredSnapshotId": restored_id,
            "creditsDeducted": created.credits_deducted,
            "creditsRemaining": created.credits_remaining,
        },
    )
