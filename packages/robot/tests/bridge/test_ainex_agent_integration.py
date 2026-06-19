"""Integration tests for the Python AiNex Eliza wrapper."""

from __future__ import annotations

import asyncio
from pathlib import Path
import sys
import unittest

import pytest
from websockets.asyncio.server import serve

from eliza_robot.bridge.server import RuntimeConfig, _handler


ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "eliza/packages/python"))
sys.path.insert(0, str(ROOT / "ainex-robot-code/eliza/packages/python"))

# Cross-package integration test: the AiNex plugin lives in a separate
# workspace package not installed in the robot venv. Skip cleanly when absent.
pytest.importorskip("elizaos_plugin_ainex")

from elizaos_plugin_ainex.agent import AiNexRobotAgent  # noqa: E402


class AiNexAgentIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def _start_bridge(self, port: int) -> asyncio.Task[None]:
        config = RuntimeConfig(
            queue_size=64,
            max_commands_per_sec=100,
            deadman_timeout_sec=5.0,
            trace_log_path="",
        )

        async def handler(ws):
            from eliza_robot.bridge.backends.mock_backend import MockBackend

            await _handler(ws, MockBackend, config)

        server = await serve(handler, "127.0.0.1", port)
        task = asyncio.create_task(server.serve_forever())
        await asyncio.sleep(0.1)
        return task

    async def test_agent_fallback_walk_command(self) -> None:
        port = 19610
        bridge_task = await self._start_bridge(port)

        try:
            agent = AiNexRobotAgent(
                bridge_url=f"ws://127.0.0.1:{port}",
                verbose=False,
            )
            await agent.initialize()
            try:
                result = await agent.send_message("Walk forward slowly")
                self.assertTrue(result["did_respond"])
                self.assertIn("WALK_SET", result["actions"])
                self.assertIn("WALK_COMMAND", result["actions"])
            finally:
                await agent.cleanup()
        finally:
            bridge_task.cancel()
            try:
                await bridge_task
            except asyncio.CancelledError:
                pass

    async def test_agent_fallback_wave_command(self) -> None:
        port = 19612
        bridge_task = await self._start_bridge(port)

        try:
            agent = AiNexRobotAgent(
                bridge_url=f"ws://127.0.0.1:{port}",
                verbose=False,
            )
            await agent.initialize()
            try:
                result = await agent.send_message("wave hello")
                self.assertTrue(result["did_respond"])
                self.assertIn("ACTION_PLAY", result["actions"])
            finally:
                await agent.cleanup()
        finally:
            bridge_task.cancel()
            try:
                await bridge_task
            except asyncio.CancelledError:
                pass

    async def test_managed_execution_service_completes_for_near_target(self) -> None:
        port = 19611
        bridge_task = await self._start_bridge(port)

        try:
            agent = AiNexRobotAgent(
                bridge_url=f"ws://127.0.0.1:{port}",
                verbose=False,
            )
            await agent.initialize()
            try:
                runtime = agent._runtime
                execution_service = runtime.get_service("ainex_execution")
                self.assertIsNotNone(execution_service)

                perception = getattr(runtime, "_ainex_perception", None)
                self.assertIsNotNone(perception)
                perception.update_entity(
                    "red-ball-01",
                    "red ball",
                    confidence=0.99,
                    x=0.0,
                    y=0.0,
                    z=0.4,
                )

                started = await execution_service.start_execution(
                    task="walk to the red ball and emote",
                    trace_id="trace-service-1",
                    planner_step_id="planner-step-1",
                    canonical_action="NAVIGATE_TO_ENTITY",
                    target_entity_id="red-ball-01",
                    target_label="red ball",
                    emote_name="wave",
                    max_steps=10,
                )
                self.assertTrue(started)

                for _ in range(120):
                    status = execution_service.get_status()
                    if status.state in {"completed", "failed", "stopped"}:
                        break
                    await asyncio.sleep(0.05)

                status = execution_service.get_status()
                self.assertEqual(status.state, "completed")
                self.assertTrue(status.success)
                self.assertEqual(status.trace_id, "trace-service-1")
                self.assertEqual(status.planner_step_id, "planner-step-1")
                self.assertEqual(status.target_entity_id, "red-ball-01")
                self.assertEqual(status.emote_name, "wave")

                result = execution_service.get_last_result()
                self.assertTrue(result.success)
                self.assertEqual(result.planner.trace_id, "trace-service-1")
                self.assertEqual(result.planner.planner_step_id, "planner-step-1")
            finally:
                await agent.cleanup()
        finally:
            bridge_task.cancel()
            try:
                await bridge_task
            except asyncio.CancelledError:
                pass


if __name__ == "__main__":
    unittest.main()
