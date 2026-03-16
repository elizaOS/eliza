from __future__ import annotations

from dataclasses import dataclass

from elizaos_plugin_roblox.actions.send_game_message import ActionExample


@dataclass
class ExecuteGameActionAction:
    AVAILABLE_GAME_ACTION_NAMES: tuple[str, ...] = (
        "give_coins",
        "teleport",
        "spawn_entity",
        "start_event",
    )

    @property
    def name(self) -> str:
        return "EXECUTE_ROBLOX_ACTION"

    @property
    def similes(self) -> list[str]:
        return ["ROBLOX_ACTION", "GAME_ACTION", "DO_IN_GAME", "TRIGGER_EVENT", "RUN_GAME_COMMAND"]

    @property
    def description(self) -> str:
        return "Execute a custom action in a Roblox game, such as spawning entities, giving rewards, or triggering events."

    def _is_execute_action_request(self, text: str) -> bool:
        lower = text.lower()
        has_action = any(
            word in lower for word in ["execute", "trigger", "spawn", "give", "teleport", "start"]
        )
        has_target = any(word in lower for word in ["game", "roblox", "player"])
        return has_action and has_target

    async def validate(self, message_text: str) -> bool:
        return self._is_execute_action_request(message_text)

    async def handler(self, params: dict[str, object]) -> dict[str, object]:
        action_name = params.get("action_name")
        if not action_name or not isinstance(action_name, str):
            raise ValueError("Missing 'action_name' parameter")

        parameters = params.get("parameters", {})

        return {
            "action": "EXECUTE_ROBLOX_ACTION",
            "action_name": action_name,
            "parameters": parameters,
            "status": "pending",
        }

    @property
    def examples(self) -> list[ActionExample]:
        return [
            ActionExample(
                input="Start a fireworks show in the game",
                output="I'll trigger the fireworks show for everyone in the game!",
            ),
            ActionExample(
                input="Give player456 100 coins as a reward",
                output="I'll give player456 100 coins right away!",
            ),
        ]
