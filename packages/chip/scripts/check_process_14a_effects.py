#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / "docs/spec-db/process-14a-effects.yaml"
SCHEMA = "eliza.process_14a_effects.v1"

REQUIRED_EFFECT_IDS = {
    "node_identity_and_pdk_binding",
    "nanosheet_device_variability",
    "frontside_vs_backside_power_delivery",
    "interconnect_rc_and_congestion",
    "self_heating_and_power_density",
    "sram_density_vmin_and_ecc",
    "reliability_aging_and_lifetime",
    "dft_yield_and_debug_lock",
}
REQUIRED_SOURCE_IDS = {
    "tsmc_a14_public_roadmap",
    "imec_backside_pdn_dtco",
    "ieee_irds_more_moore_2024",
}
REQUIRED_RELEASE_GATES = {
    "process_14a_effects_check",
    "pd_signoff_release_check",
    "sustained_power_thermal_evidence_check",
    "cpu_ap_completion_gate",
    "aosp_simulator_completion_gate",
}


def rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def load_yaml(path: Path, errors: list[str]) -> dict[str, Any]:
    if not path.is_file():
        errors.append(f"missing process effects spec: {rel(path)}")
        return {}
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        errors.append(f"{rel(path)} must be a YAML mapping")
        return {}
    return data


def require_repo_path(value: Any, field: str, errors: list[str]) -> None:
    if not isinstance(value, str) or not value:
        errors.append(f"{field} must be a non-empty repo-relative path")
        return
    path = Path(value)
    if path.is_absolute() or ".." in path.parts:
        errors.append(f"{field} must be repo-relative: {value}")
        return
    if not (ROOT / path).exists():
        errors.append(f"{field} points at missing repo artifact: {value}")


def check_sources(data: dict[str, Any], errors: list[str]) -> None:
    policy = data.get("source_policy")
    if not isinstance(policy, dict):
        errors.append("source_policy must be a mapping")
        return
    if policy.get("use") != "planning_inputs_only_not_pdk_or_signoff_data":
        errors.append("source_policy.use must keep public sources out of signoff evidence")
    sources = policy.get("sources")
    if not isinstance(sources, list):
        errors.append("source_policy.sources must be a list")
        return
    source_ids = {source.get("id") for source in sources if isinstance(source, dict)}
    missing = sorted(REQUIRED_SOURCE_IDS - source_ids)
    if missing:
        errors.append("source_policy.sources missing: " + ", ".join(missing))
    for index, source in enumerate(sources):
        if not isinstance(source, dict):
            errors.append(f"source_policy.sources[{index}] must be a mapping")
            continue
        source_id = source.get("id", f"sources[{index}]")
        url = source.get("url")
        if not isinstance(url, str) or not url.startswith("https://"):
            errors.append(f"{source_id}: url must be https")
        use = source.get("evidence_use")
        if not isinstance(use, str) or len(use.split()) < 8:
            errors.append(f"{source_id}: evidence_use must explain source role")


def check_node_target(data: dict[str, Any], errors: list[str]) -> None:
    target = data.get("node_target")
    if not isinstance(target, dict):
        errors.append("node_target must be a mapping")
        return
    if "14A" not in str(target.get("marketing_name", "")):
        errors.append("node_target.marketing_name must identify 14A")
    if "2028" not in str(target.get("production_assumption", "")):
        errors.append("node_target.production_assumption must state the 2028 planning target")
    if "blocked_until" not in str(target.get("selected_process_option", "")):
        errors.append("node_target.selected_process_option must remain blocked")
    variants = target.get("minimum_supported_variants")
    if not isinstance(variants, list) or len(variants) < 2:
        errors.append(
            "node_target.minimum_supported_variants must list base and follow-on variants"
        )
        return
    joined = " ".join(str(item) for item in variants)
    for required in ("frontside", "backside"):
        if required not in joined:
            errors.append(f"node_target.minimum_supported_variants must include {required}")


def check_effects(data: dict[str, Any], errors: list[str]) -> None:
    effects = data.get("required_effects")
    if not isinstance(effects, list):
        errors.append("required_effects must be a list")
        return
    ids = {effect.get("id") for effect in effects if isinstance(effect, dict)}
    missing = sorted(REQUIRED_EFFECT_IDS - ids)
    if missing:
        errors.append("required_effects missing: " + ", ".join(missing))
    for index, effect in enumerate(effects):
        if not isinstance(effect, dict):
            errors.append(f"required_effects[{index}] must be a mapping")
            continue
        effect_id = effect.get("id", f"required_effects[{index}]")
        if effect_id not in REQUIRED_EFFECT_IDS:
            errors.append(f"{effect_id}: unknown 14A effect id")
        category = effect.get("category")
        if not isinstance(category, str) or not category:
            errors.append(f"{effect_id}.category must be non-empty")
        risk = effect.get("risk")
        if not isinstance(risk, str) or len(risk.split()) < 8:
            errors.append(f"{effect_id}.risk must be descriptive text")
        blocker_value = effect.get("blocker")
        if not isinstance(blocker_value, str) or not blocker_value:
            errors.append(f"{effect_id}.blocker must be non-empty")
        must_model = effect.get("must_model")
        if not isinstance(must_model, list) or len(must_model) < 3:
            errors.append(f"{effect_id}.must_model must list at least 3 modeled items")
        evidence = effect.get("required_evidence")
        if not isinstance(evidence, list) or len(evidence) < 2:
            errors.append(f"{effect_id}.required_evidence must list at least 2 artifacts")
            continue
        for item in evidence:
            require_repo_path(item, f"{effect_id}.required_evidence", errors)
        blocker = str(effect.get("blocker", ""))
        if "missing" not in blocker and "blocked" not in blocker:
            errors.append(f"{effect_id}.blocker must remain a fail-closed blocker")


def check_release_gate(data: dict[str, Any], errors: list[str]) -> None:
    gate = data.get("release_gate")
    if not isinstance(gate, dict):
        errors.append("release_gate must be a mapping")
        return
    if gate.get("required_status_for_claim") != "complete_measured_and_signoff_evidence":
        errors.append("release_gate.required_status_for_claim must require measured signoff")
    forbidden = gate.get("forbidden_claims_until_complete")
    if not isinstance(forbidden, list) or len(forbidden) < 4:
        errors.append("release_gate.forbidden_claims_until_complete must list blocked claims")
    checks = gate.get("must_pass_before_release_claim")
    if not isinstance(checks, list):
        errors.append("release_gate.must_pass_before_release_claim must be a list")
        return
    missing = sorted(REQUIRED_RELEASE_GATES - set(checks))
    if missing:
        errors.append("release_gate.must_pass_before_release_claim missing: " + ", ".join(missing))


def main() -> int:
    errors: list[str] = []
    data = load_yaml(SPEC, errors)
    if data:
        if data.get("schema") != SCHEMA:
            errors.append(f"schema must be {SCHEMA}")
        if data.get("status") != "fail_closed_process_work_order":
            errors.append("status must be fail_closed_process_work_order")
        boundary = data.get("claim_boundary")
        if not isinstance(boundary, str) or "not proof" not in boundary:
            errors.append("claim_boundary must state this spec is not proof")
        check_node_target(data, errors)
        check_sources(data, errors)
        check_effects(data, errors)
        check_release_gate(data, errors)

    if errors:
        print("14A process effects check failed:")
        for error in errors:
            print(f"  - {error}")
        return 1

    print("14A process effects work order is fail-closed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
