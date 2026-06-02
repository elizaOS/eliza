#!/usr/bin/env python3
"""Validate the phased CPU/AP roadmap and phase exit gate definitions."""

from __future__ import annotations

import json

from cpu_ap_evidence_lib import ROOT, SELECTED_MANIFEST, load_json

ROADMAP = ROOT / "docs/evidence/cpu-ap-roadmap.json"
EXPECTED_PHASES = [
    "L0_tiny_cpu_scaffold",
    "L1_chipyard_rocket_import",
    "L2_rv64gc_linux_boot",
    "L3_rva23_profile_candidate",
    "L4_phone_2028_ap",
]
FALSE_CLAIM_FLAGS = {
    "linux_capable_claim_allowed": False,
    "phone_2028_claim_allowed": False,
    "rva23_claim_allowed": False,
}


def require(condition: bool, message: str, errors: list[str]) -> None:
    if not condition:
        errors.append(message)


def main() -> int:
    errors: list[str] = []
    try:
        roadmap = load_json(ROADMAP)
    except (OSError, json.JSONDecodeError) as exc:
        print("CPU/AP roadmap check failed:")
        print(f"  - cannot load {ROADMAP.relative_to(ROOT)}: {exc}")
        return 1

    selected = load_json(SELECTED_MANIFEST)
    phases = roadmap.get("phases", [])
    phase_ids = [phase.get("id") for phase in phases if isinstance(phase, dict)]
    phase_by_id = {phase.get("id"): phase for phase in phases if isinstance(phase, dict)}
    policy = roadmap.get("claim_policy", {})

    require(roadmap.get("schema") == "eliza.cpu_ap_roadmap.v1", "roadmap schema drifted", errors)
    require(
        phase_ids == EXPECTED_PHASES,
        "CPU/AP roadmap phases must remain ordered L0 through L4",
        errors,
    )
    require(
        roadmap.get("current_phase") == "L0_tiny_cpu_scaffold",
        "current phase must remain L0 until generated import exists",
        errors,
    )
    require(
        roadmap.get("selected_next_phase") == "L1_chipyard_rocket_import",
        "selected next phase must be L1 Chipyard import",
        errors,
    )
    require(
        policy.get("linux_capable_claim_allowed") is False,
        "Linux-capable claim must remain blocked",
        errors,
    )
    require(policy.get("rva23_claim_allowed") is False, "RVA23 claim must remain blocked", errors)
    require(
        policy.get("phone_2028_claim_allowed") is False,
        "2028 phone-class claim must remain blocked",
        errors,
    )
    require(
        policy.get("false_claim_flags") == FALSE_CLAIM_FLAGS,
        "claim policy false_claim_flags must match denied CPU/AP roadmap claims",
        errors,
    )
    require(
        policy.get("no_phase_may_pass_without_exit_gates") is True,
        "phase exit gates must be mandatory",
        errors,
    )

    for phase_id in EXPECTED_PHASES:
        phase = phase_by_id.get(phase_id, {})
        require(bool(phase.get("claim_allowed")), f"{phase_id} missing claim_allowed", errors)
        require(bool(phase.get("entry_state")), f"{phase_id} missing entry_state", errors)
        require(bool(phase.get("exit_gates")), f"{phase_id} missing exit_gates", errors)
        require(bool(phase.get("exit_artifacts")), f"{phase_id} missing exit_artifacts", errors)

    l0 = phase_by_id.get("L0_tiny_cpu_scaffold", {})
    l1 = phase_by_id.get("L1_chipyard_rocket_import", {})
    l2 = phase_by_id.get("L2_rv64gc_linux_boot", {})
    l3 = phase_by_id.get("L3_rva23_profile_candidate", {})
    l4 = phase_by_id.get("L4_phone_2028_ap", {})

    require(
        "make cocotb-cpu" in l0.get("exit_gates", []),
        "L0 must exit through focused CPU cocotb",
        errors,
    )
    require(
        "python3 scripts/check_chipyard_generator_manifest.py --require-generated"
        in l1.get("exit_gates", []),
        "L1 must require generated Chipyard import manifest",
        errors,
    )
    require(
        "python3 scripts/check_cpu_ap_completion_gate.py --require-complete"
        in l2.get("exit_gates", []),
        "L2 must require CPU/AP completion gate",
        errors,
    )
    require(
        any("RVA23" in gate for gate in l3.get("exit_gates", [])),
        "L3 must explicitly require RVA23/profile evidence",
        errors,
    )
    require(
        "python3 scripts/check_cpu_ap_rva23_profile.py" in l3.get("exit_gates", []),
        "L3 must include the machine-readable RVA23 profile checker",
        errors,
    )
    require(
        any("Android" in gate for gate in l4.get("exit_gates", [])),
        "L4 must explicitly require Android evidence",
        errors,
    )

    for phase_id in ("L0_tiny_cpu_scaffold", "L1_chipyard_rocket_import"):
        blocked = set(phase_by_id.get(phase_id, {}).get("must_remain_blocked", []))
        require(
            "linux_capable_claim" in blocked, f"{phase_id} must block Linux-capable claims", errors
        )
        require("rva23_claim" in blocked, f"{phase_id} must block RVA23 claims", errors)
        require("phone_2028_claim" in blocked, f"{phase_id} must block phone claims", errors)

    require(
        selected.get("roadmap_manifest") == "docs/evidence/cpu-ap-roadmap.json",
        "selected Rocket manifest must point to CPU/AP roadmap manifest",
        errors,
    )

    if errors:
        print("CPU/AP roadmap check failed:")
        for error in errors:
            print(f"  - {error}")
        return 1

    print("STATUS: PASS cpu_ap.roadmap - phased CPU/AP exits are machine-checkable")
    print(
        "STATUS: BLOCKED cpu_ap.roadmap.current - current phase remains L0 tiny scaffold; L1 import is next"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
