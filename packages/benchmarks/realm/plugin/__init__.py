"""
REALM Benchmark Plugin for ElizaOS.

This plugin provides actions and providers for the REALM benchmark,
enabling the agent to generate and execute plans using the full ElizaOS
message handling loop.
"""

from __future__ import annotations

from elizaos.types import Plugin

from .actions import REALM_ACTIONS
from .providers import REALM_PROVIDERS

__all__ = ["realm_plugin", "create_realm_plugin"]


def create_realm_plugin() -> Plugin:
    """Create the REALM benchmark plugin."""

    async def init_plugin(
        config: dict[str, str | int | float | bool | None],
        runtime: object,
    ) -> None:
        """Initialize the REALM plugin."""
        _ = config
        if hasattr(runtime, "logger"):
            runtime.logger.info(  # type: ignore[union-attr]
                "REALM benchmark plugin initialized",
                src="plugin:realm",
                actionCount=len(REALM_ACTIONS),
                providerCount=len(REALM_PROVIDERS),
            )

    return Plugin(
        name="realm",
        description="REALM benchmark plugin - provides planning actions and task context providers",
        init=init_plugin,
        config={},
        services=[],
        actions=REALM_ACTIONS,
        providers=REALM_PROVIDERS,
        evaluators=[],
    )


realm_plugin = create_realm_plugin()
