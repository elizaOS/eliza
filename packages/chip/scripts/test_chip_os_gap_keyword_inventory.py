#!/usr/bin/env python3
"""Tests for scripts/check_chip_os_gap_keyword_inventory.py."""

from __future__ import annotations

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from typing import Any, cast
from unittest import mock

import check_chip_os_gap_keyword_inventory as inv


def assert_false_claim_flags(testcase: unittest.TestCase, report: dict[str, object]) -> None:
    testcase.assertEqual(report["claim_boundary"], inv.CLAIM_BOUNDARY)
    for key, expected in inv.FALSE_CLAIM_FLAGS.items():
        testcase.assertIs(report.get(key), expected, key)


def assert_actionable_findings(testcase: unittest.TestCase, report: dict[str, object]) -> None:
    findings = report.get("findings")
    testcase.assertIsInstance(findings, list)
    for finding in cast(list[dict[str, Any]], findings):
        testcase.assertIsInstance(finding, dict)
        testcase.assertIsInstance(finding.get("next_command"), str)
        testcase.assertTrue(finding["next_command"])
        testcase.assertIsInstance(finding.get("next_commands"), list)
        testcase.assertIn(finding["next_command"], finding["next_commands"])
    summary = report.get("summary")
    testcase.assertIsInstance(summary, dict)
    summary = cast(dict[str, Any], summary)
    next_command_plan = cast(list[dict[str, Any]], report.get("next_command_plan", []))
    testcase.assertGreaterEqual(summary.get("next_command_batch_count", 0), 1)
    testcase.assertEqual(
        summary.get("next_command_batch_count"),
        len(next_command_plan),
    )
    for batch in next_command_plan:
        testcase.assertIsInstance(batch.get("commands"), list)
        testcase.assertTrue(batch["commands"])
        testcase.assertEqual(
            batch.get("claim_boundary"),
            "operator_cleanup_commands_only_not_boot_or_runtime_evidence",
        )


class ChipOsGapKeywordInventoryTests(unittest.TestCase):
    def test_scans_source_markers_and_excludes_generated_paths(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            source = repo / "packages/chip/sw/boot.sh"
            source.parent.mkdir(parents=True)
            source.write_text(
                f"# {inv.OPEN_TASK_MARKER} wire real boot\n"
                "raise NotImplementedError\n"
                "echo STATUS_LATER_AGENT_BINARY\n",
                encoding="utf-8",
            )
            generated = repo / "packages/app/android/app/src/main/assets/agent-bundle.js"
            generated.parent.mkdir(parents=True)
            generated.write_text(
                f"{inv.OPEN_TASK_MARKER} generated bundle placeholder\n", encoding="utf-8"
            )

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
        assert_actionable_findings(self, report)
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
        self.assertTrue(all("+1 " in finding["next_command"] for finding in report["findings"][:1]))

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

    def test_npu_and_benchmark_markers_route_to_specific_gates(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            npu_doc = repo / "packages/chip/docs/npu/runtime.md"
            npu_doc.parent.mkdir(parents=True)
            npu_doc.write_text(
                f"NPU {inv.OPEN_TASK_MARKER} capture accelerator evidence.\n",
                encoding="utf-8",
            )
            bench = repo / "packages/chip/sw/benchmarks/runner.sh"
            bench.parent.mkdir(parents=True)
            bench.write_text("echo placeholder benchmark path\n", encoding="utf-8")

            with mock.patch.object(inv, "REPO", repo):
                report = inv.build_report(["packages/chip/docs", "packages/chip/sw"])

        self.assertEqual(report["status"], "blocked")
        self.assertEqual(report["summary"]["findings"], 2)
        assert_actionable_findings(self, report)
        by_path = {finding["path"]: finding for finding in report["findings"]}
        self.assertIn(
            "python3 packages/chip/scripts/check_npu_scope.py",
            by_path["packages/chip/docs/npu/runtime.md"]["next_commands"],
        )
        self.assertIn(
            "python3 packages/chip/scripts/check_benchmark_efficiency_scope.py",
            by_path["packages/chip/sw/benchmarks/runner.sh"]["next_commands"],
        )

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
                'vi.mock("@capacitor/app", () => ({}));\nconst placeholder = true;\n',
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

    def test_checker_diagnostics_are_classified_but_regular_markers_still_block(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            checker = repo / "packages/chip/scripts/check_runtime_gate.py"
            checker.parent.mkdir(parents=True)
            checker.write_text(
                'raise SystemExit("runtime must remain blocked until evidence exists")\n'
                'errors.append("placeholder evidence is rejected")\n'
                'if "TB' + 'D" in payload:\n'
                '    blockers.append("release blocker remains classified")\n'
                f"# {inv.OPEN_TASK_MARKER} remove this real checker maintenance gap\n",
                encoding="utf-8",
            )

            with mock.patch.object(inv, "REPO", repo):
                report = inv.build_report(["packages/chip/scripts"])

        self.assertEqual(report["status"], "blocked")
        self.assertEqual(report["summary"]["findings"], 1)
        self.assertEqual(report["findings"][0]["marker"], inv.OPEN_TASK_MARKER)

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
            source_doc.write_text(
                "Boot placeholder text that must be resolved.\n", encoding="utf-8"
            )

            with mock.patch.object(inv, "REPO", repo):
                report = inv.build_report(["packages/chip/docs"])

        self.assertEqual(report["status"], "blocked")
        self.assertEqual(report["summary"]["findings"], 1)
        self.assertEqual(report["findings"][0]["path"], "packages/chip/docs/arch/boot.md")

    def test_project_planning_and_open_task_audits_are_not_source_gaps(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            roadmap = repo / "packages/chip/docs/project/road-to-mediatek.md"
            roadmap.parent.mkdir(parents=True)
            roadmap.write_text(
                "# Roadmap\n\n"
                "Current scaffold remains blocked until AP and benchmark evidence lands.\n",
                encoding="utf-8",
            )
            task_audit = repo / "packages/chip/docs/project/android-on-simulated-chip-task-audit.md"
            task_audit.write_text(
                f"# {inv.OPEN_TASK_MARKER} audit\n\n"
                f"| {inv.OPEN_TASK_MARKER} | placeholder evidence remains blocked |\n",
                encoding="utf-8",
            )
            source_doc = repo / "packages/chip/docs/arch/npu.md"
            source_doc.parent.mkdir(parents=True, exist_ok=True)
            source_doc.write_text(
                "NPU placeholder text that still needs resolution.\n", encoding="utf-8"
            )

            with mock.patch.object(inv, "REPO", repo):
                report = inv.build_report(["packages/chip/docs"])

        self.assertEqual(report["status"], "blocked")
        self.assertEqual(report["summary"]["findings"], 1)
        self.assertEqual(report["findings"][0]["path"], "packages/chip/docs/arch/npu.md")

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

    def test_evidence_manifests_and_pb_placeholder_fields_are_classified(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            manifest = repo / "packages/chip/docs/android/bsp-log-evidence-manifest.json"
            manifest.parent.mkdir(parents=True)
            manifest.write_text(
                json.dumps(
                    {
                        "claim_boundary": "expected future log markers only",
                        "forbidden_strings": ["placeholder transcript", "placeholder evidence"],
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            converter = repo / "packages/chip/scripts/alphachip/convert_lefdef_to_pb.sh"
            converter.parent.mkdir(parents=True)
            converter.write_text(
                'sed -e \'s/placeholder: "macro"/placeholder: "MACRO"/g\'\n',
                encoding="utf-8",
            )

            with mock.patch.object(inv, "REPO", repo):
                report = inv.build_report(["packages/chip/docs", "packages/chip/scripts"])

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
                "for placeholder, replacement in TEMPLATE_STRING_PLACEHOLDERS.items():\n"
                "    text = text.replace(placeholder, replacement)\n"
                'errors.append("payload contains placeholder")\n'
                'raise SystemExit("agent evidence remains blocked")\n',
                encoding="utf-8",
            )

            with mock.patch.object(inv, "REPO", repo):
                report = inv.build_report(["packages/chip/sw", "packages/os/linux/elizaos/scripts"])

        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["summary"]["findings"], 0)

    def test_shell_runner_negative_path_diagnostics_are_classified(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            runner = repo / "packages/chip/scripts/run_chipyard_eliza_linux_smoke.sh"
            runner.parent.mkdir(parents=True)
            runner.write_text(
                "#!/usr/bin/env sh\n"
                'case "$CHIPYARD_LINUX_SMOKE_RUN_TARGET" in\n'
                "  run-binary-fast) ;;\n"
                "  *) printf '  - unsupported CHIPYARD_LINUX_SMOKE_RUN_TARGET: %s\\n' \"$CHIPYARD_LINUX_SMOKE_RUN_TARGET\" ; exit 2 ;;\n"
                "esac\n",
                encoding="utf-8",
            )

            with mock.patch.object(inv, "REPO", repo):
                report = inv.build_report(["packages/chip/scripts"])

        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["summary"]["findings"], 0)

    def test_generator_template_vocabulary_is_classified_but_markers_still_block(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            generator = repo / "packages/chip/scripts/generate_e1_phone_demo.py"
            generator.parent.mkdir(parents=True)
            generator.write_text(
                '"""Generate non-release placeholder artifacts."""\n'
                'line = "NON-RELEASE placeholder footprint generated from template"\n'
                'note = "Replace E1Phone placeholder footprints with supplier land patterns"\n'
                'status = "release remains blocked until external review"\n'
                'state = "not yet modeled as a final phone antenna system"\n'
                "# Placeholder footprints are emitted for generated demo artifacts.\n"
                f"# {inv.OPEN_TASK_MARKER} remove this real generator maintenance gap\n",
                encoding="utf-8",
            )

            with mock.patch.object(inv, "REPO", repo):
                report = inv.build_report(["packages/chip/scripts"])

        self.assertEqual(report["status"], "blocked")
        self.assertEqual(report["summary"]["findings"], 1)
        self.assertEqual(report["findings"][0]["marker"], inv.OPEN_TASK_MARKER)

    def test_dossier_audit_docs_are_not_source_gaps(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            dossier = repo / "packages/chip/docs/E1_SOTA_TAPEOUT_DOSSIER.md"
            dossier.parent.mkdir(parents=True)
            dossier.write_text(
                "The repository is a scaffold and some evidence remains blocked.\n",
                encoding="utf-8",
            )
            source_doc = repo / "packages/chip/docs/arch/boot.md"
            source_doc.parent.mkdir(parents=True)
            source_doc.write_text(
                "Boot placeholder text that must be resolved.\n", encoding="utf-8"
            )

            with mock.patch.object(inv, "REPO", repo):
                report = inv.build_report(["packages/chip/docs"])

        self.assertEqual(report["status"], "blocked")
        self.assertEqual(report["summary"]["findings"], 1)
        self.assertEqual(report["findings"][0]["path"], "packages/chip/docs/arch/boot.md")

    def test_plan_and_survey_docs_are_not_source_gaps(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            tee_plan = repo / "packages/chip/docs/security/tee-plan/05-cpu-memory-performance.md"
            tee_plan.parent.mkdir(parents=True)
            tee_plan.write_text(
                "This experiment plan says vector arithmetic remains BLOCKED.\n"
                "Pythia is a BLOCKED stub until a named gate lands.\n",
                encoding="utf-8",
            )
            sota_report = (
                repo / "packages/chip/docs/architecture-optimization/sota-2028/cache-report.md"
            )
            sota_report.parent.mkdir(parents=True)
            sota_report.write_text(
                "The survey notes a placeholder configuration remains blocked.\n",
                encoding="utf-8",
            )
            competitor = repo / "packages/chip/docs/spec-db/competitor-2028-target.yaml"
            competitor.parent.mkdir(parents=True)
            competitor.write_text("status: blocked until vendor data exists\n")
            source_doc = repo / "packages/chip/docs/arch/boot.md"
            source_doc.parent.mkdir(parents=True)
            source_doc.write_text(
                "Boot placeholder text that must be resolved.\n", encoding="utf-8"
            )

            with mock.patch.object(inv, "REPO", repo):
                report = inv.build_report(["packages/chip/docs"])

        self.assertEqual(report["status"], "blocked")
        self.assertEqual(report["summary"]["findings"], 1)
        self.assertEqual(report["findings"][0]["path"], "packages/chip/docs/arch/boot.md")

    def test_operator_docs_classify_fail_closed_scaffold_policy(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            operator_doc = repo / "packages/chip/docs/android/riscv-bringup.md"
            operator_doc.parent.mkdir(parents=True)
            operator_doc.write_text(
                "Current status is fail-closed scaffold only.\n"
                "No stub may fake hardware success.\n"
                "Runtime shims return unsupported when the device node is absent.\n",
                encoding="utf-8",
            )
            arch_doc = repo / "packages/chip/docs/arch/npu.md"
            arch_doc.parent.mkdir(parents=True)
            arch_doc.write_text(
                "NPU placeholder text that still needs resolution.\n", encoding="utf-8"
            )

            with mock.patch.object(inv, "REPO", repo):
                report = inv.build_report(["packages/chip/docs"])

        self.assertEqual(report["status"], "blocked")
        self.assertEqual(report["summary"]["findings"], 1)
        self.assertEqual(report["findings"][0]["path"], "packages/chip/docs/arch/npu.md")

    def test_arch_contract_docs_classify_claim_boundary_disclosures(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            contract = repo / "packages/chip/docs/arch/interconnect.md"
            contract.parent.mkdir(parents=True)
            contract.write_text(
                "This is not release evidence for memory-bandwidth claims.\n"
                "AXI4 claims remain blocked until bridge tests exist.\n"
                "No release claim may rely on this scaffold.\n",
                encoding="utf-8",
            )
            memory_map = repo / "packages/chip/docs/arch/memory-map.md"
            memory_map.write_text(
                "The Linux-capable scaffold map is not yet a complete Linux device memory map.\n"
                "NPU control scaffold accesses fail closed.\n",
                encoding="utf-8",
            )
            iommu = repo / "packages/chip/docs/arch/iommu.md"
            iommu.write_text(
                "Sv48 first-stage is not yet locally covered.\n"
                "PASID behavior remains blocked by the evidence gate.\n"
                "The driver must not poll for unsupported bits.\n",
                encoding="utf-8",
            )
            source_doc = repo / "packages/chip/docs/arch/npu.md"
            source_doc.write_text(
                "NPU placeholder text that still needs resolution.\n", encoding="utf-8"
            )

            with mock.patch.object(inv, "REPO", repo):
                report = inv.build_report(["packages/chip/docs/arch"])

        self.assertEqual(report["status"], "blocked")
        self.assertEqual(report["summary"]["findings"], 1)
        self.assertEqual(report["findings"][0]["path"], "packages/chip/docs/arch/npu.md")

    def test_operator_doc_command_examples_are_not_source_gaps(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            contract = repo / "packages/chip/docs/arch/linux-capable-cpu-contract.md"
            contract.parent.mkdir(parents=True)
            contract.write_text(
                "Run the local non-claiming scaffold checks:\n"
                "make chipyard-generator-check cpu-ap-scaffold-check cpu-ap-completion-gate\n"
                "python3 scripts/capture_cpu_ap_evidence.py plan all --format shell\n",
                encoding="utf-8",
            )

            with mock.patch.object(inv, "REPO", repo):
                report = inv.build_report(["packages/chip/docs/arch"])

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
