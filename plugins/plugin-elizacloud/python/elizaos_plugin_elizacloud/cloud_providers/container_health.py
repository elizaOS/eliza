"""
containerHealthProvider — Container health in agent state (private, on-demand).
"""

from __future__ import annotations

from typing import TypedDict

from elizaos_plugin_elizacloud.services.cloud_auth_service import CloudAuthService
from elizaos_plugin_elizacloud.services.cloud_container_service import CloudContainerService


class ProviderResult(TypedDict, total=False):
    text: str
    values: dict[str, object]
    data: dict[str, object]


class HealthReport(TypedDict):
    id: str
    name: str
    healthy: bool
    billing: str


async def get_container_health(
    auth: CloudAuthService | None = None,
    container_svc: CloudContainerService | None = None,
) -> ProviderResult:
    """Get ElizaCloud container health status."""
    if not auth or not auth.is_authenticated():
        return ProviderResult(text="")

    running = (
        [c for c in container_svc.get_tracked_containers() if c.status == "running"]
        if container_svc
        else []
    )
    if not running:
        return ProviderResult(
            text="No running containers.",
            values={"healthyContainers": 0},
        )

    reports: list[HealthReport] = [
        HealthReport(
            id=c.id,
            name=c.name,
            healthy=c.billing_status == "active",
            billing=c.billing_status,
        )
        for c in running
    ]

    healthy_count = len([r for r in reports if r["healthy"]])
    lines = [
        f"Health: {healthy_count}/{len(reports)} healthy",
        *[
            f"  - {r['name']}: {'OK' if r['healthy'] else 'UNHEALTHY'} ({r['billing']})"
            for r in reports
        ],
    ]

    return ProviderResult(
        text="\n".join(lines),
        values={
            "healthyContainers": healthy_count,
            "unhealthyContainers": len(reports) - healthy_count,
        },
        data={"reports": reports},  # type: ignore[typeddict-item]
    )


container_health_provider: dict[str, object] = {
    "name": "elizacloud_health",
    "description": "ElizaCloud container health",
    "dynamic": True,
    "position": 92,
    "private": True,
    "get": get_container_health,
}
