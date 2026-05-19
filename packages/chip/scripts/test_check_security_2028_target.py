#!/usr/bin/env python3
"""Unit tests for ``scripts/check_security_2028_target.py``."""

from __future__ import annotations

import contextlib
import copy
import importlib
import io
import sys
import tempfile
import unittest
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from unittest import mock

import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

check_security_2028_target = importlib.import_module("check_security_2028_target")


CROSS_REF_FILES = ("arch", "threat_model", "test_plan", "fail_closed_work_order")


def minimal_valid_spec() -> dict[str, Any]:
    return {
        "schema": "eliza.security_2028_target.v1",
        "as_of": "2026-05-19",
        "target_year": 2028,
        "claim_boundary": "synthetic claim boundary",
        "source_anchors": {"research_inventory": "research/security_2026/inv.yaml"},
        "rot_ip_set": {
            "license": "Apache-2.0",
            "security_mcu": {"core": "ibex"},
            "boot_supervisor_blocks": [
                {"block": "rom_ctrl"},
                {"block": "lc_ctrl"},
                {"block": "otp_ctrl"},
                {"block": "keymgr"},
                {"block": "aes"},
                {"block": "hmac"},
                {"block": "entropy_src"},
                {"block": "csrng"},
                {"block": "edn"},
                {"block": "otbn"},
            ],
        },
        "boot_chain": {"no_software_only_crypto_on_boot_path": True},
        "key_algorithms": {
            "required": {"signing": "Ed25519", "rng": "SP_800_90B"}
        },
        "verified_boot": {"framework": "libavb 2.0"},
        "lifecycle_states": {"controller": "opentitan_lc_ctrl"},
        "dma_isolation": {
            "hart_pmp": {"required": "ePMP + Smepmp on every RV hart"},
            "interconnect_iopmp": {"required": "deny_by_default"},
        },
        "attestation": {"framework": "DICE"},
        "tee": {"v0_status": "deferred_no_tee"},
        "side_channel_posture": {"v0_explicit_non_goals": ["T9_DPA_EM_extraction"]},
        "rowhammer": {"cross_reference": "docs/spec-db/memory-2028-target.yaml#rowhammer_policy"},
        "synthetic_otp_prototype": {"scope": "sky130_openlane_simulator_only"},
        "phase_gates": {"v0": {"description": "synthetic OTP + libavb"}},
        "forbidden_claims_until_evidence": [
            {"claim": "secure_boot"},
            {"claim": "verified_boot"},
            {"claim": "rollback_protected"},
            {"claim": "debug_locked"},
            {"claim": "strongbox"},
        ],
        "cross_references": {
            "arch": "docs/arch/security.md",
            "threat_model": "docs/security/threat-model.md",
            "test_plan": "docs/security/test-plan.md",
            "fail_closed_work_order": "docs/project/fail-closed-work-order.yaml",
        },
    }


@contextlib.contextmanager
def patched_validator(spec: dict[str, Any], *, write_refs: bool = True) -> Iterator[Path]:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        spec_path = root / "docs/spec-db/security-2028-target.yaml"
        spec_path.parent.mkdir(parents=True, exist_ok=True)
        spec_path.write_text(yaml.safe_dump(spec, sort_keys=True), encoding="utf-8")
        if write_refs:
            for ref in (spec.get("cross_references") or {}).values():
                if not isinstance(ref, str):
                    continue
                p = root / ref
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text("# synthetic\n", encoding="utf-8")
        with (
            mock.patch.object(check_security_2028_target, "ROOT", root),
            mock.patch.object(check_security_2028_target, "SPEC", spec_path),
        ):
            yield root


def run_validator() -> tuple[int, str, str]:
    stdout = io.StringIO()
    stderr = io.StringIO()
    code = 0
    try:
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            check_security_2028_target.main()
    except SystemExit as exc:
        code = exc.code if isinstance(exc.code, int) else 1
    return code, stdout.getvalue(), stderr.getvalue()


class TestSecurityCheck(unittest.TestCase):
    def test_minimal_valid_passes(self) -> None:
        with patched_validator(minimal_valid_spec()):
            code, out, _err = run_validator()
        self.assertEqual(code, 0, out)
        self.assertIn("security 2028 target check passed", out)

    def test_wrong_schema_fails(self) -> None:
        spec = copy.deepcopy(minimal_valid_spec())
        spec["schema"] = "wrong"
        with patched_validator(spec):
            code, _out, err = run_validator()
        self.assertNotEqual(code, 0)
        self.assertIn("schema", err)

    def test_missing_required_field_fails(self) -> None:
        for field in (
            "schema",
            "rot_ip_set",
            "boot_chain",
            "key_algorithms",
            "verified_boot",
            "lifecycle_states",
            "dma_isolation",
            "attestation",
            "tee",
            "side_channel_posture",
            "rowhammer",
            "synthetic_otp_prototype",
            "phase_gates",
            "forbidden_claims_until_evidence",
            "cross_references",
        ):
            with self.subTest(field=field):
                spec = copy.deepcopy(minimal_valid_spec())
                spec.pop(field)
                with patched_validator(spec):
                    code, _out, err = run_validator()
                self.assertNotEqual(code, 0)
                self.assertIn(field, err)

    def test_missing_rot_block_fails(self) -> None:
        for needed in ("rom_ctrl", "lc_ctrl", "otp_ctrl", "keymgr", "aes", "hmac",
                       "entropy_src", "csrng", "edn", "otbn"):
            with self.subTest(block=needed):
                spec = copy.deepcopy(minimal_valid_spec())
                spec["rot_ip_set"]["boot_supervisor_blocks"] = [
                    b for b in spec["rot_ip_set"]["boot_supervisor_blocks"]
                    if b["block"] != needed
                ]
                with patched_validator(spec):
                    code, _out, err = run_validator()
                self.assertNotEqual(code, 0)
                self.assertIn(needed, err)

    def test_wrong_license_fails(self) -> None:
        spec = copy.deepcopy(minimal_valid_spec())
        spec["rot_ip_set"]["license"] = "GPL-3.0"
        with patched_validator(spec):
            code, _out, err = run_validator()
        self.assertNotEqual(code, 0)
        self.assertIn("Apache-2.0", err)

    def test_software_only_crypto_on_boot_path_fails(self) -> None:
        spec = copy.deepcopy(minimal_valid_spec())
        spec["boot_chain"]["no_software_only_crypto_on_boot_path"] = False
        with patched_validator(spec):
            code, _out, err = run_validator()
        self.assertNotEqual(code, 0)
        self.assertIn("no_software_only_crypto_on_boot_path", err)

    def test_signing_must_be_ed25519(self) -> None:
        spec = copy.deepcopy(minimal_valid_spec())
        spec["key_algorithms"]["required"]["signing"] = "RSA-2048"
        with patched_validator(spec):
            code, _out, err = run_validator()
        self.assertNotEqual(code, 0)
        self.assertIn("Ed25519", err)

    def test_rng_must_be_sp_800_90b(self) -> None:
        spec = copy.deepcopy(minimal_valid_spec())
        spec["key_algorithms"]["required"]["rng"] = "PRNG"
        with patched_validator(spec):
            code, _out, err = run_validator()
        self.assertNotEqual(code, 0)
        self.assertIn("SP_800_90B", err)

    def test_hart_pmp_must_include_epmp_smepmp(self) -> None:
        spec = copy.deepcopy(minimal_valid_spec())
        spec["dma_isolation"]["hart_pmp"]["required"] = "PMP only"
        with patched_validator(spec):
            code, _out, err = run_validator()
        self.assertNotEqual(code, 0)
        self.assertIn("ePMP + Smepmp", err)

    def test_iopmp_deny_by_default_required(self) -> None:
        spec = copy.deepcopy(minimal_valid_spec())
        spec["dma_isolation"]["interconnect_iopmp"]["required"] = "allow_all"
        with patched_validator(spec):
            code, _out, err = run_validator()
        self.assertNotEqual(code, 0)
        self.assertIn("deny_by_default", err)

    def test_missing_forbidden_claim_fails(self) -> None:
        for needed in ("secure_boot", "verified_boot", "rollback_protected", "debug_locked", "strongbox"):
            with self.subTest(claim=needed):
                spec = copy.deepcopy(minimal_valid_spec())
                spec["forbidden_claims_until_evidence"] = [
                    c for c in spec["forbidden_claims_until_evidence"]
                    if c["claim"] != needed
                ]
                with patched_validator(spec):
                    code, _out, err = run_validator()
                self.assertNotEqual(code, 0)
                self.assertIn(needed, err)

    def test_missing_cross_reference_file_fails(self) -> None:
        with patched_validator(minimal_valid_spec(), write_refs=False):
            code, _out, err = run_validator()
        self.assertNotEqual(code, 0)
        for ref_key in CROSS_REF_FILES:
            self.assertIn(ref_key, err)


if __name__ == "__main__":
    unittest.main()
