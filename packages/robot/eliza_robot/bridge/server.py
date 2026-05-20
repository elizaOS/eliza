"""Unified websocket server for AiNex real/sim backends."""

from __future__ import annotations

import argparse
import asyncio
import json
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from websockets.asyncio.server import ServerConnection, serve
from websockets.exceptions import ConnectionClosed

from eliza_robot.bridge.backends.base import BridgeBackend
from eliza_robot.bridge.backends.mock_backend import MockBackend
# isaac_backend and ros_backend may pull lazy ROS/IsaacLab modules at call-time;
# their top-level imports are safe. mujoco_backend is resolved lazily so the
# bridge can boot without mujoco installed.
from eliza_robot.bridge.backends.isaac_backend import IsaacBackend
from eliza_robot.bridge.backends.ros_backend import RosBridgeBackend
from eliza_robot.bridge.protocol import CommandEnvelope, EventEnvelope, ResponseEnvelope, parse_command, utc_now_iso
from eliza_robot.bridge.safety import (
    CommandRateLimiter,
    PolicyGuardResult,
    PolicyHeartbeatMonitor,
    check_policy_motion_bounds,
    is_deadman_heartbeat_command,
)
from eliza_robot.bridge.trace_log import TraceLogger, safe_to_record
from eliza_robot.bridge.types import JsonDict, JsonValue
from eliza_robot.bridge.validation import validate_command_payload
from eliza_robot.profiles.schema import RobotProfile, load_profile

import base64
import io
import numpy as np

try:
    from PIL import Image as _PILImage
    _HAS_PIL = True
except ImportError:
    _PILImage = None  # type: ignore[assignment]
    _HAS_PIL = False


BackendFactory = Callable[[], BridgeBackend]


def _encode_frame_as_png_base64(frame: np.ndarray) -> tuple[str, int, int]:
    """Encode an (H,W,3) uint8 RGB frame as base64-encoded PNG bytes.

    Falls back to a raw zlib-compressed bytestring labeled as "raw_rgb" when
    Pillow is unavailable; the TS client must handle both shapes.
    """
    if frame.dtype != np.uint8:
        frame = frame.astype(np.uint8)
    if frame.ndim != 3 or frame.shape[2] != 3:
        raise ValueError(f"snapshot frame must be (H,W,3) uint8 RGB; got {frame.shape}")
    height, width = int(frame.shape[0]), int(frame.shape[1])
    if _HAS_PIL:
        buf = io.BytesIO()
        _PILImage.fromarray(frame, mode="RGB").save(buf, format="PNG")
        return base64.b64encode(buf.getvalue()).decode("ascii"), width, height
    raise RuntimeError(
        "camera.snapshot requires Pillow; install with `uv add pillow`"
    )


def _profile_to_jsondict(profile: RobotProfile) -> JsonDict:
    """Serialize a RobotProfile to a JSON-safe dict.

    Pydantic's `model_dump()` keeps `Path` objects as-is, which `json.dumps`
    rejects. Stringify them here so the wire payload is plain JSON.
    """
    raw = profile.model_dump()
    assets = raw.get("assets")
    if isinstance(assets, dict):
        for key, value in list(assets.items()):
            assets[key] = str(value)
    return raw


@dataclass
class PolicyLoopState:
    """Tracks the state of an active policy loop within a session."""
    active: bool = False
    task: str = ""
    trace_id: str = ""
    planner_step_id: str = ""
    canonical_action: str = ""
    target_entity_id: str = ""
    target_label: str = ""
    hz: float = 10.0
    max_steps: int = 10000
    step: int = 0
    heartbeat: PolicyHeartbeatMonitor | None = None
    _loop_task: asyncio.Task[None] | None = None


@dataclass
class RuntimeConfig:
    queue_size: int
    max_commands_per_sec: int
    deadman_timeout_sec: float
    trace_log_path: str
    profile_id: str = "hiwonder-ainex"
    # MuJoCo backend knobs (only consulted when backend == "mujoco").
    mujoco_target_xyz: tuple[float, float, float] = (2.0, 0.0, 0.05)
    # When set, `camera.snapshot` reads from a v4l2 device (e.g. Obsbot)
    # instead of (or in addition to) the backend's snapshot_camera(). -1 = off.
    camera_device: int = -1
    camera_width: int = 640
    camera_height: int = 480
    # Remote AiNex rosbridge connection (--backend ainex_remote).
    rosbridge_host: str = "192.168.1.218"
    rosbridge_port: int = 9090


def _load_config_file(path: str) -> JsonDict:
    if path == "":
        return {}
    file_path = Path(path)
    raw = json.loads(file_path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError("config file must contain a JSON object")
    return raw


def _coerce_runtime_config(args: argparse.Namespace, config_obj: JsonDict) -> RuntimeConfig:
    queue_size = args.queue_size
    max_commands_per_sec = args.max_commands_per_sec
    deadman_timeout_sec = args.deadman_timeout_sec
    trace_log_path = args.trace_log_path

    safety_value = config_obj.get("safety")
    if isinstance(safety_value, dict):
        queue_size_value = safety_value.get("queue_size")
        if isinstance(queue_size_value, int):
            queue_size = queue_size_value
        rate_value = safety_value.get("command_rate_limit_hz")
        if isinstance(rate_value, int):
            max_commands_per_sec = rate_value
        deadman_value = safety_value.get("deadman_timeout_sec")
        if isinstance(deadman_value, int | float):
            deadman_timeout_sec = float(deadman_value)

    logging_value = config_obj.get("logging")
    if isinstance(logging_value, dict):
        trace_log_value = logging_value.get("trace_log_path")
        if isinstance(trace_log_value, str):
            trace_log_path = trace_log_value

    return RuntimeConfig(
        queue_size=queue_size,
        max_commands_per_sec=max_commands_per_sec,
        deadman_timeout_sec=deadman_timeout_sec,
        trace_log_path=trace_log_path,
        profile_id=getattr(args, "profile", "hiwonder-ainex"),
        mujoco_target_xyz=(
            getattr(args, "mujoco_target_x", 2.0),
            getattr(args, "mujoco_target_y", 0.0),
            getattr(args, "mujoco_target_z", 0.05),
        ),
        camera_device=getattr(args, "camera_device", -1),
        camera_width=getattr(args, "camera_width", 640),
        camera_height=getattr(args, "camera_height", 480),
        rosbridge_host=getattr(args, "rosbridge_host", "192.168.1.218"),
        rosbridge_port=getattr(args, "rosbridge_port", 9090),
    )


def _build_backend_factory(name: str, config: RuntimeConfig) -> BackendFactory:
    if name == "mock":
        return MockBackend
    if name == "ros":
        return lambda: RosBridgeBackend("ros_real")
    if name == "ros_real":
        return lambda: RosBridgeBackend("ros_real")
    if name == "ros_sim":
        return lambda: RosBridgeBackend("ros_sim")
    if name == "isaac":
        return IsaacBackend
    if name == "mujoco":
        # Lazy import so the bridge can boot without mujoco installed.
        # DemoEnv (CPU MuJoCo) is the default sim — it loads the profile's
        # primitives model, spawns a target ball, and exposes the same
        # joint-target + telemetry surface the real robot does.
        def _build_mujoco_backend() -> BridgeBackend:
            from eliza_robot.bridge.backends.mujoco_backend import MuJocoBackend
            from eliza_robot.sim.mujoco.demo_env import DemoEnv

            env = DemoEnv(target_position=config.mujoco_target_xyz)
            return MuJocoBackend(env, profile_id=config.profile_id)

        return _build_mujoco_backend
    if name in {"ainex_remote", "ros_remote"}:
        # Drives a physical AiNex over its rosbridge_suite without needing
        # rospy locally. Host/port come from RuntimeConfig.
        def _build_remote_backend() -> BridgeBackend:
            from eliza_robot.bridge.backends.ainex_remote import AinexRemoteBackend

            return AinexRemoteBackend(
                host=config.rosbridge_host,
                port=config.rosbridge_port,
            )

        return _build_remote_backend
    raise ValueError(f"unsupported backend: {name}")


def _json_error(message: str, request_id: str = "unknown") -> JsonDict:
    envelope = ResponseEnvelope(
        request_id=request_id,
        timestamp=utc_now_iso(),
        ok=False,
        backend="bridge",
        message=message,
        data={},
    )
    return envelope.to_json()


async def _safe_send(ws: ServerConnection, payload: JsonValue) -> None:
    if not isinstance(payload, dict):
        raise ValueError("websocket send payload must be dict")
    await ws.send(json.dumps(payload))


async def _event_pump(ws: ServerConnection, backend: BridgeBackend, hz: float) -> None:
    period = 1.0 / hz
    while True:
        events = await backend.poll_events()
        for event in events:
            await _safe_send(ws, event.to_json())
        await asyncio.sleep(period)


async def _command_worker(
    ws: ServerConnection,
    backend: BridgeBackend,
    command_queue: asyncio.Queue[CommandEnvelope],
    trace_logger: TraceLogger | None,
) -> None:
    while True:
        command = await command_queue.get()
        try:
            response = await backend.handle_command(command)
        except Exception as exc:
            response = ResponseEnvelope(
                request_id=command.request_id,
                timestamp=utc_now_iso(),
                ok=False,
                backend=backend.backend_name,
                message=f"backend error: {exc}",
                data={},
            )
        await _safe_send(ws, response.to_json())
        if trace_logger is not None:
            trace_logger.write(
                {
                    "kind": "command_response",
                    "timestamp": utc_now_iso(),
                    "backend": backend.backend_name,
                    "request_id": command.request_id,
                    "command": command.command,
                    "response": safe_to_record(response.to_json()),
                }
            )
        command_queue.task_done()


async def _deadman_pump(
    ws: ServerConnection,
    backend: BridgeBackend,
    get_last_heartbeat: Callable[[], float],
    deadman_timeout_sec: float,
) -> None:
    fired = False
    while True:
        await asyncio.sleep(0.1)
        age = asyncio.get_running_loop().time() - get_last_heartbeat()
        if age < deadman_timeout_sec:
            fired = False
            continue
        if fired:
            continue

        stop_cmd = CommandEnvelope(
            request_id=f"deadman-{int(age * 1000)}",
            timestamp=utc_now_iso(),
            command="walk.command",
            payload={"action": "stop"},
            preempt=True,
        )
        response = await backend.handle_command(stop_cmd)
        fired = True
        await _safe_send(
            ws,
            EventEnvelope(
                event="safety.deadman_triggered",
                timestamp=utc_now_iso(),
                backend=backend.backend_name,
                data={"response_ok": response.ok, "age_sec": age},
            ).to_json(),
        )


async def _handle_policy_command(
    ws: ServerConnection,
    backend: BridgeBackend,
    command: CommandEnvelope,
    policy_state: PolicyLoopState,
    trace_logger: TraceLogger | None,
) -> ResponseEnvelope:
    """Handle policy lifecycle commands (policy.start/stop/tick/status)."""

    if command.command == "policy.start":
        if policy_state.active:
            return ResponseEnvelope(
                request_id=command.request_id,
                timestamp=utc_now_iso(),
                ok=False,
                backend=backend.backend_name,
                message="policy already active",
                data={"task": policy_state.task},
            )
        policy_state.active = True
        policy_state.task = str(command.payload.get("task", ""))
        policy_state.trace_id = str(command.payload.get("trace_id", ""))
        policy_state.planner_step_id = str(command.payload.get("planner_step_id", ""))
        policy_state.canonical_action = str(command.payload.get("canonical_action", ""))
        policy_state.target_entity_id = str(command.payload.get("target_entity_id", ""))
        policy_state.target_label = str(command.payload.get("target_label", ""))
        policy_state.hz = float(command.payload.get("hz", 10.0))
        policy_state.max_steps = int(command.payload.get("max_steps", 10000))
        policy_state.step = 0
        policy_state.heartbeat = PolicyHeartbeatMonitor(timeout_sec=2.0)
        policy_state.heartbeat.record_tick()

        # Ensure walking is started for policy mode
        start_cmd = CommandEnvelope(
            request_id=f"{command.request_id}-walk-start",
            timestamp=utc_now_iso(),
            command="walk.command",
            payload={"action": "start"},
        )
        await backend.handle_command(start_cmd)

        await _safe_send(
            ws,
            EventEnvelope(
                event="policy.status",
                timestamp=utc_now_iso(),
                backend=backend.backend_name,
                data={
                    "state": "running",
                    "task": policy_state.task,
                    "step": 0,
                    "trace_id": policy_state.trace_id,
                    "planner_step_id": policy_state.planner_step_id,
                    "canonical_action": policy_state.canonical_action,
                    "target_entity_id": policy_state.target_entity_id,
                    "target_label": policy_state.target_label,
                },
            ).to_json(),
        )

        if trace_logger is not None:
            trace_logger.write({
                "kind": "policy_start",
                "timestamp": utc_now_iso(),
                "task": policy_state.task,
                "trace_id": policy_state.trace_id,
                "planner_step_id": policy_state.planner_step_id,
                "canonical_action": policy_state.canonical_action,
                "target_entity_id": policy_state.target_entity_id,
                "target_label": policy_state.target_label,
                "hz": policy_state.hz,
                "max_steps": policy_state.max_steps,
            })

        return ResponseEnvelope(
            request_id=command.request_id,
            timestamp=utc_now_iso(),
            ok=True,
            backend=backend.backend_name,
            message="policy started",
            data={
                "task": policy_state.task,
                "trace_id": policy_state.trace_id,
                "planner_step_id": policy_state.planner_step_id,
                "canonical_action": policy_state.canonical_action,
                "target_entity_id": policy_state.target_entity_id,
                "target_label": policy_state.target_label,
                "hz": policy_state.hz,
            },
        )

    if command.command == "policy.stop":
        reason = str(command.payload.get("reason", "explicit_stop"))
        was_active = policy_state.active
        policy_state.active = False

        # Stop walking
        stop_cmd = CommandEnvelope(
            request_id=f"{command.request_id}-walk-stop",
            timestamp=utc_now_iso(),
            command="walk.command",
            payload={"action": "stop"},
            preempt=True,
        )
        await backend.handle_command(stop_cmd)

        await _safe_send(
            ws,
            EventEnvelope(
                event="policy.status",
                timestamp=utc_now_iso(),
                backend=backend.backend_name,
                data={
                    "state": "idle",
                    "reason": reason,
                    "steps_completed": policy_state.step,
                    "trace_id": policy_state.trace_id,
                    "planner_step_id": policy_state.planner_step_id,
                    "canonical_action": policy_state.canonical_action,
                    "target_entity_id": policy_state.target_entity_id,
                    "target_label": policy_state.target_label,
                },
            ).to_json(),
        )

        if trace_logger is not None:
            trace_logger.write({
                "kind": "policy_stop",
                "timestamp": utc_now_iso(),
                "trace_id": policy_state.trace_id,
                "planner_step_id": policy_state.planner_step_id,
                "canonical_action": policy_state.canonical_action,
                "target_entity_id": policy_state.target_entity_id,
                "target_label": policy_state.target_label,
                "reason": reason,
                "steps_completed": policy_state.step,
            })

        return ResponseEnvelope(
            request_id=command.request_id,
            timestamp=utc_now_iso(),
            ok=True,
            backend=backend.backend_name,
            message="policy stopped" if was_active else "policy was not active",
            data={
                "reason": reason,
                "steps_completed": policy_state.step,
                "trace_id": policy_state.trace_id,
                "planner_step_id": policy_state.planner_step_id,
                "canonical_action": policy_state.canonical_action,
                "target_entity_id": policy_state.target_entity_id,
                "target_label": policy_state.target_label,
            },
        )

    if command.command == "policy.tick":
        if not policy_state.active:
            return ResponseEnvelope(
                request_id=command.request_id,
                timestamp=utc_now_iso(),
                ok=False,
                backend=backend.backend_name,
                message="policy not active",
                data={},
            )

        # Record heartbeat
        if policy_state.heartbeat is not None:
            policy_state.heartbeat.record_tick()

        # Check step limit
        policy_state.step += 1
        if policy_state.step > policy_state.max_steps:
            policy_state.active = False
            await _safe_send(
                ws,
                EventEnvelope(
                    event="policy.status",
                    timestamp=utc_now_iso(),
                    backend=backend.backend_name,
                    data={
                        "state": "idle",
                        "reason": "max_steps_reached",
                        "steps_completed": policy_state.step,
                        "trace_id": policy_state.trace_id,
                        "planner_step_id": policy_state.planner_step_id,
                        "canonical_action": policy_state.canonical_action,
                        "target_entity_id": policy_state.target_entity_id,
                        "target_label": policy_state.target_label,
                    },
                ).to_json(),
            )
            return ResponseEnvelope(
                request_id=command.request_id,
                timestamp=utc_now_iso(),
                ok=False,
                backend=backend.backend_name,
                message="max steps reached, policy stopped",
                data={"step": policy_state.step},
            )

        # Safety-gate the action payload
        action_payload = command.payload.get("action", {})
        if isinstance(action_payload, dict):
            guard = check_policy_motion_bounds(action_payload)
            if not guard.allowed:
                # Emergency stop
                policy_state.active = False
                stop_cmd = CommandEnvelope(
                    request_id=f"{command.request_id}-safety-stop",
                    timestamp=utc_now_iso(),
                    command="walk.command",
                    payload={"action": "stop"},
                    preempt=True,
                )
                await backend.handle_command(stop_cmd)
                await _safe_send(
                    ws,
                    EventEnvelope(
                        event="safety.policy_guard",
                        timestamp=utc_now_iso(),
                        backend=backend.backend_name,
                        data={"reason": guard.reason, "step": policy_state.step},
                    ).to_json(),
                )
                return ResponseEnvelope(
                    request_id=command.request_id,
                    timestamp=utc_now_iso(),
                    ok=False,
                    backend=backend.backend_name,
                    message=f"safety guard blocked: {guard.reason}",
                    data={"step": policy_state.step},
                )

            # Apply clamped action
            clamped = guard.clamped

            # Direct joint control mode: dispatch servo.set with joint positions
            if "joint_positions" in action_payload:
                from eliza_robot.bridge.isaaclab.joint_map import joint_name_to_servo_id, radians_to_pulse

                jp = action_payload["joint_positions"]
                duration = action_payload.get("duration", 20)

                # Convert joint_positions dict (name→radians) to servo
                # positions list ({id, position} in pulse) for ROS backend.
                positions: list[dict] = []
                if isinstance(jp, dict):
                    for name, rad in jp.items():
                        sid = joint_name_to_servo_id(name)
                        positions.append({"id": sid, "position": radians_to_pulse(float(rad), sid)})
                elif isinstance(jp, list):
                    # Already in [{id, position}] format
                    positions = jp

                servo_cmd = CommandEnvelope(
                    request_id=f"{command.request_id}-servo",
                    timestamp=utc_now_iso(),
                    command="servo.set",
                    payload={
                        "positions": positions,
                        "joint_positions": jp,  # keep original for mock backend
                        "duration": duration,
                    },
                )
                response = await backend.handle_command(servo_cmd)
            else:
                # Legacy walk.set mode
                walk_cmd = CommandEnvelope(
                    request_id=f"{command.request_id}-walk",
                    timestamp=utc_now_iso(),
                    command="walk.set",
                    payload={
                        "speed": clamped.get("walk_speed", 2),
                        "height": clamped.get("walk_height", 0.036),
                        "x": clamped.get("walk_x", 0.0),
                        "y": clamped.get("walk_y", 0.0),
                        "yaw": clamped.get("walk_yaw", 0.0),
                    },
                )
                response = await backend.handle_command(walk_cmd)

            # Apply head if present
            if "head_pan" in clamped or "head_tilt" in clamped:
                head_cmd = CommandEnvelope(
                    request_id=f"{command.request_id}-head",
                    timestamp=utc_now_iso(),
                    command="head.set",
                    payload={
                        "pan": clamped.get("head_pan", 0.0),
                        "tilt": clamped.get("head_tilt", 0.0),
                        "duration": 0.1,
                    },
                )
                await backend.handle_command(head_cmd)

            if guard.reason and trace_logger is not None:
                trace_logger.write({
                    "kind": "policy_tick_clamped",
                    "timestamp": utc_now_iso(),
                    "trace_id": policy_state.trace_id,
                    "step": policy_state.step,
                    "reason": guard.reason,
                })

            # Emit telemetry
            await _safe_send(
                ws,
                EventEnvelope(
                    event="telemetry.policy",
                    timestamp=utc_now_iso(),
                    backend=backend.backend_name,
                    data={
                        "step": policy_state.step,
                    "trace_id": policy_state.trace_id,
                    "planner_step_id": policy_state.planner_step_id,
                    "canonical_action": policy_state.canonical_action,
                    "target_entity_id": policy_state.target_entity_id,
                    "target_label": policy_state.target_label,
                        "clamped": clamped,
                        "guard_reason": guard.reason,
                    },
                ).to_json(),
            )

            if trace_logger is not None:
                trace_logger.write({
                    "kind": "policy_tick",
                    "timestamp": utc_now_iso(),
                    "trace_id": policy_state.trace_id,
                    "planner_step_id": policy_state.planner_step_id,
                    "canonical_action": policy_state.canonical_action,
                    "target_entity_id": policy_state.target_entity_id,
                    "target_label": policy_state.target_label,
                    "step": policy_state.step,
                    "action": safe_to_record(action_payload),
                    "clamped": safe_to_record(clamped),
                    "response_ok": response.ok,
                })

            return ResponseEnvelope(
                request_id=command.request_id,
                timestamp=utc_now_iso(),
                ok=response.ok,
                backend=backend.backend_name,
                message="policy tick applied",
                data={
                    "step": policy_state.step,
                    "trace_id": policy_state.trace_id,
                    "planner_step_id": policy_state.planner_step_id,
                    "canonical_action": policy_state.canonical_action,
                    "target_entity_id": policy_state.target_entity_id,
                    "target_label": policy_state.target_label,
                    "clamped": clamped,
                    **response.data,
                },
            )

        return ResponseEnvelope(
            request_id=command.request_id,
            timestamp=utc_now_iso(),
            ok=False,
            backend=backend.backend_name,
            message="policy.tick requires action dict in payload",
            data={},
        )

    if command.command == "policy.status":
        return ResponseEnvelope(
            request_id=command.request_id,
            timestamp=utc_now_iso(),
            ok=True,
            backend=backend.backend_name,
            message="ok",
            data={
                "active": policy_state.active,
                "task": policy_state.task,
                "trace_id": policy_state.trace_id,
                "planner_step_id": policy_state.planner_step_id,
                "canonical_action": policy_state.canonical_action,
                "target_entity_id": policy_state.target_entity_id,
                "target_label": policy_state.target_label,
                "step": policy_state.step,
                "hz": policy_state.hz,
            },
        )

    return ResponseEnvelope(
        request_id=command.request_id,
        timestamp=utc_now_iso(),
        ok=False,
        backend=backend.backend_name,
        message=f"unknown policy command: {command.command}",
        data={},
    )


async def _policy_heartbeat_pump(
    ws: ServerConnection,
    backend: BridgeBackend,
    policy_state: PolicyLoopState,
) -> None:
    """Monitor policy heartbeat and trigger fallback if stale."""
    while True:
        await asyncio.sleep(0.5)
        if not policy_state.active:
            continue
        if policy_state.heartbeat is not None and policy_state.heartbeat.is_stale():
            # Policy tick heartbeat timeout - emergency stop
            policy_state.active = False
            stop_cmd = CommandEnvelope(
                request_id=f"policy-heartbeat-timeout-{policy_state.step}",
                timestamp=utc_now_iso(),
                command="walk.command",
                payload={"action": "stop"},
                preempt=True,
            )
            await backend.handle_command(stop_cmd)
            await _safe_send(
                ws,
                EventEnvelope(
                    event="safety.policy_guard",
                    timestamp=utc_now_iso(),
                    backend=backend.backend_name,
                    data={
                        "reason": "policy_heartbeat_timeout",
                        "age_sec": policy_state.heartbeat.age_sec(),
                        "step": policy_state.step,
                    },
                ).to_json(),
            )
            await _safe_send(
                ws,
                EventEnvelope(
                    event="policy.status",
                    timestamp=utc_now_iso(),
                    backend=backend.backend_name,
                    data={
                        "state": "idle",
                        "reason": "heartbeat_timeout",
                        "steps_completed": policy_state.step,
                        "trace_id": policy_state.trace_id,
                        "planner_step_id": policy_state.planner_step_id,
                        "canonical_action": policy_state.canonical_action,
                        "target_entity_id": policy_state.target_entity_id,
                        "target_label": policy_state.target_label,
                    },
                ).to_json(),
            )


async def _handler(
    ws: ServerConnection, backend_factory: BackendFactory, config: RuntimeConfig
) -> None:
    backend = backend_factory()
    await backend.connect()
    loop = asyncio.get_running_loop()
    last_heartbeat = loop.time()
    limiter = CommandRateLimiter(max_commands_per_sec=config.max_commands_per_sec)
    command_queue: asyncio.Queue[CommandEnvelope] = asyncio.Queue(maxsize=config.queue_size)
    policy_state = PolicyLoopState()
    trace_logger: TraceLogger | None = None
    if config.trace_log_path != "":
        trace_logger = TraceLogger(path=Path(config.trace_log_path))

    def _get_last_heartbeat() -> float:
        return last_heartbeat

    await _safe_send(
        ws,
        EventEnvelope(
            event="session.hello",
            timestamp=utc_now_iso(),
            backend=backend.backend_name,
            data={
                "capabilities": backend.capabilities(),
                "queue_size": config.queue_size,
                "max_commands_per_sec": config.max_commands_per_sec,
                "deadman_timeout_sec": config.deadman_timeout_sec,
                "trace_log_path": config.trace_log_path,
            },
        ).to_json(),
    )

    event_task = asyncio.create_task(_event_pump(ws, backend, hz=2.0))
    worker_task = asyncio.create_task(
        _command_worker(ws, backend, command_queue, trace_logger=trace_logger)
    )
    deadman_task = asyncio.create_task(
        _deadman_pump(
            ws,
            backend,
            get_last_heartbeat=_get_last_heartbeat,
            deadman_timeout_sec=config.deadman_timeout_sec,
        )
    )
    policy_heartbeat_task = asyncio.create_task(
        _policy_heartbeat_pump(ws, backend, policy_state)
    )
    try:
        async for raw_message in ws:
            request_id = "unknown"
            try:
                parsed = json.loads(raw_message)
                if not isinstance(parsed, dict):
                    raise ValueError("payload must be a JSON object")
                request_id_value = parsed.get("request_id")
                if isinstance(request_id_value, str):
                    request_id = request_id_value
                command = parse_command(parsed)
                validate_command_payload(command)
                limit_result = limiter.check()
                if not limit_result.allowed:
                    await _safe_send(
                        ws,
                        _json_error(
                            f"rate limit exceeded, retry_after_sec={limit_result.retry_after_sec:.3f}",
                            request_id=request_id,
                        ),
                    )
                    continue

                if is_deadman_heartbeat_command(command):
                    last_heartbeat = loop.time()

                # Server-level commands are answered inline without touching
                # the backend command queue. `profile.describe` returns the
                # active RobotProfile so plugins can self-configure.
                if command.command == "profile.describe":
                    requested_id = command.payload.get("id")
                    target_profile_id = (
                        requested_id
                        if isinstance(requested_id, str) and requested_id
                        else config.profile_id
                    )
                    try:
                        profile = load_profile(target_profile_id)
                        await _safe_send(
                            ws,
                            ResponseEnvelope(
                                request_id=command.request_id,
                                timestamp=utc_now_iso(),
                                ok=True,
                                backend=backend.backend_name,
                                message="ok",
                                data={"profile": _profile_to_jsondict(profile)},
                            ).to_json(),
                        )
                    except Exception as exc:
                        await _safe_send(
                            ws,
                            _json_error(
                                f"profile.describe failed: {exc}",
                                request_id=request_id,
                            ),
                        )
                    continue

                if command.command == "camera.snapshot":
                    requested_cam = command.payload.get("camera")
                    cam_name = (
                        requested_cam if isinstance(requested_cam, str) and requested_cam else "head"
                    )
                    frame = None
                    # External v4l2 camera (e.g. Obsbot) takes precedence
                    # when explicitly requested via `camera=external` OR
                    # when the backend can't produce a frame.
                    use_external = (
                        config.camera_device >= 0
                        and (cam_name in {"external", "obsbot", "v4l2"} or cam_name == "head")
                    )
                    try:
                        if cam_name in {"external", "obsbot", "v4l2"} and config.camera_device >= 0:
                            from eliza_robot.perception.frame_source import OpenCVSource
                            with OpenCVSource(
                                device=config.camera_device,
                                width=config.camera_width,
                                height=config.camera_height,
                            ) as src:
                                ok, bgr = src.read()
                                if ok and bgr is not None and bgr.size > 0:
                                    # OpenCV returns BGR; we ship RGB on the wire.
                                    frame = bgr[:, :, ::-1].copy()
                        else:
                            frame = backend.snapshot_camera(cam_name)
                            if frame is None and use_external:
                                from eliza_robot.perception.frame_source import OpenCVSource
                                with OpenCVSource(
                                    device=config.camera_device,
                                    width=config.camera_width,
                                    height=config.camera_height,
                                ) as src:
                                    ok, bgr = src.read()
                                    if ok and bgr is not None and bgr.size > 0:
                                        frame = bgr[:, :, ::-1].copy()
                    except Exception as exc:
                        await _safe_send(
                            ws,
                            _json_error(
                                f"camera.snapshot failed: {exc}",
                                request_id=request_id,
                            ),
                        )
                        continue
                    if frame is None:
                        await _safe_send(
                            ws,
                            ResponseEnvelope(
                                request_id=command.request_id,
                                timestamp=utc_now_iso(),
                                ok=False,
                                backend=backend.backend_name,
                                message=f"camera '{cam_name}' not available on backend {backend.backend_name}",
                                data={},
                            ).to_json(),
                        )
                        continue
                    try:
                        b64, width, height = _encode_frame_as_png_base64(frame)
                    except Exception as exc:
                        await _safe_send(
                            ws,
                            _json_error(
                                f"camera.snapshot encode failed: {exc}",
                                request_id=request_id,
                            ),
                        )
                        continue
                    await _safe_send(
                        ws,
                        ResponseEnvelope(
                            request_id=command.request_id,
                            timestamp=utc_now_iso(),
                            ok=True,
                            backend=backend.backend_name,
                            message="ok",
                            data={
                                "camera": cam_name,
                                "width": width,
                                "height": height,
                                "format": "png",
                                "frame_base64": b64,
                            },
                        ).to_json(),
                    )
                    continue

                # Policy commands are handled directly (not queued)
                if command.command.startswith("policy."):
                    # Preempt manual command queue when entering policy mode
                    if command.command == "policy.start":
                        while not command_queue.empty():
                            _ = command_queue.get_nowait()
                            command_queue.task_done()

                    response = await _handle_policy_command(
                        ws, backend, command, policy_state, trace_logger
                    )
                    await _safe_send(ws, response.to_json())
                    continue

                # Manual commands preempt policy mode
                if policy_state.active and command.command in {
                    "walk.set", "walk.command", "head.set", "action.play",
                }:
                    # Auto-stop policy when manual command arrives
                    policy_state.active = False
                    await _safe_send(
                        ws,
                        EventEnvelope(
                            event="policy.status",
                            timestamp=utc_now_iso(),
                            backend=backend.backend_name,
                            data={
                                "state": "idle",
                                "reason": "manual_preempt",
                                "steps_completed": policy_state.step,
                                "trace_id": policy_state.trace_id,
                                "planner_step_id": policy_state.planner_step_id,
                                "canonical_action": policy_state.canonical_action,
                                "target_entity_id": policy_state.target_entity_id,
                                "target_label": policy_state.target_label,
                            },
                        ).to_json(),
                    )

                if command.preempt:
                    while not command_queue.empty():
                        _ = command_queue.get_nowait()
                        command_queue.task_done()
                try:
                    command_queue.put_nowait(command)
                except asyncio.QueueFull:
                    await _safe_send(
                        ws,
                        _json_error("command queue is full", request_id=request_id),
                    )
                    continue
                if trace_logger is not None:
                    trace_logger.write(
                        {
                            "kind": "command_enqueued",
                            "timestamp": utc_now_iso(),
                            "backend": backend.backend_name,
                            "request_id": command.request_id,
                            "command": command.command,
                            "preempt": command.preempt,
                            "payload": safe_to_record(command.payload),
                            "queue_size": command_queue.qsize(),
                        }
                    )
            except Exception as exc:
                await _safe_send(ws, _json_error(str(exc), request_id=request_id))
    except ConnectionClosed:
        pass
    finally:
        event_task.cancel()
        worker_task.cancel()
        deadman_task.cancel()
        policy_heartbeat_task.cancel()
        # Ensure policy is stopped on disconnect
        if policy_state.active:
            policy_state.active = False
            stop_cmd = CommandEnvelope(
                request_id="disconnect-policy-stop",
                timestamp=utc_now_iso(),
                command="walk.command",
                payload={"action": "stop"},
                preempt=True,
            )
            await backend.handle_command(stop_cmd)
        await backend.shutdown()


async def _run_server(host: str, port: int, backend: str, config: RuntimeConfig) -> None:
    backend_factory = _build_backend_factory(backend, config)
    async with serve(
        lambda ws: _handler(ws, backend_factory, config),
        host=host,
        port=port,
    ):
        print(
            "bridge websocket listening on "
            f"ws://{host}:{port} backend={backend} "
            f"queue_size={config.queue_size} "
            f"max_commands_per_sec={config.max_commands_per_sec} "
            f"deadman_timeout_sec={config.deadman_timeout_sec}"
        )
        await asyncio.Future()


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="AiNex unified websocket bridge")
    parser.add_argument(
        "--host",
        type=str,
        default="0.0.0.0",
        help="listen host",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=9100,
        help="listen port",
    )
    parser.add_argument(
        "--backend",
        type=str,
        choices=[
            "mock", "mujoco", "ros", "ros_real", "ros_sim", "isaac",
            "ainex_remote", "ros_remote",
        ],
        default="mock",
        help="target backend adapter",
    )
    parser.add_argument(
        "--rosbridge-host",
        type=str,
        default="192.168.1.218",
        help="rosbridge host for --backend ainex_remote (default: 192.168.1.218)",
    )
    parser.add_argument(
        "--rosbridge-port",
        type=int,
        default=9090,
        help="rosbridge port for --backend ainex_remote (default: 9090)",
    )
    parser.add_argument(
        "--profile",
        type=str,
        default="hiwonder-ainex",
        help="robot profile id (resolves URDF, calibration, safety from "
             "packages/robot/profiles/<id>/)",
    )
    parser.add_argument(
        "--queue-size",
        type=int,
        default=256,
        help="max queued commands per websocket session",
    )
    parser.add_argument(
        "--max-commands-per-sec",
        type=int,
        default=30,
        help="rate limit for inbound commands per session",
    )
    parser.add_argument(
        "--deadman-timeout-sec",
        type=float,
        default=1.0,
        help="auto-stop timeout if no heartbeat command is received",
    )
    parser.add_argument(
        "--trace-log-path",
        type=str,
        default="",
        help="optional JSONL path for command/response trace logging",
    )
    parser.add_argument(
        "--mujoco-target-x",
        type=float,
        default=2.0,
        help="MuJoCo backend: target ball X position (m, default 2.0)",
    )
    parser.add_argument(
        "--mujoco-target-y",
        type=float,
        default=0.0,
        help="MuJoCo backend: target ball Y position (m, default 0.0)",
    )
    parser.add_argument(
        "--mujoco-target-z",
        type=float,
        default=0.05,
        help="MuJoCo backend: target ball Z position (m, default 0.05)",
    )
    parser.add_argument(
        "--camera-device",
        type=int,
        default=-1,
        help="v4l2 device index for an external camera (Obsbot etc.). "
             "When >=0, `camera.snapshot` reads from this device instead "
             "of the backend (useful with --backend ros_real).",
    )
    parser.add_argument(
        "--camera-width",
        type=int,
        default=640,
        help="External camera capture width (default 640)",
    )
    parser.add_argument(
        "--camera-height",
        type=int,
        default=480,
        help="External camera capture height (default 480)",
    )
    parser.add_argument(
        "--config",
        type=str,
        default="",
        help="optional JSON config path (bridge/config/default_bridge_config.json style)",
    )
    return parser.parse_args()


def main() -> None:
    args = _parse_args()
    config_obj = _load_config_file(args.config)
    config = _coerce_runtime_config(args, config_obj)
    asyncio.run(
        _run_server(host=args.host, port=args.port, backend=args.backend, config=config)
    )


if __name__ == "__main__":
    main()

