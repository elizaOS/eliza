import asyncio
import json
import logging
import random
import time
from typing import Any

import websockets
from websockets.exceptions import ConnectionClosed

from elizaos_browser.types import NavigationResult, WebSocketResponse

logger = logging.getLogger(__name__)


class BrowserWebSocketClient:
    def __init__(self, server_url: str) -> None:
        self.server_url = server_url
        self._ws: Any = None
        self._connected = False
        self._reconnect_attempts = 0
        self._max_reconnect_attempts = 5
        self._reconnect_delay = 1.0
        self._message_handlers: dict[str, asyncio.Future[WebSocketResponse]] = {}
        self._receive_task: asyncio.Task[None] | None = None

    async def connect(self) -> None:
        try:
            self._ws = await websockets.connect(self.server_url)
            self._connected = True
            self._reconnect_attempts = 0
            logger.info(f"[Browser] Connected to server at {self.server_url}")
            self._receive_task = asyncio.create_task(self._receive_messages())

        except Exception as e:
            logger.error(f"[Browser] Connection failed: {e}")
            raise

    async def _receive_messages(self) -> None:
        try:
            async for message in self._ws:
                try:
                    data = json.loads(message)
                    response = WebSocketResponse(
                        type=data.get("type", ""),
                        request_id=data.get("requestId", ""),
                        success=data.get("success", False),
                        data=data.get("data"),
                        error=data.get("error"),
                    )

                    if response.request_id in self._message_handlers:
                        future = self._message_handlers.pop(response.request_id)
                        if not future.done():
                            future.set_result(response)

                    if response.type == "connected":
                        logger.info(f"[Browser] Server connected: {data}")

                except json.JSONDecodeError as e:
                    logger.error(f"[Browser] Error parsing message: {e}")

        except ConnectionClosed:
            self._connected = False
            logger.info("[Browser] Disconnected from server")

            if self._reconnect_attempts < self._max_reconnect_attempts:
                await self._attempt_reconnect()

    async def _attempt_reconnect(self) -> None:
        self._reconnect_attempts += 1
        logger.info(
            f"[Browser] Attempting reconnection {self._reconnect_attempts}/{self._max_reconnect_attempts}..."
        )

        await asyncio.sleep(self._reconnect_delay * self._reconnect_attempts)

        try:
            await self.connect()
        except Exception as e:
            logger.error(f"[Browser] Reconnection failed: {e}")

    async def send_message(
        self,
        msg_type: str,
        data: dict[str, Any] | None = None,
    ) -> WebSocketResponse:
        if not self._ws or not self._connected:
            raise RuntimeError("Not connected to browser server")

        request_id = f"req-{int(time.time() * 1000)}-{random.randint(1000, 9999)}"
        message = {
            "type": msg_type,
            "requestId": request_id,
            **(data or {}),
        }

        future: asyncio.Future[WebSocketResponse] = asyncio.get_event_loop().create_future()
        self._message_handlers[request_id] = future

        try:
            await self._ws.send(json.dumps(message))
            logger.debug(f"[Browser] Sent message: {msg_type} ({request_id})")
            response = await asyncio.wait_for(future, timeout=30.0)

            if response.type == "error":
                raise RuntimeError(response.error or "Unknown error")

            return response

        except asyncio.TimeoutError as e:
            self._message_handlers.pop(request_id, None)
            raise RuntimeError(f"Request timeout for {msg_type}") from e

    def disconnect(self) -> None:
        self._reconnect_attempts = self._max_reconnect_attempts

        if self._receive_task:
            self._receive_task.cancel()

        if self._ws:
            asyncio.create_task(self._ws.close())
            self._ws = None

        self._connected = False
        logger.info("[Browser] Client disconnected")

    def is_connected(self) -> bool:
        return self._connected

    async def navigate(self, session_id: str, url: str) -> NavigationResult:
        response = await self.send_message(
            "navigate",
            {"sessionId": session_id, "data": {"url": url}},
        )
        data = response.data or {}
        return NavigationResult(
            success=response.success,
            url=data.get("url", url),
            title=data.get("title", ""),
        )

    async def get_state(
        self,
        session_id: str,
    ) -> dict[str, Any]:
        response = await self.send_message("getState", {"sessionId": session_id})
        return response.data or {"url": "", "title": "", "sessionId": session_id}

    async def go_back(self, session_id: str) -> NavigationResult:
        response = await self.send_message("goBack", {"sessionId": session_id})
        data = response.data or {}
        return NavigationResult(
            success=response.success,
            url=data.get("url", ""),
            title=data.get("title", ""),
        )

    async def go_forward(self, session_id: str) -> NavigationResult:
        response = await self.send_message("goForward", {"sessionId": session_id})
        data = response.data or {}
        return NavigationResult(
            success=response.success,
            url=data.get("url", ""),
            title=data.get("title", ""),
        )

    async def refresh(self, session_id: str) -> NavigationResult:
        response = await self.send_message("refresh", {"sessionId": session_id})
        data = response.data or {}
        return NavigationResult(
            success=response.success,
            url=data.get("url", ""),
            title=data.get("title", ""),
        )

    async def click(self, session_id: str, description: str) -> WebSocketResponse:
        return await self.send_message(
            "click",
            {"sessionId": session_id, "data": {"description": description}},
        )

    async def type_text(
        self,
        session_id: str,
        text: str,
        field: str,
    ) -> WebSocketResponse:
        return await self.send_message(
            "type",
            {"sessionId": session_id, "data": {"text": text, "field": field}},
        )

    async def select(
        self,
        session_id: str,
        option: str,
        dropdown: str,
    ) -> WebSocketResponse:
        return await self.send_message(
            "select",
            {"sessionId": session_id, "data": {"option": option, "dropdown": dropdown}},
        )

    async def extract(self, session_id: str, instruction: str) -> WebSocketResponse:
        return await self.send_message(
            "extract",
            {"sessionId": session_id, "data": {"instruction": instruction}},
        )

    async def screenshot(self, session_id: str) -> WebSocketResponse:
        return await self.send_message("screenshot", {"sessionId": session_id})

    async def solve_captcha(self, session_id: str) -> WebSocketResponse:
        return await self.send_message("solveCaptcha", {"sessionId": session_id})

    async def health(self) -> bool:
        try:
            response = await self.send_message("health", {})
            return (
                response.type == "health"
                and response.data is not None
                and response.data.get("status") == "ok"
            )
        except Exception as e:
            logger.error(f"[Browser] Health check failed: {e}")
            return False
