"""Execution-based tests for the bridge policy pipeline."""

from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from eliza_robot.datasets.build_from_trace import build_dataset
from eliza_robot.eval_bridge_policy import evaluate_bridge_policy
from eliza_robot.serve_policy import PolicyServer
from eliza_robot.train_bridge_policy import train_bridge_policy


class BridgePolicyPipelineTests(unittest.TestCase):
    def test_bridge_policy_pipeline_end_to_end(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            input_trace = tmp_path / "input_trace.jsonl"
            dataset_path = tmp_path / "dataset.jsonl"
            checkpoint_path = tmp_path / "bridge_policy.pt"
            eval_dir = tmp_path / "eval"

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

            count = build_dataset(input_trace, dataset_path)
            self.assertEqual(count, 1)

            metrics = train_bridge_policy(dataset_path, checkpoint_path, epochs=50, batch_size=1)
            self.assertGreaterEqual(metrics["examples"], 1.0)
            self.assertTrue(checkpoint_path.exists())

            eval_metrics = evaluate_bridge_policy(checkpoint_path, dataset_path, eval_dir)
            self.assertTrue((eval_dir / "metrics.json").exists())
            self.assertTrue((eval_dir / "prediction_plot.png").exists())
            self.assertGreaterEqual(eval_metrics["num_examples"], 1.0)

            server = PolicyServer(str(checkpoint_path))
            server.load()
            result = server.infer({"state": [0.0] * 163, "prompt": "walk forward"})
            self.assertEqual(len(result["action"]), 7)
            self.assertEqual(result["schema_version"], "ainex-canonical-v1")


if __name__ == "__main__":
    unittest.main()
