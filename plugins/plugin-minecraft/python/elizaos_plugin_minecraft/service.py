from __future__ import annotations

import asyncio
import logging

from elizaos_plugin_minecraft.protocol import JsonObject, coerce_json_object
from elizaos_plugin_minecraft.services.websocket_client import MinecraftWebSocketClient
from elizaos_plugin_minecraft.types import MinecraftConfig

logger = logging.getLogger(__name__)


class MinecraftService:
    def __init__(self, config: MinecraftConfig) -> None:
        self.config = config
        self._client = MinecraftWebSocketClient(f"ws://localhost:{self.config.server_port}")
        self._bot_id: str | None = None
        self._initialized = False

    async def start(self) -> None:
        await self._client.connect()
        await self._wait_for_ready()
        self._initialized = True

    async def stop(self) -> None:
        if self._bot_id is not None:
            try:
                await self.destroy_bot()
            except Exception:
                pass
        await self._client.disconnect()
        self._initialized = False

    async def create_bot(self, overrides: JsonObject | None = None) -> str:
        if not self._initialized:
            raise RuntimeError("Minecraft service not initialized")
        resp = await self._client.send_message("createBot", None, overrides or {})
        bot_id = (resp.data or {}).get("botId")
        if not isinstance(bot_id, str) or not bot_id:
            raise RuntimeError("Bridge did not return botId")
        self._bot_id = bot_id
        return bot_id

    async def destroy_bot(self) -> None:
        if self._bot_id is None:
            return
        await self._client.send_message("destroyBot", self._bot_id, {})
        self._bot_id = None

    async def ensure_bot(self) -> str:
        if self._bot_id is not None:
            return self._bot_id
        return await self.create_bot()

    async def request(self, msg_type: str, data: JsonObject | None = None) -> JsonObject:
        bot_id = await self.ensure_bot()
        resp = await self._client.send_message(msg_type, bot_id, data or {})
        return coerce_json_object(resp.data) or {}

    async def get_state(self) -> JsonObject:
        if self._bot_id is None:
            return {"connected": False}
        resp = await self._client.send_message("getState", self._bot_id, {})
        return coerce_json_object(resp.data) or {"connected": False}

    async def _wait_for_ready(self, max_attempts: int = 20, delay_s: float = 0.5) -> None:
        for _ in range(max_attempts):
            if await self._client.health():
                return
            await asyncio.sleep(delay_s)
        raise RuntimeError("Mineflayer bridge server did not become ready")
