#!/usr/bin/env python3
"""Check CPU/AP target deltas against the current scaffold and selected Rocket path."""

from __future__ import annotations

import json

from cpu_ap_evidence_lib import EXPECTED_CHIPYARD, ROOT, SELECTED_MANIFEST, load_json

DELTA_MANIFEST = ROOT / "docs/evidence/cpu-ap-2028-target-deltas.json"
REQUIRED_DELTAS = {
    "cpu.count.topology",
    "cpu.privilege.trap",
    "memory.mmu.cache.coherence",
    "interrupt.timer",
    "boot.linux.android",
    "power.thermal.reliability",
}
BLOCKED_STATUSES = {
    "blocked_after_selected_bringup",
    "blocked_until_generated_and_transcripted",
}
FALSE_CLAIM_FLAGS = {
    "phone_class_claim_allowed": False,
}


def require(condition: bool, message: str, errors: list[str]) -> None:
    if not condition:
        errors.append(message)


def main() -> int:
    errors: list[str] = []
    try:
        manifest = load_json(DELTA_MANIFEST)
    except (OSError, json.JSONDecodeError) as exc:
        print("CPU/AP target delta check failed:")
        print(f"  - cannot load {DELTA_MANIFEST.relative_to(ROOT)}: {exc}")
        return 1

    selected = load_json(SELECTED_MANIFEST)
    current = manifest.get("current_capability", {})
    step = manifest.get("selected_next_step", {})
    target = manifest.get("phone_class_2028_target", {})
    claim_policy = manifest.get("claim_policy", {})
    deltas = manifest.get("deltas", [])
    delta_by_id = {delta.get("id"): delta for delta in deltas if isinstance(delta, dict)}

    require(
        manifest.get("schema") == "eliza.cpu_ap_2028_target_deltas.v1",
        "target delta manifest schema drifted",
        errors,
    )
    require(
        manifest.get("claim_boundary")
        == "current_repo_is_tiny_cpu_scaffold_plus_pinned_single_rocket_import_plan",
        "target delta manifest must preserve current scaffold/import-plan claim boundary",
        errors,
    )
    require(
        current.get("linux_capable") is False,
        "current tiny CPU must not be marked Linux-capable",
        errors,
    )
    require(
        current.get("phone_class") is False,
        "current tiny CPU must not be marked phone-class",
        errors,
    )
    require(
        step.get("phone_class_completion") is False,
        "single Rocket import step must not be phone-class completion",
        errors,
    )
    require(
        step.get("chipyard_tag") == EXPECTED_CHIPYARD["tag"],
        "selected step Chipyard tag drifted",
        errors,
    )
    require(
        step.get("chipyard_commit") == EXPECTED_CHIPYARD["commit"],
        "selected step Chipyard commit drifted",
        errors,
    )
    require(step.get("core") == "Rocket", "selected step must remain Rocket", errors)
    require(step.get("isa") == "RV64GC", "selected step must remain RV64GC", errors)
    require(
        step.get("harts") == 1, "selected bring-up step must remain explicitly single-hart", errors
    )
    require(step.get("config") == "ElizaRocketConfig", "selected step config drifted", errors)
    require(
        target.get("minimum_harts", 0) >= 4,
        "2028 phone-class target must require at least four harts",
        errors,
    )
    require(
        claim_policy.get("single_rocket_linux_boot_may_not_close") == "phone_class_2028_target",
        "claim policy must prevent single Rocket boot from closing phone-class target",
        errors,
    )
    require(
        claim_policy.get("phone_class_claim_allowed") is False,
        "phone-class claim must remain blocked",
        errors,
    )
    require(
        claim_policy.get("false_claim_flags") == FALSE_CLAIM_FLAGS,
        "claim policy false_claim_flags must match denied CPU/AP target claims",
        errors,
    )

    missing_deltas = sorted(REQUIRED_DELTAS - set(delta_by_id))
    if missing_deltas:
        errors.append("target delta manifest missing required deltas: " + ", ".join(missing_deltas))
    for delta_id, delta in delta_by_id.items():
        if delta_id in REQUIRED_DELTAS:
            require(
                delta.get("status") in BLOCKED_STATUSES,
                f"delta {delta_id} must remain blocked until generated/boot evidence exists",
                errors,
            )
            for key in ("current", "selected_step", "phone_target"):
                require(bool(delta.get(key)), f"delta {delta_id} missing {key}", errors)

    require(
        selected.get("target_delta_manifest") == "docs/evidence/cpu-ap-2028-target-deltas.json",
        "selected Rocket manifest must point to the CPU/AP target delta manifest",
        errors,
    )
    require(
        selected.get("roadmap_manifest") == "docs/evidence/cpu-ap-roadmap.json",
        "selected Rocket manifest must point to the CPU/AP roadmap manifest",
        errors,
    )
    require(
        selected.get("rva23_profile_plan") == "docs/evidence/cpu-ap-rva23-profile-plan.json",
        "selected Rocket manifest must point to the CPU/AP RVA23 profile plan",
        errors,
    )

    if errors:
        print("CPU/AP target delta check failed:")
        for error in errors:
            print(f"  - {error}")
        return 1

    print(
        "STATUS: PASS cpu_ap.target_deltas - current scaffold, Rocket bring-up step, and 2028 phone target remain separated"
    )
    print(
        "STATUS: BLOCKED cpu_ap.phone_class_2028 - phone-class AP claim remains blocked beyond single-Rocket Linux bring-up"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
