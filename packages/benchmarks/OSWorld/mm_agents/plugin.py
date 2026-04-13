"""
ElizaOS Plugin for OSWorld desktop automation benchmark.

Packages all desktop actions and the observation provider into a proper
Plugin object so the agent can register them via the canonical plugin pattern
instead of individual register_action / register_provider calls.
"""
from __future__ import annotations

from elizaos.types import Plugin
from elizaos.types.components import Action, ActionResult

from mm_agents.eliza_desktop_actions import ALL_DESKTOP_ACTIONS
from mm_agents.eliza_observation import OBSERVATION_PROVIDER

__all__ = ["osworld_plugin", "create_osworld_plugin"]


# ---------------------------------------------------------------------------
# No-op REPLY action
# ---------------------------------------------------------------------------
# The Eliza message service always tries to call REPLY as the default response
# action. OSWorld doesn't need it, but we register a no-op so the runtime
# doesn't log "Action not found: REPLY" warnings.


async def _noop_reply_handler(
    runtime: object,
    message: object,
    state: object,
    options: object = None,
    callback: object = None,
    responses: object = None,
) -> ActionResult:
    """No-op REPLY handler -- OSWorld agent doesn't converse."""
    return ActionResult(success=True, text="")


async def _noop_reply_validate(
    runtime: object, message: object, state: object
) -> bool:
    return True


_REPLY_ACTION = Action(
    name="REPLY",
    description="Default reply action (no-op for OSWorld)",
    handler=_noop_reply_handler,
    validate=_noop_reply_validate,
)


# ---------------------------------------------------------------------------
# Plugin factory
# ---------------------------------------------------------------------------


def create_osworld_plugin() -> Plugin:
    """Create the OSWorld benchmark plugin with all actions and providers."""
    return Plugin(
        name="osworld-bench",
        description=(
            "OSWorld desktop automation benchmark plugin for ElizaOS - "
            "provides desktop operation actions (DESKTOP_CLICK, DESKTOP_TYPE, "
            "DESKTOP_HOTKEY, DESKTOP_SCROLL, DESKTOP_DRAG, etc.) and an "
            "observation provider for VM screenshot / accessibility-tree context."
        ),
        config={},
        actions=[*ALL_DESKTOP_ACTIONS, _REPLY_ACTION],
        providers=[OBSERVATION_PROVIDER],
        evaluators=[],
        services=[],
    )


osworld_plugin = create_osworld_plugin()
