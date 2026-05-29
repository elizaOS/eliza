#!/usr/bin/env python3
"""Tests for scripts/check_boot_security_chain_contract.py."""

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

import check_boot_security_chain_contract as gate  # noqa: E402


def write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def write_json(path: Path, payload: dict) -> Path:
    return write(path, json.dumps(payload, indent=2, sort_keys=True) + "\n")


def stale_contract() -> dict:
    return {
        "e1_chip": {
            "has_cpu": False,
            "boot_rom": {
                "words": [{"offset": "0x0c", "name": "boot_vector_placeholder", "value": "0x1000"}]
            },
        }
    }


def ready_contract() -> dict:
    return {
        "e1_chip": {
            "has_cpu": False,
            "boot_rom": {
                "words": [{"offset": "0x0c", "name": "boot_vector_placeholder", "value": "0x1000"}]
            },
        },
        "e1_chip_cpu_variant": {
            "has_cpu": True,
            "boot": {"reset_vector": "0x1000"},
        },
    }


class BootSecurityChainContractTests(unittest.TestCase):
    def _patch_tree(self, tmp: Path):
        write_json(tmp / "sw/platform/e1_platform_contract.json", stale_contract())
        write(
            tmp / "rtl/bootrom/e1_bootrom.sv",
            "6'h00: rdata = 32'h4F50_534F; 6'h01: rdata = 32'h4348_4950; 6'h03: rdata = 32'h0000_1000;\n",
        )
        write(
            tmp / "fw/boot-rom/reset.S",
            "/* does not authenticate payloads, initialize DRAM, provide SBI services, or prove an OpenSBI/Linux handoff */\n"
            ".dword  0x0000000080000000\n",
        )
        write(
            tmp / "fw/boot-rom/check_boot_rom.py",
            'status("BLOCKED", "bootrom.check", "needs a local RISC-V toolchain")\nreturn 0\n',
        )
        write(
            tmp / "docs/boot-rom/release-evidence.md",
            "It does not claim that the ROM is wired into the CPU wrapper or exercised by simulator or hardware transcript.\n",
        )
        write(
            tmp / "fw/pmc/src/secure_boot.c",
            "/* Placeholder verifier. */\nint pmc_secure_boot_verify(const unsigned char *image, unsigned long length) { return 0; }\n",
        )
        write(
            tmp / "fw/pmc/README.md",
            "secure_boot.c - HMAC/ECDSA placeholder\nSecure-boot key provisioning not closed.\n",
        )
        write(tmp / "docs/security/secure-boot-lifecycle-evidence.md", "Status: BLOCKED\n")
        write(tmp / "docs/security/boot-image-format.md", "Status: pre-silicon specification\n")
        write(tmp / "docs/security/avb-a-b-ota.md", "No verified-boot path executes today.\n")
        write(
            tmp / "docs/security/key-ceremony.md",
            "No HSM, signer infrastructure, or audit pipeline exists yet.\n",
        )
        return [
            mock.patch.object(gate, "ROOT", tmp),
            mock.patch.object(
                gate, "PLATFORM_CONTRACT", tmp / "sw/platform/e1_platform_contract.json"
            ),
            mock.patch.object(gate, "BOOTROM_RTL", tmp / "rtl/bootrom/e1_bootrom.sv"),
            mock.patch.object(gate, "RESET_ROM", tmp / "fw/boot-rom/reset.S"),
            mock.patch.object(gate, "BOOTROM_CHECKER", tmp / "fw/boot-rom/check_boot_rom.py"),
            mock.patch.object(
                gate, "BOOTROM_RELEASE_EVIDENCE", tmp / "docs/boot-rom/release-evidence.md"
            ),
            mock.patch.object(
                gate,
                "BOOTROM_SIM_REPORT",
                tmp / "build/reports/gate-bootrom-sim-transcript-check.json",
            ),
            mock.patch.object(
                gate,
                "BOOTROM_SIM_TRANSCRIPT",
                tmp / "docs/boot-rom/transcripts/e1_secure_bootrom_qemu_rv64.txt",
            ),
            mock.patch.object(
                gate,
                "BOOTROM_POSITIVE_HANDOFF_REPORT",
                tmp / "build/reports/gate-bootrom-positive-handoff-check.json",
            ),
            mock.patch.object(
                gate,
                "BOOTROM_POSITIVE_HANDOFF_TRANSCRIPT",
                tmp / "docs/boot-rom/transcripts/e1_secure_bootrom_positive_handoff_qemu_rv64.txt",
            ),
            mock.patch.object(gate, "PMC_SECURE_BOOT", tmp / "fw/pmc/src/secure_boot.c"),
            mock.patch.object(gate, "PMC_README", tmp / "fw/pmc/README.md"),
            mock.patch.object(
                gate,
                "SECURE_BOOT_LIFECYCLE",
                tmp / "docs/security/secure-boot-lifecycle-evidence.md",
            ),
            mock.patch.object(
                gate, "BOOT_IMAGE_FORMAT", tmp / "docs/security/boot-image-format.md"
            ),
            mock.patch.object(gate, "AVB_OTA", tmp / "docs/security/avb-a-b-ota.md"),
            mock.patch.object(gate, "KEY_CEREMONY", tmp / "docs/security/key-ceremony.md"),
            mock.patch.object(gate, "REPORT", tmp / "build/reports/boot_security_chain.json"),
        ]

    def test_placeholder_boot_security_chain_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir, PatchStack(self._patch_tree(Path(tmpdir))):
            report = gate.run_check(Namespace())

        self.assertEqual(report["status"], "blocked")
        codes = {finding["code"] for finding in report["findings"]}
        self.assertIn("platform_contract_has_no_cpu_boot_target", codes)
        self.assertIn("platform_contract_boot_vector_placeholder", codes)
        self.assertIn("rtl_bootrom_identity_only_not_executable_reset_rom", codes)
        self.assertIn("reset_rom_handoff_not_authenticated_or_proven", codes)
        self.assertIn("bootrom_checker_masks_toolchain_blocked_as_success", codes)
        self.assertIn("bootrom_release_evidence_not_wired_or_exercised", codes)
        self.assertIn("bootrom_release_evidence_missing_transcript_gate", codes)
        self.assertIn("bootrom_sim_transcript_report_missing", codes)
        self.assertIn("bootrom_positive_handoff_report_missing", codes)
        self.assertIn("pmc_secure_boot_placeholder_accepts_all", codes)
        self.assertIn("pmc_secure_boot_release_blockers_open", codes)
        self.assertIn("security_boot_docs_are_pre_silicon_or_blocked", codes)

    def test_complete_static_contract_passes(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            with PatchStack(self._patch_tree(tmp)):
                write_json(gate.PLATFORM_CONTRACT, ready_contract())
                gate.BOOTROM_RTL.write_text(
                    'initial $readmemh("build/boot-rom/e1_secure_boot_rom.hex", rom);\n',
                    encoding="utf-8",
                )
                gate.RESET_ROM.write_text(
                    "verify_signature:\n"
                    "    call authenticate_image\n"
                    "    call init_dram\n"
                    "    call enter_opensbi\n",
                    encoding="utf-8",
                )
                gate.BOOTROM_CHECKER.write_text(
                    "if missing_toolchain:\n    return 2\n",
                    encoding="utf-8",
                )
                gate.BOOTROM_RELEASE_EVIDENCE.write_text(
                    "scripts/check_bootrom_sim_transcript.py checks "
                    "docs/boot-rom/transcripts/e1_secure_bootrom_qemu_rv64.txt.\n",
                    encoding="utf-8",
                )
                write_json(
                    gate.BOOTROM_SIM_REPORT,
                    {
                        "schema": "eliza.gate_status.v1",
                        "gate": "boot.bootrom_sim_transcript",
                        "status": "PASS",
                        "checks": [
                            {"id": marker, "status": "pass", "detail": "found"}
                            for marker in sorted(gate.REQUIRED_BOOTROM_SIM_MARKERS)
                        ],
                    },
                )
                write(
                    gate.BOOTROM_POSITIVE_HANDOFF_TRANSCRIPT,
                    "reset-vector-fetch <_start>\n"
                    "<e1_secure_boot_main>\n"
                    "authenticated-image-verified\n"
                    "handoff-target-loaded-from-manifest\n"
                    "OpenSBI entry reached\n",
                )
                write_json(
                    gate.BOOTROM_POSITIVE_HANDOFF_REPORT,
                    {
                        "schema": "eliza.gate_status.v1",
                        "gate": "boot.bootrom_positive_handoff",
                        "status": "PASS",
                        "evidence_paths": [
                            gate.BOOTROM_POSITIVE_HANDOFF_TRANSCRIPT.relative_to(
                                gate.ROOT
                            ).as_posix()
                        ],
                        "checks": [
                            {"id": marker, "status": "pass", "detail": "found"}
                            for marker in sorted(gate.REQUIRED_POSITIVE_HANDOFF_MARKERS)
                        ],
                    },
                )
                gate.PMC_SECURE_BOOT.write_text(
                    "int pmc_secure_boot_verify(const unsigned char *image, unsigned long length) {\n"
                    "  if (!image || length == 0) return -1;\n"
                    "  return verify_signature_and_rollback(image, length);\n"
                    "}\n",
                    encoding="utf-8",
                )
                gate.PMC_README.write_text(
                    "Secure boot verifier and key provisioning are closed by evidence.\n",
                    encoding="utf-8",
                )
                for doc in (
                    gate.SECURE_BOOT_LIFECYCLE,
                    gate.BOOT_IMAGE_FORMAT,
                    gate.AVB_OTA,
                    gate.KEY_CEREMONY,
                ):
                    doc.write_text(
                        "Implementation evidence captured and validated.\n", encoding="utf-8"
                    )
                report = gate.run_check(Namespace())

        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["findings"], [])
        self.assertEqual(report["claim_boundary"], gate.CLAIM_BOUNDARY)

    def test_positive_handoff_report_must_cite_transcript_and_markers(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            with PatchStack(self._patch_tree(tmp)):
                write_json(gate.PLATFORM_CONTRACT, ready_contract())
                gate.BOOTROM_RTL.write_text(
                    'initial $readmemh("build/boot-rom/e1_secure_boot_rom.hex", rom);\n',
                    encoding="utf-8",
                )
                gate.RESET_ROM.write_text(
                    "verify_signature:\n"
                    "    call authenticate_image\n"
                    "    call init_dram\n"
                    "    call enter_opensbi\n",
                    encoding="utf-8",
                )
                gate.BOOTROM_CHECKER.write_text(
                    "if missing_toolchain:\n    return 2\n",
                    encoding="utf-8",
                )
                gate.BOOTROM_RELEASE_EVIDENCE.write_text(
                    "scripts/check_bootrom_sim_transcript.py checks "
                    "docs/boot-rom/transcripts/e1_secure_bootrom_qemu_rv64.txt.\n",
                    encoding="utf-8",
                )
                write_json(
                    gate.BOOTROM_SIM_REPORT,
                    {
                        "schema": "eliza.gate_status.v1",
                        "gate": "boot.bootrom_sim_transcript",
                        "status": "PASS",
                        "checks": [
                            {"id": marker, "status": "pass", "detail": "found"}
                            for marker in sorted(gate.REQUIRED_BOOTROM_SIM_MARKERS)
                        ],
                    },
                )
                write_json(
                    gate.BOOTROM_POSITIVE_HANDOFF_REPORT,
                    {
                        "schema": "eliza.gate_status.v1",
                        "gate": "boot.bootrom_positive_handoff",
                        "status": "PASS",
                        "evidence_paths": ["docs/boot-rom/transcripts/wrong.log"],
                        "checks": [
                            {
                                "id": "reset_vector_fetch",
                                "status": "pass",
                                "detail": "found",
                            }
                        ],
                    },
                )
                gate.PMC_SECURE_BOOT.write_text(
                    "int pmc_secure_boot_verify(const unsigned char *image, unsigned long length) {\n"
                    "  if (!image || length == 0) return -1;\n"
                    "  return verify_signature_and_rollback(image, length);\n"
                    "}\n",
                    encoding="utf-8",
                )
                gate.PMC_README.write_text(
                    "Secure boot verifier and key provisioning are closed by evidence.\n",
                    encoding="utf-8",
                )
                for doc in (
                    gate.SECURE_BOOT_LIFECYCLE,
                    gate.BOOT_IMAGE_FORMAT,
                    gate.AVB_OTA,
                    gate.KEY_CEREMONY,
                ):
                    doc.write_text(
                        "Implementation evidence captured and validated.\n", encoding="utf-8"
                    )

                report = gate.run_check(Namespace())

        codes = {finding["code"] for finding in report["findings"]}
        self.assertEqual(report["status"], "blocked")
        self.assertIn("bootrom_positive_handoff_transcript_not_cited", codes)
        self.assertIn("bootrom_positive_handoff_missing_required_markers", codes)


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
