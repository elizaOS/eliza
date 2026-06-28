from __future__ import annotations

import asyncio
import json
import socket
import uuid
from contextlib import suppress

from websockets.asyncio.client import connect
from websockets.asyncio.server import serve

from eliza_robot.asimov_1.constants import ASIMOV1_FULL_ACTION_DIM
from eliza_robot.bridge.backends.asimov_remote import AsimovRemoteBackend
from eliza_robot.bridge.protocol import utc_now_iso
from eliza_robot.bridge.server import RuntimeConfig, _handler


def _free_port() -> int:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    port = int(sock.getsockname()[1])
    sock.close()
    return port


def _cmd(command: str, payload: dict) -> str:
    return json.dumps(
        {
            "type": "command",
            "request_id": str(uuid.uuid4()),
            "timestamp": utc_now_iso(),
            "command": command,
            "payload": payload,
        }
    )


async def _recv_event(ws, event: str) -> dict:
    while True:
        raw = await asyncio.wait_for(ws.recv(), timeout=3.0)
        msg = json.loads(raw)
        if msg.get("type") == "event" and msg.get("event") == event:
            return msg


async def _recv_response(ws) -> dict:
    while True:
        raw = await asyncio.wait_for(ws.recv(), timeout=3.0)
        msg = json.loads(raw)
        if msg.get("type") != "response":
            continue
        return msg


def test_asimov_websocket_accepts_native_and_alias_commands() -> None:
    async def run() -> None:
        port = _free_port()
        config = RuntimeConfig(
            queue_size=64,
            max_commands_per_sec=200,
            deadman_timeout_sec=10.0,
            trace_log_path="",
            profile_id="asimov-1",
        )

        async def handler(ws) -> None:
            await _handler(ws, lambda: AsimovRemoteBackend(mock=True), config)

        server = await serve(handler, "127.0.0.1", port)
        task = asyncio.create_task(server.serve_forever())
        await asyncio.sleep(0.05)
        try:
            async with connect(f"ws://127.0.0.1:{port}") as ws:
                hello = await _recv_event(ws, "session.hello")
                assert hello["backend"] == "asimov_mock"
                assert hello["data"]["capabilities"]["profile_id"] == "asimov-1"

                await ws.send(_cmd("asimov.mode", {"mode": "STAND"}))
                response = await _recv_response(ws)
                assert response["ok"] is True
                assert response["data"]["mode"] == "STAND"

                await ws.send(_cmd("walk.set", {"x": 0.2, "y": -0.1, "yaw": 0.5}))
                response = await _recv_response(ws)
                assert response["ok"] is True
                assert response["data"]["velocity"] == {
                    "vx_mps": 0.2,
                    "vy_mps": -0.1,
                    "yaw_rad_s": 0.5,
                }

                await ws.send(_cmd("walk.command", {"action": "stop"}))
                response = await _recv_response(ws)
                assert response["ok"] is True
                assert response["data"]["mode"] == "DAMP"

                await ws.send(_cmd("asimov.trajectory", {"positions": [0.01] * ASIMOV1_FULL_ACTION_DIM}))
                response = await _recv_response(ws)
                assert response["ok"] is True
                assert len(response["data"]["joint_targets"]) == ASIMOV1_FULL_ACTION_DIM
        finally:
            server.close()
            await server.wait_closed()
            task.cancel()
            with suppress(asyncio.CancelledError, Exception):
                await task

    asyncio.run(run())
