#!/usr/bin/env python3
"""Tests for scripts/check_os_rv64_chip_boot_contract.py."""

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

import check_os_rv64_chip_boot_contract as gate  # noqa: E402


def write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def write_json(path: Path, payload: dict) -> Path:
    return write(path, json.dumps(payload, indent=2) + "\n")


class OsRv64ChipBootContractTests(unittest.TestCase):
    def _patch_tree(self, tmp: Path):
        variant = tmp / "os/linux/elizaos"
        manifest = write_json(
            variant / "manifest.json",
            {
                "status": "candidate",
                "filename": "elizaos-linux-riscv64-fixture.iso",
                "sizeBytes": 1710800896,
                "target": {
                    "platform": "linux",
                    "architecture": "riscv64",
                    "device": None,
                    "hypervisor": None,
                    "firmware": None,
                },
                "validation": {
                    "requiredEvidence": ["qemu-virt-boot", "grub-efi-riscv64-boot"],
                    "evidence": [
                        {
                            "id": "qemu-virt-boot",
                            "status": "collected",
                            "path": "evidence/qemu_virt_boot.json",
                        },
                        {
                            "id": "hardware-board-boot",
                            "status": "not-required",
                            "path": None,
                        },
                    ],
                },
            },
        )
        transcript = write(
            variant / "evidence/qemu_virt_boot.transcript.log",
            "Linux version\n"
            "elizaos-ready instance=fixture\n"
            "agent binary missing at /opt/elizaos/bin/elizaos\n",
        )
        qemu = write_json(
            variant / "evidence/qemu_virt_boot.json",
            {
                "schema": "eliza.os.linux.qemu_virt_boot.v1",
                "boot_completed": True,
                "provenance": "qemu_virt",
                "claim_boundary": "qemu_virt_boot_transcript_evidence_only_no_silicon_or_physical_board_claim",
                "transcript_path": str(transcript),
            },
        )
        status_report = write(
            variant / "STATUS.md",
            "Status line: scaffold_complete_no_iso_built_no_qemu_boot_captured_no_hardware_run\n"
            "No claim is made anywhere in this document that an ISO was built from this checkout.\n"
            "No transcript is committed.\n",
        )
        first_boot = write(
            variant / "config/includes.chroot/usr/lib/elizaos/first-boot.sh",
            'READY_LINE="elizaos-ready instance=${INSTANCE_UUID}"\n'
            "systemctl start --no-block elizaos-agent.service\n",
        )
        agent_unit = write(
            variant / "config/includes.chroot/etc/systemd/system/elizaos-agent.service",
            "[Service]\nExecStart=/opt/elizaos/bin/elizaos start --headless --port=31337\n",
        )
        agent_hook = write(
            variant / "config/hooks/normal/0010-elizaos-agent.hook.chroot",
            "install_fallback_payload() {\n"
            "  echo elizaos-fallback > /opt/elizaos/app/fallback_agent.py\n"
            "}\n"
            "install_fallback_payload\n",
        )
        release_check = write(
            variant / "scripts/check_release_manifest.py",
            "# Marker the elizaOS first-boot unit prints once the agent is up.\n"
            'REQUIRED_TRANSCRIPT_MARKER = "elizaos-ready"\n',
        )
        tui_unit = write(
            variant
            / "config/includes.chroot/etc/systemd/system/elizaos-terminal-tui-smoke.service",
            "[Service]\nExecStart=/usr/lib/elizaos/run-terminal-tui-smoke.sh http://127.0.0.1:31337\n",
        )
        tui_script = write(
            variant / "config/includes.chroot/usr/lib/elizaos/run-terminal-tui-smoke.sh",
            "#!/bin/sh\nelizaos tui-smoke --api http://127.0.0.1:31337\n",
        )
        patches = [
            mock.patch.object(gate, "WORKSPACE", tmp),
            mock.patch.object(gate, "VARIANT", variant),
            mock.patch.object(gate, "MANIFEST", manifest),
            mock.patch.object(gate, "STATUS_REPORT", status_report),
            mock.patch.object(gate, "QEMU_EVIDENCE", qemu),
            mock.patch.object(gate, "FIRST_BOOT", first_boot),
            mock.patch.object(gate, "AGENT_UNIT", agent_unit),
            mock.patch.object(
                gate,
                "AGENT_INSTALL_HOOK",
                agent_hook,
            ),
            mock.patch.object(gate, "RELEASE_CHECK", release_check),
            mock.patch.object(gate, "TUI_SMOKE_UNIT", tui_unit),
            mock.patch.object(gate, "TUI_SMOKE_SCRIPT", tui_script),
        ]
        return patches, manifest, qemu, variant

    def test_qemu_only_agent_missing_state_blocks_chip_objective(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            patches, _, _, _ = self._patch_tree(Path(tmpdir))
            with PatchStack(patches):
                report = gate.run_check(Namespace(manifest=None, qemu_evidence=None))
        self.assertEqual(report["status"], "blocked")
        codes = {finding["code"] for finding in report["findings"]}
        self.assertIn("missing_chip_target_boot_evidence_row", codes)
        self.assertIn("missing_agent_live_evidence_row", codes)
        self.assertIn("manifest_target_is_generic", codes)
        self.assertIn("manifest_target_not_chip_emulator", codes)
        self.assertIn("qemu_virt_evidence_is_reference_only", codes)
        self.assertIn("os_rv64_status_report_stale_against_manifest", codes)
        self.assertIn("transcript_agent_binary_missing", codes)
        self.assertIn("elizaos_ready_marker_before_agent_start", codes)
        self.assertIn("linux_release_gate_overstates_elizaos_ready_marker", codes)
        self.assertIn("agent_execstart_not_packaged", codes)
        self.assertIn("linux_agent_fallback_payload_allowed", codes)
        self.assertIn("missing_agent_liveness_marker", codes)
        self.assertIn("missing_tui_liveness_marker", codes)
        command_ids = {item["id"] for item in report["next_command_plan"]}
        self.assertIn("write_blocked_boot_evidence_from_real_transcript", command_ids)
        self.assertIn("write_blocked_agent_live_evidence_from_real_transcript", command_ids)
        self.assertIn("target_agent_live_probe_transcript", command_ids)
        self.assertIn("recheck_contract", command_ids)
        self.assertEqual(
            report["summary"]["next_command_count"],
            len(report["next_command_plan"]),
        )
        blocked_boot = next(
            item
            for item in report["next_command_plan"]
            if item["id"] == "write_blocked_boot_evidence_from_real_transcript"
        )
        self.assertIn("capture-chip-boot-evidence.py", blocked_boot["command"])
        self.assertIn("--write-blocked", blocked_boot["command"])
        self.assertEqual(
            blocked_boot["claim_boundary"],
            "diagnostic_blocked_evidence_only_not_live_capture_proof",
        )

    def test_agent_live_row_cannot_reuse_qemu_virt_reference_for_chip_objective(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            patches, manifest, _, _ = self._patch_tree(Path(tmpdir))
            payload = json.loads(manifest.read_text(encoding="utf-8"))
            payload["validation"]["requiredEvidence"].append("elizaos-agent-live")
            payload["validation"]["evidence"].append(
                {
                    "id": "elizaos-agent-live",
                    "status": "collected",
                    "path": "evidence/qemu_virt_boot.json",
                }
            )
            manifest.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
            with PatchStack(patches):
                report = gate.run_check(Namespace(manifest=None, qemu_evidence=None))
        self.assertEqual(report["status"], "blocked")
        codes = {finding["code"] for finding in report["findings"]}
        self.assertIn("agent_live_evidence_reuses_qemu_virt_reference", codes)
        self.assertEqual(report["evidence"]["agent_live_reference_rows"], ["elizaos-agent-live"])

    def test_missing_generated_ap_files_are_reported_by_manifest_path(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            patches, manifest, _, _ = self._patch_tree(Path(tmpdir))
            payload = json.loads(manifest.read_text(encoding="utf-8"))
            payload["target"] = {
                "platform": "linux",
                "architecture": "riscv64",
                "device": "eliza-e1-generated-ap",
                "hypervisor": "eliza-chip-emulator",
                "firmware": "generated-ap OpenSBI",
            }
            payload["validation"] = {
                "requiredEvidence": [
                    "generated-eliza-ap-boot",
                    "elizaos-agent-live",
                ],
                "evidence": [
                    {
                        "id": "generated-eliza-ap-boot",
                        "status": "missing",
                        "path": "evidence/generated_eliza_ap_boot.json",
                    },
                    {
                        "id": "elizaos-agent-live",
                        "status": "missing",
                        "path": "evidence/generated_eliza_ap_agent_live.json",
                    },
                ],
            }
            manifest.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
            with PatchStack(patches):
                report = gate.run_check(Namespace(manifest=None, qemu_evidence=None))
        self.assertEqual(report["status"], "blocked")
        findings = {finding["code"]: finding for finding in report["findings"]}
        self.assertIn("chip_target_boot_evidence_file_missing", findings)
        self.assertIn("agent_live_evidence_file_missing", findings)
        self.assertIn(
            "os/linux/elizaos/evidence/generated_eliza_ap_boot.json",
            findings["chip_target_boot_evidence_file_missing"]["evidence"],
        )
        self.assertIn(
            "os/linux/elizaos/evidence/generated_eliza_ap_agent_live.json",
            findings["agent_live_evidence_file_missing"]["evidence"],
        )

    def test_chip_boot_and_agent_live_contract_passes(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            patches, manifest, qemu, variant = self._patch_tree(tmp)
            transcript = variant / "evidence/chip_boot.transcript.log"
            write(
                transcript,
                "OpenSBI\nLinux version\nelizaos-firstboot-ready instance=fixture\n"
                "systemctl is-active elizaos-agent.service: active\n"
                "GET /api/health 200\nelizaos-agent-ready\n"
                "elizaos-tui-ready\n",
            )
            write_json(
                manifest,
                {
                    "target": {
                        "platform": "linux",
                        "architecture": "riscv64",
                        "device": "eliza-e1-generated-ap",
                        "hypervisor": "chipyard-verilator",
                        "firmware": "opensbi",
                    },
                    "validation": {
                        "requiredEvidence": [
                            "generated-eliza-ap-boot",
                            "elizaos-agent-live",
                        ],
                        "evidence": [
                            {
                                "id": "generated-eliza-ap-boot",
                                "status": "collected",
                                "path": "evidence/chip_boot.json",
                            },
                            {
                                "id": "elizaos-agent-live",
                                "status": "collected",
                                "path": "evidence/agent_live.json",
                            },
                        ],
                    },
                },
            )
            write_json(
                variant / "evidence/chip_boot.json",
                {
                    "schema": "eliza.os.linux.chip_boot.v1",
                    "boot_completed": True,
                    "provenance": "generated_eliza_ap",
                    "claim_boundary": "generated_eliza_ap_chip_emulator_boot_evidence",
                    "transcript_path": str(transcript),
                },
            )
            write_json(
                variant / "evidence/agent_live.json",
                {
                    "schema": "eliza.os.linux.agent_live.v1",
                    "provenance": "generated_eliza_ap",
                    "claim_boundary": "generated_eliza_ap_chip_emulator_agent_live_evidence",
                    "transcript_path": str(transcript),
                    "fallback_payload_used": False,
                    "full_agent_bundle": True,
                    "service": {
                        "name": "elizaos-agent.service",
                        "active": True,
                        "systemctl_is_active": "active",
                    },
                    "process": {
                        "pid": 31337,
                        "executable": "/opt/elizaos/bin/elizaos",
                        "command": "/opt/elizaos/bin/elizaos start --headless --port=31337",
                    },
                    "health": {
                        "url": "http://127.0.0.1:31337/api/health",
                        "http_status": 200,
                        "ready": True,
                        "response": {
                            "agentId": "elizaos-chip-agent",
                            "status": "ready",
                        },
                    },
                },
            )
            write_json(
                qemu,
                {
                    "schema": "eliza.os.linux.qemu_virt_boot.v1",
                    "boot_completed": True,
                    "provenance": "qemu_virt",
                    "claim_boundary": "qemu_virt_boot_transcript_evidence_only_no_silicon_or_physical_board_claim",
                    "transcript_path": str(transcript),
                },
            )
            write(
                variant / "config/includes.chroot/usr/lib/elizaos/first-boot.sh",
                "systemctl start --no-block elizaos-agent.service\n"
                'READY_LINE="elizaos-firstboot-ready instance=${INSTANCE_UUID}"\n',
            )
            write(
                variant / "config/includes.chroot/opt/elizaos/bin/elizaos",
                "#!/bin/sh\n",
            )
            with PatchStack(patches):
                gate.STATUS_REPORT.write_text(
                    "Status line: candidate_qemu_virt_evidence_collected_chip_target_agent_live_collected\n",
                    encoding="utf-8",
                )
                gate.RELEASE_CHECK.write_text(
                    'REQUIRED_TRANSCRIPT_MARKER = "elizaos-firstboot-ready"\n',
                    encoding="utf-8",
                )
                gate.AGENT_INSTALL_HOOK.write_text(
                    "install -m 0755 /opt/elizaos-artifacts/bun /opt/elizaos/bin/bun\n",
                    encoding="utf-8",
                )
                report = gate.run_check(Namespace(manifest=None, qemu_evidence=None))
        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["findings"], [])
        self.assertEqual(report["next_command_plan"], [])
        self.assertEqual(report["summary"]["next_command_count"], 0)
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
