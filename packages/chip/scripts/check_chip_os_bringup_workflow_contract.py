#!/usr/bin/env python3
"""Static workflow gate for the chip + OS bring-up command.

The objective is stronger than a dashboard: Linux and AOSP must boot on the
chip emulator path and the Eliza launcher/agent must be live. This check blocks
when the named Make target is only a view over the normal aggregate or can exit
zero while objective-critical gates remain BLOCKED.
"""

from __future__ import annotations

import argparse
import ast
import json
import re
import sys
from collections.abc import Iterable
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
MAKEFILE = ROOT / "Makefile"
AGGREGATE = ROOT / "scripts/aggregate_tapeout_readiness.py"
REPORT = ROOT / "build/reports/chip_os_bringup_workflow_contract.json"

SCHEMA = "eliza.chip_os_bringup_workflow_contract.v1"
CLAIM_BOUNDARY = "static_workflow_contract_only_not_boot_or_launcher_evidence"
TARGET = "chip-os-bring-up-status"
DEDICATED_REPORT = "build/reports/chip-os-bring-up-status.json"
OBJECTIVE_CRITICAL_GATES = {
    "chipyard-ap-abi-contract-check",
    "linux-bsp-contract-check",
    "cross-fork-agent-payload-contract-check",
    "aosp-simulator-completion-check",
    "aosp-product-contract-check",
    "aosp-hal-service-contract-check",
    "android-app-runtime-contract-check",
    "android-launcher-runtime-evidence-check",
    "android-evidence-capture-contract-check",
    "android-system-bridge-contract-check",
    "android-release-readiness-contract-check",
    "minimum-linux-target-check",
    "minimum-linux-npu-target-check",
    "os-rv64-chip-boot-contract-check",
}


@dataclass(frozen=True)
class Finding:
    code: str
    severity: str
    message: str
    evidence: str
    next_step: str


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def add_if(
    findings: list[Finding],
    condition: bool,
    code: str,
    message: str,
    evidence: str,
    next_step: str,
) -> None:
    if condition:
        findings.append(Finding(code, "blocker", message, evidence, next_step))


def make_target_block(text: str, target: str) -> tuple[list[str], list[str]]:
    lines = text.splitlines()
    for index, line in enumerate(lines):
        if re.match(rf"^{re.escape(target)}\s*:", line):
            comments: list[str] = []
            cursor = index - 1
            while cursor >= 0 and lines[cursor].lstrip().startswith("#"):
                comments.insert(0, lines[cursor])
                cursor -= 1
            body: list[str] = []
            for next_line in lines[index + 1 :]:
                if next_line.startswith("\t") or next_line.startswith(" "):
                    if next_line.strip():
                        body.append(next_line.strip())
                    continue
                if not next_line.strip():
                    continue
                break
            return comments, body
    return [], []


def aggregate_gate_names(path: Path) -> set[str]:
    tree = ast.parse(read_text(path))
    names: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if isinstance(func, ast.Name) and func.id == "GateSpec":
            for keyword in node.keywords:
                if (
                    keyword.arg == "name"
                    and isinstance(keyword.value, ast.Constant)
                    and isinstance(keyword.value.value, str)
                ):
                    names.add(keyword.value.value)
    return names


def run_check(args: argparse.Namespace) -> dict[str, object]:
    del args
    findings: list[Finding] = []
    for path in (MAKEFILE, AGGREGATE):
        add_if(
            findings,
            not path.is_file(),
            "missing_input",
            "required chip OS bring-up workflow input is missing",
            rel(path),
            "Restore the Makefile and aggregate gate inventory before claiming the bring-up workflow is enforceable.",
        )
    if findings:
        return payload(findings, {})

    make_text = read_text(MAKEFILE)
    aggregate_text = read_text(AGGREGATE)
    comments, body = make_target_block(make_text, TARGET)
    target_text = "\n".join(comments + body)
    body_text = "\n".join(body)
    gate_names = aggregate_gate_names(AGGREGATE)
    missing_objective_gates = sorted(OBJECTIVE_CRITICAL_GATES - gate_names)

    add_if(
        findings,
        not body,
        "chip_os_bringup_target_missing",
        "Makefile has no chip-os-bring-up-status target body",
        rel(MAKEFILE),
        "Add a named chip-os-bring-up-status target that operators can run for the objective.",
    )
    add_if(
        findings,
        "view-only" in target_text.lower(),
        "chip_os_bringup_target_declared_view_only",
        "chip-os-bring-up-status is documented as view-only rather than a fail-closed objective gate",
        target_text,
        "Make the target fail closed for objective-critical blocked gates or rename it to a dashboard-only target.",
    )
    add_if(
        findings,
        "aggregate_tapeout_readiness.py" in body_text and "--strict" not in body_text,
        "chip_os_bringup_target_not_strict",
        "chip-os-bring-up-status runs the normal aggregate, which exits 0 with BLOCKED gates",
        body_text,
        "Invoke a strict/objective-specific checker so any missing Linux/AOSP boot, launcher, or agent evidence returns nonzero.",
    )
    add_if(
        findings,
        DEDICATED_REPORT not in body_text and "chip_os_bringup" not in body_text,
        "chip_os_bringup_missing_dedicated_report",
        "chip-os-bring-up-status does not emit a dedicated objective report",
        body_text,
        f"Emit {DEDICATED_REPORT} with per-requirement status for generated AP, Linux fork, AOSP fork, launcher, and agent liveness.",
    )
    add_if(
        findings,
        "release_blocker" in aggregate_text
        and "effective_release_blocker" in aggregate_text
        and "--strict" not in body_text,
        "normal_aggregate_semantics_not_objective_specific",
        "normal aggregate still separates FAIL from BLOCKED, so it is not itself the objective gate",
        rel(AGGREGATE),
        "Keep the dashboard, but make chip-os-bring-up-status use strict/effective blocker semantics by default.",
    )
    add_if(
        findings,
        bool(missing_objective_gates),
        "aggregate_missing_objective_critical_gates",
        "aggregate inventory is missing objective-critical Linux/AOSP/launcher/agent gates",
        f"missing={missing_objective_gates}",
        "Register every objective-critical gate in the bring-up workflow before using it as a readiness command.",
    )

    evidence = {
        "target": TARGET,
        "target_comments": comments,
        "target_body": body,
        "objective_critical_gates_present": sorted(OBJECTIVE_CRITICAL_GATES & gate_names),
        "objective_critical_gates_missing": missing_objective_gates,
        "dedicated_report": DEDICATED_REPORT,
    }
    return payload(findings, evidence)


def payload(findings: list[Finding], evidence: dict[str, Any]) -> dict[str, Any]:
    blockers = [finding for finding in findings if finding.severity == "blocker"]
    return {
        "schema": SCHEMA,
        "status": "pass" if not blockers else "blocked",
        "claim_boundary": CLAIM_BOUNDARY,
        "summary": {"blockers": len(blockers), "findings": len(findings)},
        "findings": [asdict(finding) for finding in findings],
        "evidence": evidence,
    }


def write_report(report: dict[str, Any], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def print_summary(report: dict[str, Any]) -> None:
    print(f"STATUS: {str(report['status']).upper()} chip_os.bringup_workflow_contract")
    for finding in report["findings"]:
        print(f"- {finding['code']}: {finding['message']}")
        print(f"  evidence: {finding['evidence']}")


def parse_args(argv: Iterable[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--report",
        default=str(REPORT),
        help=f"report path (default: {REPORT.relative_to(ROOT)})",
    )
    parser.add_argument("--json-only", action="store_true")
    return parser.parse_args(list(argv))


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    report = run_check(args)
    write_report(report, Path(args.report))
    if not args.json_only:
        print_summary(report)
    return 0 if report["status"] == "pass" else 2


if __name__ == "__main__":
    raise SystemExit(main())
