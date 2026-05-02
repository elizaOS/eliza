"""Security status provider.

Injects recent security event information into the agent context so the
agent can adapt its behaviour to the current threat landscape.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.types import Provider, ProviderResult

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State

    from ..service import SecurityModuleService


async def get_security_status(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> ProviderResult:
    """Provide current security status including recent events."""
    service = runtime.get_service("security_module")
    security_module = service if isinstance(service, SecurityModuleService) else None

    if security_module is None:
        return ProviderResult(text="", values={"securityAvailable": False}, data={})

    # Get room_id from message if available
    room_id = message.room_id if hasattr(message, "room_id") else None

    recent_events = await security_module.get_recent_security_events(room_id=room_id, hours=24)

    event_count = len(recent_events)
    severity_counts: dict[str, int] = {}
    for ev in recent_events:
        sev = ev.severity.value
        severity_counts[sev] = severity_counts.get(sev, 0) + 1

    threat_level = "low"
    if severity_counts.get("critical", 0) > 0:
        threat_level = "critical"
    elif severity_counts.get("high", 0) > 0:
        threat_level = "high"
    elif severity_counts.get("medium", 0) > 0:
        threat_level = "medium"

    if event_count == 0:
        text = "# Security Status\nNo recent security events. Threat level: low."
    else:
        severity_summary = ", ".join(f"{k}: {v}" for k, v in sorted(severity_counts.items()))
        text = (
            f"# Security Status\n"
            f"Recent events (24h): {event_count}\n"
            f"Severity breakdown: {severity_summary}\n"
            f"Current threat level: {threat_level}"
        )

    return ProviderResult(
        text=text,
        values={
            "securityAvailable": True,
            "recentEventCount": event_count,
            "threatLevel": threat_level,
        },
        data={
            "severityCounts": severity_counts,
            "events": [
                {
                    "type": ev.type.value,
                    "severity": ev.severity.value,
                    "entityId": str(ev.entity_id),
                    "timestamp": ev.timestamp,
                }
                for ev in recent_events[:10]
            ],
        },
    )


security_status_provider = Provider(
    name="SECURITY_STATUS",
    description="Current security status and recent security events",
    get=get_security_status,
    dynamic=True,
)
