"""End-to-end websocket tests for ROSBridge-compatible server mode."""

from __future__ import annotations

import asyncio
import json
import unittest

from websockets.asyncio.client import connect
from websockets.asyncio.server import Server, serve

from eliza_robot.bridge.rosbridge_server import RuntimeConfig, _handler
from eliza_robot.bridge.types import JsonDict


async def _recv_until(
    ws: object,
    predicate: object,
    timeout_sec: float = 2.0,
) -> JsonDict:
    async def _inner() -> JsonDict:
        while True:
            raw_value = await ws.recv()
            parsed = json.loads(raw_value)
            if isinstance(parsed, dict) and predicate(parsed):
                return parsed

    return await asyncio.wait_for(_inner(), timeout=timeout_sec)


class RosbridgeServerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self._server: Server = await serve(
            lambda ws: _handler(
                ws,
                backend_name="mock",
                config=RuntimeConfig(publish_hz=30.0, max_commands_per_sec=100, deadman_timeout_sec=60.0),
            ),
            "127.0.0.1",
            0,
        )
        sockets = self._server.sockets
        if not sockets:
            raise RuntimeError("test websocket server did not open sockets")
        self._port = int(sockets[0].getsockname()[1])

    async def asyncTearDown(self) -> None:
        self._server.close()
        await self._server.wait_closed()

    async def test_publish_subscribe_service_flow(self) -> None:
        uri = f"ws://127.0.0.1:{self._port}"
        async with connect(uri) as ws:
            _ = await _recv_until(ws, lambda item: item.get("op") == "status")
            _ = await _recv_until(ws, lambda item: item.get("op") == "hello")

            await ws.send(
                json.dumps(
                    {"op": "subscribe", "id": "sub-battery", "topic": "/ros_robot_controller/battery"}
                )
            )
            subscribe_ack = await _recv_until(
                ws,
                lambda item: item.get("op") == "status" and item.get("id") == "sub-battery",
            )
            self.assertEqual(subscribe_ack.get("level"), "info")

            battery_msg = await _recv_until(
                ws,
                lambda item: item.get("op") == "publish"
                and item.get("topic") == "/ros_robot_controller/battery",
            )
            payload = battery_msg.get("msg")
            self.assertIsInstance(payload, dict)
            if not isinstance(payload, dict):
                raise AssertionError("publish payload must be dict")
            self.assertIn("data", payload)

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
            service_response = await _recv_until(
                ws,
                lambda item: item.get("op") == "service_response" and item.get("id") == "svc-start",
            )
            values = service_response.get("values")
            self.assertIsInstance(values, dict)
            if not isinstance(values, dict):
                raise AssertionError("service values must be dict")
            self.assertTrue(bool(values.get("result")))

            await ws.send(
                json.dumps(
                    {
                        "op": "publish",
                        "id": "pub-servo",
                        "topic": "/ros_robot_controller/bus_servo/set_position",
                        "msg": {
                            "duration": 0.3,
                            "position": [{"id": 23, "position": 500}],
                        },
                    }
                )
            )
            publish_ack = await _recv_until(
                ws,
                lambda item: item.get("op") == "status" and item.get("id") == "pub-servo",
            )
            self.assertEqual(publish_ack.get("level"), "info")

    async def test_servo_state_publish_and_service_flow(self) -> None:
        uri = f"ws://127.0.0.1:{self._port}"
        async with connect(uri) as ws:
            _ = await _recv_until(ws, lambda item: item.get("op") == "status")
            _ = await _recv_until(ws, lambda item: item.get("op") == "hello")

            await ws.send(
                json.dumps(
                    {
                        "op": "publish",
                        "id": "pub-state",
                        "topic": "/ros_robot_controller/bus_servo/set_state",
                        "msg": {
                            "duration": 0.3,
                            "state": [
                                {
                                    "present_id": [23],
                                    "target_id": [24],
                                    "position": [500],
                                }
                            ],
                        },
                    }
                )
            )
            publish_ack = await _recv_until(
                ws,
                lambda item: item.get("op") == "status" and item.get("id") == "pub-state",
            )
            self.assertEqual(publish_ack.get("level"), "info")

            await ws.send(
                json.dumps(
                    {
                        "op": "call_service",
                        "id": "svc-state",
                        "service": "/ros_robot_controller/bus_servo/get_state",
                        "args": {
                            "cmd": [
                                {"id": 23, "get_position": 1, "get_voltage": 1},
                            ]
                        },
                    }
                )
            )
            response = await _recv_until(
                ws,
                lambda item: item.get("op") == "service_response" and item.get("id") == "svc-state",
            )
            values = response.get("values")
            self.assertIsInstance(values, dict)
            if not isinstance(values, dict):
                raise AssertionError("service values must be dict")
            self.assertTrue(bool(values.get("success")))
            state_value = values.get("state")
            self.assertIsInstance(state_value, list)
            if not isinstance(state_value, list):
                raise AssertionError("state must be list")
            self.assertGreaterEqual(len(state_value), 1)

    async def test_error_response_preserves_request_id(self) -> None:
        uri = f"ws://127.0.0.1:{self._port}"
        async with connect(uri) as ws:
            _ = await _recv_until(ws, lambda item: item.get("op") == "status")
            _ = await _recv_until(ws, lambda item: item.get("op") == "hello")

            await ws.send(json.dumps({"op": "publish", "id": "bad-1", "topic": "/unknown", "msg": {}}))
            error_status = await _recv_until(
                ws,
                lambda item: item.get("op") == "status"
                and item.get("level") == "error"
                and item.get("id") == "bad-1",
            )
            self.assertEqual(error_status.get("id"), "bad-1")

    async def test_get_time_and_advertise_ops(self) -> None:
        uri = f"ws://127.0.0.1:{self._port}"
        async with connect(uri) as ws:
            _ = await _recv_until(ws, lambda item: item.get("op") == "status")
            _ = await _recv_until(ws, lambda item: item.get("op") == "hello")

            await ws.send(json.dumps({"op": "get_time", "id": "time-1"}))
            time_response = await _recv_until(
                ws,
                lambda item: item.get("op") == "time" and item.get("id") == "time-1",
            )
            self.assertIsInstance(time_response.get("secs"), int)
            self.assertIsInstance(time_response.get("nsecs"), int)

            await ws.send(
                json.dumps(
                    {
                        "op": "advertise",
                        "id": "adv-1",
                        "topic": "/tmp/test",
                        "type": "std_msgs/String",
                    }
                )
            )
            advertise_response = await _recv_until(
                ws,
                lambda item: item.get("op") == "status" and item.get("id") == "adv-1",
            )
            self.assertEqual(advertise_response.get("level"), "info")


if __name__ == "__main__":
    unittest.main()
