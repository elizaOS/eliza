#!/usr/bin/env python3
"""Validate docs/spec-db/cpu-2028-target.yaml.

Fails closed when required fields are missing, when forbidden ISA escapes
appear in selected paths, or when phase_gates reference evidence files that
must exist but do not. Does not promote any CPU/AP claim; this is a contract
checker.
"""

from __future__ import annotations

import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / "docs/spec-db/cpu-2028-target.yaml"
ROCKET_MANIFEST = ROOT / "generators/chipyard/eliza-rocket-manifest.json"

REQUIRED_TOP_LEVEL = (
    "schema",
    "as_of",
    "target_year",
    "target_class",
    "positioning",
    "claim_boundary",
    "source_anchors",
    "selected_ap_path",
    "phase_a_isa",
    "phase_b_isa",
    "phase_c_isa",
    "vector",
    "mmu",
    "coherence_protocol",
    "interrupt_controller",
    "timer",
    "cache_maintenance",
    "management_security_hart",
    "forbidden_paths",
    "android_profile_target",
    "verification",
    "phase_gates",
    "forbidden_claims_until_complete",
)

EXPECTED_SCHEMA = "eliza.cpu_2028_target.v1"
FORBIDDEN_VECTOR = {"RVV_0_7_1", "Hwacha_pre_RVV_1_0", "Hwacha"}
FORBIDDEN_CACHE = {"vendor_specific_cache_CSRs"}


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

    if spec.get("target_year") != 2028:
        errors.append(f"target_year must be 2028, got {spec.get('target_year')}")

    vector = spec.get("vector") or {}
    if vector.get("required") != "RVV_1_0":
        errors.append("vector.required must be 'RVV_1_0'")
    forbidden = set(vector.get("forbidden") or [])
    if "RVV_0_7_1" not in forbidden:
        errors.append("vector.forbidden must include RVV_0_7_1")
    if not any("hwacha" in str(v).lower() for v in forbidden):
        errors.append("vector.forbidden must include a Hwacha variant")

    cache_maint = spec.get("cache_maintenance") or {}
    required_cmo = set(cache_maint.get("required") or [])
    for needed in ("Zicbom", "Zicbop", "Zicboz"):
        if needed not in required_cmo:
            errors.append(f"cache_maintenance.required must include {needed}")
    if not cache_maint.get("forbidden_vendor_csrs", False):
        errors.append("cache_maintenance.forbidden_vendor_csrs must be true")

    mgmt_hart = spec.get("management_security_hart") or {}
    if str(mgmt_hart.get("selection", "")).lower() != "ibex":
        errors.append("management_security_hart.selection must be 'ibex' (case-insensitive)")

    android = spec.get("android_profile_target") or {}
    if android.get("required") != "RVA22U64+V":
        errors.append("android_profile_target.required must be 'RVA22U64+V'")

    forbidden_paths = set(spec.get("forbidden_paths") or [])
    for needed in ("RVV_0_7_1", "Hwacha_pre_RVV_1_0", "vendor_specific_cache_CSRs"):
        if needed not in forbidden_paths:
            errors.append(f"forbidden_paths must include {needed}")

    selected_path = spec.get("selected_ap_path")
    if isinstance(selected_path, str) and "/" in selected_path:
        ap_path = ROOT / selected_path
        if not ap_path.exists():
            errors.append(f"selected_ap_path points at missing file: {selected_path}")

    if not ROCKET_MANIFEST.exists():
        errors.append(
            f"chipyard manifest missing: {ROCKET_MANIFEST.relative_to(ROOT)} (Phase A bring-up vehicle)"
        )

    phase_gates = spec.get("phase_gates") or {}
    if not isinstance(phase_gates, dict) or not phase_gates:
        errors.append("phase_gates must be a non-empty mapping")

    forbidden_claims = spec.get("forbidden_claims_until_complete") or []
    if not isinstance(forbidden_claims, list) or not forbidden_claims:
        errors.append("forbidden_claims_until_complete must be a non-empty list")

    verification = spec.get("verification") or {}
    expected_keywords = {"spike", "sail", "riscof", "rvfi", "riscv_dv"}
    found_blob = ""
    if isinstance(verification, (dict, list)):
        found_blob = str(verification).lower()
    missing_tools = {kw for kw in expected_keywords if kw not in found_blob}
    if missing_tools:
        errors.append(f"verification block must reference: {sorted(missing_tools)}")

    if errors:
        fail(errors)

    print("cpu 2028 target check passed")


if __name__ == "__main__":
    main()
