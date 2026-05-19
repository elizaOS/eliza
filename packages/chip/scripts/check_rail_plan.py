#!/usr/bin/env python3
"""Validate docs/pd/rail-plan-2028.yaml against eliza.rail_plan.v1.

Fails closed when any required field is missing or any value is outside the
documented domain. Re-runs in CI to guarantee the rail plan stays internally
consistent and stays bound to the operating-point claim.
"""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
RAIL_PLAN_PATH = ROOT / "docs" / "pd" / "rail-plan-2028.yaml"
RAIL_EVIDENCE_PATH = ROOT / "docs" / "evidence" / "power" / "rail-plan-evidence.yaml"

EXPECTED_RAILS = [
    "VDD_CPU_BIG",
    "VDD_CPU_LITTLE",
    "VDD_NPU",
    "VDD_GPU",
    "VDD_SOC_FABRIC",
    "VDD_SRAM",
    "VDD_LPDDR_VDDQ",
    "VDD_LPDDR_VDD1",
    "VDD_LPDDR_VDD2H_2L",
    "VDD_PHY_ANALOG",
    "VDD_AON",
    "VDD_PMC",
    "VDD_IO_18",
    "VDD_IO_33",
    "VDD_USB_PCIE_PHY",
    "VDD_RF_REF",
]
REQUIRED_TOP_KEYS = {
    "schema",
    "status",
    "claim_boundary",
    "source_artifacts",
    "process",
    "soc_topology",
    "budgets",
    "control_interfaces",
    "rails",
    "sum_check",
    "release_blockers",
    "release_use",
}
REQUIRED_RAIL_KEYS = {
    "id",
    "index",
    "nominal_v",
    "dvfs_min_v",
    "dvfs_max_v",
    "dvfs_step_mv",
    "peak_a",
    "avg_a",
    "regulator",
    "on_die_dldo",
    "domain",
    "decoupling_nf",
    "notes",
}


def fail(failures: list[str], message: str) -> None:
    failures.append(message)


def validate_plan(payload: dict) -> list[str]:
    failures: list[str] = []

    if payload.get("schema") != "eliza.rail_plan.v1":
        fail(failures, "schema must be 'eliza.rail_plan.v1'")
    missing = sorted(REQUIRED_TOP_KEYS - set(payload))
    if missing:
        fail(failures, f"missing top-level keys: {', '.join(missing)}")

    rails = payload.get("rails", [])
    if not isinstance(rails, list) or len(rails) != len(EXPECTED_RAILS):
        fail(
            failures,
            f"rails: expected {len(EXPECTED_RAILS)} entries, found "
            f"{len(rails) if isinstance(rails, list) else 'non-list'}",
        )
        return failures

    seen_ids: set[str] = set()
    seen_indices: set[int] = set()
    peak_sum_w = 0.0
    avg_sum_w = 0.0
    for entry in rails:
        if not isinstance(entry, dict):
            fail(failures, "rails: each entry must be a mapping")
            continue
        missing_keys = sorted(REQUIRED_RAIL_KEYS - set(entry))
        if missing_keys:
            fail(
                failures, f"rails[{entry.get('id', '?')}]: missing keys: {', '.join(missing_keys)}"
            )
            continue

        rail_id = entry["id"]
        if rail_id in seen_ids:
            fail(failures, f"rails: duplicate id {rail_id}")
        seen_ids.add(rail_id)

        index = entry["index"]
        if index in seen_indices:
            fail(failures, f"rails: duplicate index {index}")
        seen_indices.add(index)

        if entry["dvfs_min_v"] > entry["nominal_v"]:
            fail(failures, f"rails[{rail_id}]: dvfs_min_v > nominal_v")
        if entry["dvfs_max_v"] < entry["nominal_v"]:
            fail(failures, f"rails[{rail_id}]: dvfs_max_v < nominal_v")
        if entry["dvfs_max_v"] < entry["dvfs_min_v"]:
            fail(failures, f"rails[{rail_id}]: dvfs_max_v < dvfs_min_v")
        if entry["peak_a"] < entry["avg_a"]:
            fail(failures, f"rails[{rail_id}]: peak_a < avg_a")
        if entry["dvfs_step_mv"] not in (0, 6.25):
            fail(
                failures,
                f"rails[{rail_id}]: dvfs_step_mv must be 0 or 6.25, got {entry['dvfs_step_mv']}",
            )

        peak_sum_w += float(entry["nominal_v"]) * float(entry["peak_a"])
        avg_sum_w += float(entry["nominal_v"]) * float(entry["avg_a"])

    if seen_ids != set(EXPECTED_RAILS):
        missing_rails = sorted(set(EXPECTED_RAILS) - seen_ids)
        unexpected = sorted(seen_ids - set(EXPECTED_RAILS))
        if missing_rails:
            fail(failures, f"rails: missing required rails: {missing_rails}")
        if unexpected:
            fail(failures, f"rails: unexpected rails present: {unexpected}")

    sum_check = payload.get("sum_check", {})
    budgets = payload.get("budgets", {})
    burst_target = float(budgets.get("burst_peak_w", 0))
    if burst_target == 0:
        fail(failures, "budgets.burst_peak_w missing or zero")

    declared_standalone = float(sum_check.get("standalone_peak_sum_w_modeled", 0))
    if abs(declared_standalone - peak_sum_w) > 0.05:
        fail(
            failures,
            f"sum_check.standalone_peak_sum_w_modeled "
            f"({declared_standalone:.3f}) does not match computed "
            f"sum-of-standalone-peaks ({peak_sum_w:.3f})",
        )

    declared_active = float(sum_check.get("workload_active_sum_w_modeled", 0))
    if abs(declared_active - avg_sum_w) > 0.05:
        fail(
            failures,
            f"sum_check.workload_active_sum_w_modeled "
            f"({declared_active:.3f}) does not match computed "
            f"sum-of-avg ({avg_sum_w:.3f})",
        )

    declared_active_target = float(sum_check.get("workload_active_sum_w_target", 0))
    if abs(declared_active - declared_active_target) / max(declared_active_target, 1e-6) > 0.20:
        fail(
            failures,
            f"sum_check.workload_active_sum_w_modeled "
            f"({declared_active:.3f}) differs from "
            f"workload_active_sum_w_target "
            f"({declared_active_target:.3f}) by > 20%",
        )

    # standalone peak must match the declared burst target.
    if abs(peak_sum_w - burst_target) / max(burst_target, 1e-6) > 0.15:
        fail(
            failures,
            f"computed standalone peak sum ({peak_sum_w:.3f}) "
            f"differs from budgets.burst_peak_w ({burst_target:.3f}) by > 15%",
        )

    return failures


DEFAULT_BINDING_TARGETS = [
    "docs/architecture-optimization/soc-optimized-operating-point.yaml",
]


def validate_hash() -> list[str]:
    failures: list[str] = []
    if not RAIL_PLAN_PATH.is_file():
        return ["rail plan file missing"]
    if not RAIL_EVIDENCE_PATH.is_file():
        return ["rail plan evidence file missing"]
    plan_hash = hashlib.sha256(RAIL_PLAN_PATH.read_bytes()).hexdigest()
    evidence = yaml.safe_load(RAIL_EVIDENCE_PATH.read_text())
    declared = evidence.get("rail_plan_sha256")
    if declared != plan_hash:
        fail(
            failures,
            f"rail-plan-evidence.yaml.rail_plan_sha256 mismatch: "
            f"declared={declared}, actual={plan_hash}",
        )
    return failures


def validate_binding(rel_path: str) -> list[str]:
    failures: list[str] = []
    target = ROOT / rel_path
    if not target.is_file():
        return [f"binding target missing: {rel_path}"]
    plan_hash = hashlib.sha256(RAIL_PLAN_PATH.read_bytes()).hexdigest()
    payload = yaml.safe_load(target.read_text())
    binding = (payload or {}).get("rail_plan_hash", {})
    if not binding:
        fail(failures, f"{rel_path}: missing rail_plan_hash binding")
        return failures
    declared = binding.get("rail_plan_sha256")
    if declared != plan_hash:
        fail(
            failures,
            f"{rel_path}: rail_plan_hash.rail_plan_sha256 mismatch "
            f"(declared={declared}, actual={plan_hash})",
        )
    if binding.get("rail_plan_path") != "docs/pd/rail-plan-2028.yaml":
        fail(
            failures,
            f"{rel_path}: rail_plan_hash.rail_plan_path must point to docs/pd/rail-plan-2028.yaml",
        )
    return failures


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--binding-target",
        action="append",
        default=None,
        help="extra consumer YAML that must declare a rail_plan_hash binding",
    )
    args = parser.parse_args()

    if not RAIL_PLAN_PATH.is_file():
        print(f"FAIL: {RAIL_PLAN_PATH} missing", file=sys.stderr)
        return 1
    payload = yaml.safe_load(RAIL_PLAN_PATH.read_text())
    if not isinstance(payload, dict):
        print(f"FAIL: {RAIL_PLAN_PATH} must be a YAML mapping", file=sys.stderr)
        return 1
    failures = validate_plan(payload)
    failures += validate_hash()
    binding_targets = args.binding_target if args.binding_target else DEFAULT_BINDING_TARGETS
    for target in binding_targets:
        failures += validate_binding(target)
    if failures:
        for failure in failures:
            print(f"FAIL: {failure}", file=sys.stderr)
        return 1
    print(f"Rail plan {RAIL_PLAN_PATH.relative_to(ROOT)} passed schema, hash, and binding checks.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
