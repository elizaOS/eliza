#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
MATRIX = ROOT / "docs/evidence/scale/verification-maturity-matrix.yaml"

REQUIRED_PHASES = [
    "phase1_scaled_contract_verification",
    "phase2_scaled_perf_and_synthesis",
    "phase3_scaled_pd_signoff",
]

REQUIRED_DOMAINS = {
    "phase1_scaled_contract_verification": {"regression", "cocotb", "formal"},
    "phase2_scaled_perf_and_synthesis": {"performance", "synthesis"},
    "phase3_scaled_pd_signoff": {"pd"},
}

REQUIRED_TOKENS = {
    "regression": {
        "Regression suite",
        "Cocotb",
        "formal",
        "synthesis",
        "PD manifest",
        "skipped test",
    },
    "cocotb": {"CPU", "DMA", "NPU", "display", "Queue overflow", "illegal DMA"},
    "formal": {"liveness", "fairness", "Reset", "interrupt", "bounded queue"},
    "performance": {"Target-platform", "CPU fallback", "tool versions", "claim level"},
    "synthesis": {"Scaled RTL", "Area", "timing", "lint"},
    "pd": {
        "OpenROAD/OpenLane",
        "GDS",
        "DEF",
        "DRC",
        "LVS",
        "STA",
        "SPEF",
        "SDF",
        "timing corners",
        "tool versions",
    },
}

REQUIRED_COMMANDS = {
    "regression": {"make ci-fast", "make pipeline-check"},
    "cocotb": {"make cocotb", "make cocotb-contract"},
    "formal": {"make formal"},
    "performance": {
        "python3 benchmarks/run_benchmarks.py --dry-run --report-id scale-feasibility-dry-run"
    },
    "synthesis": {"make synth", "make tool-versions"},
    "pd": {"make pd-preflight-check", "make pd-signoff-manifest-check", "make pd-signoff-check"},
}


def require(condition: bool, message: str, errors: list[str]) -> None:
    if not condition:
        errors.append(message)


def valid_relative_path(value: object) -> bool:
    if not isinstance(value, str) or not value:
        return False
    path = Path(value)
    return not path.is_absolute() and ".." not in path.parts


def check_domain(
    phase_id: str, domain: str, spec: object, phase_status: str, errors: list[str]
) -> None:
    prefix = f"{phase_id}.{domain}"
    require(isinstance(spec, dict), f"{prefix} must be a mapping", errors)
    if not isinstance(spec, dict):
        return

    commands = set(spec.get("commands") or [])
    missing_commands = sorted(REQUIRED_COMMANDS[domain] - commands)
    require(
        not missing_commands, f"{prefix} missing commands: " + ", ".join(missing_commands), errors
    )

    artifacts = spec.get("artifacts")
    artifacts_ok = isinstance(artifacts, list) and bool(artifacts)
    require(artifacts_ok, f"{prefix} must list artifacts", errors)
    artifact_list = artifacts if isinstance(artifacts, list) else []
    for artifact in artifact_list:
        require(
            valid_relative_path(artifact),
            f"{prefix} artifact must be a relative repo path: {artifact}",
            errors,
        )
        if valid_relative_path(artifact):
            artifact_path = ROOT / artifact
            if phase_status == "blocked":
                require(
                    not artifact_path.exists(),
                    f"{prefix} is blocked but promotion artifact already exists: {artifact}",
                    errors,
                )
            elif phase_status == "evidence_passed":
                require(
                    artifact_path.is_file(),
                    f"{prefix} is evidence_passed but artifact is missing: {artifact}",
                    errors,
                )

    coverage_text = "\n".join(spec.get("must_cover") or [])
    for token in REQUIRED_TOKENS[domain]:
        require(token in coverage_text, f"{prefix} must_cover missing token: {token}", errors)


def main() -> int:
    errors: list[str] = []
    if not MATRIX.is_file():
        print(f"Verification maturity matrix failed:\n  - missing {MATRIX.relative_to(ROOT)}")
        return 1

    data = yaml.safe_load(MATRIX.read_text())
    if not isinstance(data, dict):
        print(
            f"Verification maturity matrix failed:\n  - {MATRIX.relative_to(ROOT)} must be a YAML mapping"
        )
        return 1

    require(
        data.get("schema") == "eliza.verification_maturity_matrix.v1",
        "matrix schema drifted",
        errors,
    )
    require(
        data.get("status") == "phase_promotion_blocked_without_evidence",
        "matrix status must keep phase promotion blocked without evidence",
        errors,
    )

    current = data.get("current_phase")
    require(isinstance(current, dict), "current_phase must be a mapping", errors)
    if isinstance(current, dict):
        require(
            current.get("id") == "phase0_e1_chip_scaffold",
            "current_phase must remain phase0_e1_chip_scaffold",
            errors,
        )
        allowed = "\n".join(current.get("allowed_claims") or [])
        for token in ("E1-chip", "scaffold", "PD input/preflight"):
            require(
                token in allowed, f"current_phase allowed_claims missing token: {token}", errors
            )
        checks = set(current.get("required_local_checks") or [])
        for command in (
            "make rtl-check",
            "make cocotb",
            "make formal",
            "make synth",
            "make pd-signoff-manifest-check",
        ):
            require(command in checks, f"current_phase missing local check: {command}", errors)

    phases = data.get("phase_promotion_gates")
    phases_ok = isinstance(phases, list) and bool(phases)
    require(phases_ok, "phase_promotion_gates must be a non-empty list", errors)
    phase_list = phases if isinstance(phases, list) else []
    phases_by_id = {phase.get("id"): phase for phase in phase_list if isinstance(phase, dict)}
    missing_phases = [phase for phase in REQUIRED_PHASES if phase not in phases_by_id]
    require(not missing_phases, "missing phase gates: " + ", ".join(missing_phases), errors)

    previous_blocked = False
    for phase_id in REQUIRED_PHASES:
        phase = phases_by_id.get(phase_id)
        if not isinstance(phase, dict):
            continue
        status = phase.get("status")
        require(
            status in {"blocked", "evidence_passed"},
            f"{phase_id} has invalid status {status!r}",
            errors,
        )
        if previous_blocked:
            require(
                status == "blocked",
                f"{phase_id} cannot be promoted while an earlier phase is blocked",
                errors,
            )
        previous_blocked = previous_blocked or status == "blocked"

        for key in ("promotion_claim", "blocks"):
            require(bool(phase.get(key)), f"{phase_id} missing {key}", errors)
        blocks_text = "\n".join(phase.get("blocks") or [])
        for token in ("2028-class", "readiness", "claims"):
            if phase_id != "phase1_scaled_contract_verification" or token != "2028-class":
                require(token in blocks_text, f"{phase_id}.blocks missing token: {token}", errors)

        evidence = phase.get("required_evidence")
        require(
            isinstance(evidence, dict), f"{phase_id} required_evidence must be a mapping", errors
        )
        if not isinstance(evidence, dict):
            continue
        missing_domains = sorted(REQUIRED_DOMAINS[phase_id] - set(evidence))
        require(
            not missing_domains,
            f"{phase_id} missing evidence domains: " + ", ".join(missing_domains),
            errors,
        )
        for domain in sorted(REQUIRED_DOMAINS[phase_id] & set(evidence)):
            assert isinstance(status, str)
            check_domain(phase_id, domain, evidence[domain], status, errors)

    rules = "\n".join(data.get("promotion_rules") or [])
    for token in (
        "phase0_e1_chip_scaffold",
        "evidence_passed",
        "Host smoke",
        "preflight",
        "Earlier phase",
    ):
        require(token in rules, f"promotion_rules missing token: {token}", errors)

    if errors:
        print("Verification maturity matrix failed:")
        for error in errors:
            print(f"  - {error}")
        return 1

    print(
        "Verification maturity matrix passed: 2028 RAM/CPU/NPU phase promotion remains evidence-gated."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
