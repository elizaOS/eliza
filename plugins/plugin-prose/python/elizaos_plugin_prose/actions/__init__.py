"""Prose plugin actions."""

from elizaos_plugin_prose.actions.compile import ProseCompileAction
from elizaos_plugin_prose.actions.help import ProseHelpAction
from elizaos_plugin_prose.actions.run import ProseRunAction

__all__ = ["ProseRunAction", "ProseCompileAction", "ProseHelpAction"]


def get_prose_action_names() -> list[str]:
    """Get the names of all prose actions."""
    return ["PROSE_RUN", "PROSE_COMPILE", "PROSE_HELP"]
