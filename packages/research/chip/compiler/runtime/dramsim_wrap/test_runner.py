"""Unit tests for the DRAMSim3 / Ramulator2 wrapper.

These tests confirm both the fail-closed behaviour the wrapper guarantees
when no backend is installed and the trace-generator + parser contract
that the in-repo DRAMSim3 build exercises.

The end-to-end DRAMSim3 run is covered by ``run_dram_sweep`` in
``runner.py``; reports under ``build/reports/memory/`` are the human-
inspectable artifacts.
"""

from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from .runner import (
    SKUS,
    _p95_latency_ns,
    _parse_dramsim3_stats,
    available_backends,
    run_dram_sweep,
)
from .trace_gen import WORKLOADS, write_trace


class DramSimWrapperFailClosedTests(unittest.TestCase):
    """Wrapper must fail closed when no backend is available."""

    def setUp(self) -> None:
        self.tmpdir = Path(tempfile.mkdtemp())
        self.cfg = SKUS["lpddr5x_10667"]

    def tearDown(self) -> None:
        for path in self.tmpdir.rglob("*"):
            if path.is_file():
                path.unlink()
        for path in sorted(self.tmpdir.rglob("*"), reverse=True):
            if path.is_dir():
                path.rmdir()
        self.tmpdir.rmdir()

    def test_no_backend_writes_blocked_json_and_empty_list(self) -> None:
        with (
            mock.patch.object(shutil, "which", return_value=None),
            mock.patch(
                "compiler.runtime.dramsim_wrap.runner._local_dramsim3_binary",
                return_value=None,
            ),
            mock.patch(
                "compiler.runtime.dramsim_wrap.runner.importlib.import_module",
                side_effect=ImportError,
            ),
        ):
            res = run_dram_sweep(self.cfg, ["microbench"], self.tmpdir)
        self.assertEqual(res, [])
        blocked = json.loads((self.tmpdir / "dram_sim_blocked.json").read_text())
        self.assertEqual(blocked["schema"], "eliza.memory.dram_sim_blocked.v1")
        self.assertEqual(blocked["status"], "blocked_no_simulator_backend")
        self.assertIn("dramsim3", blocked["unblock_commands"])

    def test_available_backends_returns_list(self) -> None:
        result = available_backends()
        self.assertIsInstance(result, list)
        for entry in result:
            self.assertIn(entry, ("dramsim3", "ramulator2"))


class DramSimParserTests(unittest.TestCase):
    """Synthetic stats payload exercises the per-channel parser."""

    def _stats_payload(self) -> dict:
        return {
            "0": {
                "num_reads_done": 200,
                "num_writes_done": 100,
                "num_cycles": 1000,
                "average_read_latency": 50.0,
                "read_latency": {str(c): 1 for c in range(40, 240)},
            },
            "1": {
                "num_reads_done": 200,
                "num_writes_done": 100,
                "num_cycles": 1000,
                "average_read_latency": 50.0,
                "read_latency": {str(c): 1 for c in range(40, 240)},
            },
        }

    def test_parser_returns_expected_units(self) -> None:
        cfg = SKUS["lpddr5x_10667"]
        tmp = Path(tempfile.mkdtemp())
        try:
            stats = tmp / "dramsim3.json"
            stats.write_text(json.dumps(self._stats_payload()))
            result = _parse_dramsim3_stats(stats, cfg)
            # 400 reads * 32 B / (1000 cycles * 0.1875 ns) = 68.27 GB/s
            # 200 writes * 32 B / (1000 cycles * 0.1875 ns) = 34.13 GB/s
            self.assertAlmostEqual(result["read_gbps"], 68.2667, places=2)
            self.assertAlmostEqual(result["write_gbps"], 34.1333, places=2)
            self.assertAlmostEqual(result["total_gbps"], 102.4, places=2)
            # p95 of two summed uniform 40..239 histograms (400 reads total)
            # lands at the 380th read = cycle 229.
            self.assertAlmostEqual(result["p95_latency_ns"], 229 * cfg.tck_ns, places=3)
        finally:
            for f in tmp.iterdir():
                f.unlink()
            tmp.rmdir()

    def test_p95_returns_zero_for_empty_histogram(self) -> None:
        self.assertEqual(_p95_latency_ns({}, SKUS["lpddr5x_10667"]), 0.0)


class TraceGeneratorTests(unittest.TestCase):
    """Trace generator must emit DRAMSim3-parseable records."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self) -> None:
        for path in self.tmp.rglob("*"):
            if path.is_file():
                path.unlink()
        self.tmp.rmdir()

    def test_known_workloads_all_emit_traces(self) -> None:
        for name in WORKLOADS:
            path = self.tmp / f"{name}.trc"
            count = write_trace(name, 16 * 1024 * 1024, path)
            self.assertGreater(count, 0, f"workload {name} emitted no transactions")
            first = path.read_text().splitlines()[0].split()
            self.assertEqual(len(first), 3, f"{name} trace not 3-column")
            int(first[0], 16)
            self.assertIn(first[1], ("READ", "WRITE"))
            int(first[2])

    def test_unknown_workload_raises(self) -> None:
        with self.assertRaises(ValueError):
            write_trace("not_a_workload", 4096, self.tmp / "x.trc")


class DramConfigTests(unittest.TestCase):
    def test_tck_ns_matches_data_rate(self) -> None:
        cfg = SKUS["lpddr5x_10667"]
        self.assertAlmostEqual(cfg.tck_ns, 0.1875, places=3)

    def test_peak_bandwidth_matches_jedec(self) -> None:
        self.assertAlmostEqual(SKUS["lpddr5x_10667"].peak_bandwidth_gbps, 85.336, places=2)
        self.assertAlmostEqual(SKUS["lpddr6_14400"].peak_bandwidth_gbps, 172.8, places=2)

    def test_dramsim3_ini_path_resolves(self) -> None:
        for cfg in SKUS.values():
            ini = cfg.dramsim3_config_path
            self.assertTrue(ini.is_file(), f"DRAMSim3 ini missing: {ini}")


if __name__ == "__main__":
    unittest.main()
