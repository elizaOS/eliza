#!/usr/bin/env python3
"""Tests for qemu_virt_smoke.py validation helpers."""

from __future__ import annotations

import contextlib
import hashlib
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).resolve().with_name("qemu_virt_smoke.py")
SPEC = importlib.util.spec_from_file_location("qemu_virt_smoke", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
qemu_virt_smoke = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(qemu_virt_smoke)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def iso_boot_artifacts(missing: list[str] | None = None) -> dict:
    missing = missing or []
    found = {
        key: f"/{key}"
        for key in qemu_virt_smoke.REQUIRED_ISO_BOOT_ARTIFACTS
        if key not in missing
    }
    return {"found": found, "missing": missing}


class QemuVirtSmokeTests(unittest.TestCase):
    def test_run_harness_streams_child_output(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            iso = root / "boot.iso"
            harness = root / "qemu_virt_boot_riscv64.sh"
            iso.write_bytes(b"iso")
            harness.write_text("#!/bin/sh\n", encoding="utf-8")
            with mock.patch.object(qemu_virt_smoke.subprocess, "run") as run:
                run.return_value = qemu_virt_smoke.subprocess.CompletedProcess(
                    ["bash", str(harness)], 0
                )
                result = qemu_virt_smoke.run_harness(
                    iso,
                    timeout_s=900,
                    bash_harness=harness,
                )

        self.assertEqual(result.returncode, 0)
        _, kwargs = run.call_args
        self.assertNotIn("capture_output", kwargs)
        self.assertEqual(kwargs["text"], True)
        self.assertEqual(kwargs["check"], False)
        self.assertIn("--timeout", run.call_args.args[0])
        self.assertIn("900", run.call_args.args[0])

    def test_validate_existing_refreshes_report_without_launching_qemu(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            variant = root / "packages/os/linux/elizaos"
            evidence_dir = variant / "evidence"
            out_dir = variant / "out"
            evidence_dir.mkdir(parents=True)
            out_dir.mkdir(parents=True)
            iso = out_dir / "elizaos-linux-riscv64.iso"
            transcript = evidence_dir / "qemu_virt_boot.transcript.log"
            iso.write_bytes(b"iso")
            transcript.write_text("Linux version\nelizaos-agent-ready\n", encoding="utf-8")
            evidence = evidence_dir / "qemu_virt_boot.json"
            evidence.write_text(
                json.dumps(
                    {
                        "schema": qemu_virt_smoke.EVIDENCE_SCHEMA,
                        "claim_boundary": qemu_virt_smoke.CLAIM_BOUNDARY,
                        "iso_path": str(iso),
                        "iso_sha256": sha256(iso),
                        "transcript_path": "evidence/qemu_virt_boot.transcript.log",
                        "transcript_sha256": sha256(transcript),
                        "memory_mb": 4096,
                        "cpus": 4,
                        "timeout_s": 600,
                        "duration_s": 8,
                        "start_utc": "2026-05-23T00:00:00Z",
                        "qemu_exit_code": 0,
                        "u_boot_path": None,
                        "boot_completed": True,
                        "markers_found": list(qemu_virt_smoke.REQUIRED_MARKERS),
                        "markers_missing": [],
                        "forbidden_markers_present": [],
                        "iso_boot_artifacts": iso_boot_artifacts(),
                        "provenance": qemu_virt_smoke.PROVENANCE,
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            report = root / "report.json"
            stdout = io.StringIO()
            with (
                mock.patch.object(qemu_virt_smoke, "VARIANT_DIR", variant),
                contextlib.redirect_stdout(stdout),
            ):
                rc = qemu_virt_smoke.main(
                    ["--validate-existing", "--evidence", str(evidence), "--report", str(report)]
                )
            data = json.loads(report.read_text(encoding="utf-8"))

        self.assertEqual(rc, 0)
        self.assertIn("existing evidence validated", stdout.getvalue())
        self.assertEqual(data["status"], "pass")
        self.assertEqual(data["evidence"]["boot_completed"], True)

    def test_validate_existing_resolves_repo_token_paths(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            variant = root / "packages/os/linux/elizaos"
            evidence_dir = variant / "evidence"
            out_dir = variant / "out"
            evidence_dir.mkdir(parents=True)
            out_dir.mkdir(parents=True)
            iso = out_dir / "elizaos-linux-riscv64.iso"
            transcript = evidence_dir / "qemu_virt_boot.transcript.log"
            iso.write_bytes(b"iso")
            transcript.write_text("Linux version\nelizaos-agent-ready\n", encoding="utf-8")
            evidence = evidence_dir / "qemu_virt_boot.json"
            evidence.write_text(
                json.dumps(
                    {
                        "schema": qemu_virt_smoke.EVIDENCE_SCHEMA,
                        "claim_boundary": qemu_virt_smoke.CLAIM_BOUNDARY,
                        "iso_path": "<repo>/packages/os/linux/elizaos/out/elizaos-linux-riscv64.iso",
                        "iso_sha256": sha256(iso),
                        "transcript_path": (
                            "<repo>/packages/os/linux/elizaos/evidence/"
                            "qemu_virt_boot.transcript.log"
                        ),
                        "transcript_sha256": sha256(transcript),
                        "memory_mb": 4096,
                        "cpus": 4,
                        "timeout_s": 600,
                        "duration_s": 8,
                        "start_utc": "2026-05-23T00:00:00Z",
                        "qemu_exit_code": 0,
                        "u_boot_path": None,
                        "boot_completed": True,
                        "markers_found": list(qemu_virt_smoke.REQUIRED_MARKERS),
                        "markers_missing": [],
                        "forbidden_markers_present": [],
                        "iso_boot_artifacts": iso_boot_artifacts(),
                        "provenance": qemu_virt_smoke.PROVENANCE,
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            report = root / "report.json"
            with (
                mock.patch.object(qemu_virt_smoke, "VARIANT_DIR", variant),
                mock.patch.object(qemu_virt_smoke, "REPO_ROOT", root),
            ):
                rc = qemu_virt_smoke.main(
                    ["--validate-existing", "--evidence", str(evidence), "--report", str(report)]
                )
            data = json.loads(report.read_text(encoding="utf-8"))

        self.assertEqual(rc, 0)
        self.assertEqual(data["status"], "pass")

    def test_validate_existing_rejects_hash_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            variant = root / "packages/os/linux/elizaos"
            evidence_dir = variant / "evidence"
            out_dir = variant / "out"
            evidence_dir.mkdir(parents=True)
            out_dir.mkdir(parents=True)
            iso = out_dir / "elizaos-linux-riscv64.iso"
            transcript = evidence_dir / "qemu_virt_boot.transcript.log"
            iso.write_bytes(b"iso")
            transcript.write_text("boot\n", encoding="utf-8")
            evidence = evidence_dir / "qemu_virt_boot.json"
            evidence.write_text(
                json.dumps(
                    {
                        "schema": qemu_virt_smoke.EVIDENCE_SCHEMA,
                        "claim_boundary": qemu_virt_smoke.CLAIM_BOUNDARY,
                        "iso_path": str(iso),
                        "iso_sha256": "0" * 64,
                        "transcript_path": "evidence/qemu_virt_boot.transcript.log",
                        "transcript_sha256": sha256(transcript),
                        "memory_mb": 4096,
                        "cpus": 4,
                        "timeout_s": 600,
                        "duration_s": 8,
                        "start_utc": "2026-05-23T00:00:00Z",
                        "qemu_exit_code": 0,
                        "u_boot_path": None,
                        "boot_completed": True,
                        "markers_found": list(qemu_virt_smoke.REQUIRED_MARKERS),
                        "markers_missing": [],
                        "forbidden_markers_present": [],
                        "iso_boot_artifacts": iso_boot_artifacts(),
                        "provenance": qemu_virt_smoke.PROVENANCE,
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            report = root / "report.json"
            with mock.patch.object(qemu_virt_smoke, "VARIANT_DIR", variant):
                rc = qemu_virt_smoke.main(
                    ["--validate-existing", "--evidence", str(evidence), "--report", str(report)]
                )
            data = json.loads(report.read_text(encoding="utf-8"))

        self.assertEqual(rc, 2)
        self.assertEqual(data["status"], "blocked")
        self.assertIn("sha256 mismatch", data["message"])

    def test_refresh_existing_recomputes_markers_from_transcript(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            variant = root / "packages/os/linux/elizaos"
            evidence_dir = variant / "evidence"
            out_dir = variant / "out"
            evidence_dir.mkdir(parents=True)
            out_dir.mkdir(parents=True)
            iso = out_dir / "elizaos-linux-riscv64.iso"
            transcript = evidence_dir / "qemu_virt_boot.transcript.log"
            iso.write_bytes(b"iso")
            transcript.write_text(
                "Linux version\nelizaos-firstboot-ready\n",
                encoding="utf-8",
            )
            evidence = evidence_dir / "qemu_virt_boot.json"
            evidence.write_text(
                json.dumps(
                    {
                        "schema": qemu_virt_smoke.EVIDENCE_SCHEMA,
                        "claim_boundary": qemu_virt_smoke.CLAIM_BOUNDARY,
                        "iso_path": str(iso),
                        "iso_sha256": sha256(iso),
                        "transcript_path": "evidence/qemu_virt_boot.transcript.log",
                        "transcript_sha256": "0" * 64,
                        "memory_mb": 4096,
                        "cpus": 4,
                        "timeout_s": 600,
                        "duration_s": 8,
                        "start_utc": "2026-05-23T00:00:00Z",
                        "qemu_exit_code": 0,
                        "u_boot_path": None,
                        "boot_completed": False,
                        "markers_found": ["Linux version"],
                        "markers_missing": list(qemu_virt_smoke.REQUIRED_MARKERS[1:]),
                        "forbidden_markers_present": [],
                        "iso_boot_artifacts": iso_boot_artifacts(),
                        "provenance": qemu_virt_smoke.PROVENANCE,
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            report = root / "report.json"
            with mock.patch.object(qemu_virt_smoke, "VARIANT_DIR", variant):
                rc = qemu_virt_smoke.main(
                    ["--refresh-existing", "--evidence", str(evidence), "--report", str(report)]
                )
            refreshed = json.loads(evidence.read_text(encoding="utf-8"))
            data = json.loads(report.read_text(encoding="utf-8"))
            expected_transcript_sha = sha256(transcript)

        self.assertEqual(rc, 2)
        self.assertIn("elizaos-firstboot-ready", refreshed["markers_found"])
        self.assertNotIn("elizaos-firstboot-ready", refreshed["markers_missing"])
        self.assertEqual(refreshed["transcript_sha256"], expected_transcript_sha)
        self.assertEqual(data["status"], "blocked")

    def test_validate_existing_rejects_missing_iso_boot_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            variant = root / "packages/os/linux/elizaos"
            evidence_dir = variant / "evidence"
            out_dir = variant / "out"
            evidence_dir.mkdir(parents=True)
            out_dir.mkdir(parents=True)
            iso = out_dir / "elizaos-linux-riscv64.iso"
            transcript = evidence_dir / "qemu_virt_boot.transcript.log"
            iso.write_bytes(b"iso")
            transcript.write_text(
                "\n".join(qemu_virt_smoke.REQUIRED_MARKERS) + "\n",
                encoding="utf-8",
            )
            evidence = evidence_dir / "qemu_virt_boot.json"
            evidence.write_text(
                json.dumps(
                    {
                        "schema": qemu_virt_smoke.EVIDENCE_SCHEMA,
                        "claim_boundary": qemu_virt_smoke.CLAIM_BOUNDARY,
                        "iso_path": str(iso),
                        "iso_sha256": sha256(iso),
                        "transcript_path": "evidence/qemu_virt_boot.transcript.log",
                        "transcript_sha256": sha256(transcript),
                        "memory_mb": 4096,
                        "cpus": 4,
                        "timeout_s": 600,
                        "duration_s": 8,
                        "start_utc": "2026-05-23T00:00:00Z",
                        "qemu_exit_code": 0,
                        "u_boot_path": None,
                        "boot_completed": True,
                        "markers_found": list(qemu_virt_smoke.REQUIRED_MARKERS),
                        "markers_missing": [],
                        "forbidden_markers_present": [],
                        "iso_boot_artifacts": iso_boot_artifacts(
                            ["riscv64_removable_uefi_loader"]
                        ),
                        "provenance": qemu_virt_smoke.PROVENANCE,
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            report = root / "report.json"
            with mock.patch.object(qemu_virt_smoke, "VARIANT_DIR", variant):
                rc = qemu_virt_smoke.main(
                    ["--validate-existing", "--evidence", str(evidence), "--report", str(report)]
                )
            data = json.loads(report.read_text(encoding="utf-8"))

        self.assertEqual(rc, 2)
        self.assertEqual(data["status"], "blocked")
        self.assertIn("ISO boot artifacts are missing", data["message"])


if __name__ == "__main__":
    unittest.main()
