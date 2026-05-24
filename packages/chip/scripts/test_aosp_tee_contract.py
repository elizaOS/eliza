#!/usr/bin/env python3
"""Tests for scripts/check_aosp_tee_contract.py."""

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

import check_aosp_tee_contract as gate  # noqa: E402

GOOD_SEPOLICY = """
type eliza_pvm_mgr, domain;
type eliza_pvm_mgr_exec, exec_type, file_type;
init_daemon_domain(eliza_pvm_mgr)
binder_call(eliza_pvm_mgr, virtualizationservice)
allow eliza_pvm_mgr virtualizationservice_service:service_manager find;
type eliza_pvm_vsock_device, dev_type;
allow eliza_pvm_mgr eliza_pvm_vsock_device:chr_file { open read write ioctl getattr };
neverallow { appdomain -eliza_pvm_mgr } eliza_pvm_vsock_device:chr_file *;
neverallow { appdomain } virtualizationservice_service:service_manager find;
"""

GOOD_FILE_CONTEXTS = """
/system/bin/eliza_pvm_mgr   u:object_r:eliza_pvm_mgr_exec:s0
/dev/vhost-vsock            u:object_r:eliza_pvm_vsock_device:s0
"""

GOOD_INIT_RC = """
service eliza_pvm_mgr /system/bin/eliza_pvm_mgr
    seclabel u:r:eliza_pvm_mgr:s0
"""

GOOD_COMMON = """
PRODUCT_ARTIFACT_PATH_REQUIREMENT_ALLOWED_LIST += \\
    product/etc/eliza/tee-policy.json \\
    product/etc/eliza/tee-measurements.json
PRODUCT_COPY_FILES += \\
    vendor/eliza/tee/tee-policy.json:$(TARGET_COPY_OUT_PRODUCT)/etc/eliza/tee-policy.json \\
    vendor/eliza/tee/tee-measurements.json:$(TARGET_COPY_OUT_PRODUCT)/etc/eliza/tee-measurements.json
"""

ZERO = "sha256:" + "0" * 64

GOOD_POLICY = {
    "confidentialityBlocked": True,
    "policy": {
        "required": True,
        "rejectSimulatedEvidence": True,
        "allowedKinds": ["pkvm", "avf"],
        "requiredMeasurements": {n: ZERO for n in gate.REQUIRED_MEASUREMENTS},
    },
}

GOOD_MEASUREMENTS = {
    "schemaVersion": 1,
    "measurements": {n: ZERO for n in gate.REQUIRED_MEASUREMENTS},
}

GOOD_EVIDENCE = {
    "kind": "pkvm",
    "provider": "eliza-pvm-mgr",
    "hardwareVendor": "eliza",
    "securityVersion": 1,
    "measurements": {n: ZERO for n in gate.REQUIRED_MEASUREMENTS},
    "freshness": {"nonce": "n", "timestamp": "2026-05-22T00:00:00Z"},
    "claims": {"debugDisabled": True, "secureBoot": True},
}


def write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


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


class AospTeeContractTests(unittest.TestCase):
    def _patch_tree(self, tmp: Path, *, complete: bool):
        vendor = tmp / "os/android/vendor/eliza"
        chip = tmp / "chip/sw/aosp-device"
        sepolicy = write(vendor / "sepolicy/eliza_pvm_mgr.te", GOOD_SEPOLICY)
        fc = write(vendor / "sepolicy/file_contexts", GOOD_FILE_CONTEXTS)
        common = write(vendor / "eliza_common.mk", GOOD_COMMON)
        init_rc = write(vendor / "init/init.eliza.rc", GOOD_INIT_RC)
        policy = write(vendor / "tee/tee-policy.json", json.dumps(GOOD_POLICY))
        meas = write(vendor / "tee/tee-measurements.json", json.dumps(GOOD_MEASUREMENTS))
        evidence = write(
            chip / "fixtures/tee/pvm-tee-evidence.bringup.json",
            json.dumps(GOOD_EVIDENCE),
        )
        if not complete:
            sepolicy.unlink()
            policy.unlink()
            evidence.unlink()
        return [
            mock.patch.object(gate, "WORKSPACE", tmp),
            mock.patch.object(gate, "OS_VENDOR", vendor),
            mock.patch.object(gate, "SEPOLICY_PVM", sepolicy),
            mock.patch.object(gate, "SEPOLICY_FILE_CONTEXTS", fc),
            mock.patch.object(gate, "OS_COMMON", common),
            mock.patch.object(gate, "INIT_RC", init_rc),
            mock.patch.object(gate, "TEE_POLICY", policy),
            mock.patch.object(gate, "TEE_MEASUREMENTS", meas),
            mock.patch.object(gate, "PVM_EVIDENCE_FIXTURE", evidence),
        ]

    def test_complete_contract_passes(self) -> None:
        with (
            tempfile.TemporaryDirectory() as tmpdir,
            PatchStack(self._patch_tree(Path(tmpdir), complete=True)),
        ):
            report = gate.run_check(Namespace())
        self.assertEqual(report["status"], "pass", report["findings"])
        self.assertEqual(report["findings"], [])
        self.assertEqual(report["confidentiality_claim"], "BLOCKED")
        self.assertEqual(report["claim_boundary"], gate.CLAIM_BOUNDARY)

    def test_missing_pieces_block(self) -> None:
        with (
            tempfile.TemporaryDirectory() as tmpdir,
            PatchStack(self._patch_tree(Path(tmpdir), complete=False)),
        ):
            report = gate.run_check(Namespace())
        self.assertEqual(report["status"], "blocked")
        codes = {f["code"] for f in report["findings"]}
        self.assertIn("pvm_sepolicy_domain_missing", codes)
        self.assertIn("tee_policy_file_missing", codes)
        self.assertIn("pvm_evidence_fixture_missing", codes)

    def test_simulated_evidence_kind_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            patches = self._patch_tree(Path(tmpdir), complete=True)
            with PatchStack(patches):
                gate.PVM_EVIDENCE_FIXTURE.write_text(
                    json.dumps({**GOOD_EVIDENCE, "kind": "pkvm-mock"}),
                    encoding="utf-8",
                )
                report = gate.run_check(Namespace())
        codes = {f["code"] for f in report["findings"]}
        self.assertEqual(report["status"], "blocked")
        self.assertIn("pvm_evidence_kind_out_of_contract", codes)
        self.assertIn("pvm_evidence_simulated_marker", codes)

    def test_confidentiality_overclaim_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            patches = self._patch_tree(Path(tmpdir), complete=True)
            with PatchStack(patches):
                gate.PVM_EVIDENCE_FIXTURE.write_text(
                    json.dumps(
                        {
                            **GOOD_EVIDENCE,
                            "claims": {
                                "debugDisabled": True,
                                "secureBoot": True,
                                "memoryEncrypted": True,
                            },
                        }
                    ),
                    encoding="utf-8",
                )
                report = gate.run_check(Namespace())
        codes = {f["code"] for f in report["findings"]}
        self.assertEqual(report["status"], "blocked")
        self.assertIn("pvm_evidence_overclaims_confidentiality", codes)

    def test_policy_not_blocked_confidentiality_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            patches = self._patch_tree(Path(tmpdir), complete=True)
            with PatchStack(patches):
                bad = {**GOOD_POLICY, "confidentialityBlocked": False}
                gate.TEE_POLICY.write_text(json.dumps(bad), encoding="utf-8")
                report = gate.run_check(Namespace())
        codes = {f["code"] for f in report["findings"]}
        self.assertEqual(report["status"], "blocked")
        self.assertIn("tee_policy_confidentiality_not_blocked", codes)

    def test_sepolicy_without_neverallow_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            patches = self._patch_tree(Path(tmpdir), complete=True)
            with PatchStack(patches):
                gate.SEPOLICY_PVM.write_text(
                    "type eliza_pvm_mgr, domain;\n"
                    "binder_call(eliza_pvm_mgr, virtualizationservice)\n"
                    "allow eliza_pvm_mgr eliza_pvm_vsock_device:chr_file { open };\n",
                    encoding="utf-8",
                )
                report = gate.run_check(Namespace())
        codes = {f["code"] for f in report["findings"]}
        self.assertEqual(report["status"], "blocked")
        self.assertIn("pvm_sepolicy_vsock_not_exclusive", codes)
        self.assertIn("pvm_sepolicy_virtmgr_not_exclusive", codes)


if __name__ == "__main__":
    unittest.main()
