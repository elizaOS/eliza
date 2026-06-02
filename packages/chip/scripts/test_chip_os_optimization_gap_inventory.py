#!/usr/bin/env python3
"""Tests for scripts/check_chip_os_optimization_gap_inventory.py."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import check_chip_os_optimization_gap_inventory as opt


def assert_false_claim_flags(testcase: unittest.TestCase, report: dict[str, object]) -> None:
    testcase.assertEqual(report["claim_boundary"], opt.CLAIM_BOUNDARY)
    for key, expected in opt.FALSE_CLAIM_FLAGS.items():
        testcase.assertIs(report.get(key), expected, key)


class ChipOsOptimizationGapInventoryTests(unittest.TestCase):
    def test_build_report_denies_runtime_performance_and_release_claims(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            artifact = repo / "packages/chip/build/reports/demo.json"
            artifact.parent.mkdir(parents=True)
            artifact.write_text(
                json.dumps(
                    {
                        "status": "pass",
                        "claim_boundary": "chip emulator runtime benchmark evidence",
                        "ready_for_runtime_claim": True,
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            spec = opt.ArtifactSpec(
                "demo",
                "benchmarks",
                "packages/chip/build/reports/demo.json",
                "demo benchmark scope",
                "runtime optimization claim",
            )
            with mock.patch.object(opt, "REPO", repo), mock.patch.object(opt, "ARTIFACTS", (spec,)):
                report = opt.build_report()

        self.assertEqual(report["status"], "pass")
        assert_false_claim_flags(self, report)

    def test_flags_nonpass_weak_scope_and_false_claim_fields(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            artifact = repo / "packages/chip/build/reports/demo.json"
            artifact.parent.mkdir(parents=True)
            artifact.write_text(
                json.dumps(
                    {
                        "status": "blocked",
                        "claim_boundary": "modeled simulator evidence not phone runtime",
                        "release_claim_allowed": False,
                        "ready_for_sota_claim": False,
                        "runtime_coverage_ready": False,
                        "message": "blocked until target measurements exist",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            spec = opt.ArtifactSpec(
                "demo",
                "benchmarks",
                "packages/chip/build/reports/demo.json",
                "demo benchmark scope",
                "runtime optimization claim",
            )
            with mock.patch.object(opt, "REPO", repo):
                _, findings = opt.evaluate_artifact(spec)
        codes = {finding["code"] for finding in findings}
        self.assertIn("optimization_artifact_not_pass", codes)
        self.assertIn("optimization_evidence_weak_scope", codes)
        self.assertIn("optimization_evidence_blocked_or_placeholder_text", codes)
        self.assertIn("optimization_required_boolean_false", codes)

    def test_clean_runtime_artifact_has_no_findings(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            artifact = repo / "packages/chip/build/reports/demo.json"
            artifact.parent.mkdir(parents=True)
            artifact.write_text(
                json.dumps(
                    {
                        "status": "pass",
                        "claim_boundary": "chip emulator runtime benchmark evidence",
                        "benchmark_success_allowed": True,
                        "ready_for_runtime_claim": True,
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            spec = opt.ArtifactSpec(
                "demo",
                "benchmarks",
                "packages/chip/build/reports/demo.json",
                "demo benchmark scope",
                "runtime optimization claim",
            )
            with mock.patch.object(opt, "REPO", repo):
                _, findings = opt.evaluate_artifact(spec)
        self.assertEqual(findings, [])

    def test_artifact_specific_pass_status_is_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            artifact = repo / "packages/chip/build/reports/local-host-coremark-probe.json"
            artifact.parent.mkdir(parents=True)
            artifact.write_text(
                json.dumps(
                    {
                        "status": "local_host_evidence_not_release",
                        "claim_boundary": "host parser plumbing evidence",
                        "summary": {"passed_count": 1},
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            spec = opt.ArtifactSpec(
                "local_coremark_probe",
                "cpu",
                "packages/chip/build/reports/local-host-coremark-probe.json",
                "local host CoreMark probe",
                "CPU baseline parser plumbing",
                pass_values=("local_host_evidence_not_release",),
            )
            with mock.patch.object(opt, "REPO", repo):
                _, findings = opt.evaluate_artifact(spec)

        self.assertNotIn(
            "optimization_artifact_not_pass",
            {finding["code"] for finding in findings},
        )

    def test_embedded_companion_reports_do_not_create_required_boolean_findings(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            artifact = repo / "packages/chip/build/reports/demo.json"
            artifact.parent.mkdir(parents=True)
            artifact.write_text(
                json.dumps(
                    {
                        "status": "pass",
                        "claim_boundary": "chip emulator runtime benchmark evidence",
                        "runtime_claim_allowed": True,
                        "companion_reports": {
                            "linux_probe": {
                                "report": {
                                    "summary": {
                                        "release_ready": False,
                                    }
                                }
                            }
                        },
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            spec = opt.ArtifactSpec(
                "demo",
                "benchmarks",
                "packages/chip/build/reports/demo.json",
                "demo benchmark scope",
                "runtime optimization claim",
            )
            with mock.patch.object(opt, "REPO", repo):
                _, findings = opt.evaluate_artifact(spec)

        self.assertNotIn(
            "optimization_required_boolean_false",
            {finding["code"] for finding in findings},
        )

    def test_embedded_companion_reports_do_not_create_blocked_text_findings(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            artifact = repo / "packages/chip/build/reports/demo.json"
            artifact.parent.mkdir(parents=True)
            artifact.write_text(
                json.dumps(
                    {
                        "status": "pass",
                        "claim_boundary": "chip emulator runtime benchmark evidence",
                        "companion_report": {
                            "status": "blocked",
                            "blockers": ["diagnostic sidecar remains blocked"],
                        },
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            spec = opt.ArtifactSpec(
                "demo",
                "benchmarks",
                "packages/chip/build/reports/demo.json",
                "demo benchmark scope",
                "runtime optimization claim",
            )
            with mock.patch.object(opt, "REPO", repo):
                _, findings = opt.evaluate_artifact(spec)

        self.assertNotIn(
            "optimization_evidence_blocked_or_placeholder_text",
            {finding["code"] for finding in findings},
        )

    def test_artifact_can_skip_blocked_text_but_keep_weak_scope(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            artifact = repo / "packages/chip/build/reports/demo.json"
            artifact.parent.mkdir(parents=True)
            artifact.write_text(
                json.dumps(
                    {
                        "status": "pass",
                        "claim_boundary": "minimum Linux only; not Android runtime evidence",
                        "stdout": "diagnostic sidecar remains BLOCKED",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            spec = opt.ArtifactSpec(
                "demo",
                "npu",
                "packages/chip/build/reports/demo.json",
                "demo NPU target",
                "Linux NPU smoke",
                scan_blocked_text=False,
            )
            with mock.patch.object(opt, "REPO", repo):
                _, findings = opt.evaluate_artifact(spec)

        codes = {finding["code"] for finding in findings}
        self.assertIn("optimization_evidence_weak_scope", codes)
        self.assertNotIn("optimization_evidence_blocked_or_placeholder_text", codes)

    def test_mvp_npu_scale_sim_skips_modeled_capability_blocked_text(self) -> None:
        spec = next(artifact for artifact in opt.ARTIFACTS if artifact.ident == "mvp_npu_scale_sim")
        self.assertFalse(spec.scan_blocked_text)
        self.assertFalse(spec.must_pass)

    def test_artifact_skipping_blocked_text_keeps_nonpass_status_blocker(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            artifact = repo / "packages/chip/build/reports/demo.json"
            artifact.parent.mkdir(parents=True)
            artifact.write_text(
                json.dumps(
                    {
                        "status": "release_blocked",
                        "claim_boundary": "scope guard only; not runtime benchmark evidence",
                        "summary": "blocked until target measurements exist",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            spec = opt.ArtifactSpec(
                "demo",
                "benchmarks",
                "packages/chip/build/reports/demo.json",
                "demo benchmark scope",
                "runtime optimization claim",
                scan_blocked_text=False,
            )
            with mock.patch.object(opt, "REPO", repo):
                _, findings = opt.evaluate_artifact(spec)

        codes = {finding["code"] for finding in findings}
        self.assertIn("optimization_artifact_not_pass", codes)
        self.assertIn("optimization_evidence_weak_scope", codes)
        self.assertNotIn("optimization_evidence_blocked_or_placeholder_text", codes)

    def test_intentionally_false_claim_denials_are_not_runtime_gaps(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            artifact = repo / "packages/chip/build/reports/demo.json"
            artifact.parent.mkdir(parents=True)
            artifact.write_text(
                json.dumps(
                    {
                        "status": "pass",
                        "claim_boundary": "chip emulator runtime benchmark evidence",
                        "phone_claim_allowed": False,
                        "release_claim_allowed": False,
                        "android_boot_claim_allowed": False,
                        "ready_for_runtime_claim": True,
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            spec = opt.ArtifactSpec(
                "demo",
                "benchmarks",
                "packages/chip/build/reports/demo.json",
                "demo benchmark scope",
                "runtime optimization claim",
            )
            with mock.patch.object(opt, "REPO", repo):
                _, findings = opt.evaluate_artifact(spec)

        self.assertNotIn(
            "optimization_required_boolean_false",
            {finding["code"] for finding in findings},
        )

    def test_inventory_covers_android_no_issues_runtime_gates(self) -> None:
        artifact_ids = {artifact.ident for artifact in opt.ARTIFACTS}
        expected = {
            "android_launcher_runtime",
            "android_identity_contract",
            "android_app_runtime_contract",
            "android_system_apk_payload",
            "android_system_bridge",
            "aosp_hal_service_liveness",
            "android_evidence_capture_strictness",
            "android_release_readiness",
            "android_peripheral_evidence",
        }
        self.assertTrue(expected.issubset(artifact_ids))

    def test_command_plan_harvests_underlying_capture_commands(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            artifact = repo / "packages/chip/build/reports/demo.json"
            artifact.parent.mkdir(parents=True)
            artifact.write_text(
                json.dumps(
                    {
                        "status": "blocked",
                        "claim_boundary": "scope guard only; not runtime benchmark evidence",
                        "next_capture_commands": {
                            "benchmark": "capture-target-benchmark",
                            "benchmark_duplicate": "capture-target-benchmark",
                        },
                        "next_command_plan": [
                            {
                                "id": "runtime",
                                "commands": ["capture-runtime-npu"],
                            }
                        ],
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            spec = opt.ArtifactSpec(
                "demo",
                "benchmarks",
                "packages/chip/build/reports/demo.json",
                "demo benchmark scope",
                "runtime optimization claim",
            )
            with mock.patch.object(opt, "REPO", repo), mock.patch.object(opt, "ARTIFACTS", (spec,)):
                report = opt.build_report()

        self.assertEqual(report["summary"]["next_command_batch_count"], 1)
        batch = report["next_command_plan"][0]
        self.assertEqual(
            batch["claim_boundary"],
            "operator_commands_only_not_optimization_runtime_evidence",
        )
        self.assertEqual(
            batch["commands"],
            ["capture-runtime-npu", "capture-target-benchmark"],
        )
        finding = report["findings"][0]
        self.assertEqual(finding["next_command"], "capture-runtime-npu")
        self.assertEqual(
            finding["next_commands"],
            ["capture-runtime-npu", "capture-target-benchmark"],
        )

    def test_command_plan_harvests_nested_runtime_logging_commands(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            artifact = repo / "packages/chip/build/reports/android_release_readiness_contract.json"
            artifact.parent.mkdir(parents=True)
            artifact.write_text(
                json.dumps(
                    {
                        "status": "blocked",
                        "claim_boundary": "release readiness command plan only",
                        "findings": [
                            {
                                "next_commands": [
                                    "adb devices",
                                    "capture-launcher-runtime --logcat out/logcat.txt",
                                ]
                            }
                        ],
                        "evidence": {
                            "prioritized_live_evidence_capture_plan": [
                                {
                                    "capture_area": "chip-riscv64",
                                    "capture_commands": [
                                        "boot-chip-android",
                                        "capture-chip-launcher-agent",
                                    ],
                                    "validation_commands": ["validate-chip-launcher-agent"],
                                }
                            ],
                            "live_launcher_agent_missing_evidence": {
                                "records": [
                                    {
                                        "collectionCommands": ["collect-post-flash-logcat"],
                                        "validationCommand": "validate-post-flash-logcat",
                                    }
                                ]
                            },
                        },
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            spec = opt.ArtifactSpec(
                "android_release_readiness",
                "runtime",
                "packages/chip/build/reports/android_release_readiness_contract.json",
                "Android release readiness contract",
                "release and post-flash runtime logs",
            )
            with mock.patch.object(opt, "REPO", repo), mock.patch.object(opt, "ARTIFACTS", (spec,)):
                report = opt.build_report()

        commands = report["next_command_plan"][0]["commands"]
        self.assertEqual(commands[0], "adb devices")
        self.assertIn("capture-launcher-runtime --logcat out/logcat.txt", commands)
        self.assertIn("boot-chip-android", commands)
        self.assertIn("capture-chip-launcher-agent", commands)
        self.assertIn("validate-chip-launcher-agent", commands)
        self.assertIn("collect-post-flash-logcat", commands)
        self.assertIn("validate-post-flash-logcat", commands)
        finding = report["findings"][0]
        self.assertEqual(finding["next_command"], "capture-launcher-runtime --logcat out/logcat.txt")

    def test_finding_prefers_npu_capture_command_over_adb_probe(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            artifact = repo / "packages/chip/build/reports/npu_scope.json"
            artifact.parent.mkdir(parents=True)
            artifact.write_text(
                json.dumps(
                    {
                        "status": "blocked",
                        "claim_boundary": "NPU scope only; not NNAPI runtime evidence",
                        "next_command_plan": [
                            {
                                "id": "npu-runtime",
                                "commands": [
                                    "adb devices",
                                    (
                                        "E1_NPU_WRITE_PROOF_JSON=1 "
                                        "scripts/android/capture_e1_npu_nnapi_evidence.sh"
                                    ),
                                    "python3 scripts/check_e1_npu_nnapi_proof.py --probe-adb",
                                ],
                            }
                        ],
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            spec = opt.ArtifactSpec(
                "npu_scope",
                "npu",
                "packages/chip/build/reports/npu_scope.json",
                "NPU runtime scope",
                "NNAPI delegated runtime evidence",
            )
            with mock.patch.object(opt, "REPO", repo), mock.patch.object(opt, "ARTIFACTS", (spec,)):
                report = opt.build_report()

        finding = report["findings"][0]
        self.assertEqual(
            finding["next_command"],
            "E1_NPU_WRITE_PROOF_JSON=1 scripts/android/capture_e1_npu_nnapi_evidence.sh",
        )
        self.assertEqual(finding["next_commands"][0], "adb devices")

    def test_command_plan_sanitizes_host_local_aosp_paths(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            artifact = repo / "packages/chip/build/reports/android_release_readiness_contract.json"
            artifact.parent.mkdir(parents=True)
            artifact.write_text(
                json.dumps(
                    {
                        "status": "blocked",
                        "claim_boundary": "release readiness command plan only",
                        "evidence": {
                            "prioritized_live_evidence_capture_plan": [
                                {
                                    "capture_commands": [
                                        "export AOSP_ROOT=/home/shaw/aosp",
                                        (
                                            "AOSP_DIR=/home/shaw/aosp "
                                            "packages/chip/scripts/boot_android_simulator.sh "
                                            "--run-cuttlefish"
                                        ),
                                    ],
                                    "validation_commands": [
                                        "python3 packages/chip/scripts/check_android_release_readiness_contract.py"
                                    ],
                                }
                            ],
                        },
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            spec = opt.ArtifactSpec(
                "android_release_readiness",
                "runtime",
                "packages/chip/build/reports/android_release_readiness_contract.json",
                "Android release readiness contract",
                "release and post-flash runtime logs",
            )
            with mock.patch.object(opt, "REPO", repo), mock.patch.object(opt, "ARTIFACTS", (spec,)):
                report = opt.build_report()

        encoded = json.dumps(report, sort_keys=True)
        self.assertNotIn("/home/shaw/aosp", encoded)
        commands = report["next_command_plan"][0]["commands"]
        self.assertIn("export AOSP_ROOT=$AOSP_WORKSPACE", commands)
        self.assertIn(
            "AOSP_DIR=$AOSP_WORKSPACE packages/chip/scripts/boot_android_simulator.sh --run-cuttlefish",
            commands,
        )
        self.assertEqual(
            report["findings"][0]["next_command"],
            "AOSP_DIR=$AOSP_WORKSPACE packages/chip/scripts/boot_android_simulator.sh --run-cuttlefish",
        )

    def test_command_plan_joins_argv_array_commands(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            artifact = repo / "packages/chip/build/reports/minimum_linux_npu_target.json"
            artifact.parent.mkdir(parents=True)
            artifact.write_text(
                json.dumps(
                    {
                        "status": "blocked",
                        "claim_boundary": "minimum Linux only; not Android runtime evidence",
                        "next_commands": [
                            [
                                "/usr/bin/python3",
                                "scripts/check_minimum_linux_target.py",
                                "--require-evidence",
                                "docs/evidence/linux/e1 npu smoke.json",
                            ],
                            [
                                "e1-npu-ml-smoke",
                                "--device",
                                "/dev/e1-npu",
                                "--workload",
                                "gemm_s8_int8_2x2x3",
                            ],
                        ],
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            spec = opt.ArtifactSpec(
                "minimum_linux_npu_target",
                "npu",
                "packages/chip/build/reports/minimum_linux_npu_target.json",
                "minimum Linux plus NPU target",
                "integrated Linux NPU workload evidence",
            )
            with mock.patch.object(opt, "REPO", repo), mock.patch.object(opt, "ARTIFACTS", (spec,)):
                report = opt.build_report()

        commands = report["next_command_plan"][0]["commands"]
        self.assertIn(
            "/usr/bin/python3 scripts/check_minimum_linux_target.py --require-evidence "
            "'docs/evidence/linux/e1 npu smoke.json'",
            commands,
        )
        self.assertIn(
            "e1-npu-ml-smoke --device /dev/e1-npu --workload gemm_s8_int8_2x2x3",
            commands,
        )
        self.assertNotIn("/usr/bin/python3", commands)
        self.assertNotIn("--device", commands)
        self.assertNotIn("/dev/e1-npu", commands)

    def test_command_plan_keeps_independent_command_lists_separate(self) -> None:
        self.assertEqual(
            opt.command_strings(["adb devices", "capture-launcher-runtime"]),
            ["adb devices", "capture-launcher-runtime"],
        )
        self.assertEqual(
            opt.command_strings(["boot-chip-android", "capture-chip-launcher-agent"]),
            ["boot-chip-android", "capture-chip-launcher-agent"],
        )

    def test_known_artifact_without_embedded_commands_gets_fallback_commands(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            artifact = repo / "packages/chip/build/reports/cpu_ap_scope.json"
            artifact.parent.mkdir(parents=True)
            artifact.write_text(
                json.dumps(
                    {
                        "status": "blocked",
                        "claim_boundary": "generated AP scope only; not runtime benchmark evidence",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            spec = opt.ArtifactSpec(
                "cpu_ap_scope",
                "cpu",
                "packages/chip/build/reports/cpu_ap_scope.json",
                "CPU/AP Linux and benchmark evidence scope",
                "sustained AP benchmark evidence",
            )
            with mock.patch.object(opt, "REPO", repo), mock.patch.object(opt, "ARTIFACTS", (spec,)):
                report = opt.build_report()

        self.assertEqual(report["summary"]["next_command_batch_count"], 1)
        self.assertEqual(
            report["next_command_plan"][0]["commands"],
            ["make cpu-ap-capture-plan-shell", "make cpu-ap-evidence-check"],
        )
        self.assertEqual(report["findings"][0]["next_command"], "make cpu-ap-capture-plan-shell")


if __name__ == "__main__":
    unittest.main()
