"""Lobster plugin actions."""

from elizaos_plugin_lobster.actions.resume import LobsterResumeAction
from elizaos_plugin_lobster.actions.run import LobsterRunAction

__all__ = ["LobsterRunAction", "LobsterResumeAction"]


def get_lobster_action_names() -> list[str]:
    """Get the names of all lobster actions."""
    return ["LOBSTER_RUN", "LOBSTER_RESUME"]
