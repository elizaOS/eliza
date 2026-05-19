"""End-to-end HTTP inference tests using the real bridge loop."""

from __future__ import annotations

import asyncio
from http.server import HTTPServer
import json
from pathlib import Path
import tempfile
import threading
import unittest

from websockets.asyncio.server import serve

from eliza_robot.bridge.server import RuntimeConfig, _handler
from eliza_robot.runtime.openpi_loop import run_openpi_loop
import eliza_robot.serve_policy as serve_policy_module
from eliza_robot.datasets.build_from_trace import build_dataset
from eliza_robot.train_bridge_policy import train_bridge_policy
from eliza_robot.serve_policy import InferenceHandler, PolicyServer


class OpenPIHttpE2ETests(unittest.IsolatedAsyncioTestCase):
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

    def _start_http_server(self, checkpoint_path: str, port: int) -> tuple[HTTPServer, threading.Thread]:
        serve_policy_module._server_instance = PolicyServer(checkpoint_path)
        serve_policy_module._server_instance.load()
        server = HTTPServer(("127.0.0.1", port), InferenceHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        return server, thread

    async def test_openpi_loop_with_trained_http_policy(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            input_trace = tmp_path / "input_trace.jsonl"
            dataset_path = tmp_path / "dataset.jsonl"
            checkpoint_path = tmp_path / "bridge_policy.pt"
            trace_path = tmp_path / "runtime_trace.jsonl"

            trace_record = {
                "trace_id": "trace-1",
                "step": 0,
                "observation": {
                    "state": [0.0] * 163,
                    "prompt": "walk forward",
                    "schema_version": "ainex-canonical-v1",
                },
                "clamped": {
                    "walk_x": 0.01,
                    "walk_y": 0.0,
                    "walk_yaw": 0.0,
                    "walk_height": 0.0375,
                    "walk_speed": 2,
                    "head_pan": 0.0,
                    "head_tilt": 0.0,
                },
            }
            input_trace.write_text(json.dumps(trace_record) + "\n", encoding="utf-8")
            build_dataset(input_trace, dataset_path)
            train_bridge_policy(dataset_path, checkpoint_path, epochs=50, batch_size=1)

            bridge_port = 19601
            http_port = 19602
            bridge_task = await self._start_bridge(bridge_port)
            http_server, http_thread = self._start_http_server(str(checkpoint_path), http_port)

            try:
                transitions = await run_openpi_loop(
                    bridge_uri=f"ws://127.0.0.1:{bridge_port}",
                    openpi_url=f"http://127.0.0.1:{http_port}",
                    task="walk forward",
                    hz=10.0,
                    max_steps=3,
                    trace_path=str(trace_path),
                    trace_id="http-e2e",
                )
                self.assertGreaterEqual(len(transitions), 3)
                self.assertTrue(trace_path.exists())
                lines = trace_path.read_text(encoding="utf-8").strip().splitlines()
                self.assertEqual(len(lines), 3)
            finally:
                bridge_task.cancel()
                try:
                    await bridge_task
                except asyncio.CancelledError:
                    pass
                http_server.shutdown()
                http_server.server_close()
                http_thread.join(timeout=2.0)


if __name__ == "__main__":
    unittest.main()
