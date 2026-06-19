"""Integration test for policy lifecycle via the bridge server with mock backend."""

from __future__ import annotations

import asyncio
import json
import unittest
import uuid

from websockets.asyncio.client import connect

from eliza_robot.bridge.backends.mock_backend import MockBackend
from eliza_robot.bridge.protocol import utc_now_iso
from eliza_robot.bridge.server import RuntimeConfig, _handler, _run_server


def _cmd(command: str, payload: dict | None = None, preempt: bool = False) -> str:
    return json.dumps({
        "type": "command",
        "request_id": str(uuid.uuid4()),
        "timestamp": utc_now_iso(),
        "command": command,
        "payload": payload or {},
        "preempt": preempt,
    })


class PolicyLifecycleIntegrationTest(unittest.IsolatedAsyncioTestCase):
    """Test policy lifecycle commands against the real server + mock backend."""

    async def _start_server(self, port: int) -> asyncio.Task[None]:
        config = RuntimeConfig(
            queue_size=64,
            max_commands_per_sec=100,
            deadman_timeout_sec=5.0,
            trace_log_path="",
        )

        from websockets.asyncio.server import serve

        async def handler(ws):
            await _handler(ws, MockBackend, config)

        server = await serve(handler, "127.0.0.1", port)
        task = asyncio.create_task(server.serve_forever())
        await asyncio.sleep(0.1)  # Let server start
        return task

    async def test_policy_start_stop(self) -> None:
        port = 19201
        server_task = await self._start_server(port)
        try:
            async with connect(f"ws://127.0.0.1:{port}") as ws:
                # Receive session.hello
                hello = json.loads(await asyncio.wait_for(ws.recv(), timeout=2))
                self.assertEqual(hello["event"], "session.hello")

                # Start policy
                await ws.send(_cmd("policy.start", {
                    "task": "test_walk",
                    "trace_id": "trace-123",
                    "planner_step_id": "planner-step-9",
                    "canonical_action": "NAVIGATE_TO_ENTITY",
                    "target_entity_id": "red-ball-01",
                    "target_label": "Red Ball",
                }))
                resp = json.loads(await asyncio.wait_for(ws.recv(), timeout=2))
                # May get events before response, collect until we get a response
                messages = [resp]
                policy_events: list[dict] = []
                while resp.get("type") != "response":
                    if resp.get("event") == "policy.status":
                        policy_events.append(resp)
                    resp = json.loads(await asyncio.wait_for(ws.recv(), timeout=2))
                    messages.append(resp)

                self.assertTrue(resp["ok"])
                self.assertIn("policy started", resp["message"])
                self.assertEqual(resp["data"]["trace_id"], "trace-123")
                self.assertEqual(resp["data"]["planner_step_id"], "planner-step-9")
                self.assertEqual(resp["data"]["canonical_action"], "NAVIGATE_TO_ENTITY")
                self.assertEqual(resp["data"]["target_entity_id"], "red-ball-01")
                self.assertEqual(resp["data"]["target_label"], "Red Ball")
                self.assertTrue(
                    any(
                        event.get("data", {}).get("trace_id") == "trace-123"
                        and event.get("data", {}).get("planner_step_id")
                        == "planner-step-9"
                        for event in policy_events
                    )
                )

                # Check policy status
                await ws.send(_cmd("policy.status"))
                resp = json.loads(await asyncio.wait_for(ws.recv(), timeout=2))
                while resp.get("type") != "response":
                    resp = json.loads(await asyncio.wait_for(ws.recv(), timeout=2))
                self.assertTrue(resp["data"]["active"])
                self.assertEqual(resp["data"]["trace_id"], "trace-123")
                self.assertEqual(resp["data"]["planner_step_id"], "planner-step-9")

                # Send a policy tick
                await ws.send(_cmd("policy.tick", {
                    "action": {"walk_x": 0.01, "walk_y": 0.0, "walk_yaw": 0.0},
                }))
                resp = json.loads(await asyncio.wait_for(ws.recv(), timeout=2))
                while resp.get("type") != "response":
                    resp = json.loads(await asyncio.wait_for(ws.recv(), timeout=2))
                self.assertTrue(resp["ok"])
                self.assertEqual(resp["data"]["step"], 1)

                # Stop policy
                await ws.send(_cmd("policy.stop", {"reason": "test_done"}))
                resp = json.loads(await asyncio.wait_for(ws.recv(), timeout=2))
                while resp.get("type") != "response":
                    resp = json.loads(await asyncio.wait_for(ws.recv(), timeout=2))
                self.assertTrue(resp["ok"])

                # Verify stopped
                await ws.send(_cmd("policy.status"))
                resp = json.loads(await asyncio.wait_for(ws.recv(), timeout=2))
                while resp.get("type") != "response":
                    resp = json.loads(await asyncio.wait_for(ws.recv(), timeout=2))
                self.assertFalse(resp["data"]["active"])

        finally:
            server_task.cancel()
            try:
                await server_task
            except asyncio.CancelledError:
                pass

    async def test_policy_tick_without_start_fails(self) -> None:
        port = 19202
        server_task = await self._start_server(port)
        try:
            async with connect(f"ws://127.0.0.1:{port}") as ws:
                # Receive session.hello
                await asyncio.wait_for(ws.recv(), timeout=2)

                # Tick without start
                await ws.send(_cmd("policy.tick", {
                    "action": {"walk_x": 0.01},
                }))
                resp = json.loads(await asyncio.wait_for(ws.recv(), timeout=2))
                while resp.get("type") != "response":
                    resp = json.loads(await asyncio.wait_for(ws.recv(), timeout=2))
                self.assertFalse(resp["ok"])
                self.assertIn("not active", resp["message"])

        finally:
            server_task.cancel()
            try:
                await server_task
            except asyncio.CancelledError:
                pass

    async def test_manual_command_preempts_policy(self) -> None:
        port = 19203
        server_task = await self._start_server(port)
        try:
            async with connect(f"ws://127.0.0.1:{port}") as ws:
                await asyncio.wait_for(ws.recv(), timeout=2)  # hello

                # Start policy
                await ws.send(_cmd("policy.start", {"task": "test"}))
                resp = json.loads(await asyncio.wait_for(ws.recv(), timeout=2))
                while resp.get("type") != "response":
                    resp = json.loads(await asyncio.wait_for(ws.recv(), timeout=2))
                self.assertTrue(resp["ok"])

                # Send manual walk command (should preempt policy)
                await ws.send(_cmd("walk.command", {"action": "stop"}))

                # Collect messages - should see policy.status with manual_preempt
                found_preempt = False
                for _ in range(10):
                    msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=2))
                    if msg.get("event") == "policy.status":
                        if msg.get("data", {}).get("reason") == "manual_preempt":
                            found_preempt = True
                            break
                    if msg.get("type") == "response":
                        break

                self.assertTrue(found_preempt)

        finally:
            server_task.cancel()
            try:
                await server_task
            except asyncio.CancelledError:
                pass

    async def test_policy_tick_clamping(self) -> None:
        port = 19204
        server_task = await self._start_server(port)
        try:
            async with connect(f"ws://127.0.0.1:{port}") as ws:
                await asyncio.wait_for(ws.recv(), timeout=2)  # hello

                # Start policy
                await ws.send(_cmd("policy.start", {"task": "test"}))
                resp = json.loads(await asyncio.wait_for(ws.recv(), timeout=2))
                while resp.get("type") != "response":
                    resp = json.loads(await asyncio.wait_for(ws.recv(), timeout=2))

                # Send out-of-bounds tick
                await ws.send(_cmd("policy.tick", {
                    "action": {"walk_x": 1.0, "walk_y": -1.0, "walk_yaw": 100.0},
                }))
                resp = json.loads(await asyncio.wait_for(ws.recv(), timeout=2))
                while resp.get("type") != "response":
                    resp = json.loads(await asyncio.wait_for(ws.recv(), timeout=2))
                self.assertTrue(resp["ok"])
                # Values should be clamped
                clamped = resp["data"]["clamped"]
                self.assertAlmostEqual(clamped["walk_x"], 0.05)
                self.assertAlmostEqual(clamped["walk_y"], -0.05)
                self.assertAlmostEqual(clamped["walk_yaw"], 10.0)

        finally:
            server_task.cancel()
            try:
                await server_task
            except asyncio.CancelledError:
                pass


if __name__ == "__main__":
    unittest.main()
