from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from datetime import datetime

from elizaos_plugin_roblox.client import RobloxClient
from elizaos_plugin_roblox.config import RobloxConfig
from elizaos_plugin_roblox.json_types import JsonValue


@dataclass
class _SendRobloxMessageAction:
    name: str = "SEND_ROBLOX_MESSAGE"
    similes: list[str] = field(
        default_factory=lambda: [
            "ROBLOX_MESSAGE",
            "GAME_MESSAGE",
            "SEND_TO_GAME",
            "BROADCAST_MESSAGE",
            "TELL_PLAYERS",
        ]
    )
    description: str = "Send a message to players in a Roblox game."

    async def validate(self, runtime, _message, _state=None) -> bool:
        svc = runtime.get_service("roblox")
        return bool(svc and getattr(svc, "is_enabled", None) and svc.is_enabled())

    async def handler(self, runtime, message, _state=None, _options=None, callback=None, _responses=None):
        from elizaos.types import ActionResult, Content

        text = str(message.content.text or "") if message.content else ""
        text = text.strip()
        if not text:
            return ActionResult(success=False, error="No message content to send")

        svc = runtime.get_service("roblox")
        if svc is None or not getattr(svc, "send_message", None):
            return ActionResult(success=False, error="Roblox service not available")

        await svc.send_message(text, None)
        if callback:
            await callback(Content(text="Sent message to Roblox.", actions=[self.name]))

        return ActionResult(
            success=True,
            text="Sent message to Roblox",
            data={"actionName": self.name},
            values={"success": True},
        )


def _parse_move_npc(text: str) -> tuple[str, dict[str, JsonValue]] | None:
    m = re.search(
        r"(?:move|walk)\s+(?:the\s+)?(?:npc|bot|agent)?\s*(?:to|towards)\s+(?:the\s+)?(\w+)",
        text,
        re.IGNORECASE,
    )
    if m:
        return ("move_npc", {"waypoint": m.group(1)})

    m2 = re.search(
        r"(?:move|walk)\s+to\s+\(?(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\)?",
        text,
        re.IGNORECASE,
    )
    if m2:
        return (
            "move_npc",
            {"x": float(m2.group(1)), "y": float(m2.group(2)), "z": float(m2.group(3))},
        )
    return None


@dataclass
class _ExecuteRobloxAction:
    name: str = "EXECUTE_ROBLOX_ACTION"
    similes: list[str] = field(
        default_factory=lambda: [
            "ROBLOX_ACTION",
            "GAME_ACTION",
            "DO_IN_GAME",
            "TRIGGER_EVENT",
        ]
    )
    description: str = "Execute a custom action in Roblox (teleport, move NPC, give rewards, etc)."

    async def validate(self, runtime, _message, _state=None) -> bool:
        svc = runtime.get_service("roblox")
        return bool(svc and getattr(svc, "is_enabled", None) and svc.is_enabled())

    async def handler(self, runtime, message, _state=None, _options=None, callback=None, _responses=None):
        from elizaos.types import ActionResult, Content

        text = str(message.content.text or "") if message.content else ""
        text = text.strip()
        if not text:
            return ActionResult(success=False, error="No action content")

        parsed = _parse_move_npc(text)
        if parsed is None:
            return ActionResult(success=False, error="Could not parse Roblox action from message")

        action_name, params = parsed
        svc = runtime.get_service("roblox")
        if svc is None or not getattr(svc, "execute_action", None):
            return ActionResult(success=False, error="Roblox service not available")

        await svc.execute_action(action_name, params, None)
        if callback:
            await callback(Content(text=f"Triggered {action_name} in Roblox.", actions=[self.name]))

        return ActionResult(
            success=True,
            text=f"Executed {action_name}",
            data={"actionName": self.name, "robloxAction": action_name, "parameters": params},
            values={"success": True},
        )


def create_roblox_elizaos_plugin():
    """
    Create an elizaOS Plugin for Roblox integration.
    This import is intentionally lazy so `elizaos_plugin_roblox` can be used without elizaos installed.
    """
    from elizaos.types import Action, Plugin
    from elizaos.types.service import Service

    class RobloxService(Service):
        service_type = "roblox"

        def __init__(self, runtime, client: RobloxClient | None, config: RobloxConfig | None) -> None:
            super().__init__(runtime)
            self._client = client
            self._config = config

        @property
        def capability_description(self) -> str:
            return "Roblox integration via Open Cloud MessagingService and APIs"

        @classmethod
        async def start(cls, runtime):
            api_key = runtime.get_setting("ROBLOX_API_KEY")
            universe_id = runtime.get_setting("ROBLOX_UNIVERSE_ID")
            api_key_s = api_key.strip() if isinstance(api_key, str) else os.environ.get("ROBLOX_API_KEY", "").strip()
            universe_s = (
                universe_id.strip()
                if isinstance(universe_id, str)
                else os.environ.get("ROBLOX_UNIVERSE_ID", "").strip()
            )

            if not api_key_s or not universe_s:
                runtime.logger.debug("Roblox service disabled (missing ROBLOX_API_KEY/ROBLOX_UNIVERSE_ID)")
                return cls(runtime, None, None)

            poll_interval = 30
            poll_raw = os.environ.get("ROBLOX_POLL_INTERVAL", "").strip()
            if poll_raw:
                try:
                    poll_interval = int(poll_raw)
                except ValueError:
                    poll_interval = 30

            cfg = RobloxConfig(
                api_key=api_key_s,
                universe_id=universe_s,
                place_id=os.environ.get("ROBLOX_PLACE_ID"),
                webhook_secret=os.environ.get("ROBLOX_WEBHOOK_SECRET"),
                messaging_topic=os.environ.get("ROBLOX_MESSAGING_TOPIC", "eliza-agent"),
                poll_interval=poll_interval,
                dry_run=os.environ.get("ROBLOX_DRY_RUN", "").lower() == "true",
            )
            cfg.validate()
            return cls(runtime, RobloxClient(cfg), cfg)

        async def stop(self) -> None:
            if self._client is not None:
                await self._client.close()

        def is_enabled(self) -> bool:
            return self._client is not None and self._config is not None

        async def send_message(self, content: str, target_player_ids: list[int] | None = None) -> None:
            if not self.is_enabled():
                raise RuntimeError("Roblox service not enabled")
            assert self._client is not None and self._config is not None
            payload: dict[str, JsonValue] = {
                "type": "agent_message",
                "content": content,
                "targetPlayerIds": target_player_ids,
                "timestamp": int(datetime.now().timestamp() * 1000),
                "sender": {
                    "agentId": str(self.runtime.agent_id),
                    "agentName": self.runtime.character.name,
                },
            }
            await self._client.publish_message(
                self._config.messaging_topic, payload, universe_id=self._config.universe_id
            )

        async def execute_action(
            self,
            action_name: str,
            parameters: dict[str, JsonValue],
            target_player_ids: list[int] | None = None,
        ) -> None:
            if not self.is_enabled():
                raise RuntimeError("Roblox service not enabled")
            assert self._client is not None and self._config is not None
            payload: dict[str, JsonValue] = {
                "type": "agent_action",
                "action": action_name,
                "parameters": parameters,
                "targetPlayerIds": target_player_ids,
                "timestamp": int(datetime.now().timestamp() * 1000),
                "sender": {
                    "agentId": str(self.runtime.agent_id),
                    "agentName": self.runtime.character.name,
                },
            }
            await self._client.publish_message(
                self._config.messaging_topic, payload, universe_id=self._config.universe_id
            )

    return Plugin(
        name="roblox",
        description="Roblox game integration plugin (Python) via Open Cloud",
        services=[RobloxService],
        actions=[
            Action(
                name=_SendRobloxMessageAction.name,
                similes=_SendRobloxMessageAction().similes,
                description=_SendRobloxMessageAction.description,
                validate=_SendRobloxMessageAction().validate,
                handler=_SendRobloxMessageAction().handler,
            ),
            Action(
                name=_ExecuteRobloxAction.name,
                similes=_ExecuteRobloxAction().similes,
                description=_ExecuteRobloxAction.description,
                validate=_ExecuteRobloxAction().validate,
                handler=_ExecuteRobloxAction().handler,
            ),
        ],
    )


_roblox_plugin_instance = None


def get_roblox_plugin():
    global _roblox_plugin_instance
    if _roblox_plugin_instance is None:
        _roblox_plugin_instance = create_roblox_elizaos_plugin()
    return _roblox_plugin_instance

