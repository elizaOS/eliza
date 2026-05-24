#!/usr/bin/env python3
"""Tests for check-multiarch-boot-contract.py."""

from __future__ import annotations

import importlib.util
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
MODULE_PATH = HERE / "check-multiarch-boot-contract.py"
spec = importlib.util.spec_from_file_location("check_multiarch_boot_contract", MODULE_PATH)
assert spec is not None and spec.loader is not None
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


def complete_row(arch: str) -> dict:
    return {
        "arch": arch,
        "status": "candidate",
        "iso": f"out/elizaos-linux-{arch}-default.iso",
        "sha256": "a" * 64,
        "evidence": f"evidence/{arch}.json",
        "proves": list(gate.ARCH_RUNTIME_EVIDENCE_REQUIREMENTS[arch]),
        "gaps": ["not physical silicon evidence"],
    }


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class MultiarchBootContractTests(unittest.TestCase):
    def test_runtime_matrix_rejects_fallback_agent_and_missing_arch(self) -> None:
        matrix = {
            "architectures": [
                {
                    **complete_row("riscv64"),
                    "status": "candidate-reference",
                    "gaps": [
                        "current riscv64 ISO evidence predates verified riscv64 Bun artifact staging and must be recaptured"
                    ],
                },
                complete_row("amd64"),
            ]
        }
        errors: list[str] = []
        gate.validate_runtime_matrix(errors, matrix)
        joined = "\n".join(errors)
        self.assertIn("riscv64 status must be candidate", joined)
        self.assertIn("predates verified riscv64 Bun artifact", joined)
        self.assertIn("missing arm64 row", joined)

    def test_runtime_matrix_rejects_current_iso_timeout_gap(self) -> None:
        matrix = {
            "architectures": [
                {
                    **complete_row("riscv64"),
                    "gaps": [
                        "current riscv64 ISO boot reaches Linux EFI stub then times out before Linux version"
                    ],
                },
                complete_row("amd64"),
                complete_row("arm64"),
            ]
        }
        errors: list[str] = []
        gate.validate_runtime_matrix(errors, matrix)
        self.assertIn("times out before Linux version", "\n".join(errors))

    def test_runtime_matrix_rejects_riscv64_bun_sigill_gap(self) -> None:
        matrix = {
            "architectures": [
                {
                    **complete_row("riscv64"),
                    "gaps": [
                        "rebuilt riscv64 ISO reaches first boot, then Bun traps with SIGILL / unhandled signal 4 before agent health"
                    ],
                },
                complete_row("amd64"),
                complete_row("arm64"),
            ]
        }
        errors: list[str] = []
        gate.validate_runtime_matrix(errors, matrix)
        self.assertIn("SIGILL", "\n".join(errors))

    def test_runtime_matrix_accepts_complete_candidate_rows(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "out").mkdir()
            (root / "evidence").mkdir()
            rows = []
            for arch in ("amd64", "arm64", "riscv64"):
                iso = root / f"out/elizaos-linux-{arch}-default.iso"
                iso.write_bytes(arch.encode("utf-8"))
                evidence = root / f"evidence/{arch}.json"
                evidence.write_text("{}\n", encoding="utf-8")
                rows.append(
                    {
                        **complete_row(arch),
                        "sha256": sha256_bytes(arch.encode("utf-8")),
                    }
                )
            matrix = {"architectures": rows}
            errors: list[str] = []
            with mock.patch.object(gate, "ROOT", root):
                gate.validate_runtime_matrix(errors, matrix)
        self.assertEqual(errors, [])

    def test_runtime_artifact_checks_verify_bun_sha(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "artifacts/arm64/elizaos-app").mkdir(parents=True)
            bun = root / "artifacts/arm64/bun"
            bun.write_bytes(b"arm64-bun")
            matrix = {
                "architectures": [
                    {
                        **complete_row("arm64"),
                        "runtime_artifacts": {
                            "bun": "artifacts/arm64/bun",
                            "bun_sha256": "0" * 64,
                            "agent_bundle": "artifacts/arm64/elizaos-app",
                        },
                    }
                ]
            }
            errors: list[str] = []
            with mock.patch.object(gate, "ROOT", root):
                gate.validate_runtime_artifacts(errors, matrix)
        self.assertIn("sha256 mismatch", "\n".join(errors))

    def test_runtime_artifact_checks_reject_riscv64_wrapper_without_runtime_bun(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "artifacts/riscv64/elizaos-app/musl-runtime").mkdir(parents=True)
            bun = root / "artifacts/riscv64/bun"
            bun.write_text(
                "#!/bin/sh\nexec /opt/elizaos/app/musl-runtime/bun \"$@\"\n",
                encoding="utf-8",
            )
            matrix = {
                "architectures": [
                    {
                        **complete_row("riscv64"),
                        "runtime_artifacts": {
                            "bun": "artifacts/riscv64/bun",
                            "bun_sha256": sha256_bytes(bun.read_bytes()),
                            "agent_bundle": "artifacts/riscv64/elizaos-app",
                        },
                    }
                ]
            }
            errors: list[str] = []
            with mock.patch.object(gate, "ROOT", root):
                gate.validate_runtime_artifacts(errors, matrix)
        self.assertIn("musl-runtime/bun", "\n".join(errors))

    def test_runtime_artifact_checks_reject_riscv64_wrapper_without_provenance(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            runtime = root / "artifacts/riscv64/elizaos-app/musl-runtime"
            runtime.mkdir(parents=True)
            (runtime / "bun").write_bytes(b"riscv64-bun")
            bun = root / "artifacts/riscv64/bun"
            bun.write_text(
                "#!/bin/sh\nexec /opt/elizaos/app/musl-runtime/bun \"$@\"\n",
                encoding="utf-8",
            )
            matrix = {
                "architectures": [
                    {
                        **complete_row("riscv64"),
                        "runtime_artifacts": {
                            "bun": "artifacts/riscv64/bun",
                            "bun_sha256": sha256_bytes(bun.read_bytes()),
                            "agent_bundle": "artifacts/riscv64/elizaos-app",
                        },
                    }
                ]
            }
            errors: list[str] = []
            with mock.patch.object(gate, "ROOT", root):
                gate.validate_runtime_artifacts(errors, matrix)
        self.assertIn("riscv64_bun_provenance missing", "\n".join(errors))

    def test_runtime_artifact_checks_verify_riscv64_bun_provenance(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            runtime = root / "artifacts/riscv64/elizaos-app/musl-runtime"
            runtime.mkdir(parents=True)
            runtime_bun = runtime / "bun"
            runtime_bun.write_bytes(b"riscv64-bun")
            bun = root / "artifacts/riscv64/bun"
            bun.write_text(
                "#!/bin/sh\nexec /opt/elizaos/app/musl-runtime/bun \"$@\"\n",
                encoding="utf-8",
            )
            provenance = root / "artifacts/riscv64/riscv64-bun-provenance.json"
            provenance.write_text(
                json.dumps(
                    {
                        "schema": "eliza.os.linux.riscv64_bun_stage_provenance.v1",
                        "inputs": {
                            "packages/app-core/scripts/bun-riscv64/bun-version.json": "0" * 64
                        },
                        "artifact": {
                            "staged_bun_sha256": sha256_bytes(runtime_bun.read_bytes())
                        },
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            matrix = {
                "architectures": [
                    {
                        **complete_row("riscv64"),
                        "runtime_artifacts": {
                            "bun": "artifacts/riscv64/bun",
                            "bun_sha256": sha256_bytes(bun.read_bytes()),
                            "agent_bundle": "artifacts/riscv64/elizaos-app",
                            "riscv64_bun_provenance": (
                                "artifacts/riscv64/riscv64-bun-provenance.json"
                            ),
                        },
                    }
                ]
            }
            errors: list[str] = []
            with mock.patch.object(gate, "ROOT", root):
                gate.validate_runtime_artifacts(errors, matrix)
        self.assertEqual(errors, [])

    def test_runtime_artifact_checks_accept_riscv64_node_mode_bundle(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app = root / "artifacts/riscv64/elizaos-app"
            app.mkdir(parents=True)
            (app / "agent-bundle.js").write_text(
                "#!/usr/bin/env node\nconsole.log('ok')\n",
                encoding="utf-8",
            )
            matrix = {
                "architectures": [
                    {
                        **complete_row("riscv64"),
                        "runtime_artifacts": {
                            "runtime_mode": "node",
                            "agent_bundle": "artifacts/riscv64/elizaos-app",
                        },
                    }
                ]
            }
            errors: list[str] = []
            with mock.patch.object(gate, "ROOT", root):
                gate.validate_runtime_artifacts(errors, matrix)
        self.assertEqual(errors, [])

    def test_runtime_matrix_verifies_iso_hash_and_evidence_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "out").mkdir()
            (root / "evidence").mkdir()
            (root / "out/elizaos-linux-riscv64-default.iso").write_bytes(b"iso")
            matrix = {
                "architectures": [
                    {
                        **complete_row("riscv64"),
                        "iso": "out/elizaos-linux-riscv64-default.iso",
                        "sha256": "0" * 64,
                        "evidence": "evidence/missing.json",
                    }
                ]
            }
            errors: list[str] = []
            with mock.patch.object(gate, "ROOT", root):
                gate.validate_runtime_matrix(errors, matrix)
        joined = "\n".join(errors)
        self.assertIn("ISO sha256 mismatch", joined)
        self.assertIn("evidence artifact missing", joined)


if __name__ == "__main__":
    unittest.main()
