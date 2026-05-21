"""End-to-end test of the AINEX_RUN_RL → bridge → policy.start path.

The Eliza chat agent flow is:

    chat → plugins/plugin-ainex/src/actions/runRl.ts:AINEX_RUN_RL
         → ws://bridge/policy.start { task: "<free-form text>", ... }
         → bridge/server.py:policy.start handler → backend.walk.command(start)

We boot the bridge with the in-memory `MockBackend`, send `policy.start`
as the Eliza agent would, then `policy.stop`, and verify the responses
match the protocol the action ships.

This test catches regressions in the wire contract between the
TypeScript action and the Python bridge.
"""

from __future__ import annotations

import asyncio
import json
import socket
from datetime import UTC, datetime

import pytest

websockets = pytest.importorskip("websockets")
from websockets.asyncio.client import connect  # noqa: E402

from eliza_robot.bridge.server import RuntimeConfig, _build_backend_factory, _run_server  # noqa: E402


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _utc_now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


async def _drive_policy_start_stop(port: int) -> dict:
    """Connect as the Eliza agent would and exercise policy.start/stop."""
    uri = f"ws://127.0.0.1:{port}"
    async with connect(uri) as ws:
        # Mirror exactly the payload AINEX_RUN_RL.sendOne emits.
        cmd_start = {
            "type": "command",
            "request_id": "test-start-1",
            "timestamp": _utc_now_iso(),
            "command": "policy.start",
            "payload": {
                "task": "walk forward",
                "canonical_action": "text_conditioned",
                "target_label": "",
                "hz": 10,
                "max_steps": 100,
            },
            "preempt": False,
        }
        await ws.send(json.dumps(cmd_start))
        start_response = None
        # Drain envelopes until we see the start response.
        for _ in range(20):
            raw = await asyncio.wait_for(ws.recv(), timeout=5.0)
            msg = json.loads(raw)
            if msg.get("type") == "response" and msg.get("request_id") == "test-start-1":
                start_response = msg
                break

        cmd_stop = {
            "type": "command",
            "request_id": "test-stop-1",
            "timestamp": _utc_now_iso(),
            "command": "policy.stop",
            "payload": {},
            "preempt": False,
        }
        await ws.send(json.dumps(cmd_stop))
        stop_response = None
        for _ in range(20):
            raw = await asyncio.wait_for(ws.recv(), timeout=5.0)
            msg = json.loads(raw)
            if msg.get("type") == "response" and msg.get("request_id") == "test-stop-1":
                stop_response = msg
                break
        return {"start": start_response, "stop": stop_response}


@pytest.mark.asyncio
async def test_policy_start_stop_round_trip_against_mock_backend() -> None:
    """Boot the bridge with the mock backend on an ephemeral port, send
    the exact policy.start payload AINEX_RUN_RL ships, verify ok=True."""
    port = _free_port()
    runtime_cfg = RuntimeConfig(
        queue_size=8,
        max_commands_per_sec=50,
        deadman_timeout_sec=1.0,
        trace_log_path="",
    )
    # mock backend is the safest target — no MuJoCo, no ROS, no hardware
    server_task = asyncio.create_task(_run_server("127.0.0.1", port, "mock", runtime_cfg))
    try:
        # Tiny wait for the listener to bind. We then poll-connect.
        for _ in range(30):
            try:
                async with connect(f"ws://127.0.0.1:{port}") as ws:
                    await ws.close()
                break
            except (ConnectionRefusedError, OSError):
                await asyncio.sleep(0.05)

        result = await _drive_policy_start_stop(port)
    finally:
        server_task.cancel()
        try:
            await server_task
        except (asyncio.CancelledError, Exception):
            pass

    assert result["start"] is not None, "no policy.start response received"
    assert result["start"]["ok"] is True, (
        f"policy.start failed: {result['start']}"
    )
    assert result["start"]["data"]["task"] == "walk forward"
    assert result["stop"] is not None, "no policy.stop response received"
    assert result["stop"]["ok"] is True


def test_policy_start_uses_runrl_payload_shape() -> None:
    """Sanity-check that the bridge accepts the exact field set the TS
    action emits (no extra required fields creeping in)."""
    from eliza_robot.bridge.protocol import parse_command
    from eliza_robot.bridge.validation import validate_command_payload

    raw = {
        "type": "command",
        "request_id": "runrl-1",
        "timestamp": _utc_now_iso(),
        "command": "policy.start",
        "payload": {
            "task": "walk forward",
            "canonical_action": "text_conditioned",
            "target_label": "",
            "hz": 10,
            "max_steps": 100,
        },
        "preempt": False,
    }
    cmd = parse_command(raw)
    # Validation must not reject the exact AINEX_RUN_RL payload shape.
    validate_command_payload(cmd)
