#!/usr/bin/env python3
"""Tests for scripts/check_linux_firmware_boot_chain_contract.py."""

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

import check_linux_firmware_boot_chain_contract as gate  # noqa: E402


def assert_false_claim_flags(testcase: unittest.TestCase, report: dict[str, object]) -> None:
    testcase.assertEqual(report["claim_boundary"], gate.CLAIM_BOUNDARY)
    for key, expected in gate.FALSE_CLAIM_FLAGS.items():
        testcase.assertIs(report.get(key), expected, key)


def write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def write_json(path: Path, payload: dict) -> Path:
    return write(path, json.dumps(payload, indent=2, sort_keys=True) + "\n")


def evidence_item(target: str, artifact: str, path: str) -> dict:
    return {
        "artifact": artifact,
        "path": path,
        "min_bytes": 40,
        "required_strings": [
            f"eliza-evidence: target={target} artifact={artifact}",
            "eliza-evidence: status=PASS",
        ],
    }


def manifest() -> dict:
    return {
        "schema_version": 1,
        "targets": {
            "buildroot": {
                "evidence": [
                    evidence_item(
                        "buildroot",
                        "eliza_e1_defconfig",
                        "docs/evidence/buildroot/eliza_e1_defconfig.log",
                    ),
                    evidence_item(
                        "buildroot",
                        "e1-mmio-smoke",
                        "docs/evidence/buildroot/e1-mmio-smoke.log",
                    ),
                ]
            },
            "opensbi": {
                "evidence": [
                    evidence_item(
                        "opensbi",
                        "opensbi_eliza_build",
                        "docs/evidence/linux/opensbi_eliza_build.log",
                    ),
                    evidence_item(
                        "opensbi",
                        "opensbi_fw_dynamic_handoff",
                        "docs/evidence/linux/opensbi_fw_dynamic_handoff.log",
                    ),
                ]
            },
            "u-boot": {
                "evidence": [
                    evidence_item(
                        "u-boot",
                        "u_boot_eliza_build",
                        "docs/evidence/linux/u_boot_eliza_build.log",
                    ),
                    evidence_item(
                        "u-boot",
                        "u_boot_opensbi_boot_chain",
                        "docs/evidence/linux/u_boot_opensbi_boot_chain.log",
                    ),
                ]
            },
        },
    }


def multiarch_matrix(*, status: str = "candidate-reference", gaps: list[str] | None = None) -> dict:
    return {
        "schema": "eliza.os.linux.multiarch_boot_matrix.v1",
        "debian_riscv64_port_contract": {
            "architecture": "riscv64",
            "bootloader_packages": ["grub-efi-riscv64", "grub-efi-riscv64-bin"],
            "firmware_chain": gate.SELECTED_RISCV64_FIRMWARE_CHAIN,
            "removable_uefi_path": "EFI/boot/bootriscv64.efi",
        },
        "architectures": [
            {
                "arch": "riscv64",
                "status": status,
                "iso": "out/elizaos-linux-riscv64-default.iso",
                "sha256": "a" * 64,
                "evidence": "evidence/qemu_virt_boot.json",
                "gaps": gaps
                if gaps is not None
                else ["current riscv64 ISO evidence must be recaptured"],
            }
        ],
    }


class LinuxFirmwareBootChainContractTests(unittest.TestCase):
    def _patch_tree(self, tmp: Path):
        write_json(tmp / "docs/evidence/software-bsp-evidence-manifest.json", manifest())
        write_json(
            tmp / "packages/os/linux/elizaos/evidence/multiarch_boot_matrix.json",
            multiarch_matrix(),
        )
        write_json(
            tmp / "docs/evidence/software-bsp-external-preflight-status.json",
            {
                "status": "BLOCKED",
                "host": {"cwd": "/Users/shawwalters/Desktop/npu_experiment"},
                "targets": [
                    {
                        "target": "opensbi",
                        "commands": [
                            "ELIZA_OPENSBI_HANDOFF_CMD='/exact/qemu-or-renode fw_dynamic handoff command'"
                        ],
                    }
                ],
            },
        )
        write(
            tmp / "scripts/check_software_bsp.py",
            'TARGETS = {"buildroot": {}, "linux": {}, "opensbi": {}, "aosp": {}}\n',
        )
        write(
            tmp / "docs/sw/buildroot/README.md",
            "claim_boundary buildroot_qemu_virt_smoke_evidence_only_no_silicon_or_physical_board_claim\n",
        )
        write(tmp / "docs/sw/opensbi/README.md", "OpenSBI fw_dynamic handoff\n")
        write(tmp / "docs/sw/u-boot/README.md", "U-Boot OpenSBI boot-chain\n")
        write(
            tmp / "sw/buildroot/scripts/capture-buildroot-qemu-virt-smoke.sh",
            "qemu-virt boot transcript evidence only; does NOT prove silicon boot\n",
        )
        write(
            tmp / "docs/evidence/buildroot/eliza_e1_defconfig.log.BLOCKED",
            "required command mentions openphone_hello_defconfig\n",
        )

        return [
            mock.patch.object(gate, "ROOT", tmp),
            mock.patch.object(
                gate,
                "EVIDENCE_MANIFEST",
                tmp / "docs/evidence/software-bsp-evidence-manifest.json",
            ),
            mock.patch.object(
                gate,
                "PREFLIGHT_REPORT",
                tmp / "docs/evidence/software-bsp-external-preflight-status.json",
            ),
            mock.patch.object(gate, "CHECK_SOFTWARE_BSP", tmp / "scripts/check_software_bsp.py"),
            mock.patch.object(gate, "BUILDROOT_README", tmp / "docs/sw/buildroot/README.md"),
            mock.patch.object(gate, "OPENSBI_README", tmp / "docs/sw/opensbi/README.md"),
            mock.patch.object(gate, "UBOOT_README", tmp / "docs/sw/u-boot/README.md"),
            mock.patch.object(
                gate,
                "QEMU_VIRT_SCRIPT",
                tmp / "sw/buildroot/scripts/capture-buildroot-qemu-virt-smoke.sh",
            ),
            mock.patch.object(gate, "BUILDROOT_BLOCKED_DIR", tmp / "docs/evidence/buildroot"),
            mock.patch.object(gate, "REPO_ROOT", tmp),
            mock.patch.object(
                gate,
                "ELIZAOS_MULTIARCH_BOOT_MATRIX",
                tmp / "packages/os/linux/elizaos/evidence/multiarch_boot_matrix.json",
            ),
            mock.patch.object(
                gate,
                "REPORT",
                tmp / "build/reports/linux_firmware_boot_chain_contract.json",
            ),
        ]

    def test_missing_evidence_and_stale_boot_chain_contract_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir, PatchStack(self._patch_tree(Path(tmpdir))):
            report = gate.run_check(Namespace())

        self.assertEqual(report["status"], "blocked")
        assert_false_claim_flags(self, report)
        codes = {finding["code"] for finding in report["findings"]}
        self.assertIn("buildroot_external_evidence_missing", codes)
        self.assertIn("opensbi_external_evidence_missing", codes)
        self.assertIn("selected_riscv64_grub_chain_evidence_incomplete", codes)
        self.assertIn("u_boot_alternate_boot_chain_not_selected", codes)
        self.assertIn("uboot_evidence_not_in_software_bsp_gate", codes)
        self.assertIn("buildroot_qemu_virt_reference_only", codes)
        self.assertIn("buildroot_blocked_sidecars_use_openphone_markers", codes)
        self.assertIn("software_bsp_preflight_has_host_local_paths", codes)
        self.assertIn("opensbi_handoff_command_placeholder", codes)
        placeholder = next(
            finding
            for finding in report["findings"]
            if finding["code"] == "opensbi_handoff_command_placeholder"
        )
        self.assertEqual(placeholder["blocker_dependency"], "live_device_validation")
        self.assertIn(
            "check_software_bsp.py external-preflight opensbi", placeholder["next_command"]
        )
        self.assertIn("--opensbi-handoff-cmd", placeholder["next_command"])
        self.assertNotIn("check_software_bsp_external_preflight.py", placeholder["next_command"])
        reference_only = next(
            finding
            for finding in report["findings"]
            if finding["code"] == "buildroot_qemu_virt_reference_only"
        )
        self.assertEqual(
            reference_only["next_command"],
            "python3 scripts/check_software_bsp.py buildroot --evidence-plan",
        )
        self.assertEqual(report["blocker_dependency_counts"]["live_device_validation"], 1)
        self.assertEqual(report["summary"]["next_command_batch_count"], 4)
        commands = {batch["id"]: batch for batch in report["next_command_plan"]}
        handoff_batch = commands["resolve_opensbi_handoff_command_placeholder"]
        self.assertEqual(
            handoff_batch["claim_boundary"],
            "operator_commands_only_not_firmware_boot_evidence",
        )
        self.assertEqual(handoff_batch["blocker_dependency"], "live_device_validation")
        self.assertIn(
            "python3 scripts/check_software_bsp.py external-preflight opensbi",
            handoff_batch["commands"][0],
        )
        self.assertIn("--opensbi-handoff-cmd", handoff_batch["commands"][0])
        self.assertNotIn(
            "resolve_u_boot_alternate_boot_chain_not_selected",
            commands,
        )

    def test_complete_boot_chain_contract_passes_static_checks(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            with PatchStack(self._patch_tree(tmp)):
                write_json(
                    gate.PREFLIGHT_REPORT,
                    {"status": "PASS", "host": {"cwd": "/work/eliza"}, "targets": []},
                )
                gate.CHECK_SOFTWARE_BSP.write_text(
                    'TARGETS = {"buildroot": {}, "linux": {}, "opensbi": {}, "aosp": {}, "u-boot": {}}\n',
                    encoding="utf-8",
                )
                gate.BUILDROOT_README.write_text(
                    "Buildroot chip-target smoke evidence.\n", encoding="utf-8"
                )
                gate.QEMU_VIRT_SCRIPT.write_text(
                    "qemu helper kept outside chip readiness.\n", encoding="utf-8"
                )
                iso = tmp / "packages/os/linux/elizaos/out/elizaos-linux-riscv64-default.iso"
                write(iso, "iso")
                evidence = tmp / "packages/os/linux/elizaos/evidence/qemu_virt_boot.json"
                write(evidence, "{}\n")
                write_json(
                    gate.ELIZAOS_MULTIARCH_BOOT_MATRIX,
                    multiarch_matrix(
                        status="candidate",
                        gaps=["not physical silicon evidence"],
                    )
                    | {
                        "architectures": [
                            {
                                **multiarch_matrix(status="candidate")["architectures"][0],
                                "sha256": gate.sha256_file(iso),
                                "gaps": ["not physical silicon evidence"],
                            }
                        ]
                    },
                )
                for sidecar in gate.BUILDROOT_BLOCKED_DIR.glob("*.BLOCKED"):
                    sidecar.unlink()

                for target_doc in manifest()["targets"].values():
                    for item in target_doc["evidence"]:
                        write(
                            gate.ROOT / item["path"],
                            f"{item['required_strings'][0]}\n"
                            "external tree command completed\n"
                            f"{item['required_strings'][1]}\n",
                        )

                report = gate.run_check(Namespace())

        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["findings"], [])
        self.assertEqual(report["next_command_plan"], [])
        self.assertEqual(report["summary"]["next_command_batch_count"], 0)
        assert_false_claim_flags(self, report)
        self.assertEqual(
            report["blocker_dependency_counts"],
            {
                "repo_artifact_generation": 0,
                "live_device_validation": 0,
                "actionable_external_dependency": 0,
            },
        )


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
