#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHECK = ROOT / "scripts/check_release_archive.py"


def load_check_module():
    spec = importlib.util.spec_from_file_location("check_release_archive", CHECK)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class ReleaseArchiveSimulatorEvidenceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.check = load_check_module()

    def write_archive(
        self,
        archive: Path,
        *,
        omit: set[str] | None = None,
        drop_tokens: dict[str, set[str]] | None = None,
    ) -> None:
        omit = omit or set()
        drop_tokens = drop_tokens or {}
        root = archive.parent / "archive-root"
        root.mkdir()
        members: list[str] = []
        for suffix in self.check.REQUIRED_SUFFIXES:
            if suffix in omit:
                continue
            member = root / suffix
            member.parent.mkdir(parents=True, exist_ok=True)
            tokens = [
                token
                for token in self.check.REQUIRED_TEXT.get(suffix, [])
                if token not in drop_tokens.get(suffix, set())
            ]
            member.write_text("\n".join(tokens or [f"fixture for {suffix}"]) + "\n")
            members.append(f"eliza-release/{suffix}")

        checksums = root / "SHA256SUMS"
        checksums.write_text("".join(f"0  {member}\n" for member in members if member != "SHA256SUMS"))

        with tarfile.open(archive, "w:gz") as tar:
            for path in sorted(root.rglob("*")):
                if path.is_file():
                    tar.add(path, arcname=f"eliza-release/{path.relative_to(root)}")

    def run_checker(self, archive: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(CHECK), str(archive)],
            cwd=ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )

    def test_complete_fixture_archive_passes_simulator_evidence_requirements(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            archive = Path(tmpdir) / "release.tar.gz"
            self.write_archive(archive)
            result = self.run_checker(archive)
        self.assertEqual(result.returncode, 0, result.stdout)
        report = json.loads(self.check.REPORT.read_text(encoding="utf-8"))
        self.assertEqual(report["status"], "pass")
        self.assertIs(report["summary"]["archive_validation_passed"], True)
        self.assertIs(report["summary"]["release_ready"], False)
        for key in (
            "phone_claim_allowed",
            "release_claim_allowed",
            "hardware_boot_claim_allowed",
            "silicon_evidence_claim_allowed",
            "simulator_pass_is_release_evidence",
        ):
            self.assertIs(report.get(key), False)

    def test_missing_qemu_manifest_blocks_release_archive(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            archive = Path(tmpdir) / "release.tar.gz"
            self.write_archive(archive, omit={"reports/qemu_smoke.manifest"})
            result = self.run_checker(archive)
        self.assertEqual(result.returncode, 1, result.stdout)
        report = json.loads(self.check.REPORT.read_text(encoding="utf-8"))
        self.assertIs(report["summary"]["release_ready"], False)
        self.assertIs(report["release_claim_allowed"], False)
        self.assertIn(
            "missing archive member ending with reports/qemu_smoke.manifest",
            result.stdout,
        )

    def test_missing_renode_status_blocks_release_archive(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            archive = Path(tmpdir) / "release.tar.gz"
            self.write_archive(archive, omit={"renode/eliza_e1_status.json"})
            result = self.run_checker(archive)
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn(
            "missing archive member ending with renode/eliza_e1_status.json",
            result.stdout,
        )

    def test_qemu_manifest_without_pass_status_blocks_release_archive(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            archive = Path(tmpdir) / "release.tar.gz"
            self.write_archive(
                archive,
                drop_tokens={"reports/qemu_smoke.manifest": {"status=PASS"}},
            )
            result = self.run_checker(archive)
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn(
            "reports/qemu_smoke.manifest missing required text token: status=PASS",
            result.stdout,
        )

    def test_qemu_manifest_without_claim_boundary_blocks_release_archive(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            archive = Path(tmpdir) / "release.tar.gz"
            self.write_archive(
                archive,
                drop_tokens={
                    "reports/qemu_smoke.manifest": {
                        "claim_boundary=qemu-virt software reference only; not e1-chip hardware ABI boot evidence"
                    }
                },
            )
            result = self.run_checker(archive)
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn(
            "reports/qemu_smoke.manifest missing required text token: claim_boundary=qemu-virt software reference only; not e1-chip hardware ABI boot evidence",
            result.stdout,
        )


if __name__ == "__main__":
    unittest.main()
