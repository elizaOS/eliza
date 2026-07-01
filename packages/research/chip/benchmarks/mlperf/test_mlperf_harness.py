#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from benchmarks.mlperf.loadgen import LoadGenConfig, Scenario, run_loadgen  # noqa: E402
from benchmarks.mlperf.model import build_dataset, macs_per_inference  # noqa: E402
from benchmarks.mlperf.run_e1_npu_mlperf import build_report  # noqa: E402
from benchmarks.mlperf.run_e1_npu_mlperf import main as run_main  # noqa: E402
from benchmarks.mlperf.sut import E1NpuSut  # noqa: E402


class MlperfHarnessTests(unittest.TestCase):
    def test_single_stream_uses_one_query_at_a_time_and_npu_counters(self) -> None:
        dataset = build_dataset(5)
        sut = E1NpuSut(dataset)
        result = run_loadgen(sut, LoadGenConfig(Scenario.SINGLE_STREAM, len(dataset)))

        self.assertEqual(len(result.responses), len(dataset))
        self.assertEqual(len(result.latencies_ns), len(dataset))
        self.assertIn("p90", result.latency_percentiles_ns)
        self.assertEqual(sut.counters.inferences, len(dataset))
        self.assertEqual(sut.counters.npu_commands, len(dataset) * 2)
        self.assertEqual(sut.counters.npu_macs, len(dataset) * macs_per_inference())
        self.assertTrue(
            all(
                response.prediction == dataset[response.index].label
                for response in result.responses
            )
        )

    def test_offline_reports_throughput_and_accuracy(self) -> None:
        report = build_report([Scenario.SINGLE_STREAM, Scenario.OFFLINE], 8)
        self.assertEqual(report["status"], "pass")
        scenarios = {item["scenario"]: item for item in report["scenarios"]}
        self.assertEqual(set(scenarios), {"SingleStream", "Offline"})
        self.assertEqual(scenarios["SingleStream"]["accuracy"]["top1_accuracy"], 1.0)
        self.assertEqual(scenarios["Offline"]["accuracy"]["top1_accuracy"], 1.0)
        self.assertIn("latency_percentiles_ns", scenarios["SingleStream"])
        self.assertIn("throughput_samples_per_second", scenarios["Offline"])
        self.assertIn("official MLCommons C++ LoadGen", report["fidelity"]["not_implemented"])
        self.assertIn("Linux /dev/e1-npu target execution", report["fidelity"]["not_implemented"])

    def test_runner_writes_report(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "report.json"
            self.assertEqual(run_main(["--samples", "4", "--out", str(out)]), 0)
            report = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual(report["schema"], "eliza.e1_npu_mlperf_modeled.v1")
            self.assertEqual(report["status"], "pass")
            self.assertEqual(report["dataset"]["count"], 4)


if __name__ == "__main__":
    unittest.main()
