#!/usr/bin/env python3
"""Tests for scripts/check_chip_os_gap_keyword_inventory.py."""

from __future__ import annotations

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import check_chip_os_gap_keyword_inventory as inv


class ChipOsGapKeywordInventoryTests(unittest.TestCase):
    def test_scans_source_markers_and_excludes_generated_paths(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            source = repo / "packages/chip/sw/boot.sh"
            source.parent.mkdir(parents=True)
            source.write_text(
                "# TODO wire real boot\n"
                "raise NotImplementedError\n"
                "echo STATUS_LATER_AGENT_BINARY\n",
                encoding="utf-8",
            )
            generated = repo / "packages/app/android/app/src/main/assets/agent-bundle.js"
            generated.parent.mkdir(parents=True)
            generated.write_text("TODO generated bundle placeholder\n", encoding="utf-8")

            with mock.patch.object(inv, "REPO", repo):
                report = inv.build_report(["packages/chip/sw", "packages/app/android"])

        self.assertEqual(report["status"], "blocked")
        self.assertIn("generated_utc", report)
        self.assertEqual(report["summary"]["findings"], 3)
        categories = report["summary"]["categories"]
        self.assertEqual(categories["todo"], 1)
        self.assertEqual(categories["implementation_missing"], 1)
        self.assertEqual(categories["deferred_blocked"], 1)
        self.assertEqual(
            report["scan_root_summary"],
            [
                {
                    "root": "packages/chip/sw",
                    "findings": 3,
                    "paths_with_findings": 1,
                    "categories": {
                        "deferred_blocked": 1,
                        "implementation_missing": 1,
                        "todo": 1,
                    },
                }
            ],
        )
        paths = {finding["path"] for finding in report["findings"]}
        self.assertEqual(paths, {"packages/chip/sw/boot.sh"})

    def test_empty_scan_passes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            source = repo / "packages/chip/sw/boot.sh"
            source.parent.mkdir(parents=True)
            source.write_text("echo ready\n", encoding="utf-8")

            with mock.patch.object(inv, "REPO", repo):
                report = inv.build_report(["packages/chip/sw"])

        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["summary"]["findings"], 0)
        self.assertEqual(report["scan_root_summary"], [])

    def test_binary_payloads_are_not_scanned_as_source(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            binary = repo / "packages/chip/sw/firemarshal/eliza-e1-linux-smoke/e1-npu-ml-smoke"
            binary.parent.mkdir(parents=True)
            binary.write_bytes(b"\x7fELF\x00unsupported workload: %s (expected %s)\x00")

            with mock.patch.object(inv, "REPO", repo):
                report = inv.build_report(["packages/chip/sw"])

        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["summary"]["findings"], 0)

    def test_test_fixtures_and_http_method_rejection_are_not_gaps(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            test_source = repo / "packages/app/src/android-update-checker.test.ts"
            test_source.parent.mkdir(parents=True)
            test_source.write_text(
                'vi.mock("@capacitor/app", () => ({}));\n'
                "const placeholder = true;\n",
                encoding="utf-8",
            )
            cpp_test = repo / "packages/chip/verify/verilator/test_npu_gemm.cpp"
            cpp_test.parent.mkdir(parents=True)
            cpp_test.write_text(
                'printf("unsupported op in negative-path fixture\\n");\n',
                encoding="utf-8",
            )
            service = (
                repo
                / "packages/app/android/app/src/main/java/ai/elizaos/app/ElizaAgentService.java"
            )
            service.parent.mkdir(parents=True)
            service.write_text(
                'throw new IllegalArgumentException("Unsupported HTTP method");\n',
                encoding="utf-8",
            )

            with mock.patch.object(inv, "REPO", repo):
                report = inv.build_report(
                    [
                        "packages/app/src",
                        "packages/app/android/app/src/main",
                        "packages/chip/verify",
                    ]
                )

        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["summary"]["findings"], 0)

    def test_checker_diagnostics_are_classified_but_regular_todos_still_block(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            checker = repo / "packages/chip/scripts/check_runtime_gate.py"
            checker.parent.mkdir(parents=True)
            checker.write_text(
                'raise SystemExit("runtime must remain blocked until evidence exists")\n'
                'errors.append("placeholder evidence is rejected")\n'
                'if "TBD" in payload:\n'
                '    blockers.append("release blocker remains classified")\n'
                "# TODO remove this real checker maintenance gap\n",
                encoding="utf-8",
            )

            with mock.patch.object(inv, "REPO", repo):
                report = inv.build_report(["packages/chip/scripts"])

        self.assertEqual(report["status"], "blocked")
        self.assertEqual(report["summary"]["findings"], 1)
        self.assertEqual(report["findings"][0]["marker"], "TODO")

    def test_default_roots_cover_os_forks_and_launcher_agent_sources(self) -> None:
        expected = {
            "packages/chip/sw",
            "packages/os/linux/elizaos/scripts",
            "packages/os/linux/agent",
            "packages/os/linux/crates/elizad",
            "packages/os/android/vendor/eliza",
            "packages/os/android/scripts",
            "packages/os/android/installer/manifests",
            "packages/os/android/installer/scripts",
            "packages/os/android/system-ui/native",
            "packages/os/android/system-ui/src",
            "packages/app/android/app/src/main",
            "packages/app/src",
            "packages/app/scripts",
        }
        self.assertTrue(expected.issubset(set(inv.DEFAULT_SCAN_ROOTS)))

    def test_json_only_prints_report_without_status_line(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip/sw"
            root.mkdir(parents=True)
            (root / "ready.sh").write_text("echo ready\n", encoding="utf-8")
            output = repo / "report.json"
            stdout = io.StringIO()
            with (
                mock.patch.object(inv, "REPO", repo),
                contextlib.redirect_stdout(stdout),
            ):
                rc = inv.main(
                    ["--root", "packages/chip/sw", "--report", str(output), "--json-only"]
                )
            written = json.loads(output.read_text(encoding="utf-8"))

        self.assertEqual(rc, 0)
        self.assertNotIn("STATUS:", stdout.getvalue())
        data = json.loads(stdout.getvalue())
        self.assertEqual(data["status"], "pass")
        self.assertEqual(written, data)


if __name__ == "__main__":
    unittest.main()
