from __future__ import annotations

from dataclasses import dataclass


@dataclass
class ActionExample:
    input: str
    output: str


@dataclass
class SendGameMessageAction:
    @property
    def name(self) -> str:
        return "SEND_ROBLOX_MESSAGE"

    @property
    def similes(self) -> list[str]:
        return [
            "ROBLOX_MESSAGE",
            "GAME_MESSAGE",
            "SEND_TO_GAME",
            "BROADCAST_MESSAGE",
            "TELL_PLAYERS",
        ]

    @property
    def description(self) -> str:
        return "Send a message to players in a Roblox game. Can target all players or specific player IDs."

    def _is_send_message_request(self, text: str) -> bool:
        lower = text.lower()
        has_action = any(word in lower for word in ["send", "tell", "message", "broadcast"])
        has_target = any(word in lower for word in ["game", "player", "roblox"])
        return has_action and has_target

    async def validate(self, message_text: str) -> bool:
        return self._is_send_message_request(message_text)

    async def handler(self, params: dict[str, object]) -> dict[str, object]:
        content = params.get("content")
        if not content or not isinstance(content, str):
            raise ValueError("Missing 'content' parameter")

        target_player_ids = params.get("target_player_ids")

        return {
            "action": "SEND_ROBLOX_MESSAGE",
            "content": content,
            "target_player_ids": target_player_ids,
            "status": "pending",
        }

    @property
    def examples(self) -> list[ActionExample]:
        return [
            ActionExample(
                input="Tell everyone in the game that there's a special event happening",
                output="I'll announce the special event to all players in the game!",
            ),
            ActionExample(
                input="Send a message to player123 welcoming them to the game",
                output="I'll send a personalized welcome message to player123.",
            ),
        ]
