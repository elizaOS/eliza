from __future__ import annotations

from dataclasses import dataclass

from elizaos_plugin_roblox.actions.send_game_message import ActionExample


@dataclass
class GetPlayerInfoAction:
    @property
    def name(self) -> str:
        return "GET_ROBLOX_PLAYER_INFO"

    @property
    def similes(self) -> list[str]:
        return ["ROBLOX_PLAYER_INFO", "LOOKUP_PLAYER", "PLAYER_DETAILS", "WHO_IS_PLAYER"]

    @property
    def description(self) -> str:
        return "Look up information about a Roblox player by their ID or username."

    def _is_player_info_request(self, text: str) -> bool:
        lower = text.lower()
        has_action = any(word in lower for word in ["who", "lookup", "info", "find"])
        has_target = "player" in lower
        return has_action and has_target

    async def validate(self, message_text: str) -> bool:
        return self._is_player_info_request(message_text)

    async def handler(self, params: dict[str, object]) -> dict[str, object]:
        identifier = params.get("identifier")
        if not identifier:
            raise ValueError("Missing 'identifier' parameter")

        return {
            "action": "GET_ROBLOX_PLAYER_INFO",
            "identifier": identifier,
            "status": "pending",
        }

    @property
    def examples(self) -> list[ActionExample]:
        return [
            ActionExample(
                input="Who is player123?",
                output="I'll look up the information for player123.",
            ),
            ActionExample(
                input="Find info on Roblox user TestUser",
                output="Let me find the details for TestUser.",
            ),
        ]
