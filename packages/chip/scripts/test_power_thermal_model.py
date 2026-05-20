#!/usr/bin/env python3
"""Unit tests for ``scripts/power_thermal_model.py``."""

from __future__ import annotations

import contextlib
import importlib
import io
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

power_thermal_model = importlib.import_module("power_thermal_model")

try:
    from hypothesis import given, settings
    from hypothesis import strategies as st

    HYPOTHESIS_AVAILABLE = True
except ImportError:  # pragma: no cover
    HYPOTHESIS_AVAILABLE = False


class TestProject(unittest.TestCase):
    def test_default_projection_loads(self) -> None:
        report = power_thermal_model.project()
        self.assertEqual(report["schema"], "eliza.power_thermal_projection.v1")
        self.assertEqual(report["provenance"], "simulator_or_spec")
        self.assertIn("blocks", report)
        self.assertIn("totals", report)
        self.assertIn("envelope", report)
        self.assertIn("fit", report)
        self.assertIn("release_blocker", report)

    def test_block_rows_are_simulator_or_spec(self) -> None:
        report = power_thermal_model.project()
        for row in report["blocks"]:
            self.assertEqual(row["provenance"], "simulator_or_spec")
            self.assertIn(row["confidence"], {"low", "medium", "high"})
            self.assertGreaterEqual(row["burst_w"], 0)
            self.assertGreaterEqual(row["sustained_w"], 0)
            self.assertLessEqual(row["sustained_w"], row["burst_w"] + 0.01)

    def test_release_blocker_iff_over_envelope(self) -> None:
        report = power_thermal_model.project()
        burst = report["totals"]["burst_w"]
        sustained = report["totals"]["sustained_w"]
        env = report["envelope"]
        actual_over_transient = burst > env["transient_w_high"]
        actual_over_steady = sustained > env["steady_state_w_high"]
        expected_blocker = actual_over_transient or actual_over_steady
        self.assertEqual(bool(report["release_blocker"]), expected_blocker)

    def test_check_exit_code_matches_release_blocker(self) -> None:
        with (
            contextlib.redirect_stdout(io.StringIO()),
            contextlib.redirect_stderr(io.StringIO()),
            unittest_mock_argv(["power_thermal_model.py", "--check"]),
        ):
            code = power_thermal_model.main()
        report = power_thermal_model.project()
        expected = 1 if report["release_blocker"] else 0
        self.assertEqual(code, expected)

    def test_report_writes_valid_json(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            report_path = Path(tmp) / "out.json"
            with (
                contextlib.redirect_stdout(io.StringIO()),
                unittest_mock_argv(
                    ["power_thermal_model.py", "--report", "--report-path", str(report_path)]
                ),
            ):
                code = power_thermal_model.main()
            self.assertEqual(code, 0)
            data = json.loads(report_path.read_text(encoding="utf-8"))
            self.assertEqual(data["schema"], "eliza.power_thermal_projection.v1")
            self.assertEqual(data["claim_boundary"], power_thermal_model.CLAIM_BOUNDARY)


@contextlib.contextmanager
def unittest_mock_argv(argv: list[str]):
    from unittest import mock

    with mock.patch.object(sys, "argv", argv):
        yield


class TestSyntheticInputs(unittest.TestCase):
    def test_synthetic_within_envelope_is_not_blocker(self) -> None:
        blocks = (
            ("a", 1.0, 0.5, "high"),
            ("b", 1.0, 0.5, "high"),
            ("c", 1.0, 0.5, "high"),
        )
        report = power_thermal_model.project(blocks)
        self.assertEqual(report["totals"]["burst_w"], 3.0)
        self.assertEqual(report["totals"]["sustained_w"], 1.5)
        self.assertFalse(report["release_blocker"])

    def test_synthetic_over_transient_is_blocker(self) -> None:
        blocks = (("a", 20.0, 1.0, "low"),)
        report = power_thermal_model.project(blocks)
        self.assertTrue(report["release_blocker"])
        self.assertTrue(report["fit"]["transient_over_envelope"])

    def test_synthetic_over_steady_is_blocker(self) -> None:
        blocks = (("a", 5.0, 20.0, "low"),)
        report = power_thermal_model.project(blocks)
        self.assertTrue(report["release_blocker"])
        self.assertFalse(report["fit"]["steady_state_fit"])

    if HYPOTHESIS_AVAILABLE:

        @settings(max_examples=80, deadline=None)
        @given(
            n_blocks=st.integers(min_value=1, max_value=8),
            block_burst=st.floats(
                min_value=0.0, max_value=5.0, allow_nan=False, allow_infinity=False
            ),
            block_sus=st.floats(
                min_value=0.0, max_value=3.0, allow_nan=False, allow_infinity=False
            ),
        )
        def test_property_totals_match_sum(
            self, n_blocks: int, block_burst: float, block_sus: float
        ) -> None:
            blocks = tuple(
                (f"b{i}", block_burst, min(block_sus, block_burst), "low") for i in range(n_blocks)
            )
            report = power_thermal_model.project(blocks)
            self.assertAlmostEqual(report["totals"]["burst_w"], n_blocks * block_burst, places=2)
            self.assertAlmostEqual(
                report["totals"]["sustained_w"], n_blocks * min(block_sus, block_burst), places=2
            )

        @settings(max_examples=60, deadline=None)
        @given(
            burst=st.floats(min_value=0.0, max_value=20.0, allow_nan=False, allow_infinity=False),
            sustained=st.floats(
                min_value=0.0, max_value=20.0, allow_nan=False, allow_infinity=False
            ),
        )
        def test_property_release_blocker_definition(self, burst: float, sustained: float) -> None:
            blocks = (("a", burst, min(sustained, burst), "low"),)
            report = power_thermal_model.project(blocks)
            env = report["envelope"]
            expected_blocker = (
                burst > env["transient_w_high"]
                or min(sustained, burst) > env["steady_state_w_high"]
            )
            self.assertEqual(bool(report["release_blocker"]), expected_blocker)


if __name__ == "__main__":
    unittest.main()
