#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Unit tests for ``check_release_manifest.py``.

The tests use Hypothesis to mutate every required field of a known-good
manifest one at a time and assert that the gate flips from ``PASS`` to
``FAIL`` (or, for evidence-row mutations, to ``BLOCKED``). Plain
``unittest`` covers the fixed PASS / BLOCKED / FAIL paths.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

try:
    from hypothesis import HealthCheck, given, settings
    from hypothesis import strategies as st

    HAS_HYPOTHESIS = True
except ModuleNotFoundError:
    HAS_HYPOTHESIS = False

THIS_DIR = Path(__file__).resolve().parent
if str(THIS_DIR) not in sys.path:
    sys.path.insert(0, str(THIS_DIR))

import check_release_manifest as gate  # noqa: E402


ISO_FILENAME = "elizaos-debian-riscv64-20260519T000000Z.iso"


def _good_iso_bytes() -> bytes:
    return b"elizaOS Debian RISC-V 64 test ISO blob\n"


def _good_iso_sha256() -> str:
    return hashlib.sha256(_good_iso_bytes()).hexdigest()


def _good_transcript() -> str:
    return (
        "OpenSBI v1.4\n"
        "GNU GRUB  version 2.12\n"
        "Booting `elizaOS Live (RISC-V 64)'\n"
        "EFI stub: Booting Linux Kernel\n"
        "Linux version 6.7 (riscv64)\n"
        "systemd[1]: Reached target Multi-User System.\n"
        "elizaos-firstboot[123]: first boot complete; emitting marker\n"
        f"elizaos-firstboot[123]: {gate.REQUIRED_TRANSCRIPT_MARKER}\n"
        "login: \n"
    )


def _good_evidence(iso_path: Path, transcript_path: Path) -> dict:
    return {
        "iso": str(iso_path),
        "iso_sha256": _good_iso_sha256(),
        "qemu_args": ["qemu-system-riscv64", "-machine", "virt"],
        "boot_completed": True,
        "elizaos_ready": True,
        "transcript_path": str(transcript_path),
        "started_at": "2026-05-19T00:00:00Z",
        "ended_at": "2026-05-19T00:03:14Z",
        "duration_s": 194.0,
    }


def _good_grub_evidence(iso_path: Path, transcript_path: Path) -> dict:
    return {
        "schema": "eliza.os.linux.grub_efi_riscv64_boot.v1",
        "claim_boundary": "grub_efi_riscv64_boot_transcript_evidence_only_no_silicon_or_physical_board_claim",
        "iso_path": str(iso_path),
        "iso_sha256": _good_iso_sha256(),
        "transcript_path": str(transcript_path),
        "transcript_sha256": hashlib.sha256(_good_transcript().encode()).hexdigest(),
        "boot_completed": True,
        "grub_markers": list(gate.GRUB_TRANSCRIPT_MARKERS),
        "provenance": "qemu_virt_transcript",
    }


def _good_manifest(
    *,
    evidence_path: str,
    grub_evidence_path: str,
    iso_filename: str = ISO_FILENAME,
) -> dict:
    return {
        "id": "elizaos-debian-riscv64-live",
        "kind": "raw-image",
        "target": {
            "platform": "linux",
            "architecture": "riscv64",
            "device": None,
            "hypervisor": None,
            "firmware": None,
        },
        "filename": iso_filename,
        "downloadUrl": f"https://download.elizaos.ai/os/linux/{iso_filename}",
        "status": "candidate",
        "sizeBytes": len(_good_iso_bytes()),
        "sha256": _good_iso_sha256(),
        "signature": {"status": "pending", "url": None},
        "validation": {
            "requiredEvidence": list(gate.REQUIRED_EVIDENCE_IDS),
            "evidence": [
                {
                    "id": "qemu-virt-boot",
                    "status": "collected",
                    "path": evidence_path,
                    "notes": "qemu-virt boot transcript captured.",
                },
                {
                    "id": "grub-efi-riscv64-boot",
                    "status": "collected",
                    "path": grub_evidence_path,
                    "notes": "GRUB EFI boot captured.",
                },
                {
                    "id": "elizaos-agent-live",
                    "status": "collected",
                    "path": "evidence/elizaos_agent_live.json",
                    "notes": "Agent service active and health endpoint responded.",
                },
                {
                    "id": "u-boot-extlinux-boot",
                    "status": "not-required",
                    "path": None,
                    "notes": "U-Boot extlinux boot is not required for this fixture.",
                },
                {
                    "id": "hardware-board-boot",
                    "status": "not-required",
                    "path": None,
                    "notes": "Hardware board boot is not required for this fixture.",
                },
            ],
        },
        "notes": "Test fixture manifest.",
    }


class _Sandbox:
    """Temporary variant-dir replica with a real ISO + evidence on disk."""

    def __init__(self) -> None:
        self.tmpdir = Path(tempfile.mkdtemp(prefix="elizaos-rv64-gate-test-"))
        (self.tmpdir / "out").mkdir(parents=True, exist_ok=True)
        (self.tmpdir / "evidence").mkdir(parents=True, exist_ok=True)
        self.iso_path = self.tmpdir / "out" / ISO_FILENAME
        self.iso_path.write_bytes(_good_iso_bytes())
        self.transcript_path = self.tmpdir / "evidence" / "qemu_virt_boot.log"
        self.transcript_path.write_text(_good_transcript())
        self.evidence_path = self.tmpdir / "evidence" / "qemu_virt_boot.json"
        self.evidence_payload = _good_evidence(self.iso_path, self.transcript_path)
        self.evidence_path.write_text(json.dumps(self.evidence_payload))
        self.grub_evidence_path = (
            self.tmpdir / "evidence" / "grub_efi_riscv64_boot.json"
        )
        self.grub_evidence_payload = _good_grub_evidence(
            self.iso_path, self.transcript_path
        )
        self.grub_evidence_path.write_text(json.dumps(self.grub_evidence_payload))
        self.manifest_payload = _good_manifest(
            evidence_path=str(self.evidence_path.relative_to(self.tmpdir)),
            grub_evidence_path=str(self.grub_evidence_path.relative_to(self.tmpdir)),
        )
        self.manifest_path = self.tmpdir / "manifest.json"
        self.manifest_path.write_text(json.dumps(self.manifest_payload))

    def cleanup(self) -> None:
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def write_manifest(self, payload: dict) -> None:
        self.manifest_path.write_text(json.dumps(payload))

    def write_evidence(self, payload: dict) -> None:
        self.evidence_path.write_text(json.dumps(payload))

    def remove_manifest(self) -> None:
        self.manifest_path.unlink(missing_ok=True)

    def remove_evidence(self) -> None:
        self.evidence_path.unlink(missing_ok=True)

    def remove_grub_evidence(self) -> None:
        self.grub_evidence_path.unlink(missing_ok=True)


def _run(sandbox: _Sandbox) -> tuple[gate.Status, list[gate.GateResult]]:
    status, results, _path, _is_template = gate.run_checks(sandbox.tmpdir)
    return status, results


class DependencyTests(unittest.TestCase):
    def test_missing_jsonschema_blocks_instead_of_crashing(self) -> None:
        original = gate.jsonschema
        try:
            gate.jsonschema = None
            results = gate.check_schema({}, {})
        finally:
            gate.jsonschema = original
        self.assertEqual(results[0].status, "BLOCKED")
        self.assertIn("jsonschema", results[0].message)


@unittest.skipUnless(
    gate.jsonschema is not None,
    "jsonschema is required for full release-manifest validation; install requirements.txt",
)
class FixedPathTests(unittest.TestCase):
    def setUp(self) -> None:
        self.sandbox = _Sandbox()

    def tearDown(self) -> None:
        self.sandbox.cleanup()

    def test_valid_manifest_passes(self) -> None:
        status, results = _run(self.sandbox)
        self.assertEqual(status, "PASS", msg=[(r.status, r.message) for r in results])

    def test_template_only_blocks(self) -> None:
        self.sandbox.remove_manifest()
        template = self.sandbox.tmpdir / "manifest.json.template"
        template.write_text((gate.VARIANT_DIR / "manifest.json.template").read_text())
        status, _results = _run(self.sandbox)
        self.assertEqual(status, "BLOCKED")

    def test_missing_evidence_file_blocks(self) -> None:
        self.sandbox.remove_evidence()
        status, results = _run(self.sandbox)
        # qemu-virt row is still ``collected`` in the manifest (the file just
        # vanished), so the row check stays PASS but the cross-check BLOCKS.
        self.assertEqual(status, "BLOCKED")
        self.assertTrue(
            any("evidence file not present" in r.message for r in results),
            msg=[(r.status, r.message) for r in results],
        )

    def test_missing_grub_evidence_file_blocks(self) -> None:
        self.sandbox.remove_grub_evidence()
        status, results = _run(self.sandbox)
        self.assertEqual(status, "BLOCKED")
        self.assertTrue(
            any("grub_efi_riscv64_boot.json" in r.message for r in results),
            msg=[(r.status, r.message) for r in results],
        )

    def test_iso_sha256_mismatch_fails(self) -> None:
        payload = dict(self.sandbox.manifest_payload)
        payload["sha256"] = "1" * 64
        self.sandbox.write_manifest(payload)
        status, results = _run(self.sandbox)
        self.assertEqual(status, "FAIL", msg=[(r.status, r.message) for r in results])
        self.assertTrue(any("iso_sha256 mismatch" in r.message for r in results))

    def test_boot_not_completed_fails(self) -> None:
        ev = dict(self.sandbox.evidence_payload)
        ev["boot_completed"] = False
        self.sandbox.write_evidence(ev)
        status, results = _run(self.sandbox)
        self.assertEqual(status, "FAIL")
        self.assertTrue(any("did not complete" in r.message for r in results))

    def test_missing_marker_fails(self) -> None:
        bad_transcript = self.sandbox.transcript_path
        bad_transcript.write_text(
            _good_transcript().replace(gate.REQUIRED_TRANSCRIPT_MARKER, "")
        )
        status, results = _run(self.sandbox)
        self.assertEqual(status, "FAIL")
        self.assertTrue(
            any("missing required marker" in r.message for r in results),
            msg=[(r.status, r.message) for r in results],
        )

    def test_missing_grub_marker_fails(self) -> None:
        self.sandbox.transcript_path.write_text(
            _good_transcript().replace("GNU GRUB", "")
        )
        status, results = _run(self.sandbox)
        self.assertEqual(status, "FAIL")
        self.assertTrue(
            any(
                "GRUB transcript missing required marker" in r.message for r in results
            ),
            msg=[(r.status, r.message) for r in results],
        )

    def test_planned_status_blocks_not_fails(self) -> None:
        payload = dict(self.sandbox.manifest_payload)
        payload["status"] = "planned"
        for row in payload["validation"]["evidence"]:
            row["status"] = "missing"
            row["path"] = None
        self.sandbox.write_manifest(payload)
        status, _results = _run(self.sandbox)
        self.assertEqual(status, "BLOCKED")

    def test_promoted_with_missing_row_fails(self) -> None:
        payload = dict(self.sandbox.manifest_payload)
        payload["status"] = "candidate"
        payload["validation"]["evidence"][1]["status"] = "missing"
        payload["validation"]["evidence"][1]["path"] = None
        self.sandbox.write_manifest(payload)
        status, results = _run(self.sandbox)
        self.assertEqual(status, "FAIL")
        self.assertTrue(any("grub-efi-riscv64-boot" in r.message for r in results))

    def test_required_evidence_id_missing_fails(self) -> None:
        payload = dict(self.sandbox.manifest_payload)
        payload["validation"]["requiredEvidence"] = [
            row
            for row in payload["validation"]["requiredEvidence"]
            if row != "qemu-virt-boot"
        ]
        self.sandbox.write_manifest(payload)
        status, _results = _run(self.sandbox)
        self.assertEqual(status, "FAIL")

    def test_evidence_row_missing_id_fails(self) -> None:
        payload = dict(self.sandbox.manifest_payload)
        payload["validation"]["evidence"] = [
            row
            for row in payload["validation"]["evidence"]
            if row["id"] != "grub-efi-riscv64-boot"
        ]
        self.sandbox.write_manifest(payload)
        status, _results = _run(self.sandbox)
        self.assertEqual(status, "FAIL")

    def test_invalid_kind_violates_schema(self) -> None:
        payload = dict(self.sandbox.manifest_payload)
        payload["kind"] = "not-a-real-kind"
        self.sandbox.write_manifest(payload)
        status, results = _run(self.sandbox)
        self.assertEqual(status, "FAIL")
        self.assertTrue(any("schema violation" in r.message for r in results))

    def test_invalid_architecture_violates_schema(self) -> None:
        payload = dict(self.sandbox.manifest_payload)
        payload["target"]["architecture"] = "powerpc"
        self.sandbox.write_manifest(payload)
        status, _results = _run(self.sandbox)
        self.assertEqual(status, "FAIL")

    def test_signature_status_invalid_violates_schema(self) -> None:
        payload = dict(self.sandbox.manifest_payload)
        payload["signature"]["status"] = "yolo"
        self.sandbox.write_manifest(payload)
        status, _results = _run(self.sandbox)
        self.assertEqual(status, "FAIL")


if HAS_HYPOTHESIS:

    class MutationFuzz(unittest.TestCase):
        """Hypothesis-driven mutations covering every top-level required field."""

        # Top-level required fields per the umbrella schema's artifacts[] items.
        _REQUIRED_TOP_LEVEL = (
            "id",
            "kind",
            "target",
            "filename",
            "downloadUrl",
            "status",
            "sizeBytes",
            "sha256",
            "validation",
        )

        def setUp(self) -> None:
            self.sandbox = _Sandbox()

        def tearDown(self) -> None:
            self.sandbox.cleanup()

        @settings(
            deadline=None,
            max_examples=25,
            suppress_health_check=[HealthCheck.function_scoped_fixture],
        )
        @given(field=st.sampled_from(_REQUIRED_TOP_LEVEL))
        def test_dropping_required_field_fails(self, field: str) -> None:
            payload = json.loads(json.dumps(self.sandbox.manifest_payload))
            payload.pop(field, None)
            self.sandbox.write_manifest(payload)
            status, results = _run(self.sandbox)
            self.assertIn(
                status,
                ("FAIL", "BLOCKED"),
                msg=f"dropping {field} produced {status} {[(r.status, r.message) for r in results]}",
            )
            # Dropping a structural field must surface as FAIL, never silently PASS.
            self.assertNotEqual(status, "PASS")

        @settings(
            deadline=None,
            max_examples=25,
            suppress_health_check=[HealthCheck.function_scoped_fixture],
        )
        @given(garbage=st.text(min_size=1, max_size=16))
        def test_garbage_sha256_fails(self, garbage: str) -> None:
            payload = json.loads(json.dumps(self.sandbox.manifest_payload))
            payload["sha256"] = garbage
            self.sandbox.write_manifest(payload)
            status, _results = _run(self.sandbox)
            # Either the schema (regex) or the cross-check catches it; PASS is illegal.
            self.assertNotEqual(status, "PASS")

        @settings(
            deadline=None,
            max_examples=10,
            suppress_health_check=[HealthCheck.function_scoped_fixture],
        )
        @given(
            bad_status=st.sampled_from(["missing", "waived", "not-required"]),
        )
        def test_promoted_with_uncollected_row_fails(self, bad_status: str) -> None:
            payload = json.loads(json.dumps(self.sandbox.manifest_payload))
            payload["status"] = "candidate"
            payload["validation"]["evidence"][1]["status"] = bad_status
            self.sandbox.write_manifest(payload)
            status, results = _run(self.sandbox)
            self.assertEqual(
                status, "FAIL", msg=[(r.status, r.message) for r in results]
            )

else:

    class MutationFuzz(unittest.TestCase):
        def test_hypothesis_dependency_missing(self) -> None:
            self.skipTest(
                "hypothesis is required for mutation fuzz tests; install requirements.txt"
            )


class AggregationTests(unittest.TestCase):
    def test_fail_dominates_blocked(self) -> None:
        results = [
            gate.GateResult("PASS", "ok"),
            gate.GateResult("BLOCKED", "wait"),
            gate.GateResult("FAIL", "nope"),
        ]
        self.assertEqual(gate.aggregate(results), "FAIL")

    def test_blocked_dominates_pass(self) -> None:
        results = [
            gate.GateResult("PASS", "ok"),
            gate.GateResult("BLOCKED", "wait"),
        ]
        self.assertEqual(gate.aggregate(results), "BLOCKED")

    def test_all_pass(self) -> None:
        self.assertEqual(
            gate.aggregate([gate.GateResult("PASS", "ok")]),
            "PASS",
        )


if __name__ == "__main__":
    unittest.main()
