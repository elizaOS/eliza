#!/usr/bin/env python3
"""Tests for scripts/check_android_evidence_capture_contract.py."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

import check_android_evidence_capture_contract as gate  # noqa: E402


def write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


class AndroidEvidenceCaptureContractTests(unittest.TestCase):
    def _patch_tree(self, tmp: Path):
        manifest = write(
            tmp / "sw/aosp-device/evidence_manifest.json",
            json.dumps(
                {
                    "required_for_android_boot_claim": [
                        "docs/evidence/android/cuttlefish_riscv64_boot.log",
                        "docs/evidence/android/qemu_riscv64_smoke.log",
                    ]
                }
            ),
        )
        capture = write(
            tmp / "sw/aosp-device/capture-aosp-evidence.sh",
            "aosp_agent_package=${AOSP_AGENT_PACKAGE:-com.elizaos.agent}\n"
            "aosp_agent_service=${AOSP_AGENT_SERVICE:-com.elizaos.agent/.AgentService}\n",
        )
        boot_gate = write(
            tmp / "sw/aosp-device/cuttlefish-boot-gate.sh",
            "adb shell getprop sys.boot_completed\nadb shell uname -m\n",
        )
        sim_boot = write(
            tmp / "scripts/check_android_sim_boot.py",
            "required_evidence = ['docs/evidence/android/cuttlefish_riscv64_boot.log']\n",
        )
        completion = write(
            tmp / "docs/project/aosp-simulator-completion-gate.yaml",
            "required_android_evidence:\n"
            "  - docs/evidence/android/cuttlefish_riscv64_boot.log\n"
            "required_markers:\n"
            "  - SELF_STATUS_HTTP=200\n",
        )
        qemu = write(
            tmp / "docs/evidence/android/qemu_riscv64_smoke.log",
            "COMMAND=qemu-system-riscv64 --version\n"
            "qemu-system-riscv64 AOSP riscv64 smoke requires kernel/system image wiring\n"
            "eliza-evidence: status=PASS\nRESULT=0\n",
        )
        cts = write(
            tmp / "docs/evidence/android/eliza_ai_soc_cts_vts_plan.log",
            "CTS_MODULES_SOURCE_SCAN=true\n"
            "vts-tradefed list modules (source scan)\n"
            "eliza-evidence: status=PASS\nRESULT=0\n",
        )
        patches = [
            mock.patch.object(gate, "ROOT", tmp),
            mock.patch.object(gate, "MANIFEST", manifest),
            mock.patch.object(gate, "CAPTURE_SCRIPT", capture),
            mock.patch.object(gate, "BOOT_GATE", boot_gate),
            mock.patch.object(gate, "ANDROID_SIM_BOOT", sim_boot),
            mock.patch.object(gate, "COMPLETION_GATE", completion),
            mock.patch.object(gate, "QEMU_SMOKE_LOG", qemu),
            mock.patch.object(gate, "CTS_VTS_PLAN_LOG", cts),
        ]
        return patches

    def test_current_reference_evidence_contract_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            patches = self._patch_tree(Path(tmpdir))
            with PatchStack(patches):
                report = gate.run_check(Namespace())
        self.assertEqual(report["status"], "blocked")
        codes = {finding["code"] for finding in report["findings"]}
        self.assertIn("android_evidence_manifest_missing_launcher_runtime_evidence", codes)
        self.assertIn("android_evidence_manifest_missing_agent_health_requirement", codes)
        self.assertIn("android_capture_defaults_agent_package_mismatch", codes)
        self.assertIn("android_capture_defaults_agent_service_mismatch", codes)
        self.assertIn("cuttlefish_boot_gate_missing_launcher_agent_checks", codes)
        self.assertIn("cuttlefish_boot_gate_launcher_evidence_boundary_mismatch", codes)
        self.assertIn("cuttlefish_boot_gate_launcher_json_shape_mismatch", codes)
        self.assertIn("android_sim_boot_gate_missing_launcher_evidence_check", codes)
        self.assertIn("aosp_completion_gate_missing_launcher_runtime_evidence", codes)
        self.assertIn("aosp_completion_gate_uses_legacy_agent_markers", codes)
        self.assertIn("qemu_smoke_log_is_version_only", codes)
        self.assertIn("cts_vts_plan_is_source_scan_only", codes)

    def test_launcher_agent_runtime_evidence_contract_passes(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            patches = self._patch_tree(tmp)
            with PatchStack(patches):
                gate.MANIFEST.write_text(
                    json.dumps(
                        {
                            "required_for_android_boot_claim": [
                                gate.LAUNCHER_EVIDENCE,
                                "docs/evidence/android/eliza_agent_health_api.log",
                            ]
                        }
                    ),
                    encoding="utf-8",
                )
                gate.CAPTURE_SCRIPT.write_text(
                    f"aosp_agent_package=${{AOSP_AGENT_PACKAGE:-{gate.EXPECTED_AGENT_PACKAGE}}}\n"
                    f"aosp_agent_service=${{AOSP_AGENT_SERVICE:-{gate.EXPECTED_AGENT_SERVICE}}}\n",
                    encoding="utf-8",
                )
                gate.BOOT_GATE.write_text(
                    f"adb shell pm path {gate.EXPECTED_AGENT_PACKAGE}\n"
                    "adb shell cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME\n"
                    "adb shell cmd role holders android.app.role.ASSISTANT\n"
                    "adb shell dumpsys activity activities\n"
                    f"adb shell pidof {gate.EXPECTED_AGENT_PACKAGE}\n"
                    "curl http://127.0.0.1:31337/api/health\n"
                    "adb shell logcat -d | grep -Ei 'fatal|avc'\n",
                    encoding="utf-8",
                )
                gate.BOOT_GATE.write_text(
                    gate.BOOT_GATE.read_text(encoding="utf-8")
                    + "\n"
                    + json.dumps(
                        {
                            "schema": gate.EXPECTED_LAUNCHER_SCHEMA,
                            "claim_boundary": gate.EXPECTED_LAUNCHER_CLAIM_BOUNDARY,
                            "device": {
                                "sys_boot_completed": "1",
                                "cpu_abi": "riscv64",
                            },
                            "app": {
                                "package_name": gate.EXPECTED_AGENT_PACKAGE,
                                "pm_path": "package:/system/priv-app/Milady/Milady.apk",
                                "role_holders": {
                                    "android.app.role.HOME": [gate.EXPECTED_AGENT_PACKAGE]
                                },
                                "home_resolve_activity": f"{gate.EXPECTED_AGENT_PACKAGE}/.MainActivity",
                                "foreground_activity": f"{gate.EXPECTED_AGENT_PACKAGE}/.MainActivity",
                                "service_component": gate.EXPECTED_AGENT_SERVICE,
                                "service_pid": 31337,
                            },
                            "agent": {
                                "health_url": "http://127.0.0.1:31337/api/health",
                                "health_http": 200,
                                "health_ready": True,
                            },
                            "logs": {
                                "logcat_path": "docs/evidence/android/eliza_launcher_runtime_logcat.txt",
                                "fatal_crash_count": 0,
                                "avc_denial_count": 0,
                            },
                            "artifacts": {
                                "transcript_path": "docs/evidence/android/eliza_launcher_runtime_transcript.log"
                            },
                        },
                        indent=2,
                    )
                    + "\n",
                    encoding="utf-8",
                )
                gate.ANDROID_SIM_BOOT.write_text(
                    f"required = ['{gate.LAUNCHER_EVIDENCE}']\n", encoding="utf-8"
                )
                gate.COMPLETION_GATE.write_text(
                    "required_android_evidence:\n"
                    f"  - {gate.LAUNCHER_EVIDENCE}\n"
                    "required_markers:\n"
                    "  - health_url=/api/health\n",
                    encoding="utf-8",
                )
                gate.QEMU_SMOKE_LOG.write_text(
                    "COMMAND=qemu-system-riscv64 -kernel Image -append androidboot\n"
                    "sys.boot_completed=1\n"
                    "eliza-evidence: status=PASS\nRESULT=0\n",
                    encoding="utf-8",
                )
                gate.CTS_VTS_PLAN_LOG.write_text(
                    "tradefed run command: run cts --module CtsAppTestCases\n"
                    "Invocation finished\n"
                    "Test Result: pass=1 fail=0\n"
                    "eliza-evidence: status=PASS\nRESULT=0\n",
                    encoding="utf-8",
                )
                report = gate.run_check(Namespace())
        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["findings"], [])
        self.assertEqual(report["claim_boundary"], gate.CLAIM_BOUNDARY)


class PatchStack:
    def __init__(self, patches):
        self._patches = patches
        self._entered = []

    def __enter__(self):
        for patch in self._patches:
            self._entered.append(patch)
            patch.__enter__()
        return self

    def __exit__(self, exc_type, exc, tb):
        while self._entered:
            self._entered.pop().__exit__(exc_type, exc, tb)


if __name__ == "__main__":
    unittest.main()
