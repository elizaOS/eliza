#!/usr/bin/env python3
"""RISC-V IOMMU evidence gate checker.

Validates docs/evidence/memory/iommu-evidence-gate.yaml together with
the RTL implementation under rtl/iommu/, the cocotb tests under
verify/cocotb/iommu/, and the pinned reference-model manifest under
verify/cocotb/iommu/refmodel/riscv-iommu.manifest.yaml.
"""

from __future__ import annotations

import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
GATE = ROOT / "docs/evidence/memory/iommu-evidence-gate.yaml"
REFMODEL_MANIFEST = ROOT / "verify/cocotb/iommu/refmodel/riscv-iommu.manifest.yaml"

REQUIRED_RTL = [
    "rtl/iommu/e1_riscv_iommu.sv",
    "rtl/iommu/e1_riscv_iommu_pkg.sv",
]
REQUIRED_RTL_TOKENS = {
    "rtl/iommu/e1_riscv_iommu.sv": [
        "module e1_riscv_iommu",
        "RISC-V IOMMU v1.0.1",
        "fault_irq",
        "page_req_irq",
        "OFFS_CAPABILITIES",
        "DDTP_MODE_BARE",
        "CAUSE_DDT_ENTRY_NOT_VALID",
        "TR_REQ_IOVA",
    ],
    "rtl/iommu/e1_riscv_iommu_pkg.sv": [
        "package e1_riscv_iommu_pkg",
        "OFFS_DDTP",
        "DDTP_MODE_1LVL",
        "FS_MODE_SV39",
        "GS_MODE_SV39X4",
        "CAUSE_DDT_ENTRY_NOT_VALID",
        "TTYP_UNTRANSLATED_READ_NO_AMO",
    ],
}

REQUIRED_TESTS = {
    "capabilities_register_advertises_v1_features",
    "bare_mode_passes_traffic_with_no_fault",
    "translate_mode_blocks_unknown_devid_with_fault",
    "translate_mode_allows_known_devid",
    "pasid_isolation_via_allowlist_revoke",
    "two_stage_translation_via_3lvl_ddt",
    "pasid_context_switch_across_two_streams",
    "page_request_interface_counter_visible",
    "ats_translation_capability_advertised",
    "translation_request_interface_round_trip",
}

REQUIRED_ARTIFACTS = {
    "docs/evidence/memory/iommu_capabilities_report.json": "eliza.memory.iommu_capabilities.v1",
    "docs/evidence/memory/iommu_fault_injection_report.json": "eliza.memory.iommu_fault_injection.v1",
    "docs/evidence/memory/iommu_ats_round_trip_report.json": "eliza.memory.iommu_ats_round_trip.v1",
    "docs/evidence/memory/iommu_pri_round_trip_report.json": "eliza.memory.iommu_pri_round_trip.v1",
    "docs/evidence/memory/iommu_linux_driver_attach_transcript.json": "eliza.memory.iommu_linux_driver.v1",
    "docs/evidence/memory/iommu_pasid_isolation_report.json": "eliza.memory.iommu_pasid_isolation.v1",
}


def require(condition: bool, message: str, errors: list[str]) -> None:
    if not condition:
        errors.append(message)


def main() -> int:
    errors: list[str] = []
    require(GATE.is_file(), f"missing {GATE.relative_to(ROOT)}", errors)
    if not GATE.is_file():
        for e in errors:
            print(f"  - {e}")
        return 1

    data = yaml.safe_load(GATE.read_text())
    require(data.get("schema") == "eliza.iommu_evidence_gate.v1", "gate schema drifted", errors)
    require(
        data.get("status") == "blocked_until_evidence",
        "gate must remain blocked_until_evidence",
        errors,
    )

    spec = data.get("specification") or {}
    require(spec.get("name") == "RISC-V IOMMU", "spec name drifted", errors)
    require(spec.get("version") == "v1.0.1", "spec version drifted", errors)

    for rel in REQUIRED_RTL:
        require((ROOT / rel).is_file(), f"missing RTL {rel}", errors)
    for rel, tokens in REQUIRED_RTL_TOKENS.items():
        path = ROOT / rel
        if not path.is_file():
            continue
        text = path.read_text()
        for token in tokens:
            require(token in text, f"{rel} missing token: {token}", errors)

    tests = data.get("required_tests") or []
    seen = {item.get("id") for item in tests if isinstance(item, dict)}
    missing = sorted(REQUIRED_TESTS - seen)
    require(not missing, "required_tests missing ids: " + ", ".join(missing), errors)

    test_file = ROOT / "verify/cocotb/iommu/test_riscv_iommu.py"
    require(test_file.is_file(), "verify/cocotb/iommu/test_riscv_iommu.py missing", errors)
    if test_file.is_file():
        text = test_file.read_text()
        for tid in REQUIRED_TESTS:
            require(tid in text, f"cocotb file missing test {tid}", errors)

    artifacts = data.get("required_artifacts") or []
    for art in artifacts:
        require(art in REQUIRED_ARTIFACTS, f"unexpected artifact {art}", errors)
        require(not (ROOT / art).exists(), f"gate blocked but artifact exists: {art}", errors)
    schemas = data.get("required_artifact_schemas") or {}
    for art, schema in REQUIRED_ARTIFACTS.items():
        require(schemas.get(art) == schema, f"artifact schema for {art} drifted", errors)

    refmodel = data.get("reference_model") or {}
    require(
        refmodel.get("manifest") == "verify/cocotb/iommu/refmodel/riscv-iommu.manifest.yaml",
        "reference_model.manifest path drifted",
        errors,
    )
    require(REFMODEL_MANIFEST.is_file(), "reference model manifest missing", errors)
    if REFMODEL_MANIFEST.is_file():
        mdata = yaml.safe_load(REFMODEL_MANIFEST.read_text())
        require(
            mdata.get("schema") == "eliza.external_dependency_manifest.v1",
            "manifest schema drifted",
            errors,
        )
        pinned = (mdata.get("pinned_revision") or {}).get("commit_sha")
        require(
            isinstance(pinned, str) and len(pinned) >= 7,
            "reference model commit_sha is not pinned",
            errors,
        )
        require(
            mdata.get("dependency", {}).get("spec_version") == "v1.0.1",
            "reference manifest must pin spec v1.0.1",
            errors,
        )

    if errors:
        print("IOMMU evidence gate failed:")
        for e in errors:
            print(f"  - {e}")
        return 1

    print("IOMMU evidence gate passed.")
    print(f"  rtl_files: {len(REQUIRED_RTL)} required RTL units present")
    print(f"  test_ids:  {len(REQUIRED_TESTS)} cocotb tests declared")
    print(f"  artifacts: {len(REQUIRED_ARTIFACTS)} BLOCKED evidence files tracked")
    print(f"  ref_model: {REFMODEL_MANIFEST.relative_to(ROOT)} pinned")
    return 0


if __name__ == "__main__":
    sys.exit(main())
