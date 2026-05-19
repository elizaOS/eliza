"""Unit tests for the DRAMSim3 / Ramulator2 wrapper.

These tests confirm the fail-closed behaviour the wrapper guarantees:

- When neither backend is installed, ``run_dram_sweep`` writes
  ``dram_sim_blocked.json`` and returns an empty list.
- When a backend reports as available but the workload driver is not yet
  wired in, the wrapper writes a per-workload blocked JSON instead of
  fabricating bandwidth numbers.
- The schema string and ``simulator_only`` status are stable.
"""

from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from .runner import DramConfig, available_backends, run_dram_sweep


class DramSimWrapperTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = Path(tempfile.mkdtemp())
        self.cfg = DramConfig(
            standard="LPDDR5X-10667",
            data_rate_mtps=10667,
            bus_width_bits=64,
            channels=4,
            bits_per_channel=16,
            capacity_gib=16,
            config_path=Path(__file__).parent / "configs" / "lpddr5x_10667.ini",
        )

    def tearDown(self) -> None:
        for f in self.tmpdir.iterdir():
            f.unlink()
        self.tmpdir.rmdir()

    def test_no_backend_writes_blocked_json_and_empty_list(self) -> None:
        with (
            mock.patch.object(shutil, "which", return_value=None),
            mock.patch(
                "compiler.runtime.dramsim_wrap.runner.importlib.import_module",
                side_effect=ImportError,
            ),
        ):
            res = run_dram_sweep(self.cfg, ["stream_triad"], self.tmpdir)
        self.assertEqual(res, [])
        blocked = json.loads((self.tmpdir / "dram_sim_blocked.json").read_text())
        self.assertEqual(blocked["schema"], "eliza.memory.dram_sim_blocked.v1")
        self.assertEqual(blocked["status"], "blocked_no_simulator_backend")

    def test_dramsim3_present_but_no_workload_driver_fails_closed(self) -> None:
        # Mock that dramsim3main is on PATH (binary path),
        # then verify the wrapper writes a per-workload blocked JSON.
        def fake_which(name: str) -> str | None:
            if name == "dramsim3main":
                return "/usr/local/bin/dramsim3main"
            return None

        with mock.patch.object(shutil, "which", side_effect=fake_which):
            res = run_dram_sweep(self.cfg, ["stream_triad"], self.tmpdir)
        # No measured result because the workload driver is not implemented.
        self.assertEqual(res, [])
        blocked_path = self.tmpdir / "dram_sim_dramsim3_stream_triad_blocked.json"
        self.assertTrue(blocked_path.is_file())
        blocked = json.loads(blocked_path.read_text())
        self.assertEqual(blocked["schema"], "eliza.memory.dram_sim_blocked.v1")
        self.assertEqual(blocked["status"], "blocked_backend_execution_failure")
        self.assertIn("workload", blocked)

    def test_available_backends_returns_list(self) -> None:
        # Smoke: just confirms the function returns a list, not its
        # contents (which depend on the host).
        result = available_backends()
        self.assertIsInstance(result, list)
        for entry in result:
            self.assertIn(entry, ("dramsim3", "ramulator2"))


if __name__ == "__main__":
    unittest.main()
