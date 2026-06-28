#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
GATE = ROOT / "docs/evidence/scale/ram-cpu-npu-scale-feasibility-gate.yaml"

REQUIRED_GROUPS = {
    "cocotb_integration",
    "formal_properties",
    "performance_evidence",
    "synthesis_timing_area",
    "physical_design_signoff",
}

REQUIRED_TOKENS_BY_GROUP = {
    "cocotb_integration": ("Contended", "Negative tests", "queue overflow"),
    "formal_properties": ("liveness", "fairness", "Bounded proofs"),
    "performance_evidence": ("Target-platform", "no CPU fallback", "claim level"),
    "synthesis_timing_area": ("synthesis", "Area", "tool-version"),
    "physical_design_signoff": ("GDS", "DEF", "DRC", "LVS", "STA", "SPEF", "SDF", "corner"),
}

REQUIRED_COMMANDS = {
    "cocotb_integration": {"make cocotb", "make cocotb-contract"},
    "formal_properties": {"make formal"},
    "performance_evidence": {
        "python3 benchmarks/run_benchmarks.py --dry-run --report-id scale-feasibility-dry-run"
    },
    "synthesis_timing_area": {"make synth", "make tool-versions"},
    "physical_design_signoff": {
        "make pd-preflight-check",
        "make pd-signoff-manifest-check",
        "make pd-signoff-check",
    },
}
FALSE_CLAIM_FLAGS = {
    "linux_capable_cpu_claim_allowed": False,
    "npu_2028_class_claim_allowed": False,
    "physical_feasibility_claim_allowed": False,
    "production_ram_claim_allowed": False,
    "release_claim_allowed": False,
    "tapeout_claim_allowed": False,
}


def valid_relative_path(value: object) -> bool:
    if not isinstance(value, str) or not value:
        return False
    path = Path(value)
    return not path.is_absolute() and ".." not in path.parts


def require(condition: bool, message: str, errors: list[str]) -> None:
    if not condition:
        errors.append(message)


def main() -> int:
    errors: list[str] = []
    if not GATE.is_file():
        print(f"Scale feasibility gate failed:\n  - missing {GATE.relative_to(ROOT)}")
        return 1

    data = yaml.safe_load(GATE.read_text())
    if not isinstance(data, dict):
        print(
            f"Scale feasibility gate failed:\n  - {GATE.relative_to(ROOT)} must be a YAML mapping"
        )
        return 1

    require(
        data.get("schema") == "eliza.scale_feasibility_gate.v1",
        "scale gate schema drifted",
        errors,
    )
    require(
        data.get("status") == "2028_class_claims_blocked_without_evidence",
        "scale gate status must keep 2028-class claims blocked",
        errors,
    )
    for flag, expected in FALSE_CLAIM_FLAGS.items():
        require(data.get(flag) is expected, f"{flag} must be false", errors)

    boundary = data.get("claim_boundary")
    require(isinstance(boundary, dict), "claim_boundary must be a mapping", errors)
    if isinstance(boundary, dict):
        blocked_claims = "\n".join(boundary.get("blocked_claims") or [])
        for token in ("2028-class", "RAM", "CPU", "NPU", "Tapeout"):
            require(token in blocked_claims, f"blocked_claims missing token: {token}", errors)
        allowed_claims = "\n".join(boundary.get("allowed_current_claims") or [])
        for token in ("scaffold", "dry-runs", "preflight"):
            require(
                token in allowed_claims,
                f"allowed_current_claims missing boundary token: {token}",
                errors,
            )

    groups = data.get("required_evidence_groups")
    groups_ok = isinstance(groups, list) and bool(groups)
    require(groups_ok, "required_evidence_groups must be a non-empty list", errors)
    group_list = groups if isinstance(groups, list) else []
    groups_by_id = {group.get("id"): group for group in group_list if isinstance(group, dict)}
    missing_groups = sorted(REQUIRED_GROUPS - set(groups_by_id))
    require(
        not missing_groups, "missing required evidence groups: " + ", ".join(missing_groups), errors
    )

    for group_id in sorted(REQUIRED_GROUPS & set(groups_by_id)):
        group = groups_by_id[group_id]
        status = group.get("status")
        require(
            status in {"blocked", "evidence_passed"},
            f"{group_id} has invalid status {status!r}",
            errors,
        )

        required = group.get("required_before_claim")
        require(
            isinstance(required, list) and len(required) >= 2,
            f"{group_id} must list required_before_claim entries",
            errors,
        )
        required_text = "\n".join(required or [])
        for token in REQUIRED_TOKENS_BY_GROUP[group_id]:
            require(token in required_text, f"{group_id} missing required token: {token}", errors)

        artifact_paths = group.get("artifact_paths")
        require(
            isinstance(artifact_paths, list) and len(artifact_paths) >= 2,
            f"{group_id} must list artifact_paths",
            errors,
        )
        for artifact in artifact_paths or []:
            require(
                valid_relative_path(artifact),
                f"{group_id} artifact path must be relative and in-repo: {artifact}",
                errors,
            )
            if status == "blocked" and valid_relative_path(artifact):
                require(
                    not (ROOT / artifact).exists(),
                    f"{group_id} is blocked but evidence artifact exists: {artifact}",
                    errors,
                )
            if status == "evidence_passed" and valid_relative_path(artifact):
                require(
                    (ROOT / artifact).is_file(),
                    f"{group_id} is evidence_passed but artifact is missing: {artifact}",
                    errors,
                )

        commands = set(group.get("local_precheck_commands") or [])
        missing_commands = sorted(REQUIRED_COMMANDS[group_id] - commands)
        require(
            not missing_commands,
            f"{group_id} missing local_precheck_commands: " + ", ".join(missing_commands),
            errors,
        )

    rules = "\n".join(data.get("claim_rules") or [])
    for token in ("2028-class", "blocked", "Host smoke", "dry-run", "scaled configuration"):
        require(token in rules, f"claim_rules missing token: {token}", errors)

    if errors:
        print("Scale feasibility gate failed:")
        for error in errors:
            print(f"  - {error}")
        return 1

    print(
        "Scale feasibility gate passed: 2028-class RAM/CPU/NPU claims remain blocked without evidence."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
