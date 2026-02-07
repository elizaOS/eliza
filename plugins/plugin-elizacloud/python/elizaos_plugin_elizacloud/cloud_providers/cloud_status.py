"""
cloudStatusProvider — Container and connection status in agent state.
"""

from __future__ import annotations

from typing import TypedDict

from elizaos_plugin_elizacloud.services.cloud_auth_service import CloudAuthService
from elizaos_plugin_elizacloud.services.cloud_bridge_service import CloudBridgeService
from elizaos_plugin_elizacloud.services.cloud_container_service import CloudContainerService


class ProviderResult(TypedDict, total=False):
    text: str
    values: dict[str, object]
    data: dict[str, object]


class ContainerSummary(TypedDict):
    id: str
    name: str
    status: str
    url: str | None
    billing: str
    bridged: bool


async def get_cloud_status(
    auth: CloudAuthService | None = None,
    container_svc: CloudContainerService | None = None,
    bridge_svc: CloudBridgeService | None = None,
) -> ProviderResult:
    """Get ElizaCloud container and connection status."""
    if not auth or not auth.is_authenticated():
        return ProviderResult(
            text="ElizaCloud: Not authenticated",
            values={"cloudAuthenticated": False},
        )

    containers = container_svc.get_tracked_containers() if container_svc else []
    connected = bridge_svc.get_connected_container_ids() if bridge_svc else []

    running = len([c for c in containers if c.status == "running"])
    deploying = len(
        [c for c in containers if c.status in ("pending", "building", "deploying")]
    )

    summaries: list[ContainerSummary] = [
        ContainerSummary(
            id=c.id,
            name=c.name,
            status=c.status,
            url=c.load_balancer_url,
            billing=c.billing_status,
            bridged=c.id in connected,
        )
        for c in containers
    ]

    lines = [
        f"ElizaCloud: {len(containers)} container(s), {running} running, {len(connected)} bridged",
        *[
            f"  - {s['name']} [{s['status']}]"
            + (f" @ {s['url']}" if s["url"] else "")
            + (" (bridged)" if s["bridged"] else "")
            for s in summaries
        ],
    ]

    return ProviderResult(
        text="\n".join(lines),
        values={
            "cloudAuthenticated": True,
            "totalContainers": len(containers),
            "runningContainers": running,
            "deployingContainers": deploying,
        },
        data={"containers": summaries},  # type: ignore[typeddict-item]
    )


cloud_status_provider: dict[str, object] = {
    "name": "elizacloud_status",
    "description": "ElizaCloud container and connection status",
    "dynamic": True,
    "position": 90,
    "get": get_cloud_status,
}
