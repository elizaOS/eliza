#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_REPORT = ROOT / "docs/evidence/linux/linux-external-bsp-status.json"
CHECKER_PATH = ROOT / "scripts/check_linux_external_bsp.py"


def load_checker():
    spec = importlib.util.spec_from_file_location(
        "check_linux_external_bsp_under_test", CHECKER_PATH
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class LinuxExternalBspReportTests(unittest.TestCase):
    def test_custom_report_path_keeps_tracked_evidence_unchanged(self) -> None:
        before = DEFAULT_REPORT.read_bytes()
        with tempfile.TemporaryDirectory() as tmp:
            report = Path(tmp) / "linux-external-bsp-status.json"
            completed = subprocess.run(
                [
                    sys.executable,
                    "scripts/check_linux_external_bsp.py",
                    str(Path(tmp) / "missing-linux"),
                    "--report",
                    str(report),
                ],
                cwd=ROOT,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                check=False,
            )

            self.assertEqual(completed.returncode, 0, completed.stdout)
            self.assertIn("STATUS: BLOCKED linux.external_bsp_status", completed.stdout)
            self.assertTrue(report.is_file())
            self.assertEqual(DEFAULT_REPORT.read_bytes(), before)

            payload = json.loads(report.read_text(encoding="utf-8"))
            self.assertEqual(payload["schema"], "eliza.linux_external_bsp_status.v1")
            self.assertIn("generated_utc", payload)
            self.assertEqual(payload["status"], "blocked")
            encoded = json.dumps(payload, sort_keys=True)
            self.assertNotIn(str(ROOT), encoded)
            self.assertNotIn("/tmp/", encoded)
            self.assertNotIn("/var/tmp/", encoded)

    def test_provenance_safe_value_sanitizes_host_local_paths(self) -> None:
        checker = load_checker()
        raw = {
            "tree": str(ROOT / "external/linux"),
            "commands": [f"run {ROOT / 'external/linux'} /tmp/e1-mmio-smoke"],
            "scratch": "/var/tmp/evidence",
        }

        sanitized = checker.provenance_safe_value(raw)
        encoded = json.dumps(sanitized, sort_keys=True)

        self.assertNotIn(str(ROOT), encoded)
        self.assertNotIn("/tmp/", encoded)
        self.assertNotIn("/var/tmp/", encoded)
        self.assertIn("<repo>/external/linux", encoded)
        self.assertIn("<tmp>/e1-mmio-smoke", encoded)
        self.assertIn("<var-tmp>/evidence", encoded)


if __name__ == "__main__":
    unittest.main()
