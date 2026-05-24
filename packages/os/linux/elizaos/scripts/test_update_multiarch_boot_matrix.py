#!/usr/bin/env python3
"""Tests for update-multiarch-boot-matrix.py."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
MODULE_PATH = HERE / "update-multiarch-boot-matrix.py"
spec = importlib.util.spec_from_file_location("update_multiarch_boot_matrix", MODULE_PATH)
assert spec is not None and spec.loader is not None
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def iso_boot_artifacts(missing: list[str] | None = None) -> dict:
    missing = missing or []
    found = {
        key: f"dummy/{key}"
        for key in updater._load_qemu_smoke_module().REQUIRED_ISO_BOOT_ARTIFACTS
        if key not in missing
    }
    return {"found": found, "missing": missing}


class UpdateMultiarchBootMatrixTests(unittest.TestCase):
    def test_promotes_valid_riscv64_qemu_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            provenance = root / "artifacts/riscv64/riscv64-bun-provenance.json"
            provenance.parent.mkdir(parents=True)
            provenance.write_text("{}\n", encoding="utf-8")
            iso = root / "out/elizaos-linux-riscv64-default.iso"
            iso.parent.mkdir(parents=True)
            iso.write_bytes(b"iso")
            evidence_path = root / "evidence/qemu_virt_boot.json"
            evidence_path.parent.mkdir(parents=True)
            transcript = root / "evidence/qemu_virt_boot.transcript.log"
            transcript.write_text(
                "GNU GRUB\nEFI stub: Booting Linux Kernel\nLinux version\n",
                encoding="utf-8",
            )
            evidence = {
                "iso_path": str(iso),
                "iso_sha256": sha256_bytes(b"iso"),
            }
            matrix = {
                "architectures": [
                    {
                        "arch": "riscv64",
                        "status": "candidate-reference",
                        "gaps": ["must be recaptured", "not physical silicon evidence"],
                    }
                ]
            }

            with mock.patch.object(updater, "ROOT", root), mock.patch.object(
                updater, "RISCV64_BUN_PROVENANCE", provenance
            ):
                row = updater.promote_riscv64(matrix, evidence_path, evidence)

            self.assertEqual(row["status"], "candidate")
            self.assertEqual(row["iso"], "out/elizaos-linux-riscv64-default.iso")
            self.assertEqual(row["evidence"], "evidence/qemu_virt_boot.json")
            self.assertNotIn("must be recaptured", row["gaps"])
            self.assertIn("not physical silicon evidence", row["gaps"])
            self.assertIn(
                "Debian live ISO boots under qemu-system-riscv64 -M virt through EDK2/OpenSBI",
                row["proves"],
            )
            self.assertEqual(
                row["runtime_artifacts"]["riscv64_bun_provenance"],
                "artifacts/riscv64/riscv64-bun-provenance.json",
            )

    def test_rejects_iso_hash_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            iso = root / "out/elizaos-linux-riscv64-default.iso"
            iso.parent.mkdir(parents=True)
            iso.write_bytes(b"iso")
            evidence_path = root / "evidence/qemu_virt_boot.json"
            evidence_path.parent.mkdir(parents=True)
            evidence_path.write_text(
                json.dumps(
                    {
                        "schema": "eliza.os.linux.qemu_virt_boot.v1",
                        "claim_boundary": (
                            "qemu_virt_boot_transcript_evidence_only_no_silicon_or_physical_board_claim"
                        ),
                        "iso_path": str(iso),
                        "iso_sha256": "0" * 64,
                        "transcript_path": "transcript.log",
                        "transcript_sha256": "1" * 64,
                        "memory_mb": 4096,
                        "cpus": 4,
                        "timeout_s": 600,
                        "duration_s": 1,
                        "start_utc": "2026-05-23T00:00:00Z",
                        "qemu_exit_code": 0,
                        "u_boot_path": None,
                        "boot_completed": True,
                        "markers_found": list(updater._load_qemu_smoke_module().REQUIRED_MARKERS),
                        "markers_missing": [],
                        "forbidden_markers_present": [],
                        "iso_boot_artifacts": iso_boot_artifacts(),
                        "provenance": "qemu_virt",
                    }
                )
                + "\n",
                encoding="utf-8",
            )

            with self.assertRaisesRegex(ValueError, "iso_sha256 does not match"):
                updater.validate_riscv64_evidence(evidence_path)

    def test_accepts_qemu_smoke_report_wrapper_with_iso_override(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            iso = root / "out/elizaos-linux-riscv64-default.iso"
            iso.parent.mkdir(parents=True)
            iso.write_bytes(b"iso")
            report_path = root / "evidence/qemu_virt_boot.report.json"
            report_path.parent.mkdir(parents=True)
            report_path.write_text(
                json.dumps(
                    {
                        "schema": "eliza.os_rv64_qemu_virt_smoke.v1",
                        "status": "pass",
                        "evidence": {
                            "schema": "eliza.os.linux.qemu_virt_boot.v1",
                            "claim_boundary": (
                                "qemu_virt_boot_transcript_evidence_only_no_silicon_or_physical_board_claim"
                            ),
                            "iso_path": "/container/out/elizaos-linux-riscv64-default.iso",
                            "iso_sha256": sha256_bytes(b"iso"),
                            "transcript_path": "transcript.log",
                            "transcript_sha256": "1" * 64,
                            "memory_mb": 4096,
                            "cpus": 4,
                            "timeout_s": 600,
                            "duration_s": 1,
                            "start_utc": "2026-05-23T00:00:00Z",
                            "qemu_exit_code": 0,
                            "u_boot_path": None,
                            "boot_completed": True,
                            "markers_found": list(updater._load_qemu_smoke_module().REQUIRED_MARKERS),
                            "markers_missing": [],
                            "forbidden_markers_present": [],
                            "iso_boot_artifacts": iso_boot_artifacts(),
                            "provenance": "qemu_virt",
                        },
                    }
                )
                + "\n",
                encoding="utf-8",
            )

            evidence = updater.validate_riscv64_evidence(report_path, iso)

            self.assertEqual(evidence["iso_path"], str(iso))

    def test_refreshes_blocked_riscv64_row_without_candidate_promotion(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            iso = root / "out/elizaos-linux-riscv64-default.iso"
            iso.parent.mkdir(parents=True)
            iso.write_bytes(b"iso")
            evidence_path = root / "evidence/qemu_virt_boot.json"
            evidence_path.parent.mkdir(parents=True)
            evidence = {
                "schema": "eliza.os.linux.qemu_virt_boot.v1",
                "claim_boundary": (
                    "qemu_virt_boot_transcript_evidence_only_no_silicon_or_physical_board_claim"
                ),
                "iso_path": str(iso),
                "iso_sha256": sha256_bytes(b"iso"),
                "transcript_path": "evidence/qemu_virt_boot.transcript.log",
                "transcript_sha256": "1" * 64,
                "memory_mb": 4096,
                "cpus": 4,
                "timeout_s": 600,
                "duration_s": 1,
                "start_utc": "2026-05-23T00:00:00Z",
                "qemu_exit_code": 0,
                "u_boot_path": None,
                "boot_completed": False,
                "markers_found": ["Linux version"],
                "markers_missing": [
                    "elizaos-curl-health-ready",
                    "elizaos-agent-ready",
                    "elizaos-tui-ready",
                ],
                "forbidden_markers_present": [],
                "iso_boot_artifacts": iso_boot_artifacts(),
                "provenance": "qemu_virt",
            }
            evidence_path.write_text(json.dumps(evidence) + "\n", encoding="utf-8")
            app = root / "artifacts/riscv64/elizaos-app"
            app.mkdir(parents=True)
            (app / "agent-bundle.js").write_text("#!/usr/bin/env node\n", encoding="utf-8")
            matrix = {
                "architectures": [
                    {
                        "arch": "riscv64",
                        "status": "stale",
                        "runtime_artifacts": {"bun": "artifacts/riscv64/bun"},
                    }
                ]
            }
            with mock.patch.object(updater, "ROOT", root):
                loaded = updater.validate_riscv64_evidence(evidence_path, allow_blocked=True)
                row = updater.refresh_blocked_riscv64(matrix, evidence_path, loaded)

            self.assertEqual(row["status"], "blocked-current-iso-boot")
            self.assertEqual(row["iso"], "out/elizaos-linux-riscv64-default.iso")
            self.assertIn("GRUB EFI path is visible in transcript", row["proves"])
            self.assertIn("kernel serial transcript includes Linux version", row["proves"])
            self.assertEqual(row["runtime_artifacts"]["runtime_mode"], "node")
            self.assertNotIn("bun", row["runtime_artifacts"])


if __name__ == "__main__":
    unittest.main()
