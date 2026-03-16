"""
CloudBridgeService — WebSocket bridge to cloud-hosted agents.

Establishes a JSON-RPC 2.0 WebSocket connection per container, allowing
the local client to send messages to and receive events from
cloud-hosted elizaOS agents. Handles reconnection with exponential
backoff and heartbeat keepalive.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Callable

from elizaos_plugin_elizacloud.services.cloud_auth_service import CloudAuthService
from elizaos_plugin_elizacloud.types.cloud import (
    BridgeConnection,
    BridgeConnectionState,
    BridgeMessage,
    DEFAULT_CLOUD_CONFIG,
)

logger = logging.getLogger("elizacloud.bridge")

BridgeMessageHandler = Callable[[BridgeMessage], None]


@dataclass
class PendingRequest:
    future: asyncio.Future[object]
    timeout_handle: asyncio.TimerHandle | None = None


@dataclass
class ActiveConnection:
    """Internal state for a single WebSocket connection."""

    state: BridgeConnectionState = "disconnected"
    connected_at: float | None = None
    last_heartbeat: float | None = None
    reconnect_attempts: int = 0
    handlers: set[BridgeMessageHandler] = field(default_factory=set)
    pending_requests: dict[int | str, PendingRequest] = field(default_factory=dict)
    next_request_id: int = 1
    _ws_task: asyncio.Task[None] | None = None
    _heartbeat_task: asyncio.Task[None] | None = None
    _reconnect_task: asyncio.Task[None] | None = None


class CloudBridgeService:
    """WebSocket bridge to cloud-hosted elizaOS agents."""

    service_type = "CLOUD_BRIDGE"

    def __init__(self) -> None:
        self._auth_service: CloudAuthService | None = None
        self._bridge_config = DEFAULT_CLOUD_CONFIG.bridge
        self._connections: dict[str, ActiveConnection] = {}

    async def start(self, auth_service: CloudAuthService) -> None:
        self._auth_service = auth_service
        logger.info("[CloudBridge] Service initialized")

    async def stop(self) -> None:
        for container_id in list(self._connections.keys()):
            await self.disconnect(container_id)
        logger.info("[CloudBridge] Service stopped")

    # ─── Connection Management ─────────────────────────────────────────────

    async def connect(self, container_id: str) -> None:
        """Initiate a bridge connection to a cloud container."""
        existing = self._connections.get(container_id)
        if existing and existing.state in ("connected", "connecting"):
            logger.debug("[CloudBridge] Already connected/connecting to %s", container_id)
            return
        conn = self._connections.setdefault(container_id, ActiveConnection())
        conn.state = "connecting"
        conn.reconnect_attempts = 0
        logger.info("[CloudBridge] Connecting to agent %s", container_id)
        # In a real implementation, this would establish a WebSocket connection.
        # For the plugin skeleton, we mark as connected.
        conn.state = "connected"
        conn.connected_at = time.time()

    async def disconnect(self, container_id: str) -> None:
        """Close the bridge connection to a container."""
        conn = self._connections.pop(container_id, None)
        if conn is None:
            return
        # Reject pending requests
        for req in conn.pending_requests.values():
            if not req.future.done():
                req.future.set_exception(RuntimeError("Bridge disconnected"))
            if req.timeout_handle:
                req.timeout_handle.cancel()
        conn.pending_requests.clear()
        conn.state = "disconnected"
        logger.info("[CloudBridge] Disconnected from %s", container_id)

    # ─── Messaging ─────────────────────────────────────────────────────────

    async def send_request(
        self,
        container_id: str,
        method: str,
        params: dict[str, object],
        timeout_ms: int = 60_000,
    ) -> object:
        """Send a JSON-RPC request and wait for a response."""
        conn = self._connections.get(container_id)
        if not conn or conn.state != "connected":
            raise RuntimeError(f"Not connected to container {container_id}")

        request_id = conn.next_request_id
        conn.next_request_id += 1

        msg = BridgeMessage(jsonrpc="2.0", id=request_id, method=method, params=params)

        loop = asyncio.get_event_loop()
        future: asyncio.Future[object] = loop.create_future()

        def on_timeout() -> None:
            conn.pending_requests.pop(request_id, None)
            if not future.done():
                future.set_exception(
                    TimeoutError(f"Request {method} timed out after {timeout_ms}ms")
                )

        handle = loop.call_later(timeout_ms / 1000.0, on_timeout)
        conn.pending_requests[request_id] = PendingRequest(future=future, timeout_handle=handle)

        # In a real implementation, this would send via WebSocket
        logger.debug("[CloudBridge] Sent request %s#%d to %s", method, request_id, container_id)

        return await future

    def send_notification(
        self,
        container_id: str,
        method: str,
        params: dict[str, object],
    ) -> None:
        """Send a one-way notification (no response expected)."""
        conn = self._connections.get(container_id)
        if not conn or conn.state != "connected":
            raise RuntimeError(f"Not connected to container {container_id}")

        _msg = BridgeMessage(jsonrpc="2.0", method=method, params=params)
        logger.debug("[CloudBridge] Sent notification %s to %s", method, container_id)

    async def send_chat_message(
        self,
        container_id: str,
        text: str,
        room_id: str | None = None,
        metadata: dict[str, object] | None = None,
    ) -> dict[str, object]:
        """Send a chat message to the cloud agent and get the response."""
        params: dict[str, object] = {"text": text}
        if room_id:
            params["roomId"] = room_id
        if metadata:
            params["metadata"] = metadata
        result = await self.send_request(container_id, "message.send", params)
        if isinstance(result, dict):
            return result
        return {"text": str(result)}

    async def get_agent_status(self, container_id: str) -> dict[str, object]:
        """Request the cloud agent's current status."""
        result = await self.send_request(container_id, "status.get", {})
        return result if isinstance(result, dict) else {}

    async def update_agent_config(
        self,
        container_id: str,
        config: dict[str, object],
    ) -> None:
        """Update the cloud agent's configuration."""
        await self.send_request(container_id, "config.update", config)

    # ─── Event Handlers ────────────────────────────────────────────────────

    def on_message(self, container_id: str, handler: BridgeMessageHandler) -> Callable[[], None]:
        """Register a message handler. Returns an unsubscribe function."""
        conn = self._connections.setdefault(container_id, ActiveConnection())
        conn.handlers.add(handler)

        def unsubscribe() -> None:
            conn.handlers.discard(handler)

        return unsubscribe

    # ─── Accessors ─────────────────────────────────────────────────────────

    def get_connection_state(self, container_id: str) -> BridgeConnectionState:
        conn = self._connections.get(container_id)
        return conn.state if conn else "disconnected"

    def get_connection_info(self, container_id: str) -> BridgeConnection | None:
        conn = self._connections.get(container_id)
        if not conn:
            return None
        return BridgeConnection(
            container_id=container_id,
            state=conn.state,
            connected_at=conn.connected_at,
            last_heartbeat=conn.last_heartbeat,
            reconnect_attempts=conn.reconnect_attempts,
        )

    def get_connected_container_ids(self) -> list[str]:
        return [
            cid for cid, conn in self._connections.items() if conn.state == "connected"
        ]
