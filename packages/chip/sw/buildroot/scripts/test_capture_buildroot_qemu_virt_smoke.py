#!/usr/bin/env python3
"""Unit tests for ``capture-buildroot-qemu-virt-smoke.sh``.

The tests never launch a real ``qemu-system-riscv64``. They exercise:

* The bash harness fail-closed behaviour when ``qemu-system-riscv64`` is
  not on PATH or when the kernel/rootfs inputs are missing.
* The success branch with a stubbed ``qemu-system-riscv64`` that prints all
  required markers.
* The missing-marker branch (kernel boots but never reaches ``login:``).
* The forbidden-marker branch (``Kernel panic`` appears in the
  transcript).
* The timeout branch where the stub sleeps longer than the harness allows.
* JSON schema validation of the emitted evidence document.

Run with::

    python3 -m unittest \
        sw.buildroot.scripts.test_capture_buildroot_qemu_virt_smoke
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
BASH_HARNESS = HERE / "capture-buildroot-qemu-virt-smoke.sh"

EVIDENCE_SCHEMA = "eliza.chip.buildroot_qemu_virt_smoke.v1"
CLAIM_BOUNDARY = "buildroot_qemu_virt_smoke_evidence_only_no_silicon_or_physical_board_claim"
PROVENANCE = "qemu_virt"

REQUIRED_MARKERS = (
    "Linux version",
    "Welcome to Buildroot",
    "login:",
)
FORBIDDEN_MARKERS = (
    "Kernel panic",
    "Oops",
    "BUG:",
)

_HEX64 = re.compile(r"^[0-9a-f]{64}$")

_TOP_LEVEL_FIELDS: dict[str, type | tuple[type, ...]] = {
    "schema": str,
    "claim_boundary": str,
    "status": str,
    "kernel_path": str,
    "kernel_sha256": str,
    "rootfs_path": str,
    "rootfs_sha256": str,
    "transcript_path": str,
    "transcript_sha256": str,
    "memory_mb": int,
    "cpus": int,
    "timeout_s": int,
    "duration_s": int,
    "markers_found": list,
    "markers_missing": list,
    "forbidden_markers_found": list,
    "boot_completed": bool,
    "provenance": str,
}


class EvidenceSchemaError(AssertionError):
    """Raised by the test helper when the evidence document is invalid."""


def _validate_evidence(doc: dict[str, Any]) -> None:
    """Validate an evidence document against the v1 schema.

    Raises ``EvidenceSchemaError`` if anything is wrong. This is intentionally
    a local re-implementation so the tests do not require a sibling Python
    module — the bash harness is the only artifact under test.
    """
    if not isinstance(doc, dict):
        raise EvidenceSchemaError(f"evidence root is {type(doc).__name__}, expected dict")

    missing = sorted(set(_TOP_LEVEL_FIELDS) - set(doc))
    if missing:
        raise EvidenceSchemaError(f"evidence missing fields: {missing}")

    for field, expected in _TOP_LEVEL_FIELDS.items():
        value = doc[field]
        if expected is bool:
            if not isinstance(value, bool):
                raise EvidenceSchemaError(
                    f"field {field!r} is {type(value).__name__}, expected bool"
                )
            continue
        if isinstance(value, bool) and expected is int:
            raise EvidenceSchemaError(f"field {field!r} is bool but expected int")
        if not isinstance(value, expected):
            raise EvidenceSchemaError(
                f"field {field!r} is {type(value).__name__}, expected {expected!r}"
            )

    if doc["schema"] != EVIDENCE_SCHEMA:
        raise EvidenceSchemaError(f"schema mismatch: {doc['schema']!r}")
    if doc["claim_boundary"] != CLAIM_BOUNDARY:
        raise EvidenceSchemaError(f"claim_boundary mismatch: {doc['claim_boundary']!r}")
    if doc["provenance"] != PROVENANCE:
        raise EvidenceSchemaError(f"provenance mismatch: {doc['provenance']!r}")

    # When status=blocked, kernel/rootfs hashes may legitimately be empty
    # strings because the underlying file was missing on disk. In every other
    # status they must be hex64. transcript_sha256 is always empty for
    # blocked runs (we never opened a transcript) and hex64 otherwise.
    blocked = doc["status"] == "blocked"
    kernel_sha = doc["kernel_sha256"]
    if (not blocked or kernel_sha) and not _HEX64.match(kernel_sha):
        raise EvidenceSchemaError(f"kernel_sha256 is not hex64: {kernel_sha!r}")
    rootfs_sha = doc["rootfs_sha256"]
    if (not blocked or rootfs_sha) and not _HEX64.match(rootfs_sha):
        raise EvidenceSchemaError(f"rootfs_sha256 is not hex64: {rootfs_sha!r}")
    transcript_sha = doc["transcript_sha256"]
    if transcript_sha and not _HEX64.match(transcript_sha):
        raise EvidenceSchemaError(f"transcript_sha256 is not hex64: {transcript_sha!r}")

    for numeric in ("memory_mb", "cpus", "timeout_s", "duration_s"):
        if doc[numeric] < 0:
            raise EvidenceSchemaError(f"{numeric} must be non-negative, got {doc[numeric]}")

    for list_field in ("markers_found", "markers_missing", "forbidden_markers_found"):
        for idx, item in enumerate(doc[list_field]):
            if not isinstance(item, str):
                raise EvidenceSchemaError(f"field {list_field!r}[{idx}] is not a string: {item!r}")

    if doc["boot_completed"]:
        if doc["forbidden_markers_found"]:
            raise EvidenceSchemaError(
                "boot_completed=true but forbidden_markers_found is non-empty"
            )
        for marker in REQUIRED_MARKERS:
            if marker not in doc["markers_found"]:
                raise EvidenceSchemaError(
                    f"boot_completed=true but required marker missing: {marker!r}"
                )

    if doc["status"] == "blocked":
        expected_blocked_keys = {"blocked_reason"}
        if not expected_blocked_keys.issubset(doc):
            raise EvidenceSchemaError("status=blocked but blocked_reason is missing")
        if doc["boot_completed"]:
            raise EvidenceSchemaError("status=blocked but boot_completed=true")
        if doc["transcript_sha256"]:
            raise EvidenceSchemaError("status=blocked but transcript_sha256 is populated")
    elif doc["status"] not in ("pass", "fail"):
        raise EvidenceSchemaError(f"unexpected status: {doc['status']!r}")


class _HarnessTestBase(unittest.TestCase):
    """Common scaffolding: synthetic kernel/rootfs, stub PATH, evidence paths."""

    def setUp(self) -> None:
        if shutil.which("bash") is None:
            self.skipTest("bash not available")
        if shutil.which("python3") is None:
            self.skipTest("python3 not available")
        if shutil.which("sha256sum") is None:
            self.skipTest("sha256sum not available")

        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmpdir = Path(self._tmp.name)

        self.kernel = self.tmpdir / "Image"
        self.kernel.write_bytes(b"fake-kernel-payload")
        self.rootfs = self.tmpdir / "rootfs.cpio"
        self.rootfs.write_bytes(b"fake-rootfs-payload")

        self.evidence = self.tmpdir / "evidence" / "buildroot_qemu_virt_smoke.json"
        self.transcript = self.tmpdir / "evidence" / "buildroot_qemu_virt_smoke.transcript.log"

        self.stub_bin = self.tmpdir / "bin"
        self.stub_bin.mkdir()

    def _write_stub(self, name: str, body: str) -> None:
        path = self.stub_bin / name
        path.write_text(body, encoding="utf-8")
        path.chmod(0o755)

    def _install_qemu_stub(self) -> None:
        """Stub ``qemu-system-riscv64`` parameterised by environment variables."""
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
        printf 'Linux version 6.6.0-buildroot-rv64gc\n'
        printf 'Welcome to Buildroot\n'
        printf 'buildroot login: \n'
        ;;
    missing_login)
        printf 'Linux version 6.6.0-buildroot-rv64gc\n'
        printf 'Welcome to Buildroot\n'
        ;;
    panic)
        printf 'Linux version 6.6.0-buildroot-rv64gc\n'
        printf 'Kernel panic - not syncing: VFS unable to mount root fs\n'
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

    def _run_harness(
        self,
        *,
        env_overrides: dict[str, str] | None = None,
        omit_qemu_stub: bool = False,
        kernel_override: Path | None = None,
        rootfs_override: Path | None = None,
        path_includes_qemu: bool = True,
    ) -> subprocess.CompletedProcess[str]:
        if not omit_qemu_stub:
            self._install_qemu_stub()

        env = os.environ.copy()
        if path_includes_qemu:
            env["PATH"] = f"{self.stub_bin}{os.pathsep}{env.get('PATH', '')}"
        else:
            # Build a PATH that has only standard system utilities and the
            # tmpdir stub (which we intentionally leave without a qemu stub)
            # so the harness must hit its "qemu-system-riscv64 not on PATH"
            # branch deterministically.
            scrubbed: list[str] = []
            for candidate in ("/usr/bin", "/bin"):
                if candidate not in scrubbed and Path(candidate).is_dir():
                    scrubbed.append(candidate)
            for required in ("python3", "sha256sum", "bash", "dirname", "mkdir"):
                if shutil.which(required, path=os.pathsep.join(scrubbed)) is None:
                    self.skipTest(f"{required} not available in scrubbed PATH")
            if shutil.which("qemu-system-riscv64", path=os.pathsep.join(scrubbed)):
                self.skipTest("qemu-system-riscv64 unexpectedly present in scrubbed PATH")
            env["PATH"] = f"{self.stub_bin}{os.pathsep}{os.pathsep.join(scrubbed)}"

        if env_overrides:
            env.update(env_overrides)

        kernel = kernel_override if kernel_override is not None else self.kernel
        rootfs = rootfs_override if rootfs_override is not None else self.rootfs

        return subprocess.run(
            [
                "bash",
                str(BASH_HARNESS),
                "--kernel",
                str(kernel),
                "--rootfs",
                str(rootfs),
                "--memory",
                "256",
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


class BlockedBranchTests(_HarnessTestBase):
    def test_missing_qemu_binary_is_blocked(self) -> None:
        result = self._run_harness(omit_qemu_stub=True, path_includes_qemu=False)
        self.assertEqual(result.returncode, 1, msg=result.stderr)
        self.assertIn("STATUS: BLOCKED", result.stderr)
        self.assertTrue(self.evidence.is_file())
        doc = json.loads(self.evidence.read_text(encoding="utf-8"))
        _validate_evidence(doc)
        self.assertEqual(doc["status"], "blocked")
        self.assertFalse(doc["boot_completed"])
        self.assertIn("qemu-system-riscv64", doc["blocked_reason"])

    def test_missing_kernel_is_blocked(self) -> None:
        result = self._run_harness(
            kernel_override=self.tmpdir / "does-not-exist-Image",
        )
        self.assertEqual(result.returncode, 1, msg=result.stderr)
        self.assertIn("STATUS: BLOCKED", result.stderr)
        doc = json.loads(self.evidence.read_text(encoding="utf-8"))
        _validate_evidence(doc)
        self.assertEqual(doc["status"], "blocked")
        self.assertIn("kernel image not found", doc["blocked_reason"])

    def test_missing_rootfs_is_blocked(self) -> None:
        result = self._run_harness(
            rootfs_override=self.tmpdir / "does-not-exist-rootfs.cpio",
        )
        self.assertEqual(result.returncode, 1, msg=result.stderr)
        self.assertIn("STATUS: BLOCKED", result.stderr)
        doc = json.loads(self.evidence.read_text(encoding="utf-8"))
        _validate_evidence(doc)
        self.assertEqual(doc["status"], "blocked")
        self.assertIn("rootfs cpio not found", doc["blocked_reason"])


class BootBranchTests(_HarnessTestBase):
    def test_success_all_markers(self) -> None:
        result = self._run_harness(env_overrides={"QVB_STUB_MODE": "success"})
        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertTrue(self.evidence.is_file())
        doc = json.loads(self.evidence.read_text(encoding="utf-8"))
        _validate_evidence(doc)
        self.assertTrue(doc["boot_completed"])
        self.assertEqual(doc["status"], "pass")
        for marker in REQUIRED_MARKERS:
            self.assertIn(marker, doc["markers_found"])
        self.assertEqual(doc["markers_missing"], [])
        self.assertEqual(doc["forbidden_markers_found"], [])
        # Sha256s of the kernel and rootfs must match the actual files.
        import hashlib

        self.assertEqual(
            doc["kernel_sha256"],
            hashlib.sha256(self.kernel.read_bytes()).hexdigest(),
        )
        self.assertEqual(
            doc["rootfs_sha256"],
            hashlib.sha256(self.rootfs.read_bytes()).hexdigest(),
        )

    def test_missing_login_marker_fails(self) -> None:
        result = self._run_harness(env_overrides={"QVB_STUB_MODE": "missing_login"})
        self.assertEqual(result.returncode, 1, msg=result.stderr)
        doc = json.loads(self.evidence.read_text(encoding="utf-8"))
        _validate_evidence(doc)
        self.assertFalse(doc["boot_completed"])
        self.assertEqual(doc["status"], "fail")
        self.assertIn("login:", doc["markers_missing"])
        self.assertIn("Linux version", doc["markers_found"])
        self.assertIn("Welcome to Buildroot", doc["markers_found"])
        self.assertEqual(doc["forbidden_markers_found"], [])

    def test_forbidden_marker_kernel_panic(self) -> None:
        result = self._run_harness(env_overrides={"QVB_STUB_MODE": "panic"})
        self.assertEqual(result.returncode, 1, msg=result.stderr)
        doc = json.loads(self.evidence.read_text(encoding="utf-8"))
        _validate_evidence(doc)
        self.assertFalse(doc["boot_completed"])
        self.assertEqual(doc["status"], "fail")
        self.assertIn("Kernel panic", doc["forbidden_markers_found"])

    def test_timeout_branch(self) -> None:
        # Stub sleeps longer than the harness timeout; harness must kill it
        # and record boot_completed=false with qemu_exit_code=124.
        result = self._run_harness(
            env_overrides={"QVB_STUB_MODE": "empty", "QVB_STUB_SLEEP": "10"},
        )
        self.assertEqual(result.returncode, 1, msg=result.stderr)
        doc = json.loads(self.evidence.read_text(encoding="utf-8"))
        _validate_evidence(doc)
        self.assertFalse(doc["boot_completed"])
        self.assertEqual(doc["status"], "fail")
        self.assertEqual(doc["qemu_exit_code"], 124)
        # No markers should have been found.
        self.assertEqual(doc["markers_found"], [])
        for marker in REQUIRED_MARKERS:
            self.assertIn(marker, doc["markers_missing"])


class EvidenceSchemaSelfTests(unittest.TestCase):
    """Self-tests for the validator helper used by the harness tests."""

    def _good_doc(self, **overrides: object) -> dict[str, object]:
        base: dict[str, object] = {
            "schema": EVIDENCE_SCHEMA,
            "claim_boundary": CLAIM_BOUNDARY,
            "status": "pass",
            "kernel_path": "/tmp/Image",
            "kernel_sha256": "a" * 64,
            "rootfs_path": "/tmp/rootfs.cpio",
            "rootfs_sha256": "b" * 64,
            "transcript_path": "/tmp/qemu.log",
            "transcript_sha256": "c" * 64,
            "memory_mb": 1024,
            "cpus": 2,
            "timeout_s": 300,
            "duration_s": 12,
            "start_utc": "2026-05-19T00:00:00Z",
            "qemu_exit_code": 0,
            "boot_completed": True,
            "markers_found": list(REQUIRED_MARKERS),
            "markers_missing": [],
            "forbidden_markers_found": [],
            "provenance": PROVENANCE,
        }
        base.update(overrides)
        return base

    def test_good_doc_passes(self) -> None:
        _validate_evidence(self._good_doc())

    def test_wrong_schema_rejected(self) -> None:
        with self.assertRaises(EvidenceSchemaError):
            _validate_evidence(self._good_doc(schema="some.other.schema.v1"))

    def test_wrong_claim_boundary_rejected(self) -> None:
        with self.assertRaises(EvidenceSchemaError):
            _validate_evidence(self._good_doc(claim_boundary="silicon-ready"))

    def test_bad_sha256_rejected(self) -> None:
        with self.assertRaises(EvidenceSchemaError):
            _validate_evidence(self._good_doc(kernel_sha256="not-hex"))

    def test_boot_completed_requires_all_markers(self) -> None:
        with self.assertRaises(EvidenceSchemaError):
            _validate_evidence(
                self._good_doc(
                    markers_found=["Linux version"],
                    markers_missing=["Welcome to Buildroot", "login:"],
                )
            )

    def test_boot_completed_rejects_forbidden_markers(self) -> None:
        with self.assertRaises(EvidenceSchemaError):
            _validate_evidence(self._good_doc(forbidden_markers_found=["Kernel panic"]))

    def test_non_string_marker_rejected(self) -> None:
        with self.assertRaises(EvidenceSchemaError):
            _validate_evidence(
                self._good_doc(markers_found=["Linux version", 42, "Welcome to Buildroot"])
            )

    def test_negative_duration_rejected(self) -> None:
        with self.assertRaises(EvidenceSchemaError):
            _validate_evidence(self._good_doc(duration_s=-1))

    def test_blocked_requires_blocked_reason(self) -> None:
        doc = self._good_doc(status="blocked", boot_completed=False)
        # Missing blocked_reason should fail.
        with self.assertRaises(EvidenceSchemaError):
            _validate_evidence(doc)


if __name__ == "__main__":
    unittest.main()
