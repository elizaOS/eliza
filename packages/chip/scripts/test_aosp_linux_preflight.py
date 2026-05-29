#!/usr/bin/env python3
"""Tests for scripts/check_aosp_linux_preflight.py."""

from __future__ import annotations

import sys
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

import check_aosp_linux_preflight as gate  # noqa: E402


def assert_false_claim_flags(testcase: unittest.TestCase, report: dict[str, object]) -> None:
    testcase.assertEqual(report["claim_boundary"], gate.CLAIM_BOUNDARY)
    for key, expected in gate.FALSE_CLAIM_FLAGS.items():
        testcase.assertIs(report.get(key), expected, key)


class AospLinuxPreflightTests(unittest.TestCase):
    def test_missing_aosp_dir_blocks_without_claims(self) -> None:
        with (
            mock.patch.object(gate, "DEFAULT_AOSP_DIRS", ()),
            mock.patch.dict(gate.os.environ, {}, clear=True),
        ):
            rc, report = gate.build_report(Namespace(aosp_dir="", require_qemu=False))

        self.assertEqual(rc, 2)
        self.assertEqual(report["status"], "blocked")
        assert_false_claim_flags(self, report)
        self.assertIn("AOSP_DIR is not set", report["blockers"])

    def test_ready_host_preflight_still_denies_boot_and_release_claims(self) -> None:
        original_exists = Path.exists

        def fake_exists(path: Path) -> bool:
            if str(path) == "/dev/kvm":
                return True
            return original_exists(path)

        def fake_access(path: object, mode: int) -> bool:
            if str(path) == "/dev/kvm":
                return True
            return True

        with tempfile.TemporaryDirectory() as tmpdir:
            aosp = Path(tmpdir) / "aosp"
            (aosp / "build").mkdir(parents=True)
            (aosp / "device").mkdir()
            (aosp / "build/envsetup.sh").write_text("# envsetup\n", encoding="utf-8")
            with (
                mock.patch.object(gate, "repo_input_state", return_value={"missing": []}),
                mock.patch.object(gate, "command_blocker", return_value=None),
                mock.patch.object(gate, "command_version", return_value="/usr/bin/tool"),
                mock.patch.object(gate, "tool_path", return_value="/usr/bin/tool"),
                mock.patch.object(gate, "aosp_tool", return_value="/usr/bin/cvd"),
                mock.patch.object(gate, "smoke_command_value", return_value="/usr/bin/smoke"),
                mock.patch.object(gate, "group_output", return_value="kvm cvdnetwork"),
                mock.patch.object(Path, "exists", fake_exists),
                mock.patch.object(gate.os, "access", fake_access),
            ):
                rc, report = gate.build_report(
                    Namespace(aosp_dir=str(aosp), require_qemu=False)
                )

        self.assertEqual(rc, 0)
        self.assertEqual(report["status"], "pass")
        assert_false_claim_flags(self, report)


if __name__ == "__main__":
    unittest.main()
