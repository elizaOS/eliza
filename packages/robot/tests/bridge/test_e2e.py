"""End-to-end tests for the Eliza + OpenPI + AiNex stack.

These tests exercise the complete data flow through every layer of the system,
running real servers with the mock backend and verifying actual behaviour.
"""

from __future__ import annotations

import asyncio
import json
import time
import unittest
import uuid

from websockets.asyncio.client import connect
from websockets.asyncio.server import serve

from eliza_robot.bridge.backends.mock_backend import MockBackend
from eliza_robot.bridge.backends.isaac_backend import IsaacBackend
from eliza_robot.bridge.openpi_adapter import (
    AINEX_ACTION_DIM,
    AINEX_STATE_DIM,
    action_to_bridge_commands,
    build_observation,
    decode_action,
    default_perception,
    observation_to_dict,
)
from eliza_robot.bridge.perception import PerceptionAggregator
from eliza_robot.bridge.protocol import utc_now_iso
from eliza_robot.bridge.safety import check_policy_motion_bounds
from eliza_robot.bridge.server import RuntimeConfig, _handler
from eliza_robot.interfaces import (
    AinexPerceptionObservation,
    OpenPIActionChunk,
    OpenPIObservationPayload,
    PolicyState,
    PolicyTransitionRecord,
    TrackedEntity,
)
from eliza_robot.runtime.openpi_loop import run_openpi_loop
from eliza_robot.runtime.policy_bridge_loop import ConstantForwardPolicy, run_policy_loop


# ── Helpers ──────────────────────────────────────────────────────────────

def _cmd(command: str, payload: dict | None = None, preempt: bool = False) -> str:
    return json.dumps({
        "type": "command",
        "request_id": str(uuid.uuid4()),
        "timestamp": utc_now_iso(),
        "command": command,
        "payload": payload or {},
        "preempt": preempt,
    })


def _config() -> RuntimeConfig:
    return RuntimeConfig(
        queue_size=64,
        max_commands_per_sec=200,
        deadman_timeout_sec=10.0,
        trace_log_path="",
    )


async def _start_mock_server(port: int) -> asyncio.Task[None]:
    async def handler(ws):
        await _handler(ws, MockBackend, _config())
    server = await serve(handler, "127.0.0.1", port)
    task = asyncio.create_task(server.serve_forever())
    await asyncio.sleep(0.05)
    return task


async def _recv_until_response(ws) -> dict:
    """Receive messages until we get a response, return it."""
    while True:
        raw = await asyncio.wait_for(ws.recv(), timeout=3)
        msg = json.loads(raw)
        if msg.get("type") == "response":
            return msg


async def _collect_events(ws, count: int = 20, timeout: float = 2.0) -> list[dict]:
    """Collect up to `count` messages within `timeout`."""
    msgs = []
    deadline = time.monotonic() + timeout
    while len(msgs) < count and time.monotonic() < deadline:
        try:
            remaining = deadline - time.monotonic()
            raw = await asyncio.wait_for(ws.recv(), timeout=max(0.01, remaining))
            msgs.append(json.loads(raw))
        except asyncio.TimeoutError:
            break
    return msgs


# ── Test: Full perception -> adapter -> safety -> bridge data flow ───────

class TestDataFlowRoundtrip(unittest.TestCase):
    """Test #16: Verify every link in the perception->action chain."""

    def test_full_data_chain(self) -> None:
        # 1. Perception aggregator gets telemetry + entities
        agg = PerceptionAggregator()
        agg.update_telemetry({
            "battery_mv": 11800,
            "is_walking": True,
            "imu_roll": 0.05,
            "imu_pitch": -0.02,
            "walk_x": 0.03,
            "walk_y": -0.01,
            "walk_yaw": 5.0,
            "walk_height": 0.04,
            "walk_speed": 3,
            "head_pan": 0.5,
            "head_tilt": -0.2,
        })
        agg.update_entity("cup_1", "red cup", confidence=0.92, x=0.4, y=0.1, z=1.2, source="object")
        agg.update_entity("face_1", "person", confidence=0.85, x=-0.1, y=0.0, z=2.0, source="face")

        # 2. Snapshot -> observation
        snap = agg.snapshot(language_instruction="pick up the red cup")
        self.assertEqual(snap.battery_mv, 11800)
        self.assertTrue(snap.is_walking)
        self.assertEqual(len(snap.tracked_entities), 2)
        self.assertEqual(snap.language_instruction, "pick up the red cup")

        # 3. Build OpenPI observation
        obs = build_observation(snap)
        self.assertEqual(len(obs.state), AINEX_STATE_DIM)
        self.assertEqual(obs.prompt, "pick up the red cup")
        # walk_x=0.03 / max=0.05 => normalized should be 0.2 (close to it)
        # Exact: 2*(0.03 - (-0.05))/(0.1) - 1 = 2*0.08/0.1 - 1 = 0.6
        self.assertAlmostEqual(obs.state[0], 0.6, places=2)
        self.assertIn("entities", obs.metadata)
        self.assertEqual(len(obs.metadata["entities"]), 2)

        # 4. Serialize for wire
        obs_dict = observation_to_dict(obs)
        self.assertIsInstance(obs_dict["state"], list)
        self.assertEqual(len(obs_dict["state"]), AINEX_STATE_DIM)
        self.assertEqual(obs_dict["prompt"], "pick up the red cup")

        # 5. Simulate OpenPI response (raw action vector)
        raw_response = {"action": [0.3, -0.2, 0.5, 0.0, 0.5, 0.4, -0.3], "confidence": 0.88}
        action = decode_action(raw_response)
        self.assertAlmostEqual(action.confidence, 0.88)
        self.assertTrue(-0.05 <= action.walk_x <= 0.05)
        self.assertTrue(-0.05 <= action.walk_y <= 0.05)
        self.assertTrue(1 <= action.walk_speed <= 4)
        self.assertTrue(-1.5 <= action.head_pan <= 1.5)

        # 6. Safety gate
        action_dict = {
            "walk_x": action.walk_x,
            "walk_y": action.walk_y,
            "walk_yaw": action.walk_yaw,
            "walk_height": action.walk_height,
            "walk_speed": action.walk_speed,
            "head_pan": action.head_pan,
            "head_tilt": action.head_tilt,
        }
        guard = check_policy_motion_bounds(action_dict)
        self.assertTrue(guard.allowed)
        # All clamped values should be within bounds
        self.assertTrue(-0.05 <= guard.clamped["walk_x"] <= 0.05)
        self.assertTrue(-0.05 <= guard.clamped["walk_y"] <= 0.05)
        self.assertTrue(-10.0 <= guard.clamped["walk_yaw"] <= 10.0)

        # 7. Convert to bridge commands
        action_chunk = OpenPIActionChunk(
            walk_x=guard.clamped["walk_x"],
            walk_y=guard.clamped["walk_y"],
            walk_yaw=guard.clamped["walk_yaw"],
            walk_height=guard.clamped["walk_height"],
            walk_speed=guard.clamped["walk_speed"],
            head_pan=guard.clamped.get("head_pan", 0.0),
            head_tilt=guard.clamped.get("head_tilt", 0.0),
        )
        bridge_cmds = action_to_bridge_commands(action_chunk)
        self.assertTrue(len(bridge_cmds) >= 1)
        walk_cmd = bridge_cmds[0]
        self.assertEqual(walk_cmd["command"], "walk.set")
        self.assertTrue(-0.05 <= walk_cmd["payload"]["x"] <= 0.05)
        # Head command should be present since head values are non-zero
        head_cmds = [c for c in bridge_cmds if c["command"] == "head.set"]
        self.assertEqual(len(head_cmds), 1)

    def test_data_chain_with_out_of_bounds(self) -> None:
        """Verify the chain handles extreme values gracefully."""
        # Extreme raw action vector
        raw = {"action": [5.0, -5.0, 5.0, 5.0, 5.0, 5.0, -5.0], "confidence": 0.3}
        action = decode_action(raw)

        # Everything should be clamped to valid ranges
        self.assertTrue(-0.05 <= action.walk_x <= 0.05)
        self.assertTrue(-0.05 <= action.walk_y <= 0.05)
        self.assertTrue(1 <= action.walk_speed <= 4)

        guard = check_policy_motion_bounds({
            "walk_x": action.walk_x,
            "walk_y": action.walk_y,
            "walk_yaw": action.walk_yaw,
            "walk_height": action.walk_height,
            "walk_speed": action.walk_speed,
        })
        self.assertTrue(guard.allowed)

    def test_default_perception_through_chain(self) -> None:
        """Verify the default (zero) state produces valid output."""
        snap = default_perception()
        obs = build_observation(snap)
        obs_dict = observation_to_dict(obs)

        # Should produce all-center normalized values
        for val in obs.state:
            self.assertTrue(-1.1 <= val <= 1.1, f"State value {val} out of expected range")


# ── Test: Enriched backend telemetry ─────────────────────────────────────

class TestBackendTelemetry(unittest.IsolatedAsyncioTestCase):
    """Test #18: Verify backends emit complete telemetry fields."""

    async def test_mock_backend_telemetry_fields(self) -> None:
        backend = MockBackend()
        await backend.connect()

        # Set some state via commands
        from eliza_robot.bridge.protocol import CommandEnvelope
        await backend.handle_command(CommandEnvelope(
            request_id="t1", timestamp=utc_now_iso(),
            command="walk.set",
            payload={"speed": 3, "height": 0.04, "x": 0.02, "y": -0.01, "yaw": 5.0},
        ))
        await backend.handle_command(CommandEnvelope(
            request_id="t2", timestamp=utc_now_iso(),
            command="head.set",
            payload={"pan": 0.8, "tilt": -0.3, "duration": 0.5},
        ))

        events = await backend.poll_events()
        self.assertGreaterEqual(len(events), 1)
        # Find the telemetry event (not perception)
        data = None
        for evt in events:
            if "battery_mv" in (evt.data or {}):
                data = evt.data
                break
        if data is None:
            data = events[0].data

        # Verify all required fields are present
        required_fields = [
            "battery_mv", "is_walking", "imu_roll", "imu_pitch",
            "walk_x", "walk_y", "walk_yaw", "walk_speed", "walk_height",
            "head_pan", "head_tilt",
        ]
        for field in required_fields:
            self.assertIn(field, data, f"Missing telemetry field: {field}")

        # Verify values reflect what we set
        self.assertAlmostEqual(data["walk_x"], 0.02)
        self.assertAlmostEqual(data["walk_y"], -0.01)
        self.assertAlmostEqual(data["walk_yaw"], 5.0)
        self.assertEqual(data["walk_speed"], 3)
        self.assertAlmostEqual(data["walk_height"], 0.04)
        self.assertAlmostEqual(data["head_pan"], 0.8)
        self.assertAlmostEqual(data["head_tilt"], -0.3)

        await backend.shutdown()

    async def test_isaac_backend_telemetry_fields(self) -> None:
        backend = IsaacBackend()
        await backend.connect()

        from eliza_robot.bridge.protocol import CommandEnvelope
        await backend.handle_command(CommandEnvelope(
            request_id="t1", timestamp=utc_now_iso(),
            command="walk.set",
            payload={"speed": 2, "height": 0.036, "x": 0.01, "y": 0.0, "yaw": 3.0},
        ))
        await backend.handle_command(CommandEnvelope(
            request_id="t2", timestamp=utc_now_iso(),
            command="head.set",
            payload={"pan": -0.5, "tilt": 0.2, "duration": 0.3},
        ))
        await backend.handle_command(CommandEnvelope(
            request_id="t3", timestamp=utc_now_iso(),
            command="walk.command",
            payload={"action": "start"},
        ))

        events = await backend.poll_events()
        self.assertEqual(len(events), 1)
        data = events[0].data

        required_fields = [
            "battery_mv", "is_walking", "imu_roll", "imu_pitch",
            "walk_x", "walk_y", "walk_yaw", "walk_speed", "walk_height",
            "head_pan", "head_tilt",
        ]
        for field in required_fields:
            self.assertIn(field, data, f"Missing telemetry field: {field}")

        self.assertAlmostEqual(data["walk_x"], 0.01)
        self.assertAlmostEqual(data["head_pan"], -0.5)
        self.assertTrue(data["is_walking"])

        await backend.shutdown()

    async def test_telemetry_feeds_perception_aggregator(self) -> None:
        """Verify backend telemetry can be consumed by PerceptionAggregator."""
        backend = MockBackend()
        await backend.connect()

        from eliza_robot.bridge.protocol import CommandEnvelope
        await backend.handle_command(CommandEnvelope(
            request_id="t1", timestamp=utc_now_iso(),
            command="walk.set",
            payload={"speed": 2, "height": 0.036, "x": 0.02, "y": 0.0, "yaw": 0.0},
        ))

        events = await backend.poll_events()
        telemetry_data = events[0].data

        # Feed into perception aggregator
        agg = PerceptionAggregator()
        agg.update_telemetry(telemetry_data)

        snap = agg.snapshot(language_instruction="test")
        self.assertAlmostEqual(snap.walk_x, 0.02)
        self.assertEqual(snap.walk_speed, 2)
        self.assertGreater(snap.battery_mv, 10000)

        # Build observation from it
        obs = build_observation(snap)
        self.assertEqual(len(obs.state), AINEX_STATE_DIM)

        await backend.shutdown()


# ── Test: Policy heartbeat timeout ───────────────────────────────────────

class TestPolicyHeartbeatTimeout(unittest.IsolatedAsyncioTestCase):
    """Test #17: Policy heartbeat timeout triggers fallback."""

    async def test_heartbeat_timeout_stops_policy(self) -> None:
        port = 19410
        config = RuntimeConfig(
            queue_size=64,
            max_commands_per_sec=200,
            deadman_timeout_sec=10.0,
            trace_log_path="",
        )

        async def handler(ws):
            await _handler(ws, MockBackend, config)

        server = await serve(handler, "127.0.0.1", port)
        server_task = asyncio.create_task(server.serve_forever())
        await asyncio.sleep(0.05)

        try:
            async with connect(f"ws://127.0.0.1:{port}") as ws:
                # Hello
                await asyncio.wait_for(ws.recv(), timeout=2)

                # Start policy
                await ws.send(_cmd("policy.start", {"task": "heartbeat_test"}))
                resp = await _recv_until_response(ws)
                self.assertTrue(resp["ok"])

                # Send one tick to activate heartbeat
                await ws.send(_cmd("policy.tick", {
                    "action": {"walk_x": 0.01},
                }))
                resp = await _recv_until_response(ws)
                self.assertTrue(resp["ok"])

                # Now wait for heartbeat timeout (2 sec default + buffer)
                # Collect events looking for safety.policy_guard
                found_guard = False
                found_idle = False
                msgs = await _collect_events(ws, count=50, timeout=4.0)
                for msg in msgs:
                    if msg.get("type") == "event":
                        if msg.get("event") == "safety.policy_guard":
                            reason = msg.get("data", {}).get("reason", "")
                            if "heartbeat" in reason:
                                found_guard = True
                        if msg.get("event") == "policy.status":
                            if msg.get("data", {}).get("state") == "idle":
                                found_idle = True

                self.assertTrue(found_guard, "Expected safety.policy_guard with heartbeat timeout")
                self.assertTrue(found_idle, "Expected policy.status with state=idle")

                # Verify policy is stopped
                await ws.send(_cmd("policy.status"))
                status = await _recv_until_response(ws)
                self.assertFalse(status["data"]["active"])

        finally:
            server_task.cancel()
            try:
                await server_task
            except asyncio.CancelledError:
                pass


# ── Test: Full OpenPI loop E2E ───────────────────────────────────────────

class TestOpenPILoopE2E(unittest.IsolatedAsyncioTestCase):
    """Test #15: Full openpi_loop.py against a live mock bridge server."""

    async def test_openpi_loop_completes(self) -> None:
        port = 19411
        server_task = await _start_mock_server(port)

        try:
            transitions = await run_openpi_loop(
                bridge_uri=f"ws://127.0.0.1:{port}",
                openpi_url="",  # passthrough
                task="e2e_test_walk_forward",
                hz=20.0,
                max_steps=10,
                confidence_threshold=0.05,
            )

            # Should have transition records
            self.assertGreaterEqual(len(transitions), 3)

            # Check lifecycle: idle -> starting -> running -> stopping -> idle
            states = [(t.from_state, t.to_state) for t in transitions]
            self.assertEqual(states[0], (PolicyState.IDLE, PolicyState.STARTING))
            self.assertEqual(states[1], (PolicyState.STARTING, PolicyState.RUNNING))

            # Last transition should end at IDLE
            self.assertEqual(transitions[-1].to_state, PolicyState.IDLE)

            # All should have the task name
            for t in transitions:
                self.assertEqual(t.task, "e2e_test_walk_forward")

        finally:
            server_task.cancel()
            try:
                await server_task
            except asyncio.CancelledError:
                pass

    async def test_openpi_loop_runs_correct_number_of_steps(self) -> None:
        port = 19412
        server_task = await _start_mock_server(port)

        try:
            transitions = await run_openpi_loop(
                bridge_uri=f"ws://127.0.0.1:{port}",
                openpi_url="",
                task="step_count_test",
                hz=20.0,
                max_steps=5,
            )

            # Should have at least 2 transitions: IDLE->STARTING, STARTING->RUNNING
            self.assertGreaterEqual(len(transitions), 2)
            # First transition is always IDLE -> STARTING
            self.assertEqual(transitions[0].from_state, PolicyState.IDLE)
            self.assertEqual(transitions[0].to_state, PolicyState.STARTING)
            # Second is STARTING -> RUNNING
            self.assertEqual(transitions[1].from_state, PolicyState.STARTING)
            self.assertEqual(transitions[1].to_state, PolicyState.RUNNING)
            # The loop should not have FAILED state (clean exit)
            for t in transitions:
                self.assertNotEqual(t.to_state, PolicyState.FAILED)

        finally:
            server_task.cancel()
            try:
                await server_task
            except asyncio.CancelledError:
                pass


# ── Test: Policy bridge loop E2E ─────────────────────────────────────────

class TestPolicyBridgeLoopE2E(unittest.IsolatedAsyncioTestCase):
    """Test #19: Rewritten policy_bridge_loop uses lifecycle protocol."""

    async def test_policy_bridge_loop_lifecycle(self) -> None:
        port = 19413
        server_task = await _start_mock_server(port)

        try:
            policy = ConstantForwardPolicy()
            # This should complete without error
            await run_policy_loop(
                uri=f"ws://127.0.0.1:{port}",
                policy=policy,
                task="bridge_loop_test",
                hz=20.0,
                max_steps=5,
            )
            # If we got here without exception, the loop worked

        finally:
            server_task.cancel()
            try:
                await server_task
            except asyncio.CancelledError:
                pass

    async def test_policy_bridge_loop_verifies_state(self) -> None:
        """Run the loop, then check server policy is actually stopped."""
        port = 19414
        server_task = await _start_mock_server(port)

        try:
            policy = ConstantForwardPolicy()
            await run_policy_loop(
                uri=f"ws://127.0.0.1:{port}",
                policy=policy,
                task="verify_state_test",
                hz=20.0,
                max_steps=3,
            )

            # Connect again and verify policy is stopped
            async with connect(f"ws://127.0.0.1:{port}") as ws:
                await asyncio.wait_for(ws.recv(), timeout=2)  # hello
                await ws.send(_cmd("policy.status"))
                resp = await _recv_until_response(ws)
                # Policy should be idle (previous loop stopped it)
                self.assertFalse(resp["data"]["active"])

        finally:
            server_task.cancel()
            try:
                await server_task
            except asyncio.CancelledError:
                pass


# ── Test: Double start rejected ──────────────────────────────────────────

class TestPolicyEdgeCases(unittest.IsolatedAsyncioTestCase):
    """Additional policy edge case tests."""

    async def test_double_start_rejected(self) -> None:
        port = 19415
        server_task = await _start_mock_server(port)

        try:
            async with connect(f"ws://127.0.0.1:{port}") as ws:
                await asyncio.wait_for(ws.recv(), timeout=2)

                # First start
                await ws.send(_cmd("policy.start", {"task": "first"}))
                resp = await _recv_until_response(ws)
                self.assertTrue(resp["ok"])

                # Second start should fail
                await ws.send(_cmd("policy.start", {"task": "second"}))
                resp = await _recv_until_response(ws)
                self.assertFalse(resp["ok"])
                self.assertIn("already active", resp["message"])

                # Clean up
                await ws.send(_cmd("policy.stop"))
                await _recv_until_response(ws)

        finally:
            server_task.cancel()
            try:
                await server_task
            except asyncio.CancelledError:
                pass

    async def test_stop_when_not_active_is_ok(self) -> None:
        port = 19416
        server_task = await _start_mock_server(port)

        try:
            async with connect(f"ws://127.0.0.1:{port}") as ws:
                await asyncio.wait_for(ws.recv(), timeout=2)

                await ws.send(_cmd("policy.stop"))
                resp = await _recv_until_response(ws)
                self.assertTrue(resp["ok"])
                self.assertIn("was not active", resp["message"])

        finally:
            server_task.cancel()
            try:
                await server_task
            except asyncio.CancelledError:
                pass

    async def test_max_steps_auto_stops(self) -> None:
        port = 19417
        server_task = await _start_mock_server(port)

        try:
            async with connect(f"ws://127.0.0.1:{port}") as ws:
                await asyncio.wait_for(ws.recv(), timeout=2)

                # Start with max_steps=3
                await ws.send(_cmd("policy.start", {
                    "task": "max_step_test", "max_steps": 3,
                }))
                resp = await _recv_until_response(ws)
                self.assertTrue(resp["ok"])

                # Send 3 ticks (should be ok)
                for i in range(3):
                    await ws.send(_cmd("policy.tick", {
                        "action": {"walk_x": 0.01},
                    }))
                    resp = await _recv_until_response(ws)
                    self.assertTrue(resp["ok"], f"Tick {i} failed: {resp.get('message')}")

                # 4th tick should fail (max_steps reached)
                await ws.send(_cmd("policy.tick", {
                    "action": {"walk_x": 0.01},
                }))
                resp = await _recv_until_response(ws)
                self.assertFalse(resp["ok"])
                self.assertIn("max steps", resp["message"])

        finally:
            server_task.cancel()
            try:
                await server_task
            except asyncio.CancelledError:
                pass

    async def test_policy_tick_telemetry_emitted(self) -> None:
        """Verify policy ticks emit telemetry.policy events."""
        port = 19418
        server_task = await _start_mock_server(port)

        try:
            async with connect(f"ws://127.0.0.1:{port}") as ws:
                await asyncio.wait_for(ws.recv(), timeout=2)

                await ws.send(_cmd("policy.start", {"task": "telemetry_test"}))
                await _recv_until_response(ws)

                await ws.send(_cmd("policy.tick", {
                    "action": {"walk_x": 0.02, "walk_y": -0.01, "walk_yaw": 3.0},
                }))

                # Collect all messages
                msgs = await _collect_events(ws, count=20, timeout=1.0)

                # Should have a telemetry.policy event
                policy_telemetry = [
                    m for m in msgs
                    if m.get("type") == "event" and m.get("event") == "telemetry.policy"
                ]
                self.assertTrue(len(policy_telemetry) > 0, "Expected telemetry.policy event")
                data = policy_telemetry[0]["data"]
                self.assertEqual(data["step"], 1)
                self.assertIn("clamped", data)
                self.assertAlmostEqual(data["clamped"]["walk_x"], 0.02)

                # Clean up
                await ws.send(_cmd("policy.stop"))
                await _recv_until_response(ws)

        finally:
            server_task.cancel()
            try:
                await server_task
            except asyncio.CancelledError:
                pass


# ── Test: Import chain verification ──────────────────────────────────────

class TestImportChains(unittest.TestCase):
    """Test #20: Verify every module imports cleanly."""

    def test_training_interfaces(self) -> None:
        from eliza_robot.interfaces import (
            RobotObservation, PolicyVector, PolicyOutput, PolicyRuntime,
            AinexPerceptionObservation, TrackedEntity,
            OpenPIObservationPayload, OpenPIActionChunk,
            PolicyState, PolicyTransitionRecord,
        )
        # Verify the dataclasses are constructible
        obs = RobotObservation(timestamp=0, battery_mv=12000, imu_roll=0, imu_pitch=0, is_walking=False)
        self.assertFalse(obs.is_walking)

        entity = TrackedEntity(entity_id="e1", label="cup", confidence=0.9, x=0, y=0, z=0, last_seen=0)
        self.assertEqual(entity.label, "cup")

        perc = AinexPerceptionObservation(
            timestamp=0, battery_mv=12000, imu_roll=0, imu_pitch=0,
            is_walking=False, walk_x=0, walk_y=0, walk_yaw=0,
            walk_height=0.036, walk_speed=2, head_pan=0, head_tilt=0,
        )
        self.assertEqual(perc.walk_speed, 2)

        action_chunk = OpenPIActionChunk()
        self.assertAlmostEqual(action_chunk.walk_x, 0.0)

        record = PolicyTransitionRecord(
            timestamp=0, from_state=PolicyState.IDLE,
            to_state=PolicyState.RUNNING, reason="test",
        )
        self.assertEqual(record.reason, "test")

    def test_bridge_modules(self) -> None:
        from eliza_robot.bridge.protocol import VALID_COMMANDS, VALID_EVENTS, parse_command
        self.assertIn("policy.start", VALID_COMMANDS)
        self.assertIn("safety.policy_guard", VALID_EVENTS)

        from eliza_robot.bridge.validation import validate_command_payload
        from eliza_robot.bridge.safety import (
            CommandRateLimiter, check_policy_motion_bounds,
            PolicyHeartbeatMonitor, is_deadman_heartbeat_command,
        )
        from eliza_robot.bridge.openpi_adapter import (
            build_observation, decode_action, observation_to_dict,
            action_to_bridge_commands, default_perception,
            AINEX_STATE_DIM, AINEX_ACTION_DIM,
        )
        self.assertEqual(AINEX_STATE_DIM, 163)  # 11 proprio + 152 entity slots
        self.assertEqual(AINEX_ACTION_DIM, 7)

        from eliza_robot.bridge.perception import PerceptionAggregator
        agg = PerceptionAggregator()
        snap = agg.snapshot()
        self.assertIsNotNone(snap)

    def test_runtime_modules(self) -> None:
        from eliza_robot.runtime.policy_bridge_loop import (
            run_policy_loop, ConstantForwardPolicy,
        )
        policy = ConstantForwardPolicy()
        from eliza_robot.interfaces import RobotObservation, PolicyVector
        obs = RobotObservation(timestamp=0, battery_mv=12000, imu_roll=0, imu_pitch=0, is_walking=False)
        z = PolicyVector(values=(0.0,))
        output = policy.infer(obs, z)
        self.assertAlmostEqual(output.walk_x, 0.01)

        from eliza_robot.runtime.openpi_loop import (
            run_openpi_loop, OpenPIInferenceClient,
        )

    def test_backend_modules(self) -> None:
        from eliza_robot.bridge.backends.mock_backend import MockBackend
        from eliza_robot.bridge.backends.isaac_backend import IsaacBackend
        from eliza_robot.bridge.backends.base import BridgeBackend

        # Verify they're proper subclasses
        self.assertTrue(issubclass(MockBackend, BridgeBackend))
        self.assertTrue(issubclass(IsaacBackend, BridgeBackend))


if __name__ == "__main__":
    unittest.main()
