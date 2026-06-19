"""Compare ROSBridge-compatible behavior between two endpoints."""

from __future__ import annotations

import argparse
import asyncio
import json
from dataclasses import dataclass

from websockets.asyncio.client import connect

from eliza_robot.bridge.types import JsonDict


@dataclass(frozen=True)
class EndpointSummary:
    backend: str
    battery_present: bool
    walk_start_ok: bool
    servo_service_ok: bool
    get_time_ok: bool
    advertise_ok: bool


async def _recv_until(ws: object, predicate: object, timeout_sec: float = 3.0) -> JsonDict:
    async def _inner() -> JsonDict:
        while True:
            inbound_raw = await ws.recv()
            inbound = json.loads(inbound_raw)
            if isinstance(inbound, dict) and predicate(inbound):
                return inbound

    return await asyncio.wait_for(_inner(), timeout=timeout_sec)


async def _probe(uri: str) -> EndpointSummary:
    async with connect(uri) as ws:
        _ = await _recv_until(ws, lambda item: item.get("op") == "status")
        hello = await _recv_until(ws, lambda item: item.get("op") == "hello")
        backend_name_value = hello.get("backend")
        backend_name = str(backend_name_value) if isinstance(backend_name_value, str) else "unknown"

        await ws.send(json.dumps({"op": "subscribe", "id": "sub-battery", "topic": "/ros_robot_controller/battery"}))
        _ = await _recv_until(
            ws,
            lambda item: item.get("op") == "status" and item.get("id") == "sub-battery",
        )
        battery_msg = await _recv_until(
            ws,
            lambda item: item.get("op") == "publish" and item.get("topic") == "/ros_robot_controller/battery",
        )
        battery_present = isinstance(battery_msg.get("msg"), dict)

        await ws.send(
            json.dumps(
                {
                    "op": "call_service",
                    "id": "svc-walk",
                    "service": "/walking/command",
                    "args": {"command": "start"},
                }
            )
        )
        walk_response = await _recv_until(
            ws,
            lambda item: item.get("op") == "service_response" and item.get("id") == "svc-walk",
        )
        walk_values = walk_response.get("values")
        walk_start_ok = isinstance(walk_values, dict) and bool(walk_values.get("result"))

        await ws.send(
            json.dumps(
                {
                    "op": "call_service",
                    "id": "svc-servo",
                    "service": "/ros_robot_controller/bus_servo/get_position",
                    "args": {"id": [23]},
                }
            )
        )
        servo_response = await _recv_until(
            ws,
            lambda item: item.get("op") == "service_response" and item.get("id") == "svc-servo",
        )
        servo_values = servo_response.get("values")
        servo_service_ok = (
            isinstance(servo_values, dict)
            and bool(servo_values.get("success"))
            and isinstance(servo_values.get("position"), list)
        )

        await ws.send(json.dumps({"op": "get_time", "id": "time-1"}))
        time_response = await _recv_until(
            ws,
            lambda item: item.get("op") == "time" and item.get("id") == "time-1",
        )
        get_time_ok = isinstance(time_response.get("secs"), int) and isinstance(
            time_response.get("nsecs"), int
        )

        await ws.send(json.dumps({"op": "advertise", "id": "adv-1", "topic": "/tmp/topic", "type": "std_msgs/String"}))
        advertise_response = await _recv_until(
            ws,
            lambda item: item.get("op") == "status" and item.get("id") == "adv-1",
        )
        advertise_ok = advertise_response.get("level") == "info"

        return EndpointSummary(
            backend=backend_name,
            battery_present=battery_present,
            walk_start_ok=walk_start_ok,
            servo_service_ok=servo_service_ok,
            get_time_ok=get_time_ok,
            advertise_ok=advertise_ok,
        )


def _is_equivalent(left: EndpointSummary, right: EndpointSummary) -> tuple[bool, list[str]]:
    issues: list[str] = []
    if left.battery_present != right.battery_present:
        issues.append("battery publish parity mismatch")
    if left.walk_start_ok != right.walk_start_ok:
        issues.append("walking service parity mismatch")
    if left.servo_service_ok != right.servo_service_ok:
        issues.append("servo service parity mismatch")
    if left.get_time_ok != right.get_time_ok:
        issues.append("get_time parity mismatch")
    if left.advertise_ok != right.advertise_ok:
        issues.append("advertise ack parity mismatch")
    return len(issues) == 0, issues


async def _main(left_uri: str, right_uri: str) -> int:
    left = await _probe(left_uri)
    right = await _probe(right_uri)
    print(f"left_backend={left.backend}")
    print(f"right_backend={right.backend}")
    ok, issues = _is_equivalent(left, right)
    if ok:
        print("rosbridge_parity=PASS")
        return 0
    print("rosbridge_parity=FAIL")
    for issue in issues:
        print(f"- {issue}")
    return 1


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Compare ROSBridge-compatible parity between two endpoints")
    parser.add_argument("--left-uri", type=str, required=True, help="left endpoint URI")
    parser.add_argument("--right-uri", type=str, required=True, help="right endpoint URI")
    return parser.parse_args()


def main() -> None:
    args = _parse_args()
    exit_code = asyncio.run(_main(left_uri=args.left_uri, right_uri=args.right_uri))
    raise SystemExit(exit_code)


if __name__ == "__main__":
    main()
