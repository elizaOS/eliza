"""
Autonomy Routes for elizaOS Python runtime.

API routes for controlling autonomy via REST.
"""

from __future__ import annotations

from elizaos.types.plugin import Route, RouteRequest, RouteResponse
from elizaos.types.runtime import IAgentRuntime

from .service import AUTONOMY_SERVICE_TYPE, AutonomyService

Route.model_rebuild()


def _get_autonomy_service(runtime: IAgentRuntime) -> AutonomyService | None:
    """Get autonomy service from runtime with fallback."""
    service = runtime.get_service(AUTONOMY_SERVICE_TYPE)
    if service is None:
        service = runtime.get_service("autonomy")
    return service  # type: ignore[return-value]


async def _status_handler(_req: RouteRequest, res: RouteResponse, runtime: IAgentRuntime) -> None:
    """GET /autonomy/status - Get current autonomy status."""
    autonomy_service = _get_autonomy_service(runtime)

    if not autonomy_service:
        res.status(503).json({"error": "Autonomy service not available"})
        return

    status = autonomy_service.get_status()

    res.json(
        {
            "success": True,
            "data": {
                "enabled": status.enabled,
                "running": status.running,
                "interval": status.interval,
                "intervalSeconds": round(status.interval / 1000),
                "autonomousRoomId": status.autonomous_room_id,
                "agentId": str(runtime.agent_id),
                "characterName": runtime.character.name if runtime.character else "Agent",
            },
        }
    )


async def _enable_handler(_req: RouteRequest, res: RouteResponse, runtime: IAgentRuntime) -> None:
    """POST /autonomy/enable - Enable autonomy."""
    autonomy_service = _get_autonomy_service(runtime)

    if not autonomy_service:
        res.status(503).json({"success": False, "error": "Autonomy service not available"})
        return

    await autonomy_service.enable_autonomy()
    status = autonomy_service.get_status()

    res.json(
        {
            "success": True,
            "message": "Autonomy enabled",
            "data": {
                "enabled": status.enabled,
                "running": status.running,
                "interval": status.interval,
            },
        }
    )


async def _disable_handler(_req: RouteRequest, res: RouteResponse, runtime: IAgentRuntime) -> None:
    """POST /autonomy/disable - Disable autonomy."""
    autonomy_service = _get_autonomy_service(runtime)

    if not autonomy_service:
        res.status(503).json({"success": False, "error": "Autonomy service not available"})
        return

    await autonomy_service.disable_autonomy()
    status = autonomy_service.get_status()

    res.json(
        {
            "success": True,
            "message": "Autonomy disabled",
            "data": {
                "enabled": status.enabled,
                "running": status.running,
                "interval": status.interval,
            },
        }
    )


async def _toggle_handler(_req: RouteRequest, res: RouteResponse, runtime: IAgentRuntime) -> None:
    """POST /autonomy/toggle - Toggle autonomy state."""
    autonomy_service = _get_autonomy_service(runtime)

    if not autonomy_service:
        res.status(503).json({"success": False, "error": "Autonomy service not available"})
        return

    current_status = autonomy_service.get_status()

    if current_status.enabled:
        await autonomy_service.disable_autonomy()
    else:
        await autonomy_service.enable_autonomy()

    new_status = autonomy_service.get_status()

    res.json(
        {
            "success": True,
            "message": "Autonomy enabled" if new_status.enabled else "Autonomy disabled",
            "data": {
                "enabled": new_status.enabled,
                "running": new_status.running,
                "interval": new_status.interval,
            },
        }
    )


async def _interval_handler(req: RouteRequest, res: RouteResponse, runtime: IAgentRuntime) -> None:
    """POST /autonomy/interval - Set loop interval."""
    autonomy_service = _get_autonomy_service(runtime)

    if not autonomy_service:
        res.status(503).json({"success": False, "error": "Autonomy service not available"})
        return

    body = req.body or {}
    interval = body.get("interval") if isinstance(body, dict) else None

    if not isinstance(interval, (int, float)) or interval < 5000 or interval > 600000:
        res.status(400).json(
            {
                "success": False,
                "error": "Interval must be a number between 5000ms (5s) and 600000ms (10m)",
            }
        )
        return

    autonomy_service.set_loop_interval(int(interval))
    status = autonomy_service.get_status()

    res.json(
        {
            "success": True,
            "message": "Interval updated",
            "data": {
                "interval": status.interval,
                "intervalSeconds": round(status.interval / 1000),
            },
        }
    )


# Autonomy API routes
autonomy_routes: list[Route] = [
    Route(type="GET", path="/autonomy/status", handler=_status_handler),
    Route(type="POST", path="/autonomy/enable", handler=_enable_handler),
    Route(type="POST", path="/autonomy/disable", handler=_disable_handler),
    Route(type="POST", path="/autonomy/toggle", handler=_toggle_handler),
    Route(type="POST", path="/autonomy/interval", handler=_interval_handler),
]
