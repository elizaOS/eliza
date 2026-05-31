#!/usr/bin/env python3
"""Validate the per-corner DVFS table placeholders.

Required for procurement:
  - Twelve files under docs/pd/dvfs-tables/ named dvfs-table-<corner>-<tempC>c.yaml
    for the cross product of {ss, tt, ff} x {0, 25, 85, 105}.
  - Every file schema = eliza.dvfs_table.v1.
  - Every file covers all six DVFS-managed rails declared in the rail plan
    (the DVFS_RAIL_* enums in rtl/power/power_pkg.sv).
  - For numeric operating points: min_code <= nominal_code <= max_code, and
    the implied voltage window must lie inside [dvfs_min_v, dvfs_max_v] from
    docs/pd/rail-plan-2028.yaml.
  - The string sentinel `pending_silicon_corner_sta` is accepted in any of the
    three numeric fields and propagates the blocker; the gate
    docs/evidence/power/dvfs-table-evidence.yaml remains failed-closed until
    every cell is numeric.

This is a planning-completeness gate. Release-grade DVFS tables must come
from `pd/signoff/sta/<corner>/` and re-pass this check with no sentinel
values left.
"""

from __future__ import annotations

from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
DVFS_DIR = ROOT / "docs" / "pd" / "dvfs-tables"
RAIL_PLAN = ROOT / "docs" / "pd" / "rail-plan-2028.yaml"
EVIDENCE = ROOT / "docs" / "evidence" / "power" / "dvfs-table-evidence.yaml"

CORNERS = ("ss", "tt", "ff")
TEMPS = (0, 25, 85, 105)
DVFS_RAILS = (
    "VDD_CPU_BIG",
    "VDD_CPU_LITTLE",
    "VDD_NPU",
    "VDD_GPU",
    "VDD_SOC_FABRIC",
    "VDD_SRAM",
)
DVFS_STEP_V = 6.25e-3
SENTINEL = "pending_silicon_corner_sta"
REQUIRED_FALSE_CLAIM_FLAGS = {
    "claim_allowed",
    "release_claim_allowed",
    "silicon_sta_claim_allowed",
    "dvfs_signoff_claim_allowed",
    "production_voltage_claim_allowed",
    "pmic_programming_claim_allowed",
}


def code_to_v(code: int) -> float:
    return code * DVFS_STEP_V


def validate_table(path: Path, rail_window: dict[str, tuple[float, float]]) -> list[str]:
    failures: list[str] = []
    try:
        payload = yaml.safe_load(path.read_text())
    except yaml.YAMLError as exc:
        return [f"{path.name}: YAML parse error: {exc}"]
    if payload.get("schema") != "eliza.dvfs_table.v1":
        failures.append(f"{path.name}: schema must be eliza.dvfs_table.v1")

    rails = payload.get("rails", {})
    missing = [r for r in DVFS_RAILS if r not in rails]
    if missing:
        failures.append(f"{path.name}: missing rails: {missing}")

    for rail_id in DVFS_RAILS:
        ops = (rails.get(rail_id) or {}).get("operating_points", [])
        if not ops:
            failures.append(f"{path.name} rail {rail_id}: no operating_points")
            continue
        vmin, vmax = rail_window[rail_id]
        for i, op in enumerate(ops):
            nom = op.get("nominal_code")
            mn = op.get("min_code")
            mx = op.get("max_code")
            if SENTINEL in (nom, mn, mx):
                # Each sentinel cell must mark *all three* as sentinel.
                if not (nom == SENTINEL and mn == SENTINEL and mx == SENTINEL):
                    failures.append(
                        f"{path.name} rail {rail_id} op[{i}]: partial sentinel; "
                        f"all three of nominal/min/max must be {SENTINEL}"
                    )
                continue
            try:
                nom_i = int(nom)
                mn_i = int(mn)
                mx_i = int(mx)
            except (TypeError, ValueError):
                failures.append(
                    f"{path.name} rail {rail_id} op[{i}]: non-integer codes "
                    f"(nom={nom}, min={mn}, max={mx})"
                )
                continue
            if not (mn_i <= nom_i <= mx_i):
                failures.append(
                    f"{path.name} rail {rail_id} op[{i}]: "
                    f"min={mn_i} <= nominal={nom_i} <= max={mx_i} not satisfied"
                )
            if code_to_v(mn_i) < vmin - 1e-9 or code_to_v(mx_i) > vmax + 1e-9:
                failures.append(
                    f"{path.name} rail {rail_id} op[{i}]: code window "
                    f"[{code_to_v(mn_i):.4f},{code_to_v(mx_i):.4f}] V outside "
                    f"rail plan [{vmin},{vmax}] V"
                )
    return failures


def main() -> int:
    if not DVFS_DIR.is_dir():
        print(f"FAIL dvfs-tables dir missing: {DVFS_DIR.relative_to(ROOT)}")
        return 1
    if not RAIL_PLAN.is_file():
        print(f"FAIL rail plan missing: {RAIL_PLAN.relative_to(ROOT)}")
        return 1
    if not EVIDENCE.is_file():
        print(f"FAIL DVFS evidence missing: {EVIDENCE.relative_to(ROOT)}")
        return 1

    plan = yaml.safe_load(RAIL_PLAN.read_text())
    evidence = yaml.safe_load(EVIDENCE.read_text())
    if not isinstance(evidence, dict):
        print(f"FAIL {EVIDENCE.relative_to(ROOT)} must be a YAML mapping")
        return 1
    false_flag_errors = [
        f"{key} must be false"
        for key in sorted(REQUIRED_FALSE_CLAIM_FLAGS)
        if evidence.get(key) is not False
    ]
    if false_flag_errors:
        print("DVFS table check FAILED:")
        for failure in false_flag_errors:
            print(f"  - {failure}")
        return 1
    rail_window = {
        rail["id"]: (float(rail["dvfs_min_v"]), float(rail["dvfs_max_v"])) for rail in plan["rails"]
    }

    failures: list[str] = []
    sentinel_count = 0
    for corner in CORNERS:
        for temp in TEMPS:
            fname = f"dvfs-table-{corner}-{temp}c.yaml"
            path = DVFS_DIR / fname
            if not path.is_file():
                failures.append(f"missing corner file: {fname}")
                continue
            file_failures = validate_table(path, rail_window)
            failures.extend(file_failures)
            text = path.read_text()
            sentinel_count += text.count(SENTINEL)

    if failures:
        print("DVFS table check FAILED:")
        for f in failures:
            print(f"  - {f}")
        return 1

    n_files = len(CORNERS) * len(TEMPS)
    print(
        f"DVFS tables: {n_files} corner files schema-valid; "
        f"{sentinel_count} {SENTINEL} cells remain "
        f"(release gate stays blocked until 0)."
    )
    return 0 if sentinel_count >= 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
