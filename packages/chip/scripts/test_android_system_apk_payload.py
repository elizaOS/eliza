#!/usr/bin/env python3
"""Tests for scripts/check_android_system_apk_payload.py."""

from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
import warnings
import zipfile
from argparse import Namespace
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

import check_android_system_apk_payload as gate  # noqa: E402


def make_apk(path: Path, entries: list[str]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as zf:
        for entry in entries:
            zf.writestr(entry, "x")
    return path


def make_complete_apk(
    path: Path,
    *,
    provenance_overrides: dict | None = None,
    runtime_overrides: dict | None = None,
    runtime_file_overrides: dict[str, dict] | None = None,
) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload_entries = list(gate.REQUIRED_ENTRIES)
    file_rows = [
        {
            "path": entry,
            "size_bytes": 1,
            "sha256": hashlib.sha256(b"x").hexdigest(),
        }
        for entry in payload_entries
    ]
    if runtime_file_overrides:
        for row in file_rows:
            override = runtime_file_overrides.get(row["path"])
            if override:
                row.update(override)
    runtime_provenance = {
        "schema": gate.RUNTIME_PROVENANCE_SCHEMA,
        "claim_boundary": gate.RUNTIME_PROVENANCE_CLAIM_BOUNDARY,
        "riscv64_bun_artifact": {
            "required": True,
            "filename": "bun-linux-riscv64-musl.zip",
            "sha256": "a" * 64,
            "source": {
                "kind": "local",
                "path": "packages/app-core/scripts/bun-riscv64/dist/bun-linux-riscv64-musl.zip",
            },
        },
        "files": file_rows,
    }
    if runtime_overrides:
        runtime_provenance.update(runtime_overrides)
    runtime_bytes = json.dumps(runtime_provenance, sort_keys=True).encode("utf-8")
    aosp_provenance = {
        "schema": gate.AOSP_PROVENANCE_SCHEMA,
        "claim_boundary": gate.AOSP_PROVENANCE_CLAIM_BOUNDARY,
        "android_package": "ai.elizaos.app",
        "apk_name": path.name,
        "runtime_provenance_sha256": hashlib.sha256(runtime_bytes).hexdigest(),
        "runtime_provenance": runtime_provenance,
    }
    if provenance_overrides:
        aosp_provenance.update(provenance_overrides)
    with zipfile.ZipFile(path, "w") as zf:
        for entry in payload_entries:
            zf.writestr(entry, "x")
        zf.writestr(gate.RUNTIME_PROVENANCE_ENTRY, runtime_bytes)
        zf.writestr(gate.PROVENANCE_ENTRY, json.dumps(aosp_provenance, sort_keys=True))
    return path


class AndroidSystemApkPayloadTests(unittest.TestCase):
    def test_missing_riscv64_payload_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            apk = make_apk(
                Path(tmpdir) / "Eliza.apk",
                [
                    "AndroidManifest.xml",
                    "assets/agent/agent-bundle.js",
                    "assets/agent/launch.sh",
                ],
            )
            report = gate.run_check(
                Namespace(apk=str(apk), allow_missing_aapt=True),
            )
        self.assertEqual(report["status"], "blocked")
        missing = report["evidence"]["missing_entries"]
        self.assertIn("assets/agent/llama-kernel-diagnostic.mjs", missing)
        self.assertIn("assets/agent/riscv64/bun", missing)
        self.assertIn(
            "packages/app-core/scripts/bun-riscv64/run-build.sh",
            report["evidence"]["riscv64_runtime_build_commands"][0],
        )
        self.assertIn(
            "riscv64_bun_artifact.sha256",
            "; ".join(report["evidence"]["riscv64_runtime_provenance_requirements"]),
        )
        self.assertTrue(
            any("ELIZA_BUN_RISCV64_FILE" in finding["next_step"] for finding in report["findings"])
        )

    def test_complete_static_payload_passes(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            apk = make_complete_apk(Path(tmpdir) / "Eliza.apk")
            report = gate.run_check(
                Namespace(apk=str(apk), allow_missing_aapt=True),
            )
        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["findings"], [])
        self.assertTrue(report["evidence"]["has_llama_kernel_diagnostic"])

    def test_stale_aosp_build_provenance_apk_name_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            apk = make_complete_apk(
                Path(tmpdir) / "Eliza.apk",
                provenance_overrides={"apk_name": "Milady.apk"},
            )
            report = gate.run_check(
                Namespace(apk=str(apk), allow_missing_aapt=True),
            )
        self.assertEqual(report["status"], "blocked")
        codes = {finding["code"] for finding in report["findings"]}
        self.assertIn("aosp_build_provenance_apk_name_mismatch", codes)

    def test_duplicate_aosp_provenance_entry_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            apk = make_complete_apk(Path(tmpdir) / "Eliza.apk")
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", UserWarning)
                with zipfile.ZipFile(apk, "a") as zf:
                    zf.writestr(gate.PROVENANCE_ENTRY, "{}")
            report = gate.run_check(
                Namespace(apk=str(apk), allow_missing_aapt=True),
            )
        codes = {finding["code"] for finding in report["findings"]}
        self.assertEqual(report["status"], "blocked")
        self.assertIn("duplicate_critical_zip_entries", codes)
        self.assertIn(gate.PROVENANCE_ENTRY, report["evidence"]["duplicate_critical_entries"])

    def test_duplicate_runtime_provenance_entry_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            apk = make_complete_apk(Path(tmpdir) / "Eliza.apk")
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", UserWarning)
                with zipfile.ZipFile(apk, "a") as zf:
                    zf.writestr(gate.RUNTIME_PROVENANCE_ENTRY, "{}")
            report = gate.run_check(
                Namespace(apk=str(apk), allow_missing_aapt=True),
            )
        codes = {finding["code"] for finding in report["findings"]}
        self.assertEqual(report["status"], "blocked")
        self.assertIn("duplicate_critical_zip_entries", codes)
        self.assertIn(
            gate.RUNTIME_PROVENANCE_ENTRY,
            report["evidence"]["duplicate_critical_entries"],
        )

    def test_wrong_aosp_claim_boundary_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            apk = make_complete_apk(
                Path(tmpdir) / "Eliza.apk",
                provenance_overrides={"claim_boundary": "runtime_evidence_claim"},
            )
            report = gate.run_check(
                Namespace(apk=str(apk), allow_missing_aapt=True),
            )
        codes = {finding["code"] for finding in report["findings"]}
        self.assertEqual(report["status"], "blocked")
        self.assertIn("aosp_build_provenance_claim_boundary_mismatch", codes)

    def test_wrong_runtime_claim_boundary_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            apk = make_complete_apk(
                Path(tmpdir) / "Eliza.apk",
                runtime_overrides={"claim_boundary": "runtime_evidence_claim"},
            )
            report = gate.run_check(
                Namespace(apk=str(apk), allow_missing_aapt=True),
            )
        codes = {finding["code"] for finding in report["findings"]}
        self.assertEqual(report["status"], "blocked")
        self.assertIn("runtime_provenance_claim_boundary_mismatch", codes)

    def test_incomplete_runtime_file_metadata_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            apk = make_complete_apk(
                Path(tmpdir) / "Eliza.apk",
                runtime_file_overrides={
                    "assets/agent/riscv64/bun": {
                        "size_bytes": 0,
                        "sha256": "not-a-sha",
                    },
                },
            )
            report = gate.run_check(
                Namespace(apk=str(apk), allow_missing_aapt=True),
            )
        codes = {finding["code"] for finding in report["findings"]}
        self.assertEqual(report["status"], "blocked")
        self.assertIn("runtime_provenance_file_metadata_incomplete", codes)


if __name__ == "__main__":
    unittest.main()
