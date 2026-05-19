#!/usr/bin/env python3
"""Validate docs/spec-db/memory-2028-target.yaml.

Fails closed when required fields are missing or numeric targets fall below
the npu-2028-target.yaml memory contract. Does not promote any memory claim.
"""

from __future__ import annotations

import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / "docs/spec-db/memory-2028-target.yaml"
NPU_SPEC = ROOT / "docs/spec-db/npu-2028-target.yaml"

REQUIRED_TOP_LEVEL = (
    "schema",
    "as_of",
    "target_year",
    "claim_boundary",
    "source_anchors",
    "external_memory",
    "shared_system_cache",
    "npu_local_sram",
    "coherent_fabric",
    "iommu",
    "qos",
    "compression_aware_dma",
    "framebuffer_compression",
    "cache_stash",
    "rowhammer_policy",
    "phase_gates",
    "forbidden_claims_until_complete",
)

EXPECTED_SCHEMA = "eliza.memory_2028_target.v1"


def fail(messages: list[str]) -> None:
    for line in messages:
        print(f"FAIL: {line}", file=sys.stderr)
    sys.exit(1)


def stringify(value: object) -> str:
    return str(value).lower()


def main() -> None:
    if not SPEC.exists():
        fail([f"spec missing: {SPEC.relative_to(ROOT)}"])
    if not NPU_SPEC.exists():
        fail([f"cross-reference missing: {NPU_SPEC.relative_to(ROOT)}"])

    with SPEC.open("r", encoding="utf-8") as fh:
        spec = yaml.safe_load(fh)
    with NPU_SPEC.open("r", encoding="utf-8") as fh:
        npu = yaml.safe_load(fh)

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

    npu_numeric = (npu or {}).get("numeric_targets") or {}
    spec_blob = stringify(spec)

    npu_extern_bw = npu_numeric.get("external_memory_bandwidth_gbps_min")
    if npu_extern_bw is not None and str(npu_extern_bw) not in str(spec):
        errors.append(
            f"memory spec must reference npu_external_memory_bandwidth_gbps_min={npu_extern_bw}"
        )

    if "lpddr6" not in spec_blob and "lpddr-6" not in spec_blob:
        errors.append("external_memory must reference LPDDR6")

    if "tilelink" not in spec_blob and "chi" not in spec_blob:
        errors.append("coherent_fabric must reference TileLink-C or CHI variant")

    if "iommu" not in spec_blob and "smmu" not in spec_blob:
        errors.append("iommu block must reference IOMMU or SMMU")

    rowhammer = spec.get("rowhammer_policy") or {}
    rowhammer_blob = stringify(rowhammer)
    for keyword in ("trr", "rfm"):
        if keyword not in rowhammer_blob:
            errors.append(f"rowhammer_policy must reference {keyword.upper()}")

    forbidden = spec.get("forbidden_claims_until_complete") or []
    if not isinstance(forbidden, list) or not forbidden:
        errors.append("forbidden_claims_until_complete must be a non-empty list")

    phase_gates = spec.get("phase_gates") or {}
    if not isinstance(phase_gates, dict) or not phase_gates:
        errors.append("phase_gates must be a non-empty mapping")

    if errors:
        fail(errors)

    print("memory 2028 target check passed")


if __name__ == "__main__":
    main()
