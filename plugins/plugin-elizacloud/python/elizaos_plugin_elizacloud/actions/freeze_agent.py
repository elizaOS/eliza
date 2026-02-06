"""
FREEZE_CLOUD_AGENT — Snapshot and stop a cloud agent.

Creates a state snapshot, disconnects bridge, cancels auto-backup,
stops the container. Resume later with RESUME_CLOUD_AGENT.
"""

from __future__ import annotations

import logging

from elizaos_plugin_elizacloud.actions.provision_agent import ActionResult, ServiceRegistry

logger = logging.getLogger("elizacloud.actions.freeze")


def _get_container_id(
    message_metadata: dict[str, object] | None = None,
    options: dict[str, object] | None = None,
) -> str | None:
    if options and options.get("containerId"):
        return str(options["containerId"])
    if message_metadata:
        action_params = message_metadata.get("actionParams")
        if isinstance(action_params, dict) and action_params.get("containerId"):
            return str(action_params["containerId"])
    return None


freeze_cloud_agent_action: dict[str, object] = {
    "name": "FREEZE_CLOUD_AGENT",
    "description": "Freeze a cloud agent: snapshot state, disconnect bridge, stop container.",
    "similes": ["freeze agent", "hibernate agent", "pause agent", "stop cloud agent"],
    "tags": ["cloud", "container", "backup"],
    "parameters": [
        {
            "name": "containerId",
            "description": "ID of the container to freeze",
            "required": True,
            "schema": {"type": "string"},
        },
    ],
}


async def validate_freeze(registry: ServiceRegistry) -> bool:
    return registry.auth is not None and registry.auth.is_authenticated()


async def handle_freeze(
    registry: ServiceRegistry,
    message_text: str = "",
    message_metadata: dict[str, object] | None = None,
    options: dict[str, object] | None = None,
) -> ActionResult:
    """Handle the FREEZE_CLOUD_AGENT action."""
    containers = registry.containers
    bridge = registry.bridge
    backup = registry.backup

    if not containers:
        return ActionResult(success=False, error="Container service unavailable")

    container_id = _get_container_id(message_metadata, options)
    if not container_id:
        return ActionResult(success=False, error="Missing containerId")

    container = await containers.get_container(container_id)
    if container.status != "running":
        return ActionResult(
            success=False,
            error=f"Container not running (status: {container.status})",
        )

    # Snapshot → disconnect → stop
    snapshot_id: str | None = None
    if backup:
        snap = await backup.create_snapshot(container_id, "manual", {
            "trigger": "user-freeze",
            "containerName": container.name,
        })
        snapshot_id = snap.id
        backup.cancel_auto_backup(container_id)

    if bridge:
        await bridge.disconnect(container_id)

    await containers.delete_container(container_id)

    return ActionResult(
        success=True,
        text=f'Agent "{container.name}" frozen',
        data={
            "containerId": container_id,
            "containerName": container.name,
            "snapshotId": snapshot_id,
        },
    )
