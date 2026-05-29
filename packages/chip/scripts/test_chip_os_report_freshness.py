#!/usr/bin/env python3
"""Tests for scripts/check_chip_os_report_freshness.py."""

from __future__ import annotations

import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

import check_chip_os_report_freshness as freshness
from aggregate_tapeout_readiness import GateSpec


def assert_false_claim_flags(testcase: unittest.TestCase, report: dict[str, object]) -> None:
    testcase.assertEqual(report["claim_boundary"], freshness.CLAIM_BOUNDARY)
    for key, expected in freshness.FALSE_CLAIM_FLAGS.items():
        testcase.assertIs(report.get(key), expected, key)


class ChipOsReportFreshnessTests(unittest.TestCase):
    def test_missing_report_and_source_are_findings(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            spec = freshness.ReportSpec(
                "demo",
                "packages/chip/build/reports/demo.json",
                ("packages/chip/scripts/missing.py",),
                "demo report",
            )
            with mock.patch.object(freshness, "REPO", repo):
                row, findings = freshness.row_for_spec(spec)
        self.assertFalse(row["present"])
        codes = {finding["code"] for finding in findings}
        self.assertIn("missing_report_demo", codes)
        self.assertIn("missing_report_source_demo", codes)

    def test_source_newer_than_report_is_stale(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            source = repo / "packages/chip/scripts/demo.py"
            report = repo / "packages/chip/build/reports/demo.json"
            source.parent.mkdir(parents=True)
            report.parent.mkdir(parents=True)
            report.write_text("{}\n", encoding="utf-8")
            source.write_text("print('demo')\n", encoding="utf-8")
            now = time.time()
            os.utime(report, (now - 20, now - 20))
            os.utime(source, (now, now))
            spec = freshness.ReportSpec(
                "demo",
                "packages/chip/build/reports/demo.json",
                ("packages/chip/scripts/demo.py",),
                "demo report",
            )
            with mock.patch.object(freshness, "REPO", repo):
                row, findings = freshness.row_for_spec(spec)
        self.assertTrue(row["stale"])
        self.assertEqual(findings[0]["code"], "stale_report_demo")

    def test_fresh_report_passes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            source = repo / "packages/chip/scripts/demo.py"
            report = repo / "packages/chip/build/reports/demo.json"
            source.parent.mkdir(parents=True)
            report.parent.mkdir(parents=True)
            source.write_text("print('demo')\n", encoding="utf-8")
            report.write_text("{}\n", encoding="utf-8")
            now = time.time()
            os.utime(source, (now - 20, now - 20))
            os.utime(report, (now, now))
            spec = freshness.ReportSpec(
                "demo",
                "packages/chip/build/reports/demo.json",
                ("packages/chip/scripts/demo.py",),
                "demo report",
            )
            with mock.patch.object(freshness, "REPO", repo):
                row, findings = freshness.row_for_spec(spec)
        self.assertFalse(row["stale"])
        self.assertEqual(findings, [])

    def test_dynamic_gate_specs_watch_existing_detail_reports(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "packages/chip"
            source = root / "scripts/check_demo_gate.py"
            report = root / "build/reports/demo_gate.json"
            source.parent.mkdir(parents=True)
            report.parent.mkdir(parents=True)
            source.write_text("print('demo')\n", encoding="utf-8")
            report.write_text("{}\n", encoding="utf-8")
            gate = GateSpec(
                name="demo-gate-check",
                script="scripts/check_demo_gate.py",
                subsystem="bsp",
                tier="spec",
            )
            with (
                mock.patch.object(freshness, "ROOT", root),
                mock.patch.object(freshness.aggregate, "GATES", (gate,)),
            ):
                specs = freshness.dynamic_gate_report_specs()
        self.assertEqual(len(specs), 1)
        self.assertEqual(specs[0].report, "packages/chip/build/reports/demo_gate.json")
        self.assertEqual(specs[0].sources, ("packages/chip/scripts/check_demo_gate.py",))

    def test_report_freshness_payload_denies_boot_launcher_and_release_claims(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            source = repo / "packages/chip/scripts/demo.py"
            report_path = repo / "packages/chip/build/reports/demo.json"
            source.parent.mkdir(parents=True)
            report_path.parent.mkdir(parents=True)
            source.write_text("print('demo')\n", encoding="utf-8")
            report_path.write_text("{}\n", encoding="utf-8")
            spec = freshness.ReportSpec(
                "demo",
                "packages/chip/build/reports/demo.json",
                ("packages/chip/scripts/demo.py",),
                "demo report",
            )
            with (
                mock.patch.object(freshness, "REPO", repo),
                mock.patch.object(freshness, "BASE_REPORTS", (spec,)),
                mock.patch.object(freshness, "dynamic_gate_report_specs", return_value=[]),
            ):
                report = freshness.build_report()

        self.assertEqual(report["status"], "pass")
        assert_false_claim_flags(self, report)

    def test_dynamic_alias_reports_use_real_report_producer_sources(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "packages/chip"
            gate_source = root / "scripts/check_aosp_simulator_completion_gate.py"
            producer = root / "scripts/run_mvp_simulator.py"
            checker = root / "scripts/check_mvp_simulator.py"
            report = root / "build/reports/mvp_simulator.json"
            for path in (gate_source, producer, checker):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("print('demo')\n", encoding="utf-8")
            report.parent.mkdir(parents=True)
            report.write_text("{}\n", encoding="utf-8")
            gate = GateSpec(
                name="aosp-simulator-completion-check",
                script="scripts/check_aosp_simulator_completion_gate.py",
                subsystem="aosp",
                tier="os_boot",
            )
            with (
                mock.patch.object(freshness, "ROOT", root),
                mock.patch.object(freshness.aggregate, "GATES", (gate,)),
            ):
                specs = freshness.dynamic_gate_report_specs()
        mvp_specs = [spec for spec in specs if spec.report.endswith("mvp_simulator.json")]
        self.assertEqual(len(mvp_specs), 1)
        self.assertEqual(
            mvp_specs[0].sources,
            (
                "packages/chip/scripts/run_mvp_simulator.py",
                "packages/chip/scripts/check_mvp_simulator.py",
            ),
        )

    def test_android_evidence_capture_contract_watches_workflow_sources(self) -> None:
        specs = {spec.ident: spec for spec in freshness.BASE_REPORTS}
        spec = specs["android_evidence_capture_contract"]
        self.assertEqual(
            spec.report,
            "packages/chip/build/reports/android_evidence_capture_contract.json",
        )
        for source in (
            "packages/chip/scripts/check_android_evidence_capture_contract.py",
            "packages/chip/sw/aosp-device/capture-aosp-evidence.sh",
            "packages/chip/sw/aosp-device/cuttlefish-boot-gate.sh",
            "packages/chip/sw/aosp-device/evidence_manifest.json",
            "packages/chip/docs/project/aosp-simulator-completion-gate.yaml",
        ):
            self.assertIn(source, spec.sources)

    def test_android_app_runtime_contract_watches_app_and_smoke_sources(self) -> None:
        specs = {spec.ident: spec for spec in freshness.BASE_REPORTS}
        spec = specs["android_app_runtime_contract"]
        for source in (
            "packages/chip/scripts/check_android_app_runtime_contract.py",
            "packages/app-core/platforms/android/app/build.gradle",
            "packages/app-core/platforms/android/app/src/main/AndroidManifest.xml",
            "packages/app-core/platforms/android/app/src/main/java/ai/milady/milady/ElizaAgentService.java",
            "packages/app-core/platforms/android/app/src/main/java/ai/milady/milady/ElizaNativeBridge.java",
            "packages/os/android/vendor/eliza/eliza_common.mk",
            "packages/os/android/vendor/eliza/permissions/default-permissions-ai.elizaos.app.xml",
            "packages/os/android/vendor/eliza/permissions/privapp-permissions-ai.elizaos.app.xml",
            "packages/chip/sw/aosp-device/start-eliza-agent-riscv64.sh",
            "packages/chip/sw/aosp-device/agent-smoke-riscv64.sh",
            "packages/chip/sw/aosp-device/scripts/cuttlefish_agent_smoke.py",
            "packages/chip/sw/aosp-device/capture-aosp-evidence.sh",
            "packages/chip/sw/aosp-device/install-eliza-apk-riscv64.sh",
        ):
            self.assertIn(source, spec.sources)

    def test_aosp_product_contract_alias_watches_product_workflow_sources(self) -> None:
        sources = freshness.GATE_REPORT_ALIAS_SOURCES["aosp_product_contract.json"]
        for source in (
            "packages/chip/scripts/check_aosp_product_contract.py",
            "packages/chip/sw/aosp-device/build-aosp-riscv64.sh",
            "packages/chip/scripts/boot_android_simulator.sh",
            "packages/chip/sw/aosp-device/capture-aosp-evidence.sh",
            "packages/os/android/vendor/eliza/eliza_common.mk",
            "packages/os/android/vendor/eliza/products/eliza_openagent_ai_soc_phone.mk",
        ):
            self.assertIn(source, sources)

    def test_aosp_hal_contract_alias_watches_hal_sources(self) -> None:
        sources = freshness.GATE_REPORT_ALIAS_SOURCES["aosp_hal_service_contract.json"]
        for source in (
            "packages/chip/scripts/check_aosp_hal_service_contract.py",
            "packages/chip/sw/aosp-device/device/eliza/eliza_ai_soc/hal/e1_npu/Android.bp",
            "packages/chip/sw/aosp-device/device/eliza/eliza_ai_soc/hal/e1_npu/E1Npu.h",
            "packages/chip/sw/aosp-device/device/eliza/eliza_ai_soc/hal/e1_npu/1.0/IE1Npu.hal",
            "packages/chip/sw/aosp-device/device/eliza/eliza_ai_soc/hal/e1_npu_sim/Android.bp",
            "packages/chip/sw/aosp-device/device/eliza/eliza_ai_soc/hal/e1_npu_sim/E1NpuSim.h",
            "packages/chip/sw/aosp-device/device/eliza/eliza_ai_soc/hal/hwcomposer/Android.bp",
            "packages/chip/sw/aosp-device/device/eliza/eliza_ai_soc/hal/hwcomposer/hwcomposer.cpp",
            "packages/chip/sw/linux/drivers/e1/e1_platform_contract.h",
        ):
            self.assertIn(source, sources)

    def test_android_system_apk_payload_alias_watches_apk_sources(self) -> None:
        sources = freshness.GATE_REPORT_ALIAS_SOURCES["android_system_apk_payload.json"]
        for source in (
            "packages/chip/scripts/check_android_system_apk_payload.py",
            "packages/os/android/vendor/eliza/apps/Eliza/Android.bp",
            "packages/os/android/vendor/eliza/apps/Eliza/Eliza.apk",
            "packages/os/android/vendor/eliza/eliza_common.mk",
            "packages/app-core/platforms/android/app/src/main/java/ai/milady/milady/ElizaAgentService.java",
        ):
            self.assertIn(source, sources)

    def test_cross_fork_agent_payload_alias_watches_both_forks(self) -> None:
        sources = freshness.GATE_REPORT_ALIAS_SOURCES["cross_fork_agent_payload_contract.json"]
        for source in (
            "packages/chip/scripts/check_cross_fork_agent_payload_contract.py",
            "packages/app-core/scripts/bun-riscv64/bun-version.json",
            "packages/app-core/scripts/lib/stage-android-agent.mjs",
            "packages/app-core/platforms/android/app/src/main/java/ai/milady/milady/ElizaAgentService.java",
            "packages/os/linux/elizaos/config/hooks/normal/0010-elizaos-agent.hook.chroot",
            "packages/os/linux/elizaos/config/includes.chroot/etc/systemd/system/elizaos-agent.service",
            "packages/os/linux/elizaos/config/includes.chroot/usr/lib/elizaos/run-agent.sh",
            "packages/os/linux/elizaos/config/includes.chroot/usr/lib/elizaos/wait-agent-health.sh",
            "packages/os/linux/elizaos/manifest.json.template",
            "packages/os/linux/elizaos/chip-boot-manifest.json",
        ):
            self.assertIn(source, sources)

    def test_android_system_bridge_contract_alias_watches_bridge_sources(self) -> None:
        sources = freshness.GATE_REPORT_ALIAS_SOURCES["android_system_bridge_contract.json"]
        for source in (
            "packages/chip/scripts/check_android_system_bridge_contract.py",
            "packages/os/android/system-ui/native/src/main/java/ai/elizaos/system/bridge/SystemBridge.kt",
            "packages/os/android/system-ui/native/src/main/AndroidManifest.xml",
            "packages/os/android/system-ui/native/build.gradle.kts",
            "packages/os/android/system-ui/native/Android.bp",
            "packages/os/android/system-ui/src/providers/AndroidSystemProvider.tsx",
            "packages/os/android/system-ui/src/providers/MockSystemProvider.tsx",
            "packages/os/android/system-ui/src/bridge/bridge-contract.ts",
            "packages/os/android/vendor/eliza/eliza_common.mk",
            "packages/os/android/vendor/eliza/permissions/privapp-permissions-ai.elizaos.system.bridge.xml",
            "packages/chip/sw/aosp-device/local_manifests/eliza.xml",
        ):
            self.assertIn(source, sources)


if __name__ == "__main__":
    unittest.main()
