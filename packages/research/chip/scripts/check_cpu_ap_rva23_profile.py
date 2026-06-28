#!/usr/bin/env python3
"""Validate the CPU/AP RVA23 profile plan and keep RVA23 claims fail-closed."""

from __future__ import annotations

import json

from cpu_ap_evidence_lib import ROOT, SELECTED_MANIFEST, load_json

PROFILE_PLAN = ROOT / "docs/evidence/cpu-ap-rva23-profile-plan.json"
ROADMAP = ROOT / "docs/evidence/cpu-ap-roadmap.json"
REQUIRED_FEATURES = {
    "rva23.profile_matrix",
    "rva23.vector",
    "rva23.hypervisor",
    "rva23.isa_compliance",
    "rva23.linux_userspace_discovery",
}
REQUIRED_EXIT_ARTIFACTS = {
    "build/evidence/cpu_ap/eliza_e1_rva23_profile_matrix.json",
    "build/evidence/cpu_ap/eliza_e1_rva23_hwprobe.log",
    "build/evidence/cpu_ap/eliza_e1_rva23_compliance.log",
}
FALSE_CLAIM_FLAGS = {
    "phone_2028_claim_allowed": False,
    "rva23_candidate_claim_allowed": False,
    "rva23_compliant_claim_allowed": False,
}


def require(condition: bool, message: str, errors: list[str]) -> None:
    if not condition:
        errors.append(message)


def main() -> int:
    errors: list[str] = []
    try:
        plan = load_json(PROFILE_PLAN)
    except (OSError, json.JSONDecodeError) as exc:
        print("CPU/AP RVA23 profile check failed:")
        print(f"  - cannot load {PROFILE_PLAN.relative_to(ROOT)}: {exc}")
        return 1

    selected = load_json(SELECTED_MANIFEST)
    roadmap = load_json(ROADMAP)
    bringup = plan.get("selected_bringup_path", {})
    phase = plan.get("phase", {})
    policy = plan.get("claim_policy", {})
    sources = plan.get("profile_sources", [])
    features = plan.get("required_profile_features_for_claim", [])
    feature_by_id = {
        feature.get("id"): feature for feature in features if isinstance(feature, dict)
    }

    require(
        plan.get("schema") == "eliza.cpu_ap_rva23_profile_plan.v1",
        "RVA23 profile plan schema drifted",
        errors,
    )
    require(
        plan.get("claim_boundary")
        == "rva23_claim_blocked_until_profile_matrix_and_external_evidence_exist",
        "RVA23 claim boundary must remain fail-closed",
        errors,
    )
    require(
        plan.get("current_claim_allowed") is False,
        "current RVA23 claim must remain blocked",
        errors,
    )
    require(
        len(sources) >= 2, "RVA23 plan must include normative/profile source references", errors
    )
    require(
        any(
            "docs.riscv.org/reference/profiles/rva23" in source.get("url", "") for source in sources
        ),
        "RVA23 plan must reference the official RVA23 profile specification",
        errors,
    )
    require(
        bringup.get("manifest") == "generators/chipyard/eliza-rocket-manifest.json",
        "RVA23 plan must tie back to selected Rocket manifest",
        errors,
    )
    require(
        bringup.get("isa_floor") == "RV64GC",
        "selected bring-up ISA floor must remain RV64GC",
        errors,
    )
    require(
        bringup.get("rva23_claim") is False, "single Rocket bring-up must not claim RVA23", errors
    )
    require(
        phase.get("roadmap_phase") == "L3_rva23_profile_candidate",
        "RVA23 plan must bind to roadmap L3",
        errors,
    )

    exit_artifacts = set(phase.get("exit_artifacts", []))
    missing_artifacts = sorted(REQUIRED_EXIT_ARTIFACTS - exit_artifacts)
    if missing_artifacts:
        errors.append("RVA23 plan missing exit artifacts: " + ", ".join(missing_artifacts))

    missing_features = sorted(REQUIRED_FEATURES - set(feature_by_id))
    if missing_features:
        errors.append("RVA23 plan missing required feature gates: " + ", ".join(missing_features))
    for feature_id, feature in feature_by_id.items():
        if feature_id in REQUIRED_FEATURES:
            require(
                feature.get("status") == "blocked",
                f"{feature_id} must remain blocked without evidence",
                errors,
            )
            require(
                feature.get("evidence") in REQUIRED_EXIT_ARTIFACTS,
                f"{feature_id} evidence path is not an approved RVA23 artifact",
                errors,
            )

    require(
        policy.get("rva23_candidate_claim_allowed") is False,
        "RVA23 candidate claim must remain blocked",
        errors,
    )
    require(
        policy.get("rva23_compliant_claim_allowed") is False,
        "RVA23 compliant claim must remain blocked",
        errors,
    )
    require(
        policy.get("single_rocket_rv64gc_is_not_rva23_completion") is True,
        "policy must state single Rocket RV64GC does not close RVA23",
        errors,
    )
    require(
        policy.get("phone_2028_claim_allowed") is False,
        "phone-class claim must remain blocked",
        errors,
    )
    require(
        policy.get("false_claim_flags") == FALSE_CLAIM_FLAGS,
        "claim policy false_claim_flags must match denied RVA23 claims",
        errors,
    )

    phases = {
        phase.get("id"): phase for phase in roadmap.get("phases", []) if isinstance(phase, dict)
    }
    l3 = phases.get("L3_rva23_profile_candidate", {})
    require(
        "python3 scripts/check_cpu_ap_rva23_profile.py" in l3.get("exit_gates", []),
        "roadmap L3 must include the RVA23 profile checker",
        errors,
    )
    require(
        selected.get("rva23_profile_plan") == "docs/evidence/cpu-ap-rva23-profile-plan.json",
        "selected Rocket manifest must point to the RVA23 profile plan",
        errors,
    )

    if errors:
        print("CPU/AP RVA23 profile check failed:")
        for error in errors:
            print(f"  - {error}")
        return 1

    print("STATUS: PASS cpu_ap.rva23_profile_plan - RVA23 phase gates are defined")
    print(
        "STATUS: BLOCKED cpu_ap.rva23_claim - no RVA23 claim without profile matrix, hwprobe, and compliance evidence"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
