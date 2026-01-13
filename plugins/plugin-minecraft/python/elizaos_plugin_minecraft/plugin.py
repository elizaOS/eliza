from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from typing import Awaitable, Callable

from elizaos_plugin_minecraft.protocol import coerce_json_object
from elizaos_plugin_minecraft.service import MinecraftService
from elizaos_plugin_minecraft.types import MinecraftConfig

logger = logging.getLogger(__name__)

ActionHandler = Callable[[str], Awaitable[object]]
ProviderHandler = Callable[[], Awaitable[object]]


@dataclass
class MinecraftPlugin:
    name: str = "plugin-minecraft"
    description: str = "Minecraft automation plugin (Mineflayer bridge client)"
    config: MinecraftConfig = field(default_factory=MinecraftConfig)
    service: MinecraftService | None = None
    actions: dict[str, ActionHandler] = field(default_factory=dict)
    providers: dict[str, ProviderHandler] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.actions = {
            "MC_CONNECT": self._wrap_action(self._connect),
            "MC_DISCONNECT": self._wrap_action(self._disconnect),
            "MC_CHAT": self._wrap_action(self._chat),
            "MC_GOTO": self._wrap_action(self._goto),
            "MC_STOP": self._wrap_action(self._stop),
            "MC_LOOK": self._wrap_action(self._look),
            "MC_CONTROL": self._wrap_action(self._control),
            "MC_DIG": self._wrap_action(self._dig),
            "MC_PLACE": self._wrap_action(self._place),
            "MC_ATTACK": self._wrap_action(self._attack),
        }
        self.providers = {
            "MC_WORLD_STATE": self._wrap_provider(self._world_state),
        }

    def _wrap_action(self, action: Callable[[str], Awaitable[object]]) -> ActionHandler:
        async def wrapper(message: str) -> object:
            if self.service is None:
                raise RuntimeError("Minecraft service not initialized")
            return await action(message)

        return wrapper

    def _wrap_provider(self, provider: Callable[[], Awaitable[object]]) -> ProviderHandler:
        async def wrapper() -> object:
            if self.service is None:
                raise RuntimeError("Minecraft service not initialized")
            return await provider()

        return wrapper

    async def init(self) -> None:
        self.config = MinecraftConfig(
            server_port=int(os.getenv("MC_SERVER_PORT", "3457")),
        )
        self.service = MinecraftService(self.config)
        await self.service.start()

    async def stop(self) -> None:
        if self.service is not None:
            await self.service.stop()
        self.service = None

    async def handle_action(self, action_name: str, message: str) -> object:
        handler = self.actions.get(action_name)
        if handler is None:
            raise ValueError(f"Unknown action: {action_name}")
        return await handler(message)

    async def get_provider(self, provider_name: str) -> object:
        provider = self.providers.get(provider_name)
        if provider is None:
            raise ValueError(f"Unknown provider: {provider_name}")
        return await provider()

    async def _connect(self, message: str) -> object:
        # Optional JSON overrides supported: {"host": "...", "port": 25565, "username": "...", "auth": "...", "version":"..."}
        overrides = {}
        if message.strip().startswith("{") and message.strip().endswith("}"):
            try:
                import json

                parsed = json.loads(message)
                coerced = coerce_json_object(parsed)
                if coerced is not None:
                    overrides = coerced
            except Exception:
                overrides = {}

        assert self.service is not None
        bot_id = await self.service.create_bot(overrides)
        return {"botId": bot_id}

    async def _disconnect(self, _message: str) -> object:
        assert self.service is not None
        await self.service.destroy_bot()
        return {"disconnected": True}

    async def _chat(self, message: str) -> object:
        assert self.service is not None
        await self.service.request("chat", {"message": message})
        return {"sent": True}

    async def _goto(self, message: str) -> object:
        assert self.service is not None
        coords = message.strip()
        if coords.startswith("{") and coords.endswith("}"):
            import json

            parsed = json.loads(coords)
            coerced = coerce_json_object(parsed)
            if coerced is not None:
                return await self.service.request("goto", coerced)
        parts = coords.split()
        if len(parts) < 3:
            raise ValueError("Expected 'x y z'")
        x, y, z = (float(parts[0]), float(parts[1]), float(parts[2]))
        return await self.service.request("goto", {"x": x, "y": y, "z": z})

    async def _stop(self, _message: str) -> object:
        assert self.service is not None
        return await self.service.request("stop", {})

    async def _look(self, message: str) -> object:
        assert self.service is not None
        parts = message.strip().split()
        if len(parts) < 2:
            raise ValueError("Expected 'yaw pitch'")
        yaw, pitch = (float(parts[0]), float(parts[1]))
        return await self.service.request("look", {"yaw": yaw, "pitch": pitch})

    async def _control(self, message: str) -> object:
        assert self.service is not None
        parts = message.strip().split()
        if len(parts) < 2:
            raise ValueError("Expected 'control true|false [durationMs]'")
        control = parts[0]
        state = parts[1].lower() == "true"
        duration_ms = int(parts[2]) if len(parts) >= 3 else None
        payload = {"control": control, "state": state}
        if duration_ms is not None:
            payload["durationMs"] = duration_ms
        return await self.service.request("control", payload)

    async def _dig(self, message: str) -> object:
        assert self.service is not None
        parts = message.strip().split()
        if len(parts) < 3:
            raise ValueError("Expected 'x y z'")
        x, y, z = (float(parts[0]), float(parts[1]), float(parts[2]))
        return await self.service.request("dig", {"x": x, "y": y, "z": z})

    async def _place(self, message: str) -> object:
        assert self.service is not None
        parts = message.strip().split()
        if len(parts) < 4:
            raise ValueError("Expected 'x y z face'")
        x, y, z = (float(parts[0]), float(parts[1]), float(parts[2]))
        face = parts[3]
        return await self.service.request("place", {"x": x, "y": y, "z": z, "face": face})

    async def _attack(self, message: str) -> object:
        assert self.service is not None
        entity_id = int(message.strip())
        return await self.service.request("attack", {"entityId": entity_id})

    async def _world_state(self) -> object:
        assert self.service is not None
        return await self.service.get_state()


def create_minecraft_plugin(config: MinecraftConfig | None = None) -> MinecraftPlugin:
    plugin = MinecraftPlugin(config=config or MinecraftConfig())
    return plugin

