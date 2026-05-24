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
import contextlib
import json
import socket
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import pytest

websockets = pytest.importorskip("websockets")
from websockets.asyncio.client import connect  # noqa: E402

from eliza_robot.bridge.server import RuntimeConfig, _run_server  # noqa: E402
from eliza_robot.rl.alberta.agent import (  # noqa: E402
    AlbertaContinualController,
    AlbertaControllerConfig,
)
from eliza_robot.rl.alberta.features import FeatureConfig  # noqa: E402


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _utc_now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _write_hiwonder_alberta_checkpoint(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    feature_cfg = FeatureConfig(
        mode="sparse_gated",
        embed_dim=4,
        n_prototypes=8,
        gate_hard=True,
        proprio_random_dim=8,
        random_dim=16,
        seed=0,
    )
    controller_cfg = AlbertaControllerConfig(
        obs_dim=49,
        action_dim=2,
        gamma=0.5,
        log_sigma_init=-1.0,
        normalize=False,
        obgd_kappa=2.0,
        features=feature_cfg,
        seed=0,
    )
    controller = AlbertaContinualController(controller_cfg)
    np.savez(path / "alberta_policy.npz", **controller.state_dict())
    manifest = {
        "regime": "alberta_streaming",
        "curriculum_version": 1,
        "pca_dim": 4,
        "active_tasks": ["walk_forward"],
        "obs_dim": 49,
        "proprio_dim": 45,
        "text_dim": 4,
        "action_dim": 2,
        "output_dim": 24,
        "profile_id": "hiwonder-ainex",
        "profile_version": 1,
        "ckpt": "alberta_policy.npz",
        "controller": {
            "gamma": controller_cfg.gamma,
            "actor_step_size": controller_cfg.actor_step_size,
            "critic_step_size": controller_cfg.critic_step_size,
            "actor_lamda": controller_cfg.actor_lamda,
            "critic_lamda": controller_cfg.critic_lamda,
            "log_sigma_init": controller_cfg.log_sigma_init,
            "log_sigma_min": controller_cfg.log_sigma_min,
            "log_sigma_max": controller_cfg.log_sigma_max,
            "action_low": controller_cfg.action_low,
            "action_high": controller_cfg.action_high,
            "obgd_kappa": controller_cfg.obgd_kappa,
            "normalize": controller_cfg.normalize,
            "normalizer_decay": controller_cfg.normalizer_decay,
            "decouple_global_bias": controller_cfg.decouple_global_bias,
            "features": {
                "mode": feature_cfg.mode,
                "embed_dim": feature_cfg.embed_dim,
                "n_prototypes": feature_cfg.n_prototypes,
                "gate_hard": feature_cfg.gate_hard,
                "gate_temperature": feature_cfg.gate_temperature,
                "proprio_random_dim": feature_cfg.proprio_random_dim,
                "random_dim": feature_cfg.random_dim,
                "scale": feature_cfg.scale,
                "seed": feature_cfg.seed,
            },
        },
    }
    (path / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")


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


async def _drive_autonomous_policy_start(port: int) -> dict:
    uri = f"ws://127.0.0.1:{port}"
    async with connect(uri) as ws:
        cmd_start = {
            "type": "command",
            "request_id": "test-autonomous-start",
            "timestamp": _utc_now_iso(),
            "command": "policy.start",
            "payload": {
                "task": "walk_forward",
                "canonical_action": "text_conditioned",
                "hz": 20,
                "max_steps": 1,
            },
            "preempt": False,
        }
        await ws.send(json.dumps(cmd_start))
        start_response = None
        completed = None
        for _ in range(40):
            raw = await asyncio.wait_for(ws.recv(), timeout=5.0)
            msg = json.loads(raw)
            if msg.get("type") == "response" and msg.get("request_id") == "test-autonomous-start":
                start_response = msg
            if (
                msg.get("type") == "event"
                and msg.get("event") == "policy.status"
                and msg.get("data", {}).get("reason") == "completed"
            ):
                completed = msg
                break
        return {"start": start_response, "completed": completed}


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
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await server_task

    assert result["start"] is not None, "no policy.start response received"
    assert result["start"]["ok"] is True, (
        f"policy.start failed: {result['start']}"
    )
    assert result["start"]["data"]["task"] == "walk forward"
    assert result["stop"] is not None, "no policy.stop response received"
    assert result["stop"]["ok"] is True


@pytest.mark.asyncio
async def test_policy_start_can_run_alberta_checkpoint_server_side(
    tmp_path: Path,
) -> None:
    ckpt = tmp_path / "alberta_ckpt"
    _write_hiwonder_alberta_checkpoint(ckpt)
    port = _free_port()
    runtime_cfg = RuntimeConfig(
        queue_size=8,
        max_commands_per_sec=50,
        deadman_timeout_sec=1.0,
        trace_log_path="",
        policy_checkpoint=str(ckpt),
    )
    server_task = asyncio.create_task(_run_server("127.0.0.1", port, "mock", runtime_cfg))
    try:
        for _ in range(30):
            try:
                async with connect(f"ws://127.0.0.1:{port}") as ws:
                    await ws.close()
                break
            except (ConnectionRefusedError, OSError):
                await asyncio.sleep(0.05)

        result = await _drive_autonomous_policy_start(port)
    finally:
        server_task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await server_task

    assert result["start"] is not None
    assert result["start"]["ok"] is True
    assert result["start"]["data"]["server_side_policy"] is True
    assert result["completed"] is not None
    data = result["completed"]["data"]
    assert data["steps_completed"] == 1
    assert data["result"]["matched_task_id"] == "walk_forward"


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
