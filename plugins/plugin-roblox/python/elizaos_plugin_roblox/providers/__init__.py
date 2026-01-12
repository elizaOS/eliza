"""
Roblox plugin providers module.
"""

from elizaos_plugin_roblox.providers.game_state import GameStateProvider

__all__ = [
    "GameStateProvider",
]


def get_roblox_provider_names() -> list[str]:
    """Get all Roblox plugin provider names."""
    return ["roblox-game-state"]
