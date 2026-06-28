#!/usr/bin/env python3
"""Validate docs/spec-db/security-2028-target.yaml.

Fails closed when required fields are missing, when forbidden_claims do not
align with the existing fail-closed work order, or when cross-referenced
security docs are absent. Does not promote any security claim.
"""

from __future__ import annotations

import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / "docs/spec-db/security-2028-target.yaml"

REQUIRED_TOP_LEVEL = (
    "schema",
    "as_of",
    "target_year",
    "claim_boundary",
    "source_anchors",
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
)

EXPECTED_SCHEMA = "eliza.security_2028_target.v1"

REQUIRED_ROT_BLOCKS = (
    "rom_ctrl",
    "lc_ctrl",
    "otp_ctrl",
    "keymgr",
    "aes",
    "hmac",
    "entropy_src",
    "csrng",
    "edn",
    "otbn",
)


def fail(messages: list[str]) -> None:
    for line in messages:
        print(f"FAIL: {line}", file=sys.stderr)
    sys.exit(1)


def main() -> None:
    if not SPEC.exists():
        fail([f"spec missing: {SPEC.relative_to(ROOT)}"])

    with SPEC.open("r", encoding="utf-8") as fh:
        spec = yaml.safe_load(fh)

    errors: list[str] = []

    if not isinstance(spec, dict):
        fail([f"spec is not a mapping: {SPEC.relative_to(ROOT)}"])

    if spec.get("schema") != EXPECTED_SCHEMA:
        errors.append(f"schema must be '{EXPECTED_SCHEMA}', got '{spec.get('schema')}'")

    for key in REQUIRED_TOP_LEVEL:
        if key not in spec:
            errors.append(f"missing required field: {key}")

    rot = spec.get("rot_ip_set") or {}
    blocks_list = rot.get("boot_supervisor_blocks") or []
    block_names = {str((b or {}).get("block", "")).lower() for b in blocks_list}
    for needed in REQUIRED_ROT_BLOCKS:
        if needed not in block_names:
            errors.append(f"rot_ip_set.boot_supervisor_blocks must include {needed}")
    if str(rot.get("license", "")).lower() != "apache-2.0":
        errors.append("rot_ip_set.license must be 'Apache-2.0'")

    boot_chain = spec.get("boot_chain") or {}
    if not boot_chain.get("no_software_only_crypto_on_boot_path", False):
        errors.append("boot_chain.no_software_only_crypto_on_boot_path must be true")

    crypto = spec.get("key_algorithms") or {}
    required_crypto = crypto.get("required") or {}
    if required_crypto.get("signing") != "Ed25519":
        errors.append("key_algorithms.required.signing must be 'Ed25519'")
    if required_crypto.get("rng") != "SP_800_90B":
        errors.append("key_algorithms.required.rng must be 'SP_800_90B'")

    dma = spec.get("dma_isolation") or {}
    hart_pmp = (dma.get("hart_pmp") or {}).get("required", "")
    if "Smepmp" not in str(hart_pmp) or "ePMP" not in str(hart_pmp):
        errors.append("dma_isolation.hart_pmp.required must include ePMP + Smepmp")
    interconnect = dma.get("interconnect_iopmp") or {}
    if interconnect.get("required") != "deny_by_default":
        errors.append("dma_isolation.interconnect_iopmp.required must be 'deny_by_default'")

    forbidden = spec.get("forbidden_claims_until_evidence") or []
    if not isinstance(forbidden, list) or not forbidden:
        errors.append("forbidden_claims_until_evidence must be a non-empty list")
    else:
        claim_names = {str((c or {}).get("claim", "")).lower() for c in forbidden}
        for needed in (
            "secure_boot",
            "verified_boot",
            "rollback_protected",
            "debug_locked",
            "strongbox",
        ):
            if needed not in claim_names:
                errors.append(f"forbidden_claims_until_evidence must include '{needed}'")

    cross_refs = spec.get("cross_references") or {}
    for key in ("arch", "threat_model", "test_plan", "fail_closed_work_order"):
        ref = cross_refs.get(key)
        if not ref:
            errors.append(f"cross_references.{key} missing")
            continue
        ref_path = ROOT / ref
        if not ref_path.exists():
            errors.append(f"cross_references.{key} points at missing file: {ref}")

    if errors:
        fail(errors)

    print("security 2028 target check passed")


if __name__ == "__main__":
    main()
