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


def assert_false_claim_flags(testcase: unittest.TestCase, report: dict[str, object]) -> None:
    testcase.assertEqual(report["claim_boundary"], inv.CLAIM_BOUNDARY)
    for key, expected in inv.FALSE_CLAIM_FLAGS.items():
        testcase.assertIs(report.get(key), expected, key)


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
        assert_false_claim_flags(self, report)
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
        assert_false_claim_flags(self, report)
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

    def test_nested_capture_diagnostics_are_classified(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            capture = repo / "packages/chip/scripts/ai_eda/capture_runtime_readiness.py"
            capture.parent.mkdir(parents=True)
            capture.write_text(
                'blockers.append("runtime claims remain blocked until replay evidence exists")\n'
                'evidence["note"] = "placeholder rows do not count as signoff"\n',
                encoding="utf-8",
            )

            with mock.patch.object(inv, "REPO", repo):
                report = inv.build_report(["packages/chip/scripts"])

        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["summary"]["findings"], 0)

    def test_classified_blocker_inventory_docs_are_not_source_gaps(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            blocker_doc = repo / "packages/chip/docs/project/critical-gap-review.md"
            blocker_doc.parent.mkdir(parents=True)
            blocker_doc.write_text(
                "# Critical gap review\n\n"
                "- blocked until live boot evidence exists\n"
                "- placeholder evidence remains prohibited\n",
                encoding="utf-8",
            )
            source_doc = repo / "packages/chip/docs/arch/boot.md"
            source_doc.parent.mkdir(parents=True)
            source_doc.write_text("Boot placeholder text that must be resolved.\n", encoding="utf-8")

            with mock.patch.object(inv, "REPO", repo):
                report = inv.build_report(["packages/chip/docs"])

        self.assertEqual(report["status"], "blocked")
        self.assertEqual(report["summary"]["findings"], 1)
        self.assertEqual(report["findings"][0]["path"], "packages/chip/docs/arch/boot.md")

    def test_generated_traceability_outputs_are_not_scanned_as_source(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            graph = repo / "packages/chip/docs/spec-db/traceability/graph.json"
            graph.parent.mkdir(parents=True)
            graph.write_text('{"dst": "gate:stub-audit"}\n', encoding="utf-8")

            with mock.patch.object(inv, "REPO", repo):
                report = inv.build_report(["packages/chip/docs"])

        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["summary"]["findings"], 0)

    def test_os_and_bsp_checker_diagnostics_are_classified(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            bsp_checker = repo / "packages/chip/sw/check_bsp_scaffolds.py"
            bsp_checker.parent.mkdir(parents=True)
            bsp_checker.write_text(
                'errors.append("external evidence remains BLOCKED")\n'
                'print("opensbi BSP scaffold check passed")\n',
                encoding="utf-8",
            )
            os_checker = repo / "packages/os/linux/elizaos/scripts/check_release_manifest.py"
            os_checker.parent.mkdir(parents=True)
            os_checker.write_text(
                '"""BLOCKED means a manifest artifact is not yet on disk."""\n'
                'TEMPLATE_STRING_PLACEHOLDERS = {"@@PROFILE@@": "template"}\n'
                'for placeholder, replacement in TEMPLATE_STRING_PLACEHOLDERS.items():\n'
                '    text = text.replace(placeholder, replacement)\n'
                'errors.append("payload contains placeholder")\n'
                'raise SystemExit("agent evidence remains blocked")\n',
                encoding="utf-8",
            )

            with mock.patch.object(inv, "REPO", repo):
                report = inv.build_report(
                    ["packages/chip/sw", "packages/os/linux/elizaos/scripts"]
                )

        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["summary"]["findings"], 0)

    def test_shell_runner_negative_path_diagnostics_are_classified(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            runner = repo / "packages/chip/scripts/run_chipyard_eliza_linux_smoke.sh"
            runner.parent.mkdir(parents=True)
            runner.write_text(
                "#!/usr/bin/env sh\n"
                "case \"$CHIPYARD_LINUX_SMOKE_RUN_TARGET\" in\n"
                "  run-binary-fast) ;;\n"
                "  *) printf '  - unsupported CHIPYARD_LINUX_SMOKE_RUN_TARGET: %s\\n' \"$CHIPYARD_LINUX_SMOKE_RUN_TARGET\" ; exit 2 ;;\n"
                "esac\n",
                encoding="utf-8",
            )

            with mock.patch.object(inv, "REPO", repo):
                report = inv.build_report(["packages/chip/scripts"])

        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["summary"]["findings"], 0)

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
