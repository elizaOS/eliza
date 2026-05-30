#!/usr/bin/env python3
"""Focused tests for the elizaOS riscv64 release-manifest gate."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).resolve().with_name("check_release_manifest.py")
SPEC = importlib.util.spec_from_file_location("check_release_manifest", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
gate = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = gate
SPEC.loader.exec_module(gate)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def manifest_with_runtime(path: str | None = "evidence/riscv64_agent_runtime_smoke.json") -> dict:
    return {
        "status": "candidate",
        "validation": {
            "requiredEvidence": list(gate.REQUIRED_EVIDENCE_IDS),
            "evidence": [
                {"id": "qemu-virt-boot", "status": "collected", "path": "unused"},
                {
                    "id": "grub-efi-riscv64-boot",
                    "status": "collected",
                    "path": "unused",
                },
                {"id": "elizaos-agent-live", "status": "collected", "path": "unused"},
                {"id": "riscv64-agent-runtime", "status": "collected", "path": path},
            ],
        },
    }


class ReleaseManifestRuntimeEvidenceTests(unittest.TestCase):
    def test_required_evidence_includes_riscv64_runtime_smoke(self) -> None:
        manifest = manifest_with_runtime()
        manifest["validation"]["requiredEvidence"].remove("riscv64-agent-runtime")

        results = gate.check_required_evidence_rows(manifest)

        self.assertTrue(any(result.status == "FAIL" for result in results))
        self.assertIn("riscv64-agent-runtime", "\n".join(result.message for result in results))

    def test_runtime_smoke_rejects_missing_provenance(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            evidence = root / "evidence"
            evidence.mkdir()
            transcript = evidence / "riscv64_agent_runtime_smoke.log"
            transcript.write_text("ok\n", encoding="utf-8")
            report = evidence / "riscv64_agent_runtime_smoke.json"
            report.write_text(
                json.dumps(
                    {
                        "schema": gate.RISCV64_AGENT_RUNTIME_SCHEMA,
                        "status": "pass",
                        "failures": [],
                        "artifacts": "artifacts/riscv64",
                        "transcript": "evidence/riscv64_agent_runtime_smoke.log",
                        "transcript_sha256": sha256(b"ok\n"),
                    }
                ),
                encoding="utf-8",
            )

            results = gate.check_riscv64_agent_runtime_evidence(
                manifest_with_runtime(), False, root
            )

            messages = "\n".join(result.message for result in results)
            self.assertIn("staged riscv64 Bun provenance missing", messages)
            self.assertTrue(any(result.status == "FAIL" for result in results))

    def test_collected_evidence_rows_require_existing_paths(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "evidence").mkdir()
            (root / "evidence/qemu_virt_boot.json").write_text("{}", encoding="utf-8")
            manifest = manifest_with_runtime("evidence/missing_runtime.json")
            for row in manifest["validation"]["evidence"]:
                if row["id"] in {
                    "qemu-virt-boot",
                    "grub-efi-riscv64-boot",
                    "elizaos-agent-live",
                }:
                    row["path"] = "evidence/qemu_virt_boot.json"

            results = gate.check_collected_evidence_paths(manifest, root)

            messages = "\n".join(result.message for result in results)
            self.assertIn("riscv64-agent-runtime", messages)
            self.assertTrue(any(result.status == "BLOCKED" for result in results))

    def test_runtime_smoke_accepts_matching_provenance(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            evidence = root / "evidence"
            evidence.mkdir()
            transcript = evidence / "riscv64_agent_runtime_smoke.log"
            transcript.write_text("ok\n", encoding="utf-8")
            artifacts = root / "artifacts" / "riscv64"
            bun = artifacts / "elizaos-app" / "musl-runtime" / "bun"
            bun.parent.mkdir(parents=True)
            bun.write_bytes(b"fresh-riscv64-bun")
            (artifacts / "riscv64-bun-provenance.json").write_text(
                json.dumps(
                    {
                        "schema": gate.RISCV64_BUN_PROVENANCE_SCHEMA,
                        "inputs": {
                            gate.RISCV64_BUN_VERSION_INPUT: "0" * 64,
                        },
                        "artifact": {
                            "staged_bun_sha256": sha256(b"fresh-riscv64-bun"),
                        },
                    }
                ),
                encoding="utf-8",
            )
            report = evidence / "riscv64_agent_runtime_smoke.json"
            report.write_text(
                json.dumps(
                    {
                        "schema": gate.RISCV64_AGENT_RUNTIME_SCHEMA,
                        "status": "pass",
                        "failures": [],
                        "artifacts": "artifacts/riscv64",
                        "transcript": "evidence/riscv64_agent_runtime_smoke.log",
                        "transcript_sha256": sha256(b"ok\n"),
                    }
                ),
                encoding="utf-8",
            )

            results = gate.check_riscv64_agent_runtime_evidence(
                manifest_with_runtime(), False, root
            )

            self.assertEqual(["PASS"], [result.status for result in results])

    def test_runtime_smoke_resolves_repo_token_paths(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            variant = repo / "packages/os/linux/elizaos"
            evidence = variant / "evidence"
            evidence.mkdir(parents=True)
            transcript = evidence / "riscv64_agent_runtime_smoke.log"
            transcript.write_text("ok\n", encoding="utf-8")
            artifacts = variant / "artifacts" / "riscv64"
            bun = artifacts / "elizaos-app" / "musl-runtime" / "bun"
            bun.parent.mkdir(parents=True)
            bun.write_bytes(b"fresh-riscv64-bun")
            (artifacts / "riscv64-bun-provenance.json").write_text(
                json.dumps(
                    {
                        "schema": gate.RISCV64_BUN_PROVENANCE_SCHEMA,
                        "inputs": {
                            gate.RISCV64_BUN_VERSION_INPUT: "0" * 64,
                        },
                        "artifact": {
                            "staged_bun_sha256": sha256(b"fresh-riscv64-bun"),
                        },
                    }
                ),
                encoding="utf-8",
            )
            (evidence / "riscv64_agent_runtime_smoke.json").write_text(
                json.dumps(
                    {
                        "schema": gate.RISCV64_AGENT_RUNTIME_SCHEMA,
                        "status": "pass",
                        "failures": [],
                        "artifacts": "<repo>/packages/os/linux/elizaos/artifacts/riscv64",
                        "transcript": (
                            "<repo>/packages/os/linux/elizaos/evidence/"
                            "riscv64_agent_runtime_smoke.log"
                        ),
                        "transcript_sha256": sha256(b"ok\n"),
                    }
                ),
                encoding="utf-8",
            )

            with mock.patch.object(gate, "REPO_ROOT", repo):
                results = gate.check_riscv64_agent_runtime_evidence(
                    manifest_with_runtime(), False, variant
                )

            self.assertEqual(["PASS"], [result.status for result in results])

    def test_runtime_smoke_accepts_node_mode_bundle_without_bun(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            evidence = root / "evidence"
            evidence.mkdir()
            transcript = evidence / "riscv64_agent_runtime_smoke.log"
            transcript.write_text("elizaos-riscv64-node-agent-bundle-staged\n", encoding="utf-8")
            bundle = root / "artifacts/riscv64/elizaos-app/agent-bundle.js"
            bundle.parent.mkdir(parents=True)
            bundle.write_text("#!/usr/bin/env node\nconsole.log('ok')\n", encoding="utf-8")
            (evidence / "riscv64_agent_runtime_smoke.json").write_text(
                json.dumps(
                    {
                        "schema": gate.RISCV64_AGENT_RUNTIME_SCHEMA,
                        "status": "pass",
                        "runtime_mode": "node",
                        "failures": [],
                        "artifacts": "artifacts/riscv64",
                        "transcript": "evidence/riscv64_agent_runtime_smoke.log",
                        "transcript_sha256": sha256(
                            b"elizaos-riscv64-node-agent-bundle-staged\n"
                        ),
                    }
                ),
                encoding="utf-8",
            )

            results = gate.check_riscv64_agent_runtime_evidence(
                manifest_with_runtime(), False, root
            )

            self.assertEqual(["PASS"], [result.status for result in results])

    def test_runtime_smoke_rejects_stale_provenance_hash(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            evidence = root / "evidence"
            evidence.mkdir()
            transcript = evidence / "riscv64_agent_runtime_smoke.log"
            transcript.write_text("ok\n", encoding="utf-8")
            artifacts = root / "artifacts" / "riscv64"
            bun = artifacts / "elizaos-app" / "musl-runtime" / "bun"
            bun.parent.mkdir(parents=True)
            bun.write_bytes(b"current-riscv64-bun")
            (artifacts / "riscv64-bun-provenance.json").write_text(
                json.dumps(
                    {
                        "schema": gate.RISCV64_BUN_PROVENANCE_SCHEMA,
                        "inputs": {
                            gate.RISCV64_BUN_VERSION_INPUT: "0" * 64,
                        },
                        "artifact": {
                            "staged_bun_sha256": sha256(b"old-riscv64-bun"),
                        },
                    }
                ),
                encoding="utf-8",
            )
            report = evidence / "riscv64_agent_runtime_smoke.json"
            report.write_text(
                json.dumps(
                    {
                        "schema": gate.RISCV64_AGENT_RUNTIME_SCHEMA,
                        "status": "pass",
                        "failures": [],
                        "artifacts": "artifacts/riscv64",
                        "transcript": "evidence/riscv64_agent_runtime_smoke.log",
                        "transcript_sha256": sha256(b"ok\n"),
                    }
                ),
                encoding="utf-8",
            )

            results = gate.check_riscv64_agent_runtime_evidence(
                manifest_with_runtime(), False, root
            )

            messages = "\n".join(result.message for result in results)
            self.assertIn("staged_bun_sha256 mismatch", messages)
            self.assertTrue(any(result.status == "FAIL" for result in results))


if __name__ == "__main__":
    unittest.main()
