"""Dry-run the ASIMOV websocket command surface through the bridge server."""

from __future__ import annotations

import asyncio
import json
import socket
import uuid
from contextlib import suppress
from typing import Any

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


def _cmd(command: str, payload: dict[str, Any]) -> str:
    return json.dumps(
        {
            "type": "command",
            "request_id": str(uuid.uuid4()),
            "timestamp": utc_now_iso(),
            "command": command,
            "payload": payload,
        }
    )


async def _recv_event(ws, event: str) -> dict[str, Any]:
    while True:
        raw = await asyncio.wait_for(ws.recv(), timeout=3.0)
        msg = json.loads(raw)
        if msg.get("type") == "event" and msg.get("event") == event:
            return msg


async def _recv_response(ws) -> dict[str, Any]:
    while True:
        raw = await asyncio.wait_for(ws.recv(), timeout=3.0)
        msg = json.loads(raw)
        if msg.get("type") == "response":
            return msg


def _ok_response(response: dict[str, Any]) -> bool:
    return response.get("type") == "response" and response.get("ok") is True


async def _validate_asimov_server_command_surface() -> dict[str, Any]:
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
    commands: list[dict[str, Any]] = []
    try:
        async with connect(f"ws://127.0.0.1:{port}") as ws:
            hello = await _recv_event(ws, "session.hello")

            scenarios = [
                ("mode_stand", "asimov.mode", {"mode": "STAND"}),
                ("native_velocity", "asimov.velocity", {"vx_mps": 0.2, "vy_mps": -0.1, "yaw_rad_s": 0.5}),
                ("walk_set_alias", "walk.set", {"x": 0.2, "y": -0.1, "yaw": 0.5}),
                ("walk_command_stop", "walk.command", {"action": "stop"}),
                ("walk_command_velocity", "walk.command", {"vx_mps": 0.1, "vy_mps": 0.0, "yaw_rad_s": 0.2}),
                ("action_play_stand", "action.play", {"name": "stand"}),
                ("trajectory", "asimov.trajectory", {"positions": [0.01] * ASIMOV1_FULL_ACTION_DIM}),
            ]

            for label, command, payload in scenarios:
                await ws.send(_cmd(command, payload))
                response = await _recv_response(ws)
                commands.append(
                    {
                        "label": label,
                        "command": command,
                        "ok": _ok_response(response),
                        "message": response.get("message", ""),
                        "data": response.get("data", {}),
                    }
                )
    finally:
        server.close()
        await server.wait_closed()
        task.cancel()
        with suppress(asyncio.CancelledError, Exception):
            await task

    response_by_label = {item["label"]: item for item in commands}
    trajectory_data = response_by_label.get("trajectory", {}).get("data", {})
    hello_data = hello.get("data", {}) if isinstance(hello, dict) else {}
    checks = {
        "hello_backend": hello.get("backend") == "asimov_mock",
        "hello_profile": hello_data.get("capabilities", {}).get("profile_id") == "asimov-1",
        "all_responses_ok": all(item["ok"] for item in commands),
        "walk_set_alias": response_by_label.get("walk_set_alias", {}).get("data", {}).get("velocity")
        == {"vx_mps": 0.2, "vy_mps": -0.1, "yaw_rad_s": 0.5},
        "walk_command_stop": response_by_label.get("walk_command_stop", {}).get("data", {}).get("mode")
        == "DAMP",
        "trajectory_width": len(trajectory_data.get("joint_targets", [])) == ASIMOV1_FULL_ACTION_DIM,
    }
    return {
        "ok": all(checks.values()),
        "port": port,
        "checks": checks,
        "commands": commands,
    }


def validate_asimov_server_command_surface() -> dict[str, Any]:
    """Exercise ASIMOV bridge validation, websocket parsing, and backend dispatch."""
    return asyncio.run(_validate_asimov_server_command_surface())
