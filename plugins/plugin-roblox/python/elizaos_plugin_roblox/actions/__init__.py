from elizaos_plugin_roblox.actions.execute_game_action import ExecuteGameActionAction
from elizaos_plugin_roblox.actions.get_player_info import GetPlayerInfoAction
from elizaos_plugin_roblox.actions.send_game_message import SendGameMessageAction

__all__ = [
    "SendGameMessageAction",
    "ExecuteGameActionAction",
    "GetPlayerInfoAction",
]


def get_roblox_action_names() -> list[str]:
    return [
        "SEND_ROBLOX_MESSAGE",
        "EXECUTE_ROBLOX_ACTION",
        "GET_ROBLOX_PLAYER_INFO",
    ]
