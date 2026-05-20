#!/usr/bin/env python3
"""Validate board/kicad/e1-pmic-daughtercard/bom-planning.csv against the rail
plan in docs/pd/rail-plan-2028.yaml.

Fails closed when:
  - Any rail in the rail plan is not covered by at least one BOM row.
  - Any BOM row declares a vmin_v / vmax_v window that does not cover the
    rail's dvfs_min_v / dvfs_max_v.
  - Any BOM row declares an i_max_a smaller than the rail's peak_a.
  - The control field is not one of {spmi_v2, i2c_fmplus, enable_pin_only}.

This is procurement gating; it does NOT validate physical fab-readiness
(KiCad schematic / DRC / ERC), which is gated separately.
"""

from __future__ import annotations

import csv
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
RAIL_PLAN = ROOT / "docs" / "pd" / "rail-plan-2028.yaml"
BOM = ROOT / "board" / "kicad" / "e1-pmic-daughtercard" / "bom-planning.csv"
ALLOWED_CONTROL = {"spmi_v2", "i2c_fmplus", "enable_pin_only"}
REQUIRED_COLUMNS = {
    "ref",
    "rail",
    "role",
    "vendor",
    "family",
    "mpn_candidate",
    "topology",
    "vmin_v",
    "vmax_v",
    "i_max_a",
    "control",
    "board_target_nf",
    "notes",
}


def main() -> int:
    if not RAIL_PLAN.is_file():
        print(f"FAIL rail plan missing: {RAIL_PLAN.relative_to(ROOT)}")
        return 1
    if not BOM.is_file():
        print(f"FAIL BOM missing: {BOM.relative_to(ROOT)}")
        return 1

    plan = yaml.safe_load(RAIL_PLAN.read_text())
    rails = {rail["id"]: rail for rail in plan.get("rails", [])}
    if not rails:
        print("FAIL rail plan has no rails")
        return 1

    with BOM.open(newline="") as fh:
        reader = csv.DictReader(fh)
        header = set(reader.fieldnames or [])
        missing_cols = REQUIRED_COLUMNS - header
        if missing_cols:
            print(f"FAIL BOM missing columns: {sorted(missing_cols)}")
            return 1
        rows = list(reader)

    if not rows:
        print("FAIL BOM has no rows")
        return 1

    failures: list[str] = []
    covered: set[str] = set()
    for i, row in enumerate(rows, start=2):
        rail_id = row["rail"]
        if rail_id not in rails:
            failures.append(f"row {i}: rail '{rail_id}' is not in rail plan")
            continue
        rail = rails[rail_id]
        try:
            vmin = float(row["vmin_v"])
            vmax = float(row["vmax_v"])
            imax = float(row["i_max_a"])
        except ValueError as exc:
            failures.append(f"row {i} rail {rail_id}: numeric parse error: {exc}")
            continue
        if vmin > float(rail["dvfs_min_v"]):
            failures.append(
                f"row {i} rail {rail_id}: vmin_v {vmin} > dvfs_min_v {rail['dvfs_min_v']}"
            )
        if vmax < float(rail["dvfs_max_v"]):
            failures.append(
                f"row {i} rail {rail_id}: vmax_v {vmax} < dvfs_max_v {rail['dvfs_max_v']}"
            )
        if imax < float(rail["peak_a"]):
            failures.append(f"row {i} rail {rail_id}: i_max_a {imax} < peak_a {rail['peak_a']}")
        if row["control"] not in ALLOWED_CONTROL:
            failures.append(
                f"row {i} rail {rail_id}: control '{row['control']}' not in {sorted(ALLOWED_CONTROL)}"
            )
        covered.add(rail_id)

    uncovered = set(rails) - covered
    if uncovered:
        failures.append(f"uncovered rails: {sorted(uncovered)}")

    if failures:
        print("PMIC daughtercard BOM check FAILED:")
        for f in failures:
            print(f"  - {f}")
        return 1

    print(
        f"PMIC daughtercard BOM covers all {len(rails)} rails "
        f"with {len(rows)} planning entries (path A v0)."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
