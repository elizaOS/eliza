#!/usr/bin/env python3
"""Unit tests for ``qemu_virt_smoke`` and ``qemu_virt_boot.sh``.

The tests never launch QEMU. They exercise:
  * The Python validator on synthetic well-formed and malformed evidence
    documents.
  * The bash harness fail-closed behaviour by stubbing
    ``qemu-system-riscv64`` with a shell that writes a synthetic transcript
    matching the marker-found, marker-missing, and forbidden-marker branches.
  * Timeout behaviour via a stub that simply sleeps longer than the harness
    timeout allows.

Run with::

    python3 -m unittest scripts.test_qemu_virt_smoke
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import qemu_virt_smoke as smoke  # noqa: E402

BASH_HARNESS = HERE / "qemu_virt_boot.sh"


def _sha256_hex(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _well_formed_doc(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "schema": smoke.EVIDENCE_SCHEMA,
        "claim_boundary": smoke.CLAIM_BOUNDARY,
        "iso_path": "/tmp/elizaos.iso",
        "iso_sha256": _sha256_hex(b"iso"),
        "transcript_path": "/tmp/qemu.log",
        "transcript_sha256": _sha256_hex(b"transcript"),
        "memory_mb": 4096,
        "cpus": 4,
        "timeout_s": 600,
        "duration_s": 42,
        "start_utc": "2026-05-19T00:00:00Z",
        "qemu_exit_code": 0,
        "u_boot_path": None,
        "boot_completed": True,
        "markers_found": [
            "Linux version",
            "elizaos-firstboot-ready",
            "login:",
        ],
        "markers_missing": [],
        "forbidden_markers_present": [],
        "provenance": "qemu_virt",
    }
    base.update(overrides)
    return base


class ValidateEvidenceTests(unittest.TestCase):
    def test_well_formed_passes(self) -> None:
        smoke.validate_evidence(_well_formed_doc())

    def test_missing_field_fails(self) -> None:
        doc = _well_formed_doc()
        del doc["iso_sha256"]
        with self.assertRaises(smoke.EvidenceValidationError) as ctx:
            smoke.validate_evidence(doc)
        self.assertIn("missing fields", str(ctx.exception))

    def test_wrong_schema_fails(self) -> None:
        doc = _well_formed_doc(schema="some.other.schema.v1")
        with self.assertRaises(smoke.EvidenceValidationError):
            smoke.validate_evidence(doc)

    def test_wrong_claim_boundary_fails(self) -> None:
        doc = _well_formed_doc(claim_boundary="silicon-ready")
        with self.assertRaises(smoke.EvidenceValidationError):
            smoke.validate_evidence(doc)

    def test_bad_sha256_fails(self) -> None:
        doc = _well_formed_doc(iso_sha256="not-hex")
        with self.assertRaises(smoke.EvidenceValidationError):
            smoke.validate_evidence(doc)

    def test_boot_completed_requires_required_markers(self) -> None:
        doc = _well_formed_doc(
            boot_completed=True,
            markers_found=["elizaos-firstboot-ready"],
            markers_missing=["Linux version"],
        )
        with self.assertRaises(smoke.EvidenceValidationError):
            smoke.validate_evidence(doc)

    def test_boot_completed_rejects_forbidden_markers(self) -> None:
        doc = _well_formed_doc(
            forbidden_markers_present=["Kernel panic"],
        )
        with self.assertRaises(smoke.EvidenceValidationError):
            smoke.validate_evidence(doc)

    def test_boot_failed_with_missing_markers_is_valid_document(self) -> None:
        doc = _well_formed_doc(
            boot_completed=False,
            markers_found=["Linux version"],
            markers_missing=["elizaos-firstboot-ready"],
        )
        smoke.validate_evidence(doc)

    def test_non_string_marker_fails(self) -> None:
        doc = _well_formed_doc(markers_found=["Linux version", 42])
        with self.assertRaises(smoke.EvidenceValidationError):
            smoke.validate_evidence(doc)

    def test_negative_duration_fails(self) -> None:
        doc = _well_formed_doc(duration_s=-1)
        with self.assertRaises(smoke.EvidenceValidationError):
            smoke.validate_evidence(doc)


class LoadEvidenceTests(unittest.TestCase):
    def test_missing_file_raises(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            missing = Path(tmp) / "nope.json"
            with self.assertRaises(FileNotFoundError):
                smoke.load_evidence(missing)

    def test_bad_json_raises(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            bad = Path(tmp) / "bad.json"
            bad.write_text("{not valid", encoding="utf-8")
            with self.assertRaises(smoke.EvidenceValidationError):
                smoke.load_evidence(bad)


class BashHarnessIntegrationTests(unittest.TestCase):
    """End-to-end exercises of qemu_virt_boot.sh with a stubbed qemu binary."""

    def setUp(self) -> None:
        if shutil.which("bash") is None:
            self.skipTest("bash not available")
        if shutil.which("python3") is None:
            self.skipTest("python3 not available")
        if shutil.which("sha256sum") is None:
            self.skipTest("sha256sum not available")
        if shutil.which("timeout") is None and shutil.which("gtimeout") is None:
            self.skipTest("neither timeout nor gtimeout available")

        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmpdir = Path(self._tmp.name)

        self.iso = self.tmpdir / "elizaos.iso"
        self.iso.write_bytes(b"fake-iso-payload")
        self.evidence = self.tmpdir / "evidence" / "qemu_virt_boot.json"
        self.transcript = self.tmpdir / "evidence" / "qemu_virt_boot.transcript.log"

        # Stubs for qemu-system-riscv64 and qemu-img. We place them in a
        # private bin/ that we put at the head of PATH so the harness picks
        # them up instead of any real binary that might be installed.
        self.stub_bin = self.tmpdir / "bin"
        self.stub_bin.mkdir()
        self._write_stub("qemu-img", "#!/usr/bin/env bash\nexit 0\n")
        # The qemu stub is parameterised by env vars set per test.
        self._write_stub(
            "qemu-system-riscv64",
            r"""#!/usr/bin/env bash
set -eu
mode="${QVB_STUB_MODE:-success}"
sleep_s="${QVB_STUB_SLEEP:-0}"
if [ "$sleep_s" != "0" ]; then
    sleep "$sleep_s"
fi
case "$mode" in
    success)
        printf 'Linux version 6.6.0-elizaos-riscv64\n'
        printf 'elizaos-firstboot-ready\n'
        printf 'debian login: \n'
        ;;
    missing_ready)
        printf 'Linux version 6.6.0-elizaos-riscv64\n'
        ;;
    panic)
        printf 'Linux version 6.6.0-elizaos-riscv64\n'
        printf 'Kernel panic - not syncing: VFS unable to mount root\n'
        ;;
    empty)
        :
        ;;
    *)
        echo "unknown QVB_STUB_MODE: $mode" >&2
        exit 99
        ;;
esac
""",
        )

    def _write_stub(self, name: str, body: str) -> None:
        path = self.stub_bin / name
        path.write_text(body, encoding="utf-8")
        path.chmod(0o755)

    def _run_harness(
        self, *, env_overrides: dict[str, str]
    ) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        env["PATH"] = f"{self.stub_bin}{os.pathsep}{env.get('PATH', '')}"
        env.update(env_overrides)
        return subprocess.run(
            [
                "bash",
                str(BASH_HARNESS),
                "--iso",
                str(self.iso),
                "--memory",
                "512",
                "--cpus",
                "1",
                "--timeout",
                "5",
                "--evidence",
                str(self.evidence),
                "--transcript",
                str(self.transcript),
            ],
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )

    def test_missing_iso_fails_closed(self) -> None:
        env = os.environ.copy()
        env["PATH"] = f"{self.stub_bin}{os.pathsep}{env.get('PATH', '')}"
        result = subprocess.run(
            [
                "bash",
                str(BASH_HARNESS),
                "--iso",
                str(self.tmpdir / "does-not-exist.iso"),
                "--evidence",
                str(self.evidence),
                "--transcript",
                str(self.transcript),
            ],
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ISO not found", result.stderr)
        self.assertFalse(self.evidence.exists())

    def test_success_markers(self) -> None:
        result = self._run_harness(env_overrides={"QVB_STUB_MODE": "success"})
        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertTrue(self.evidence.is_file())
        doc = json.loads(self.evidence.read_text(encoding="utf-8"))
        smoke.validate_evidence(doc)
        self.assertTrue(doc["boot_completed"])
        self.assertIn("Linux version", doc["markers_found"])
        self.assertIn("elizaos-firstboot-ready", doc["markers_found"])
        self.assertEqual(doc["forbidden_markers_present"], [])

    def test_missing_required_marker(self) -> None:
        result = self._run_harness(env_overrides={"QVB_STUB_MODE": "missing_ready"})
        self.assertEqual(result.returncode, 1, msg=result.stderr)
        self.assertTrue(self.evidence.is_file())
        doc = json.loads(self.evidence.read_text(encoding="utf-8"))
        smoke.validate_evidence(doc)
        self.assertFalse(doc["boot_completed"])
        self.assertIn("elizaos-firstboot-ready", doc["markers_missing"])

    def test_forbidden_marker_kernel_panic(self) -> None:
        result = self._run_harness(env_overrides={"QVB_STUB_MODE": "panic"})
        self.assertEqual(result.returncode, 1, msg=result.stderr)
        doc = json.loads(self.evidence.read_text(encoding="utf-8"))
        smoke.validate_evidence(doc)
        self.assertFalse(doc["boot_completed"])
        self.assertIn("Kernel panic", doc["forbidden_markers_present"])

    def test_timeout_branch(self) -> None:
        # The stub sleeps longer than the harness allows; the harness kills it
        # and we expect boot_completed=false with no markers found.
        result = self._run_harness(
            env_overrides={"QVB_STUB_MODE": "empty", "QVB_STUB_SLEEP": "10"},
        )
        self.assertEqual(result.returncode, 1, msg=result.stderr)
        doc = json.loads(self.evidence.read_text(encoding="utf-8"))
        smoke.validate_evidence(doc)
        self.assertFalse(doc["boot_completed"])
        self.assertEqual(doc["qemu_exit_code"], 124)


if __name__ == "__main__":
    unittest.main()
