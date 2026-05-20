#!/usr/bin/env python3
"""Fail-closed PDN signoff workload gate.

Validates docs/evidence/power/pdn-signoff-gate.yaml. The gate passes only when
ONE of the following is true:

  (a) A commercial Voltus or RedHawk-SC run is present with all four required
      artifact globs populated (static_ir, dynamic_ir, em, signoff-manifest)
      and a signed-by attestation file.

  (b) The open-flow waiver path is taken AND every artifact glob in the
      waiver path matches an actual file AND a 2.0x margin factor is
      explicitly recorded in pd/signoff/waivers/pdn-open-flow-waiver.yaml.

Today (status == 'blocked' in the gate file), neither path is satisfied; the
script exits non-zero with the specific blocker reasons.

The script accepts --allow-blocked to surface blockers without crashing the
broader CI run when the project is still pre-procurement.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
GATE_FILE = ROOT / "docs" / "evidence" / "power" / "pdn-signoff-gate.yaml"


def files_match(glob_pattern: str) -> list[Path]:
    return sorted(ROOT.glob(glob_pattern.replace("<run_id>", "*")))


def check_commercial(payload: dict) -> tuple[bool, list[str]]:
    blockers: list[str] = []
    commercial = payload.get("required_commercial_signoff", {})
    for option in commercial.get("any_of", []):
        all_present = True
        for glob_pattern in option.get("report_globs", []):
            if not files_match(glob_pattern):
                all_present = False
                blockers.append(f"commercial {option['tool']}: missing artifact for {glob_pattern}")
        if all_present:
            return True, []
    return False, blockers


def check_open_flow_waiver(payload: dict) -> tuple[bool, list[str]]:
    blockers: list[str] = []
    waiver = payload.get("open_flow_waiver_path", {})
    waiver_yaml = ROOT / "pd" / "signoff" / "waivers" / "pdn-open-flow-waiver.yaml"
    if not waiver_yaml.is_file():
        blockers.append(f"open-flow waiver: {waiver_yaml.relative_to(ROOT)} missing")
        return False, blockers
    waiver_doc = yaml.safe_load(waiver_yaml.read_text()) or {}
    margin = float(waiver_doc.get("margin_factor", 0))
    required_margin = float(waiver.get("required_margin_factor", 2.0))
    if margin < required_margin:
        blockers.append(f"open-flow waiver: margin_factor {margin} < required {required_margin}")
    for glob_pattern in waiver.get("required_artifacts", []):
        if not files_match(glob_pattern):
            blockers.append(f"open-flow waiver: missing artifact for {glob_pattern}")
    return (not blockers), blockers


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--allow-blocked",
        action="store_true",
        help="exit 0 when status='blocked' but emit blockers",
    )
    args = parser.parse_args(argv)

    if not GATE_FILE.is_file():
        print(f"FAIL: {GATE_FILE.relative_to(ROOT)} missing", file=sys.stderr)
        return 1

    payload = yaml.safe_load(GATE_FILE.read_text()) or {}
    status = payload.get("status")
    if payload.get("schema") != "eliza.pdn_signoff_gate.v1":
        print("FAIL: schema must be 'eliza.pdn_signoff_gate.v1'", file=sys.stderr)
        return 1

    commercial_ok, commercial_blockers = check_commercial(payload)
    waiver_ok, waiver_blockers = check_open_flow_waiver(payload)

    if commercial_ok:
        print("PDN signoff gate passes via commercial signoff artifacts.")
        return 0
    if waiver_ok:
        print("PDN signoff gate passes via open-flow waiver (2x margin).")
        return 0

    blockers = payload.get("release_blockers", []) + commercial_blockers + waiver_blockers
    print(f"PDN signoff gate is BLOCKED (status={status}).", file=sys.stderr)
    for b in blockers:
        print(f"  - {b}", file=sys.stderr)
    if args.allow_blocked and status == "blocked":
        print("--allow-blocked: surfacing blockers without failing CI.", file=sys.stderr)
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
