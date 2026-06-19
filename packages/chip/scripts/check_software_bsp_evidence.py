#!/usr/bin/env python3
"""Fail-closed wrapper for external software BSP evidence release gates."""

import argparse
import json
import sys
from typing import Any

import check_software_bsp

FALSE_CLAIM_FLAGS = {
    "claim_allowed": False,
    "phone_claim_allowed": False,
    "release_claim_allowed": False,
    "linux_boot_claim_allowed": False,
    "aosp_boot_claim_allowed": False,
    "android_runtime_claim_allowed": False,
    "production_bsp_claim_allowed": False,
}


def build_report(target: str) -> dict[str, Any]:
    names = check_software_bsp.TARGETS.keys() if target == "all" else [target]
    reports = [check_software_bsp.target_report(name) for name in names]
    status = "PASS"
    if any(report["invalid_evidence"] or report["errors"] for report in reports):
        status = "FAIL"
    if any(report["missing_evidence"] for report in reports):
        status = "BLOCKED"
    return {
        "schema": "eliza.software_bsp_evidence_release_gate.v1",
        "status": status,
        "claim_boundary": "external_logs_required_no_placeholder_or_failed_transcripts",
        **FALSE_CLAIM_FLAGS,
        "checker": "scripts/check_software_bsp.py --require-evidence",
        "targets": reports,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "target",
        choices=[*check_software_bsp.TARGETS.keys(), "all"],
        nargs="?",
        default="all",
    )
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    report = build_report(args.target)
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print(f"software BSP evidence release gate: {report['status']}")
        for target in report["targets"]:
            print(
                f"{target['target']}: scaffold={target['scaffold_status']} "
                f"evidence={target['evidence_status']}"
            )
            for item in target["missing_evidence"]:
                print(f"  [BLOCKED] missing {item['path']} ({item['blocker_code']})")
                print(f"    capture: {item['capture_command']}")
                print(f"    validate: {item['validation_command']}")
            for item in target["invalid_evidence"]:
                print(f"  [FAIL] invalid {item['path']}")
                for problem in item["problems"]:
                    print(f"    problem: {problem}")
            for error in target["errors"]:
                print(f"  [SCAFFOLD-ERROR] {error}")
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
