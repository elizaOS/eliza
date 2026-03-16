from __future__ import annotations

import asyncio
import json
import logging
import random
import time

import websockets
from websockets.client import WebSocketClientProtocol
from websockets.exceptions import ConnectionClosed

from elizaos_plugin_minecraft.protocol import BridgeResponse, JsonObject, JsonValue

logger = logging.getLogger(__name__)


class MinecraftWebSocketClient:
    def __init__(self, server_url: str) -> None:
        self.server_url = server_url
        self._ws: WebSocketClientProtocol | None = None
        self._connected = False
        self._message_handlers: dict[str, asyncio.Future[BridgeResponse]] = {}
        self._receive_task: asyncio.Task[None] | None = None

    async def connect(self) -> None:
        self._ws = await websockets.connect(self.server_url)
        self._connected = True
        self._receive_task = asyncio.create_task(self._receive_messages())
        logger.info(f"[Minecraft] Connected to server at {self.server_url}")

    async def _receive_messages(self) -> None:
        try:
            assert self._ws is not None
            async for message in self._ws:
                try:
                    data = json.loads(message)
                    response = BridgeResponse.model_validate(data)
                    future = self._message_handlers.pop(response.request_id, None)
                    if future is not None and not future.done():
                        future.set_result(response)
                except Exception as e:
                    logger.error(f"[Minecraft] Error parsing message: {e}")
        except ConnectionClosed:
            self._connected = False
            logger.info("[Minecraft] Disconnected from server")

    async def send_message(
        self,
        msg_type: str,
        bot_id: str | None,
        data: JsonObject | None = None,
        timeout_s: float = 30.0,
    ) -> BridgeResponse:
        if not self._ws or not self._connected:
            raise RuntimeError("Not connected to Mineflayer bridge server")

        request_id = f"req-{int(time.time() * 1000)}-{random.randint(1000, 9999)}"
        message: dict[str, JsonValue] = {
            "type": msg_type,
            "requestId": request_id,
        }
        if bot_id is not None:
            message["botId"] = bot_id
        if data:
            message["data"] = data

        loop = asyncio.get_running_loop()
        future: asyncio.Future[BridgeResponse] = loop.create_future()
        self._message_handlers[request_id] = future

        await self._ws.send(json.dumps(message))
        response = await asyncio.wait_for(future, timeout=timeout_s)
        if not response.success:
            raise RuntimeError(response.error or f"Request failed: {msg_type}")
        return response

    async def health(self) -> bool:
        try:
            resp = await self.send_message("health", None, {})
            return resp.data is not None and resp.data.get("status") == "ok"
        except Exception:
            return False

    async def disconnect(self) -> None:
        if self._receive_task is not None:
            self._receive_task.cancel()
            self._receive_task = None
        if self._ws is not None:
            await self._ws.close()
            self._ws = None
        self._connected = False
