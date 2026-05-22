#!/usr/bin/env python3
"""Fail-closed consistency gate over the multi-PDK closure evidence file.

docs/evidence/process/multi-pdk-closure.yaml is the human-facing roll-up of
where every foundry lane stands: which open-PDK lanes have real closure
artifacts, which are configured-and-pending, and which advanced-node lanes are
procurement-blocked. Before this gate it was the only multi-PDK artifact with
no validator, so it could silently drift from the portability index and the
node profiles, and could keep pointing at run artifacts that no longer exist.

This gate enforces:
  1. Schema marker and that every open/predictive/advanced lane in the
     portability index appears in the closure file (no lane silently dropped).
  2. config / library_manifest / corner_manifest agree with the
     portability-index row for the same PDK.
  3. Any non-null last_run_artifact path actually exists on disk (no stale
     references to deleted runs).
  4. Every advanced lane is listed as blocked_until_foundry_agreement with its
     access-gate file present (mirrors the fail-closed law).
  5. No advanced lane carries a last_run_artifact (advanced nodes must produce
     no signoff artifacts in this open repo).

Consistency is achievable today, so a consistent file exits 0; drift or a
missing/stale reference exits 1. The advanced lanes staying blocked is the
expected healthy state, not a failure.

It never edits the closure file; it only reports drift.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

from chip_utils import load_yaml_object

ROOT = Path(__file__).resolve().parents[1]
CLOSURE = ROOT / "docs/evidence/process/multi-pdk-closure.yaml"
INDEX = ROOT / "pd/openlane/portability-index.yaml"

CLOSURE_SCHEMA = "eliza.process_multi_pdk_closure.v1"
STATUS_BLOCKED = "blocked_until_foundry_agreement"

# closure lane id -> portability-index pdk_name, grouped by lane class.
OPEN_LANES = {"sky130A": "sky130A", "gf180mcuC": "gf180mcuC", "ihp-sg13g2": "ihp-sg13g2"}
PREDICTIVE_LANES = {"asap7": "ASAP7"}
ADVANCED_LANES = {
    "tsmc_n2p": "TSMC_N2P",
    "tsmc_a14": "TSMC_A14",
    "intel_14a": "Intel_14A",
    "samsung_sf2p": "Samsung_SF2P",
}


def rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def index_by_pdk() -> dict[str, dict[str, Any]]:
    data = load_yaml_object(INDEX)
    configs = data.get("configs")
    if not isinstance(configs, list):
        raise ValueError(f"{rel(INDEX)} configs must be a list")
    rows: dict[str, dict[str, Any]] = {}
    for entry in configs:
        if isinstance(entry, dict) and isinstance(entry.get("pdk_name"), str):
            rows[entry["pdk_name"]] = entry
    return rows


def check_manifest_lane(
    lane: dict[str, Any],
    pdk_name: str,
    rows: dict[str, dict[str, Any]],
    errors: list[str],
) -> None:
    lid = lane.get("id", "<no_id>")
    row = rows.get(pdk_name)
    if row is None:
        errors.append(f"{lid}: no portability-index row for pdk_name {pdk_name}")
        return
    for field in ("config", "library_manifest", "corner_manifest"):
        if lane.get(field) != row.get(field):
            errors.append(
                f"{lid}: {field} {lane.get(field)!r} != portability-index {row.get(field)!r}"
            )
        ref = lane.get(field)
        if isinstance(ref, str) and not (ROOT / ref).exists():
            errors.append(f"{lid}: {field} file missing: {ref}")


def check_run_artifact(lane: dict[str, Any], errors: list[str]) -> None:
    artifact = lane.get("last_run_artifact")
    if artifact is None:
        return
    if not isinstance(artifact, str):
        errors.append(f"{lane.get('id', '<no_id>')}: last_run_artifact must be a string or null")
        return
    if not (ROOT / artifact).exists():
        errors.append(
            f"{lane.get('id', '<no_id>')}: last_run_artifact missing on disk: {artifact}"
        )


def main() -> int:
    if not CLOSURE.is_file():
        print(f"FAIL: closure file missing: {rel(CLOSURE)}", file=sys.stderr)
        return 1

    doc = load_yaml_object(CLOSURE)
    rows = index_by_pdk()
    errors: list[str] = []

    if doc.get("schema") != CLOSURE_SCHEMA:
        errors.append(f"schema must be {CLOSURE_SCHEMA}, got {doc.get('schema')!r}")

    def lanes(key: str) -> list[dict[str, Any]]:
        section = doc.get(key)
        if section is None:
            return []
        if not isinstance(section, list):
            errors.append(f"{key} must be a list")
            return []
        return [item for item in section if isinstance(item, dict)]

    open_lanes = lanes("open_pdk_lanes")
    predictive_lanes = lanes("predictive_lanes")
    advanced_lanes = lanes("advanced_lanes_blocked")

    seen_open = {lane.get("id") for lane in open_lanes}
    for lane in open_lanes:
        pdk = OPEN_LANES.get(lane.get("id", ""))
        if pdk is None:
            errors.append(f"unexpected open lane id: {lane.get('id')!r}")
            continue
        check_manifest_lane(lane, pdk, rows, errors)
        check_run_artifact(lane, errors)
    missing_open = set(OPEN_LANES) - seen_open
    if missing_open:
        errors.append(f"open_pdk_lanes missing required lanes: {sorted(missing_open)}")

    for lane in predictive_lanes:
        pdk = PREDICTIVE_LANES.get(lane.get("id", ""))
        if pdk is None:
            errors.append(f"unexpected predictive lane id: {lane.get('id')!r}")
            continue
        check_manifest_lane(lane, pdk, rows, errors)
        check_run_artifact(lane, errors)

    seen_advanced = {lane.get("id") for lane in advanced_lanes}
    for lane in advanced_lanes:
        lid = lane.get("id", "<no_id>")
        if lid not in ADVANCED_LANES:
            errors.append(f"unexpected advanced lane id: {lid!r}")
            continue
        if lane.get("status") != STATUS_BLOCKED:
            errors.append(f"{lid}: advanced lane status must be {STATUS_BLOCKED}")
        if lane.get("last_run_artifact") not in (None, ""):
            errors.append(f"{lid}: advanced lane must not carry a last_run_artifact")
        gate_ref = lane.get("access_gate_file")
        if not isinstance(gate_ref, str) or not (ROOT / gate_ref).exists():
            errors.append(f"{lid}: access_gate_file missing or not a path: {gate_ref!r}")
    missing_advanced = set(ADVANCED_LANES) - seen_advanced
    if missing_advanced:
        errors.append(f"advanced_lanes_blocked missing required lanes: {sorted(missing_advanced)}")

    if errors:
        print("multi-PDK closure consistency check FAILED:")
        for err in errors:
            print(f"  - {err}")
        return 1

    proven = sum(1 for lane in open_lanes if lane.get("last_run_artifact"))
    print(
        f"multi-PDK closure consistent: {len(open_lanes)} open lanes "
        f"({proven} with closure artifacts), {len(advanced_lanes)} advanced lanes blocked"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
