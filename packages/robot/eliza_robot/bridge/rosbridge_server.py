"""ROSBridge-compatible websocket server for AiNex real/sim/isaac backends.

Provides a ROSBridge wire-compatible endpoint with integrated safety controls
(rate limiting, deadman timeout) so the same websocket client can drive real
robot, ROS simulation, or IsaacLab simulation identically.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import time
from dataclasses import dataclass

from websockets.asyncio.server import ServerConnection, serve
from websockets.exceptions import ConnectionClosed

from eliza_robot.bridge.backends.rosbridge_base import RosbridgeBackend
from eliza_robot.bridge.backends.rosbridge_isaac import IsaacRosbridgeBackend
from eliza_robot.bridge.backends.rosbridge_mock import MockRosbridgeBackend
from eliza_robot.bridge.backends.rosbridge_ros import Ros1RosbridgeBackend
from eliza_robot.bridge.protocol import utc_now_iso
from eliza_robot.bridge.safety import CommandRateLimiter
from eliza_robot.bridge.types import JsonDict, JsonValue

# Topics that count as heartbeat activity for deadman timeout.
_HEARTBEAT_TOPICS: frozenset[str] = frozenset(
    {
        "/app/set_walking_param",
        "/head_pan_controller/command",
        "/head_tilt_controller/command",
    }
)

# Services that count as heartbeat activity.
_HEARTBEAT_SERVICES: frozenset[str] = frozenset({"/walking/command"})


@dataclass(frozen=True)
class RuntimeConfig:
    publish_hz: float
    max_commands_per_sec: int = 30
    deadman_timeout_sec: float = 5.0
    camera_url: str = ""


def _build_backend(name: str) -> RosbridgeBackend:
    if name == "mock":
        return MockRosbridgeBackend()
    if name == "ros_real":
        return Ros1RosbridgeBackend("ros_real")
    if name == "ros_sim":
        return Ros1RosbridgeBackend("ros_sim")
    if name == "isaac":
        return IsaacRosbridgeBackend()
    raise ValueError(f"unsupported backend: {name}")


def _status(level: str, msg: str, request_id: str | None = None) -> JsonDict:
    payload: JsonDict = {"op": "status", "level": level, "msg": msg}
    if request_id is not None:
        payload["id"] = request_id
    return payload


def _service_response(
    service: str, values: JsonDict, result: bool, request_id: str | None = None
) -> JsonDict:
    payload: JsonDict = {
        "op": "service_response",
        "service": service,
        "values": values,
        "result": result,
    }
    if request_id is not None:
        payload["id"] = request_id
    return payload


def _ensure_json_dict(value: JsonValue, field_name: str) -> JsonDict:
    if not isinstance(value, dict):
        raise ValueError(f"'{field_name}' must be an object")
    return value


def _ensure_str(value: JsonValue, field_name: str) -> str:
    if not isinstance(value, str) or value == "":
        raise ValueError(f"'{field_name}' must be a non-empty string")
    return value


def _normalize_service_args(args: JsonValue) -> JsonDict:
    if args is None:
        return {}
    return _ensure_json_dict(args, "args")


async def _safe_send(ws: ServerConnection, payload: JsonDict) -> None:
    await ws.send(json.dumps(payload))


async def _publish_loop(
    ws: ServerConnection,
    backend: RosbridgeBackend,
    subscriptions: set[str],
    publish_hz: float,
) -> None:
    period = 1.0 / publish_hz
    while True:
        snapshot = await backend.snapshot_topics()
        for topic in subscriptions:
            message = snapshot.get(topic)
            if message is None:
                continue
            await _safe_send(
                ws,
                {
                    "op": "publish",
                    "topic": topic,
                    "msg": message,
                },
            )
        await asyncio.sleep(period)


async def _deadman_pump(
    ws: ServerConnection,
    backend: RosbridgeBackend,
    get_last_heartbeat: object,
    deadman_timeout_sec: float,
) -> None:
    """Auto-stop walking if no heartbeat received within timeout."""
    fired = False
    while True:
        await asyncio.sleep(0.25)
        age = asyncio.get_running_loop().time() - get_last_heartbeat()
        if age < deadman_timeout_sec:
            fired = False
            continue
        if fired:
            continue

        # Issue emergency stop via walking/command service.
        try:
            await backend.call_service("/walking/command", {"command": "stop"})
        except Exception:
            pass
        fired = True
        await _safe_send(
            ws,
            {
                "op": "status",
                "level": "warning",
                "msg": f"deadman timeout: auto-stopped walking after {age:.1f}s inactivity",
                "timestamp": utc_now_iso(),
            },
        )


async def _handle_message(
    ws: ServerConnection,
    backend: RosbridgeBackend,
    parsed: JsonDict,
    subscriptions: set[str],
    limiter: CommandRateLimiter,
    update_heartbeat: object,
) -> None:

    op = _ensure_str(parsed.get("op"), "op")
    request_id = parsed.get("id")
    request_id_str: str | None
    if isinstance(request_id, str) and request_id != "":
        request_id_str = request_id
    else:
        request_id_str = None

    if op in {"advertise", "unadvertise", "set_level", "advertise_service", "unadvertise_service"}:
        await _safe_send(ws, _status("info", f"{op} acknowledged", request_id_str))
        return

    if op == "get_time":
        current_time = time.time()
        secs = int(current_time)
        nsecs = int((current_time - secs) * 1_000_000_000)
        await _safe_send(
            ws,
            {
                "op": "time",
                "secs": secs,
                "nsecs": nsecs,
                "id": request_id_str if request_id_str is not None else "",
            },
        )
        return

    if op == "subscribe":
        topic = _ensure_str(parsed.get("topic"), "topic")
        subscriptions.add(topic)
        await _safe_send(ws, _status("info", f"subscribed: {topic}", request_id_str))
        return

    if op == "unsubscribe":
        topic = _ensure_str(parsed.get("topic"), "topic")
        subscriptions.discard(topic)
        await _safe_send(ws, _status("info", f"unsubscribed: {topic}", request_id_str))
        return

    # Rate-limit publish and call_service operations.
    limit_result = limiter.check()
    if not limit_result.allowed:
        await _safe_send(
            ws,
            _status(
                "warning",
                f"rate limit exceeded, retry after {limit_result.retry_after_sec:.3f}s",
                request_id_str,
            ),
        )
        return

    if op == "publish":
        topic = _ensure_str(parsed.get("topic"), "topic")
        message = _ensure_json_dict(parsed.get("msg"), "msg")
        await backend.publish(topic, message)
        if topic in _HEARTBEAT_TOPICS:
            update_heartbeat()
        await _safe_send(ws, _status("info", f"published: {topic}", request_id_str))
        return

    if op == "call_service":
        service = _ensure_str(parsed.get("service"), "service")
        args = _normalize_service_args(parsed.get("args"))
        values = await backend.call_service(service, args)
        if service in _HEARTBEAT_SERVICES:
            update_heartbeat()
        await _safe_send(
            ws,
            _service_response(
                service=service,
                values=values,
                result=True,
                request_id=request_id_str,
            ),
        )
        return

    raise ValueError(f"unsupported op: {op}")


async def _handler(ws: ServerConnection, backend_name: str, config: RuntimeConfig) -> None:
    backend = _build_backend(backend_name)
    await backend.connect()
    subscriptions: set[str] = set()
    limiter = CommandRateLimiter(max_commands_per_sec=config.max_commands_per_sec)

    loop = asyncio.get_running_loop()
    last_heartbeat = loop.time()

    def _get_last_heartbeat() -> float:
        return last_heartbeat

    def _update_heartbeat() -> None:
        nonlocal last_heartbeat
        last_heartbeat = loop.time()

    publish_task = asyncio.create_task(
        _publish_loop(
            ws=ws,
            backend=backend,
            subscriptions=subscriptions,
            publish_hz=config.publish_hz,
        )
    )
    deadman_task = asyncio.create_task(
        _deadman_pump(
            ws=ws,
            backend=backend,
            get_last_heartbeat=_get_last_heartbeat,
            deadman_timeout_sec=config.deadman_timeout_sec,
        )
    )
    try:
        await _safe_send(
            ws,
            {
                "op": "status",
                "level": "info",
                "backend": backend.backend_name,
                "timestamp": utc_now_iso(),
                "msg": f"connected backend={backend.backend_name}",
            },
        )
        hello_payload: JsonDict = {
            "op": "hello",
            "backend": backend.backend_name,
            "timestamp": utc_now_iso(),
            "capabilities": backend.capabilities(),
            "safety": {
                "max_commands_per_sec": config.max_commands_per_sec,
                "deadman_timeout_sec": config.deadman_timeout_sec,
            },
        }
        if config.camera_url:
            hello_payload["camera_url"] = config.camera_url
        await _safe_send(ws, hello_payload)
        async for raw_message in ws:
            request_id: str | None = None
            try:
                parsed_raw = json.loads(raw_message)
                if not isinstance(parsed_raw, dict):
                    raise ValueError("payload must be a JSON object")
                parsed = parsed_raw
                if isinstance(parsed, dict):
                    request_id_value = parsed.get("id")
                    if isinstance(request_id_value, str) and request_id_value != "":
                        request_id = request_id_value
                await _handle_message(
                    ws, backend, parsed, subscriptions, limiter, _update_heartbeat
                )
            except Exception as exc:
                payload: JsonDict = {
                    "op": "status",
                    "level": "error",
                    "backend": backend.backend_name,
                    "timestamp": utc_now_iso(),
                    "msg": str(exc),
                }
                if request_id is not None:
                    payload["id"] = request_id
                await _safe_send(ws, payload)
    except ConnectionClosed:
        pass
    finally:
        publish_task.cancel()
        deadman_task.cancel()
        await backend.shutdown()


async def _run_server(host: str, port: int, backend_name: str, config: RuntimeConfig) -> None:
    async with serve(
        lambda ws: _handler(ws, backend_name=backend_name, config=config), host=host, port=port
    ):
        print(
            "rosbridge-compatible websocket listening on "
            f"ws://{host}:{port} backend={backend_name} "
            f"publish_hz={config.publish_hz} "
            f"rate_limit={config.max_commands_per_sec}/s "
            f"deadman={config.deadman_timeout_sec}s"
        )
        await asyncio.Future()


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="AiNex ROSBridge-compatible websocket server")
    parser.add_argument("--host", type=str, default="0.0.0.0", help="listen host")
    parser.add_argument("--port", type=int, default=9090, help="listen port")
    parser.add_argument(
        "--backend",
        type=str,
        choices=["mock", "ros_real", "ros_sim", "isaac"],
        default="isaac",
        help="target backend adapter",
    )
    parser.add_argument(
        "--publish-hz",
        type=float,
        default=15.0,
        help="publish frequency for subscription fanout",
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
        default=5.0,
        help="auto-stop walking if no heartbeat for this many seconds",
    )
    parser.add_argument(
        "--camera-url",
        type=str,
        default="",
        help="camera MJPEG stream URL to expose in hello message",
    )
    return parser.parse_args()


def main() -> None:
    args = _parse_args()
    config = RuntimeConfig(
        publish_hz=args.publish_hz,
        max_commands_per_sec=args.max_commands_per_sec,
        deadman_timeout_sec=args.deadman_timeout_sec,
        camera_url=args.camera_url,
    )
    asyncio.run(
        _run_server(
            host=args.host,
            port=args.port,
            backend_name=args.backend,
            config=config,
        )
    )


if __name__ == "__main__":
    main()
