#!/usr/bin/env python3
"""Unit tests for ``scripts/check_pd_utilization.py``.

Exercises the threshold loader, run-dir discovery, JSON parser, regex
parser, and CLI overrides. Uses Hypothesis to fuzz observed utilization
against the threshold so every monotone branch is covered.
"""

from __future__ import annotations

import contextlib
import importlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

check_pd_utilization = importlib.import_module("check_pd_utilization")

try:
    from hypothesis import given, settings
    from hypothesis import strategies as st

    HYPOTHESIS_AVAILABLE = True
except ImportError:  # pragma: no cover
    HYPOTHESIS_AVAILABLE = False


def write_threshold(root: Path, max_util: float = 1.05) -> Path:
    p = root / "pd/signoff/util_threshold.yaml"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(
        yaml.safe_dump(
            {
                "schema": "eliza.pd_utilization_threshold.v1",
                "max_utilization": max_util,
                "overrides": [{"design": "e1_chip_top", "max_utilization": max_util}],
                "report_keys": [
                    "utilization_fraction",
                    "utilization",
                    "core_utilization",
                    "placement_utilization",
                ],
                "report_regex": r"(?P<key>core_utilization|utilization|placement_utilization|utilization_fraction)\s*[:=]\s*(?P<value>[0-9]+\.?[0-9]*)",
            },
            sort_keys=True,
        ),
        encoding="utf-8",
    )
    return p


@contextlib.contextmanager
def patched_root(extra_files: dict[str, str] | None = None, max_util: float = 1.05):
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        threshold = write_threshold(root, max_util=max_util)
        run_dir_root = root / "pd/openlane/runs"
        run_dir_root.mkdir(parents=True, exist_ok=True)
        for rel, content in (extra_files or {}).items():
            p = root / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content, encoding="utf-8")
        with (
            mock.patch.object(check_pd_utilization, "ROOT", root),
            mock.patch.object(check_pd_utilization, "THRESHOLD_FILE", threshold),
            mock.patch.object(check_pd_utilization, "DEFAULT_RUN_DIR", run_dir_root),
        ):
            yield root


def run_main(argv: list[str] | None = None) -> tuple[int, str, str]:
    argv_full = ["check_pd_utilization.py"] + (argv or [])
    stdout = io.StringIO()
    stderr = io.StringIO()
    code = 0
    with (
        mock.patch.object(sys, "argv", argv_full),
        contextlib.redirect_stdout(stdout),
        contextlib.redirect_stderr(stderr),
    ):
        try:
            code = check_pd_utilization.main()
        except SystemExit as exc:
            if isinstance(exc.code, int):
                code = exc.code
            else:
                # SystemExit("string") prints the string to stderr and exits 1
                stderr.write(str(exc.code) + "\n")
                code = 1
    return code, stdout.getvalue(), stderr.getvalue()


class TestPdUtilization(unittest.TestCase):
    def test_missing_threshold_file_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with (
                mock.patch.object(check_pd_utilization, "ROOT", root),
                mock.patch.object(check_pd_utilization, "THRESHOLD_FILE", root / "missing.yaml"),
                mock.patch.object(check_pd_utilization, "DEFAULT_RUN_DIR", root / "runs"),
            ):
                code, _out, err = run_main(["--utilization", "0.5"])
        self.assertNotEqual(code, 0)
        self.assertIn("util_threshold.yaml missing", err)

    def test_threshold_yaml_must_be_mapping(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            threshold = root / "pd/signoff/util_threshold.yaml"
            threshold.parent.mkdir(parents=True, exist_ok=True)
            threshold.write_text("- not\n- a\n- mapping\n", encoding="utf-8")
            with (
                mock.patch.object(check_pd_utilization, "ROOT", root),
                mock.patch.object(check_pd_utilization, "THRESHOLD_FILE", threshold),
                mock.patch.object(check_pd_utilization, "DEFAULT_RUN_DIR", root / "runs"),
            ):
                code, _out, err = run_main(["--utilization", "0.5"])
        self.assertNotEqual(code, 0)
        self.assertIn("util_threshold.yaml malformed", err)

    def test_missing_max_utilization_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            threshold = root / "pd/signoff/util_threshold.yaml"
            threshold.parent.mkdir(parents=True, exist_ok=True)
            threshold.write_text(yaml.safe_dump({"overrides": []}), encoding="utf-8")
            with (
                mock.patch.object(check_pd_utilization, "ROOT", root),
                mock.patch.object(check_pd_utilization, "THRESHOLD_FILE", threshold),
                mock.patch.object(check_pd_utilization, "DEFAULT_RUN_DIR", root / "runs"),
            ):
                code, _out, err = run_main(["--utilization", "0.5"])
        self.assertNotEqual(code, 0)
        self.assertIn("max_utilization", err)

    def test_utilization_below_threshold_passes(self) -> None:
        with patched_root():
            code, out, _err = run_main(["--utilization", "0.265"])
        self.assertEqual(code, 0)
        self.assertIn("pd-util-check passed", out)
        self.assertIn("0.2650", out)

    def test_utilization_at_threshold_passes(self) -> None:
        with patched_root():
            code, out, _err = run_main(["--utilization", "1.05"])
        self.assertEqual(code, 0)
        self.assertIn("pd-util-check passed", out)

    def test_utilization_above_threshold_fails(self) -> None:
        with patched_root():
            code, _out, err = run_main(["--utilization", "1.06"])
        self.assertNotEqual(code, 0)
        self.assertIn("pd-util-check observed=1.0600", err)
        self.assertIn("threshold=1.0500", err)

    def test_historical_incident_fails_closed(self) -> None:
        # The 2026-05-17 Sky130 / PDK mismatch reported 771.788% utilization.
        # The gate must always refuse that.
        with patched_root():
            code, _out, err = run_main(["--utilization", "7.71788"])
        self.assertNotEqual(code, 0)
        self.assertIn("771.788", err)

    def test_threshold_override_via_cli(self) -> None:
        with patched_root():
            code, _out, _err = run_main(["--utilization", "1.20", "--threshold", "1.50"])
        self.assertEqual(code, 0)

    def test_blocked_when_no_run_dir(self) -> None:
        with patched_root():
            code, out, _err = run_main([])
        # When no run dir is present we get BLOCKED, but the gate must not
        # claim PASS — return code is 0 (informational), with status in stdout.
        self.assertEqual(code, 0)
        self.assertIn("BLOCKED", out)

    def test_blocked_when_run_dir_has_no_util_key(self) -> None:
        with patched_root() as root:
            run = root / "pd/openlane/runs/RUN_synthetic"
            run.mkdir(parents=True, exist_ok=True)
            (run / "summary.json").write_text(json.dumps({"other_key": 0.5}), encoding="utf-8")
            code, out, _err = run_main([])
        self.assertEqual(code, 0)
        self.assertIn("BLOCKED", out)
        self.assertIn("no utilization key found", out)

    def test_parses_utilization_from_json_report(self) -> None:
        with patched_root() as root:
            run = root / "pd/openlane/runs/RUN_synthetic"
            run.mkdir(parents=True, exist_ok=True)
            (run / "report.json").write_text(
                json.dumps({"utilization_fraction": 0.27}),
                encoding="utf-8",
            )
            code, out, _err = run_main([])
        self.assertEqual(code, 0)
        self.assertIn("pd-util-check passed observed=0.2700", out)

    def test_parses_utilization_from_text_report(self) -> None:
        with patched_root() as root:
            run = root / "pd/openlane/runs/RUN_synthetic"
            run.mkdir(parents=True, exist_ok=True)
            (run / "summary.rpt").write_text("core_utilization: 0.42\n", encoding="utf-8")
            code, out, _err = run_main([])
        self.assertEqual(code, 0)
        self.assertIn("0.4200", out)

    def test_design_override_picks_per_design_max(self) -> None:
        with patched_root(max_util=2.00) as root:
            # design=e1_chip_top override exists in default threshold helper at 2.00
            (Path(root) / "pd/signoff/util_threshold.yaml").write_text(
                yaml.safe_dump(
                    {
                        "max_utilization": 1.05,
                        "overrides": [{"design": "e1_chip_top", "max_utilization": 1.20}],
                    },
                    sort_keys=True,
                ),
                encoding="utf-8",
            )
            code, _out, _err = run_main(["--utilization", "1.15", "--design", "e1_chip_top"])
        self.assertEqual(code, 0)

    if HYPOTHESIS_AVAILABLE:

        @settings(max_examples=80, deadline=None)
        @given(
            util=st.floats(min_value=0.0, max_value=10.0, allow_nan=False, allow_infinity=False),
            thr=st.floats(min_value=0.5, max_value=3.0, allow_nan=False, allow_infinity=False),
        )
        def test_property_monotone(self, util: float, thr: float) -> None:
            with patched_root():
                code, _out, _err = run_main(
                    ["--utilization", f"{util:.6f}", "--threshold", f"{thr:.6f}"]
                )
            expected_pass = util <= thr
            if expected_pass:
                self.assertEqual(code, 0)
            else:
                self.assertNotEqual(code, 0)


if __name__ == "__main__":
    unittest.main()
