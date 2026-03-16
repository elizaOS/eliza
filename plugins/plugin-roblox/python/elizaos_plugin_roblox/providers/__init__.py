from elizaos_plugin_roblox.providers.game_state import GameStateProvider

__all__ = [
    "GameStateProvider",
]


def get_roblox_provider_names() -> list[str]:
    return ["roblox-game-state"]
