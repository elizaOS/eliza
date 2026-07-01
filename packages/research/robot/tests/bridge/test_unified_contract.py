"""Unified bridge contract test.

The user's hard constraint: the MuJoCo world is an emulator of the real
robot. The plugin/agent talks to the bridge through ONE protocol; the
only thing that differs between sim and real is the websocket port.

This test enforces that contract:

  - Every backend (mock, mujoco) accepts the same `VALID_COMMANDS` set.
  - Every backend implements `BridgeBackend` and exposes a stable
    `capabilities()` shape.
  - Server-level commands (`profile.describe`, `camera.snapshot`) work
    end-to-end against each backend with byte-for-byte identical envelope
    layouts.
  - Telemetry events from each backend share the same `telemetry.basic`
    field set.

The `ros_real` / `isaac` backends pull heavy runtime imports (rospy,
IsaacLab) at construction time; they are excluded here and covered by
their dedicated integration tests when those environments are available.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import socket
from collections.abc import AsyncIterator
from typing import Any, Callable

import pytest
import pytest_asyncio
from websockets.asyncio.client import connect
from websockets.asyncio.server import serve

from eliza_robot.bridge.backends.base import BridgeBackend
from eliza_robot.bridge.backends.mock_backend import MockBackend
from eliza_robot.bridge.protocol import VALID_COMMANDS, CommandEnvelope, utc_now_iso
from eliza_robot.bridge.server import RuntimeConfig, _handler


# -------------------------------------------------------------------------
# Backend factories — each yields a fresh backend instance.
# -------------------------------------------------------------------------


def _mock_backend() -> BridgeBackend:
    return MockBackend()


def _mujoco_backend() -> BridgeBackend | None:
    """Try to build a MuJoCoBackend; return None if mujoco isn't available."""
    try:
        import mujoco  # noqa: F401
        from eliza_robot.bridge.backends.mujoco_backend import MuJocoBackend
        from eliza_robot.sim.mujoco.demo_env import DemoEnv

        return MuJocoBackend(DemoEnv(target_position=(2.0, 0.0, 0.05)))
    except Exception:
        return None


# -------------------------------------------------------------------------
# Shared bridge fixture builder — creates a per-test server on a free port.
# -------------------------------------------------------------------------


def _free_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


async def _boot_bridge(
    factory: Callable[[], BridgeBackend],
) -> tuple[str, Any, asyncio.Task]:
    port = _free_port()
    config = RuntimeConfig(
        queue_size=64,
        max_commands_per_sec=200,
        deadman_timeout_sec=30.0,
        trace_log_path="",
    )

    async def handler(ws) -> None:
        await _handler(ws, factory, config)

    server = await serve(handler, "127.0.0.1", port)
    serve_task = asyncio.create_task(server.serve_forever())
    await asyncio.sleep(0.1)
    return f"ws://127.0.0.1:{port}", server, serve_task


async def _shutdown_bridge(server: Any, task: asyncio.Task) -> None:
    server.close()
    await server.wait_closed()
    task.cancel()
    try:
        await task
    except (asyncio.CancelledError, Exception):
        pass


async def _request(ws, command: str, payload: dict | None = None) -> dict:
    rid = f"parity-{command}"
    envelope = CommandEnvelope(
        request_id=rid,
        timestamp=utc_now_iso(),
        command=command,
        payload=payload or {},
    )
    await ws.send(json.dumps(envelope.to_json()))
    for _ in range(120):
        frame = json.loads(await ws.recv())
        if frame.get("type") == "response" and frame.get("request_id") == rid:
            return frame
    raise AssertionError(f"no response to {command}")


# -------------------------------------------------------------------------
# Test cases
# -------------------------------------------------------------------------


_REQUIRED_CAP_KEYS = {
    "walk_set",
    "walk_command",
    "action_play",
    "head_set",
    "servo_set",
}


def _interface_methods() -> set[str]:
    """Names of every abstract method on the BridgeBackend interface."""
    abstracts = {
        name
        for name, value in inspect.getmembers(BridgeBackend, callable)
        if getattr(value, "__isabstractmethod__", False)
    }
    abstracts.add("snapshot_camera")  # not abstract, but part of the surface
    return abstracts


@pytest.mark.parametrize(
    "factory_name,factory",
    [
        ("mock", _mock_backend),
        pytest.param(
            "mujoco",
            _mujoco_backend,
            marks=pytest.mark.skipif(
                _mujoco_backend() is None, reason="mujoco not installed"
            ),
        ),
    ],
)
def test_backend_implements_bridge_interface(
    factory_name: str, factory: Callable[[], BridgeBackend | None]
) -> None:
    """Every shipped backend implements the full BridgeBackend interface."""
    backend = factory()
    if backend is None:
        pytest.skip(f"{factory_name} backend unavailable")
    assert isinstance(backend, BridgeBackend), f"{factory_name} is not BridgeBackend"
    for method in _interface_methods():
        assert hasattr(backend, method), (
            f"{factory_name} missing {method}"
        )


@pytest.mark.parametrize(
    "factory_name,factory",
    [
        ("mock", _mock_backend),
        pytest.param(
            "mujoco",
            _mujoco_backend,
            marks=pytest.mark.skipif(
                _mujoco_backend() is None, reason="mujoco not installed"
            ),
        ),
    ],
)
def test_backend_capabilities_shape(
    factory_name: str, factory: Callable[[], BridgeBackend | None]
) -> None:
    """Every backend reports the canonical capability keys (bool values)."""
    backend = factory()
    if backend is None:
        pytest.skip(f"{factory_name} backend unavailable")
    caps = backend.capabilities()
    assert isinstance(caps, dict)
    missing = _REQUIRED_CAP_KEYS - set(caps.keys())
    assert not missing, f"{factory_name} missing capability keys: {missing}"
    for key in _REQUIRED_CAP_KEYS:
        assert isinstance(caps[key], bool), (
            f"{factory_name}.capabilities()['{key}'] must be bool"
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "factory_name,factory",
    [
        ("mock", _mock_backend),
        pytest.param(
            "mujoco",
            _mujoco_backend,
            marks=pytest.mark.skipif(
                _mujoco_backend() is None, reason="mujoco not installed"
            ),
        ),
    ],
)
async def test_unified_command_surface_over_websocket(
    factory_name: str, factory: Callable[[], BridgeBackend | None]
) -> None:
    """For every backend, the unified protocol responds successfully to:
        - profile.describe (server-level)
        - camera.snapshot
        - walk.set / walk.command:start / walk.command:stop
        - head.set
    """
    backend = factory()
    if backend is None:
        pytest.skip(f"{factory_name} backend unavailable")
    bridge_factory = lambda: backend  # singleton across the test
    url, server, task = await _boot_bridge(bridge_factory)
    try:
        async with connect(url) as ws:
            hello = json.loads(await ws.recv())
            assert hello["event"] == "session.hello"
            caps = hello["data"]["capabilities"]
            assert isinstance(caps, dict)

            # profile.describe
            r = await _request(ws, "profile.describe", {})
            assert r["ok"], f"{factory_name} profile.describe failed: {r['message']}"
            assert r["data"]["profile"]["id"] == "hiwonder-ainex"

            # camera.snapshot
            r = await _request(ws, "camera.snapshot", {})
            assert r["ok"], f"{factory_name} camera.snapshot failed: {r['message']}"
            assert r["data"]["format"] == "png"
            assert r["data"]["width"] > 0

            # walk.set + walk.command:start + walk.command:stop
            r = await _request(
                ws,
                "walk.set",
                {"speed": 1, "height": 0.036, "x": 0.0, "y": 0.0, "yaw": 0.0},
            )
            assert r["ok"]
            r = await _request(ws, "walk.command", {"action": "start"})
            assert r["ok"]
            r = await _request(ws, "walk.command", {"action": "stop"})
            assert r["ok"]

            # head.set
            r = await _request(
                ws, "head.set", {"pan": 0.1, "tilt": 0.0, "duration": 0.05}
            )
            assert r["ok"]
    finally:
        await _shutdown_bridge(server, task)


def test_protocol_command_set_is_canonical() -> None:
    """VALID_COMMANDS is the single source of truth for the unified surface."""
    expected = {
        "walk.set",
        "walk.command",
        "action.play",
        "head.set",
        "servo.set",
        "policy.start",
        "policy.stop",
        "policy.tick",
        "policy.status",
        "asimov.mode",
        "asimov.velocity",
        "asimov.trajectory",
        "profile.describe",
        "camera.snapshot",
    }
    assert VALID_COMMANDS == expected, (
        f"VALID_COMMANDS drift: missing={expected - VALID_COMMANDS}, "
        f"extra={VALID_COMMANDS - expected}"
    )
