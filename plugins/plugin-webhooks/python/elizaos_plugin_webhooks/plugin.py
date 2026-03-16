"""
elizaOS plugin definition for HTTP webhook ingress.

Exposes three route groups:
  POST /hooks/wake      – Enqueue system event + optional immediate heartbeat
  POST /hooks/agent     – Run isolated agent turn + optional delivery
  POST /hooks/:name     – Mapped webhook (resolves via hooks.mappings config)

No separate HTTP server is created – routes register on the runtime's
existing HTTP server via the Eliza plugin system.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Coroutine

from .handlers import handle_agent, handle_mapped, handle_wake


@dataclass
class Route:
    """A single HTTP route registered by a plugin."""

    type: str
    path: str
    handler: Callable[..., Coroutine[Any, Any, Any]]


@dataclass
class WebhooksPlugin:
    """HTTP webhook ingress for external triggers."""

    name: str = "webhooks"
    description: str = "HTTP webhook ingress for external triggers"
    routes: list[Route] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.routes = [
            Route(type="POST", path="/hooks/wake", handler=handle_wake),
            Route(type="POST", path="/hooks/agent", handler=handle_agent),
            Route(type="POST", path="/hooks/:name", handler=handle_mapped),
        ]


webhooks_plugin = WebhooksPlugin()
