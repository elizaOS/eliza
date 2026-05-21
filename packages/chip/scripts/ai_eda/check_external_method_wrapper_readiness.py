#!/usr/bin/env python3
"""Validate the fail-closed contract for real external method wrappers."""

from __future__ import annotations

import argparse
from datetime import date
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MANIFEST = ROOT / "docs/spec-db/ai-eda/external-method-wrapper-readiness.yaml"
LOCKFILE = ROOT / "external/SOURCES.lock.yaml"
INVENTORY = ROOT / "research/alpha_chip_macro_placement/01_sources/ai_eda_source_inventory.yaml"
EXPECTED_SCHEMA = "eliza.ai_eda.external_method_wrapper_readiness.v1"
EXPECTED_CLAIM_BOUNDARY = "external_method_wrapper_readiness_only_no_inference_training_replay_or_release_claim"
EXPECTED_PROXY_POLICIES = {
    "circuit_training_proxy": "circuit_training_proxy_locations",
    "simulated_annealing_proxy": "simulated_annealing_proxy_locations",
    "hier_rtlmp_proxy": "hier_rtlmp_proxy_locations",
    "chipdiffusion_proxy": "chipdiffusion_proxy_locations",
}
POLICY_FALSE_FIELDS = {
    "imports_external_code",
    "downloads_assets",
    "runs_inference",
    "trains_model",
    "runs_openroad",
    "runs_openlane",
    "writes_design_files",
    "release_use_allowed",
}


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def repo_path(value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else ROOT / path


def load_yaml(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{rel(path)} root must be a mapping")
    return data


def ids_from_yaml(path: Path) -> set[str]:
    data = load_yaml(path)
    entries = data.get("entries")
    if not isinstance(entries, list):
        raise ValueError(f"{rel(path)} entries must be a list")
    return {
        entry["id"]
        for entry in entries
        if isinstance(entry, dict) and isinstance(entry.get("id"), str) and entry["id"]
    }


def validate_manifest(path: Path) -> list[str]:
    manifest = load_yaml(path)
    errors: list[str] = []
    if manifest.get("schema") != EXPECTED_SCHEMA:
        errors.append(f"schema must be {EXPECTED_SCHEMA}")
    if manifest.get("claim_boundary") != EXPECTED_CLAIM_BOUNDARY:
        errors.append("claim_boundary mismatch")
    updated = manifest.get("updated")
    updated_text = updated.isoformat() if isinstance(updated, date) else updated
    if not isinstance(updated_text, str) or not updated_text.startswith("2026-"):
        errors.append("updated must be a 2026 date string")
    policy = manifest.get("policy")
    if not isinstance(policy, dict):
        errors.append("policy must be a mapping")
    else:
        if policy.get("metadata_only") is not True:
            errors.append("policy.metadata_only must be true")
        if policy.get("deterministic_e1_replay_required") is not True:
            errors.append("policy.deterministic_e1_replay_required must be true")
        for field in sorted(POLICY_FALSE_FIELDS):
            if policy.get(field) is not False:
                errors.append(f"policy.{field} must be false")

    source = manifest.get("source")
    proxy_text = ""
    if not isinstance(source, dict):
        errors.append("source must be a mapping")
    else:
        for field in ("proxy_implementation", "baseline_checker"):
            value = source.get(field)
            if not isinstance(value, str) or not value:
                errors.append(f"source.{field} must be a path")
                continue
            path_value = repo_path(value)
            if not path_value.is_file():
                errors.append(f"source.{field} missing on disk: {value}")
            elif field == "proxy_implementation":
                proxy_text = path_value.read_text(encoding="utf-8")

    inventory_ids = ids_from_yaml(INVENTORY)
    lock_ids = ids_from_yaml(LOCKFILE)
    wrappers = manifest.get("wrappers")
    if not isinstance(wrappers, list) or not wrappers:
        return errors + ["wrappers must be a non-empty list"]

    seen_ids: set[str] = set()
    seen_policies: set[str] = set()
    for index, wrapper in enumerate(wrappers):
        if not isinstance(wrapper, dict):
            errors.append(f"wrappers[{index}] must be a mapping")
            continue
        wrapper_id = wrapper.get("id")
        prefix = wrapper_id if isinstance(wrapper_id, str) and wrapper_id else f"wrappers[{index}]"
        if isinstance(wrapper_id, str):
            if wrapper_id in seen_ids:
                errors.append(f"{wrapper_id}: duplicate wrapper id")
            seen_ids.add(wrapper_id)
        proxy_policy = wrapper.get("proxy_policy")
        proxy_function = wrapper.get("proxy_function")
        if proxy_policy not in EXPECTED_PROXY_POLICIES:
            errors.append(f"{prefix}: unexpected proxy_policy {proxy_policy!r}")
        else:
            seen_policies.add(proxy_policy)
            if EXPECTED_PROXY_POLICIES[proxy_policy] != proxy_function:
                errors.append(f"{prefix}: proxy_function must be {EXPECTED_PROXY_POLICIES[proxy_policy]}")
        if isinstance(proxy_policy, str) and proxy_policy not in proxy_text:
            errors.append(f"{prefix}: proxy policy is not present in proxy implementation")
        if isinstance(proxy_function, str) and f"def {proxy_function}(" not in proxy_text:
            errors.append(f"{prefix}: proxy function is not present in proxy implementation")
        for field, allowed_ids in (("source_inventory_ids", inventory_ids), ("lock_asset_ids", lock_ids)):
            values = wrapper.get(field)
            if not isinstance(values, list) or not values:
                errors.append(f"{prefix}: {field} must be a non-empty list")
                continue
            for value in values:
                if not isinstance(value, str) or value not in allowed_ids:
                    errors.append(f"{prefix}: {field} references unknown id {value}")
        current = wrapper.get("current_adapter")
        if not isinstance(current, dict) or current.get("status") != "proxy_only":
            errors.append(f"{prefix}: current_adapter.status must be proxy_only")
        elif "proxy" not in str(current.get("description", "")).lower():
            errors.append(f"{prefix}: current_adapter.description must describe the proxy boundary")
        real = wrapper.get("real_wrapper")
        if not isinstance(real, dict):
            errors.append(f"{prefix}: real_wrapper must be a mapping")
            continue
        if real.get("status") != "blocked_pending_payload_review":
            errors.append(f"{prefix}: real_wrapper.status must remain blocked_pending_payload_review")
        if not isinstance(real.get("expected_entrypoint"), str) or len(real["expected_entrypoint"]) < 40:
            errors.append(f"{prefix}: real_wrapper.expected_entrypoint must be specific")
        for field in ("required_inputs", "output_contract", "blockers", "replay_gates"):
            values = real.get(field)
            if not isinstance(values, list) or len(values) < 3:
                errors.append(f"{prefix}: real_wrapper.{field} must list at least three items")
        blockers = " ".join(real.get("blockers", [])) if isinstance(real.get("blockers"), list) else ""
        if "OpenLane/OpenROAD replay evidence" not in blockers:
            errors.append(f"{prefix}: blockers must mention missing deterministic OpenLane/OpenROAD replay evidence")
        gates = " ".join(real.get("replay_gates", [])) if isinstance(real.get("replay_gates"), list) else ""
        if "ai-eda-macro-placement-replay-preflight" not in gates:
            errors.append(f"{prefix}: replay_gates must include replay preflight")

    if seen_policies != set(EXPECTED_PROXY_POLICIES):
        errors.append(
            "proxy policies must match expected set "
            f"missing={sorted(set(EXPECTED_PROXY_POLICIES) - seen_policies)} "
            f"extra={sorted(seen_policies - set(EXPECTED_PROXY_POLICIES))}"
        )
    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    manifest = repo_path(str(args.manifest))
    if not manifest.is_file():
        print(f"STATUS: FAIL ai_eda.external_method_wrapper_readiness missing_manifest {rel(manifest)}")
        return 1
    try:
        errors = validate_manifest(manifest)
    except Exception as exc:  # noqa: BLE001
        print(f"STATUS: FAIL ai_eda.external_method_wrapper_readiness {exc}")
        return 1
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.external_method_wrapper_readiness {error}")
        return 1
    print(
        "STATUS: PASS ai_eda.external_method_wrapper_readiness "
        f"wrappers={len(EXPECTED_PROXY_POLICIES)} claim_boundary={EXPECTED_CLAIM_BOUNDARY}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
