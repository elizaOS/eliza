#!/usr/bin/env python3
"""Tests for scripts/check_android_simulated_peripheral_evidence.py."""

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

import check_android_simulated_peripheral_evidence as gate  # noqa: E402


def write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


COMPONENTS = {
    "rear_camera": (
        "docs/evidence/android/peripherals/rear_camera_sim.log",
        ["COMPONENT=rear_camera", "FRAME_SOURCE=simulated_sensor", "CAPTURE_COUNT=2"],
    ),
    "front_camera": (
        "docs/evidence/android/peripherals/front_camera_sim.log",
        ["COMPONENT=front_camera", "FRAME_SOURCE=simulated_sensor", "CAPTURE_COUNT=2"],
    ),
    "microphone": (
        "docs/evidence/android/peripherals/microphone_input_sim.log",
        ["COMPONENT=microphone", "AUDIO_CAPTURE=pcm_s16le", "INPUT_RMS_DBFS="],
    ),
    "speakers": (
        "docs/evidence/android/peripherals/speaker_output_sim.log",
        ["COMPONENT=speakers", "AUDIO_OUTPUT=stereo_pcm", "LOOPBACK_VERIFIED=true"],
    ),
    "wifi": (
        "docs/evidence/android/peripherals/wifi_sim.log",
        ["COMPONENT=wifi", "IP_CONNECTIVITY=pass", "ANDROID_DUMPSYS_WIFI=pass"],
    ),
    "bluetooth": (
        "docs/evidence/android/peripherals/bluetooth_sim.log",
        ["COMPONENT=bluetooth", "HCI_ATTACH=pass", "BLE_SCAN=pass"],
    ),
    "cellular_5g_lte": (
        "docs/evidence/android/peripherals/cellular_5g_lte_sim.log",
        ["COMPONENT=cellular_5g_lte", "LTE_REGISTRATION=pass", "NR5G_REGISTRATION=pass"],
    ),
}


def yaml_text() -> str:
    lines = ["required_simulated_peripherals:"]
    for component, (evidence, markers) in COMPONENTS.items():
        lines.extend(
            [
                f"  - id: {component}",
                f"    evidence: {evidence}",
                f"    producer: scripts/android/capture_simulated_peripheral_evidence.py {component}",
                "    required_markers:",
            ]
        )
        lines.extend(f"      - {marker}" for marker in markers)
    return "\n".join(lines) + "\n"


class AndroidSimulatedPeripheralEvidenceTests(unittest.TestCase):
    def _patch_tree(self, tmp: Path):
        gate_yaml = write(tmp / "docs/project/aosp-simulator-completion-gate.yaml", yaml_text())
        launch = write(
            tmp / "sw/aosp-device/launch-cuttlefish-riscv64.sh",
            "launch_cvd --enable_wifi=false\n",
        )
        ai_readme = write(
            tmp / "sw/aosp-device/device/eliza/eliza_ai_soc/README.md",
            "Explicit non-claims: no audio HAL, no microphone, no speaker\n",
        )
        cf_readme = write(
            tmp / "sw/aosp-device/device/eliza/cuttlefish_e1/README.md",
            "Add camera/audio/radio/GNSS/NFC/bluetooth/wifi HALs.\n",
        )
        patches = [
            mock.patch.object(gate, "ROOT", tmp),
            mock.patch.object(gate, "GATE_YAML", gate_yaml),
            mock.patch.object(gate, "LAUNCH_CVD", launch),
            mock.patch.object(gate, "ELIZA_AI_SOC_README", ai_readme),
            mock.patch.object(gate, "CUTTLEFISH_E1_README", cf_readme),
        ]
        return patches

    def test_blocked_logs_and_source_contradictions_are_reported(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            patches = self._patch_tree(tmp)
            with PatchStack(patches):
                for component, (evidence, markers) in COMPONENTS.items():
                    write(
                        gate.ROOT / evidence,
                        f"eliza-evidence: target=android_simulated_peripheral component={component}\n"
                        "eliza-evidence: claim_boundary=adb-backed Android simulator peripheral evidence only\n"
                        "eliza-evidence: command_env=ELIZA_TEST\n"
                        "eliza-evidence: command=probe\n"
                        "eliza-evidence: started_utc=2026-05-19T20:06:41Z\n"
                        f"COMPONENT={component}\n"
                        "COMMAND_OUTPUT_BEGIN\n"
                        "eliza-evidence: status=BLOCKED\n"
                        "COMMAND_OUTPUT_END\n"
                        "eliza-evidence: ended_utc=2026-05-19T20:06:42Z\n"
                        "RESULT=2\n"
                        f"MISSING_MARKERS={','.join(markers[1:])}\n",
                    )
                report = gate.run_check(Namespace())
        self.assertEqual(report["status"], "blocked")
        codes = {finding["code"] for finding in report["findings"]}
        self.assertIn("peripheral_evidence_blocked:rear_camera", codes)
        self.assertIn("peripheral_result_not_pass:wifi", codes)
        self.assertIn("peripheral_status_not_pass:bluetooth", codes)
        self.assertIn("peripheral_marker_missing:cellular_5g_lte", codes)
        self.assertIn("peripheral_capture_probe_wifi_disabled", codes)
        self.assertIn("aosp_chip_product_declares_no_audio_hal", codes)
        self.assertIn("cuttlefish_e1_missing_phone_hals", codes)

    def test_all_pass_logs_and_consistent_sources_pass(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            patches = self._patch_tree(tmp)
            with PatchStack(patches):
                gate.LAUNCH_CVD.write_text("launch_cvd --enable_wifi=true\n", encoding="utf-8")
                gate.ELIZA_AI_SOC_README.write_text(
                    "Audio HAL, microphone, and speaker are wired for simulator evidence.\n",
                    encoding="utf-8",
                )
                gate.CUTTLEFISH_E1_README.write_text(
                    "Phone HAL evidence is captured by the simulator probes.\n",
                    encoding="utf-8",
                )
                for component, (evidence, markers) in COMPONENTS.items():
                    write(
                        gate.ROOT / evidence,
                        "\n".join(
                            [
                                f"eliza-evidence: target=android_simulated_peripheral component={component}",
                                "eliza-evidence: claim_boundary=adb-backed Android simulator peripheral evidence only",
                                "eliza-evidence: command_env=ELIZA_TEST",
                                "eliza-evidence: command=probe",
                                "eliza-evidence: started_utc=2026-05-19T20:06:41Z",
                                f"COMPONENT={component}",
                                "COMMAND_OUTPUT_BEGIN",
                                *markers,
                                "COMMAND_OUTPUT_END",
                                "eliza-evidence: ended_utc=2026-05-19T20:06:42Z",
                                "eliza-evidence: status=PASS",
                                "RESULT=0",
                            ]
                        )
                        + "\n",
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
