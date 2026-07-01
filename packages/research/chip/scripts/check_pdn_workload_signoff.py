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
import json
import sys
from datetime import UTC, datetime
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
GATE_FILE = ROOT / "docs" / "evidence" / "power" / "pdn-signoff-gate.yaml"
REPORT = ROOT / "build/reports/pdn_workload_signoff.json"
SCHEMA = "eliza.pdn_workload_signoff.v1"
CLAIM_BOUNDARY = "pdn_workload_signoff_validation_only_not_release_evidence"
FALSE_CLAIM_FLAGS = {
    "claim_allowed": False,
    "release_claim_allowed": False,
    "pdn_signoff_claim_allowed": False,
    "ir_em_signoff_claim_allowed": False,
    "tapeout_claim_allowed": False,
    "silicon_claim_allowed": False,
    "production_readiness_claim_allowed": False,
}


def blocker_bucket(finding: str) -> str:
    lowered = finding.lower()
    if "commercial" in lowered or "voltus" in lowered or "redhawk" in lowered:
        return "commercial_ir_em_signoff"
    if "workload vectors" in lowered or "vcd" in lowered:
        return "workload_activity_vectors"
    if "spef" in lowered or "parasitic" in lowered or "corner" in lowered:
        return "multi_corner_extraction"
    if "package model" in lowered or "bond-wire" in lowered or "bga" in lowered:
        return "package_pdn_model"
    if "impedance" in lowered or "z(f)" in lowered:
        return "pdn_impedance_profile"
    if "open-flow waiver" in lowered:
        return "open_flow_waiver_artifacts"
    return "pdn_signoff_evidence"


def next_step_for_bucket(bucket: str) -> str:
    steps = {
        "commercial_ir_em_signoff": (
            "Procure or archive commercial Voltus/RedHawk/PrimePower IR/EM reports, "
            "tool run manifests, and signed signoff metadata."
        ),
        "workload_activity_vectors": (
            "Generate rail-granular workload VCDs for CPU burst, NPU saturation, token loop, "
            "idle, and display-refresh scenarios."
        ),
        "multi_corner_extraction": (
            "Produce signoff-corner SPEF/parasitic evidence for every required corner run."
        ),
        "package_pdn_model": (
            "Archive the package/bond-wire/BGA PDN model and fold it into the IR-drop loop."
        ),
        "pdn_impedance_profile": "Generate and archive the PDN impedance Z(f) profile.",
        "open_flow_waiver_artifacts": (
            "Complete the open-flow waiver path with required artifacts and the recorded margin factor."
        ),
        "pdn_signoff_evidence": "Archive the named PDN signoff evidence and rerun the checker.",
    }
    return steps[bucket]


def release_unblock_action_inventory(findings: list[str]) -> list[dict[str, object]]:
    buckets: dict[str, list[str]] = {}
    for finding in findings:
        buckets.setdefault(blocker_bucket(finding), []).append(finding)
    return [
        {
            "bucket": bucket,
            "count": len(items),
            "sample_blockers": items[:4],
            "next_step": next_step_for_bucket(bucket),
            "validation_command": "python3 scripts/check_pdn_workload_signoff.py",
            "release_credit": False,
        }
        for bucket, items in sorted(buckets.items(), key=lambda item: (-len(item[1]), item[0]))
    ]


def write_report(status: str, findings: list[str], allow_blocked: bool) -> None:
    actions = release_unblock_action_inventory(findings) if status == "blocked" else []
    payload = {
        "schema": SCHEMA,
        "generated_utc": datetime.now(UTC).isoformat(),
        "status": status,
        "claim_boundary": CLAIM_BOUNDARY,
        **FALSE_CLAIM_FLAGS,
        "mode": "allow_blocked" if allow_blocked else "strict",
        "gate_file": GATE_FILE.relative_to(ROOT).as_posix(),
        "summary": {
            "release_ready": status == "pass",
            "blockers": len(findings) if status == "blocked" else 0,
            "failures": len(findings) if status == "fail" else 0,
            "action_buckets": {row["bucket"]: row["count"] for row in actions},
        },
        "blocker_dependency_counts": {
            "actionable_external_dependency": len(findings) if status == "blocked" else 0,
            "repo_artifact_generation": 0,
            "live_device_validation": 0,
        },
        "next_command_by_dependency": {
            "actionable_external_dependency": [
                "python3 scripts/check_pdn_workload_signoff.py",
                "python3 scripts/check_pdn_workload_signoff.py --allow-blocked",
            ]
        }
        if status == "blocked"
        else {},
        "release_unblock_action_inventory": actions,
        "findings": [
            {
                "code": f"pdn_workload_signoff_{status}_{index}",
                "severity": "blocker" if status == "blocked" else "error",
                "message": finding,
                "evidence": GATE_FILE.relative_to(ROOT).as_posix(),
                "bucket": blocker_bucket(finding),
                "next_step": next_step_for_bucket(blocker_bucket(finding)),
            }
            for index, finding in enumerate(findings, start=1)
        ],
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


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
        finding = f"{GATE_FILE.relative_to(ROOT)} missing"
        write_report("fail", [finding], args.allow_blocked)
        print(f"FAIL: {finding}", file=sys.stderr)
        return 1

    payload = yaml.safe_load(GATE_FILE.read_text()) or {}
    status = payload.get("status")
    if payload.get("schema") != "eliza.pdn_signoff_gate.v1":
        write_report("fail", ["schema must be 'eliza.pdn_signoff_gate.v1'"], args.allow_blocked)
        print("FAIL: schema must be 'eliza.pdn_signoff_gate.v1'", file=sys.stderr)
        return 1

    commercial_ok, commercial_blockers = check_commercial(payload)
    waiver_ok, waiver_blockers = check_open_flow_waiver(payload)

    if commercial_ok:
        write_report("pass", [], args.allow_blocked)
        print("PDN signoff gate passes via commercial signoff artifacts.")
        return 0
    if waiver_ok:
        write_report("pass", [], args.allow_blocked)
        print("PDN signoff gate passes via open-flow waiver (2x margin).")
        return 0

    blockers = payload.get("release_blockers", []) + commercial_blockers + waiver_blockers
    write_report("blocked", [str(blocker) for blocker in blockers], args.allow_blocked)
    print(f"PDN signoff gate is BLOCKED (status={status}).", file=sys.stderr)
    for b in blockers:
        print(f"  - {b}", file=sys.stderr)
    if args.allow_blocked and status == "blocked":
        print("--allow-blocked: surfacing blockers without failing CI.", file=sys.stderr)
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
