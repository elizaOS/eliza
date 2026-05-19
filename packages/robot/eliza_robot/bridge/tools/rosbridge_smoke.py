"""Smoke test ROSBridge-compatible endpoint behavior."""

from __future__ import annotations

import argparse
import asyncio
import json

from websockets.asyncio.client import connect

from eliza_robot.bridge.types import JsonDict


async def _recv_until(
    ws: object,
    predicate: object,
    timeout_sec: float = 3.0,
) -> JsonDict:
    async def _inner() -> JsonDict:
        while True:
            raw_value = await ws.recv()
            parsed = json.loads(raw_value)
            if isinstance(parsed, dict) and predicate(parsed):
                return parsed

    return await asyncio.wait_for(_inner(), timeout=timeout_sec)


async def _run(uri: str) -> int:
    async with connect(uri) as ws:
        _ = await _recv_until(ws, lambda item: item.get("op") == "status")
        hello = await _recv_until(ws, lambda item: item.get("op") == "hello")
        backend = hello.get("backend")
        print(f"connected backend={backend}")

        await ws.send(
            json.dumps(
                {"op": "subscribe", "id": "sub-battery", "topic": "/ros_robot_controller/battery"}
            )
        )
        _ = await _recv_until(
            ws,
            lambda item: item.get("op") == "status" and item.get("id") == "sub-battery",
        )
        battery_msg = await _recv_until(
            ws,
            lambda item: item.get("op") == "publish"
            and item.get("topic") == "/ros_robot_controller/battery",
        )
        print(f"battery_sample={battery_msg.get('msg')}")

        await ws.send(
            json.dumps(
                {
                    "op": "call_service",
                    "id": "svc-start",
                    "service": "/walking/command",
                    "args": {"command": "start"},
                }
            )
        )
        start_response = await _recv_until(
            ws,
            lambda item: item.get("op") == "service_response" and item.get("id") == "svc-start",
        )
        start_values = start_response.get("values")
        if not isinstance(start_values, dict) or not bool(start_values.get("result")):
            print("walking start service failed")
            return 1

        await ws.send(
            json.dumps(
                {
                    "op": "publish",
                    "id": "pub-servo",
                    "topic": "/ros_robot_controller/bus_servo/set_position",
                    "msg": {"duration": 0.3, "position": [{"id": 23, "position": 500}]},
                }
            )
        )
        _ = await _recv_until(
            ws,
            lambda item: item.get("op") == "status" and item.get("id") == "pub-servo",
        )

        await ws.send(
            json.dumps(
                {
                    "op": "call_service",
                    "id": "svc-servo",
                    "service": "/ros_robot_controller/bus_servo/get_position",
                    "args": {"id": [23, 24]},
                }
            )
        )
        servo_response = await _recv_until(
            ws,
            lambda item: item.get("op") == "service_response" and item.get("id") == "svc-servo",
        )
        servo_values = servo_response.get("values")
        if not isinstance(servo_values, dict):
            print("servo response values missing")
            return 1
        if not bool(servo_values.get("success", False)):
            print("servo service indicated failure")
            return 1
        positions_value = servo_values.get("position")
        if not isinstance(positions_value, list) or len(positions_value) == 0:
            print("servo position payload missing")
            return 1

    print("rosbridge_smoke=PASS")
    return 0


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Smoke test ROSBridge-compatible bridge")
    parser.add_argument(
        "--uri",
        type=str,
        default="ws://127.0.0.1:9090",
        help="ROSBridge-compatible websocket URI",
    )
    return parser.parse_args()


def main() -> None:
    args = _parse_args()
    exit_code = asyncio.run(_run(args.uri))
    raise SystemExit(exit_code)


if __name__ == "__main__":
    main()
