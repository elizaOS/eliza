#!/usr/bin/env python3
"""Build a machine-readable inventory of chip OS boot blockers.

This is an inventory, not a boot claim. It consolidates the current aggregate
gate state and the detailed JSON reports that explain why Linux/AOSP boot,
launcher foreground, and agent liveness are still not proven.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Iterable
from dataclasses import asdict
from pathlib import Path
from typing import Any

import aggregate_tapeout_readiness as aggregate

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_AGGREGATE = ROOT / "build/reports/chip-os-bring-up-status.json"
CHIP_TAPEOUT_AGGREGATE = ROOT / "build/reports/tapeout-readiness-chip.json"
FALLBACK_AGGREGATE = ROOT / "build/reports/tapeout-readiness.json"
REPORT_DIR = ROOT / "build/reports"
REPORT = REPORT_DIR / "chip-os-boot-gap-inventory.json"
SURVEY_ONLY_REPORT_NAMES = {
    "chip-os-closure-plan.json",
    "chip-os-environment-preflight.json",
    "chip-os-evidence-provenance.json",
    "chip-os-gap-keyword-inventory.json",
    "chip-os-identity-contract.json",
    "chip-os-objective-evidence-matrix.json",
    "chip-os-optimization-gap-inventory.json",
    "chip-os-report-freshness.json",
}

SCHEMA = "eliza.chip_os_boot_gap_inventory.v1"
CLAIM_BOUNDARY = "inventory_only_not_boot_or_launcher_evidence"
NONPASS = {"BLOCKED", "FAIL"}
PASS_STATUSES = {"pass", "passed", "ok"}
STRUCTURED_DETAIL_KEYS = (
    "findings",
    "blockers",
    "errors",
    "failures",
    "entries",
    "blockers_to_on_chip_os_boot",
    "blockers_to_minimum_linux_npu_target",
)
GATE_REPORT_ALIASES = {
    "aosp-simulator-completion-check": ("android_sim_boot.json", "mvp_simulator.json"),
    "chipyard-generated-linux-contract-check": (
        "chipyard_payload_path.json",
        "cpu_ap_scope.json",
    ),
    "cpu-ap-completion-gate": ("cpu_ap_scope.json", "cpu_ap_boot_readiness.json"),
    "minimum-linux-target-check": ("minimum-linux-kernel-target.json",),
    "software-bsp-scaffold-check": ("software_bsp.json",),
}


def rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def status_is_nonpass(value: object) -> bool:
    if not isinstance(value, str):
        return False
    return value.upper() in NONPASS or value.lower() not in PASS_STATUSES


def has_structured_detail_rows(data: dict[str, Any]) -> bool:
    for key in STRUCTURED_DETAIL_KEYS:
        values = data.get(key)
        if isinstance(values, list) and values:
            return True
    if (
        status_is_nonpass(data.get("status"))
        and isinstance(data.get("next_honest_capture"), str)
        and (
            isinstance(data.get("best_raw_candidate"), dict)
            or isinstance(data.get("wrapper_log"), dict)
        )
    ):
        return True
    if data.get("schema") == "eliza.gate_status.v1" and status_is_nonpass(data.get("status")):
        gate = data.get("gate")
        evidence_paths = data.get("evidence_paths")
        if isinstance(gate, str) and gate and isinstance(evidence_paths, list):
            return True
    return False


def code_from_text(text: str, fallback: str) -> str:
    cleaned = "".join(char.lower() if char.isalnum() else "_" for char in text)
    parts = [part for part in cleaned.split("_") if part]
    return "_".join(parts[:10]) or fallback


def aggregate_path(explicit: str | None) -> Path:
    if explicit:
        return Path(explicit)
    candidates = [
        path
        for path in (DEFAULT_AGGREGATE, CHIP_TAPEOUT_AGGREGATE, FALLBACK_AGGREGATE)
        if path.is_file()
    ]
    if candidates:
        return max(candidates, key=lambda path: path.stat().st_mtime)
    return DEFAULT_AGGREGATE


def collect_aggregate_gates(data: dict[str, Any]) -> list[dict[str, Any]]:
    gates = data.get("gates", [])
    if not isinstance(gates, list):
        return []
    rows: list[dict[str, Any]] = []
    for gate in gates:
        if not isinstance(gate, dict) or gate.get("status") not in NONPASS:
            continue
        rows.append(
            {
                "name": gate.get("name"),
                "status": gate.get("status"),
                "subsystem": gate.get("subsystem"),
                "tier": gate.get("tier"),
                "evidence": gate.get("evidence"),
            }
        )
    return sorted(rows, key=lambda row: (str(row["status"]), str(row["name"])))


def gate_specs_by_name() -> dict[str, dict[str, Any]]:
    specs: dict[str, dict[str, Any]] = {}
    for spec in aggregate.GATES:
        row = asdict(spec)
        row["script"] = str(row["script"])
        row["args"] = list(row.get("args", ()))
        specs[spec.name] = row
    return specs


def gate_script_path(script: object) -> Path | None:
    if not isinstance(script, str) or not script:
        return None
    path = Path(script)
    if not path.is_absolute():
        path = ROOT / path
    return path.resolve()


def expected_report_candidates(script: object, gate_name: object | None = None) -> list[str]:
    path = gate_script_path(script)
    candidates: set[str] = set()
    if isinstance(gate_name, str):
        candidates.update(GATE_REPORT_ALIASES.get(gate_name, ()))
    if path is None:
        return sorted(candidates)
    stem = path.stem
    candidates.add(f"{stem}.json")
    if stem.startswith("check_"):
        candidates.add(f"{stem.removeprefix('check_')}.json")
    if stem.startswith("test_"):
        candidates.add(f"{stem.removeprefix('test_')}.json")
    return sorted(candidates)


def matched_reports_for_gate(gate: dict[str, Any], report_statuses: dict[str, object]) -> list[str]:
    candidates = set(expected_report_candidates(gate.get("source_script"), gate.get("name")))
    name = str(gate.get("name", ""))
    normalized_name = name.removesuffix("-check").replace("-", "_")
    if normalized_name:
        candidates.add(f"{normalized_name}.json")
    matches: set[str] = set()
    for source in report_statuses:
        if Path(source).name in candidates:
            matches.add(source)
    return sorted(matches)


def aggregate_gate_entry(gate: dict[str, Any]) -> dict[str, Any]:
    name = str(gate.get("name", "aggregate_gate"))
    status = str(gate.get("status", "NONPASS")).lower()
    return {
        "source_report": "aggregate",
        "kind": "aggregate_gate",
        "code": f"aggregate_{status}_{code_from_text(name, 'gate')}",
        "severity": "blocker",
        "message": f"{name} is {gate.get('status')}",
        "evidence": gate.get("evidence"),
        "next_step": "Run or repair the named checker until it produces PASS evidence for the Linux/AOSP chip boot objective.",
    }


def report_mismatch_entry(gate: dict[str, Any], source: str, status: object) -> dict[str, Any]:
    name = str(gate.get("name", "aggregate_gate"))
    return {
        "source_report": source,
        "kind": "detail_report_mismatch",
        "code": f"detail_report_mismatch_{code_from_text(name, 'gate')}",
        "severity": "blocker",
        "message": "nonpassing aggregate gate has a matching detailed report that is not nonpassing",
        "evidence": f"gate_status={gate.get('status')} report_status={status!r} gate_evidence={gate.get('evidence')}",
        "next_step": "Make the checker write a fail-closed detailed report that matches the aggregate gate result.",
    }


def stale_aggregate_entry(gate: dict[str, Any], source: str, status: object) -> dict[str, Any]:
    name = str(gate.get("name", "aggregate_gate"))
    return {
        "source_report": source,
        "kind": "stale_aggregate_gate",
        "code": f"stale_aggregate_gate_{code_from_text(name, 'gate')}",
        "severity": "blocker",
        "message": "nonpassing aggregate gate is stale relative to a newer passing detailed report",
        "evidence": f"gate_status={gate.get('status')} report_status={status!r} gate_evidence={gate.get('evidence')}",
        "next_step": "Regenerate the aggregate readiness report so it reflects the newer passing detailed checker output.",
    }


def finding_entry(source: Path, finding: dict[str, Any]) -> dict[str, Any] | None:
    severity = str(finding.get("severity", "")).lower()
    if severity in PASS_STATUSES:
        return None
    code = finding.get("code")
    if not isinstance(code, str) or not code:
        code = code_from_text(str(finding.get("message", "")), "finding_without_code")
    return {
        "source_report": rel(source),
        "kind": "finding",
        "code": code,
        "severity": severity or "unknown",
        "message": finding.get("message"),
        "evidence": finding.get("evidence"),
        "next_step": finding.get("next_step"),
    }


def string_entry(source: Path, kind: str, value: object) -> dict[str, Any] | None:
    if not isinstance(value, str) or not value.strip():
        return None
    return {
        "source_report": rel(source),
        "kind": kind,
        "code": code_from_text(value, kind),
        "severity": "blocker",
        "message": value.strip(),
        "evidence": None,
        "next_step": None,
    }


def dict_entry(source: Path, kind: str, value: dict[str, Any]) -> dict[str, Any]:
    raw_code = value.get("code") or value.get("name") or value.get("gate")
    if not isinstance(raw_code, str) or not raw_code:
        raw_code = str(value.get("message") or value.get("detail") or kind)
    code = code_from_text(f"{kind}_{raw_code}", kind)
    message = value.get("message") or value.get("detail") or value.get("name") or value.get("gate")
    evidence = value.get("evidence") or value.get("detail")
    next_step = value.get("next_step") or value.get("next") or value.get("next_command")
    severity = str(value.get("severity") or kind).lower()
    return {
        "source_report": rel(source),
        "kind": kind,
        "code": code,
        "severity": severity,
        "message": message,
        "evidence": evidence,
        "next_step": next_step,
    }


def detail_kind_for_key(key: str) -> str:
    if key == "entries":
        return "entry"
    return key[:-1] if key.endswith("s") else key


def gate_status_entry(source: Path, data: dict[str, Any]) -> dict[str, Any] | None:
    if data.get("schema") != "eliza.gate_status.v1" or not status_is_nonpass(data.get("status")):
        return None
    gate = data.get("gate")
    if not isinstance(gate, str) or not gate:
        gate = source.stem
    status = str(data.get("status", "NONPASS")).lower()
    blocker_id = data.get("blocker_id")
    code_seed = blocker_id if isinstance(blocker_id, str) and blocker_id else f"{gate}_{status}"
    blocker_reason = data.get("blocker_reason")
    if isinstance(blocker_reason, str) and blocker_reason:
        message = blocker_reason
    else:
        message = f"{gate} gate is {data.get('status')}"
    evidence_paths = data.get("evidence_paths")
    evidence = evidence_paths if isinstance(evidence_paths, list) else None
    return {
        "source_report": rel(source),
        "kind": "gate_status",
        "code": f"gate_status_{code_from_text(code_seed, 'gate_status')}",
        "severity": "blocker",
        "message": message,
        "evidence": {
            "gate": gate,
            "status": data.get("status"),
            "evidence_paths": evidence,
            "subsystem": data.get("subsystem"),
        },
        "next_step": (
            "Replace this fail-closed gate status with a PASS report backed by the listed evidence paths, "
            "or add a specific blocker_id/blocker_reason if the gate remains nonpassing."
        ),
    }


def unstructured_nonpass_entry(source: Path, data: dict[str, Any]) -> dict[str, Any]:
    return {
        "source_report": rel(source),
        "kind": "unstructured_nonpass_report",
        "code": f"unstructured_nonpass_report_{code_from_text(source.stem, 'report')}",
        "severity": "blocker",
        "message": "nonpassing report has no structured finding, blocker, error, or failure rows",
        "evidence": f"status={data.get('status')!r}",
        "next_step": (
            "Add stable structured findings/blockers/errors/failures with code, message, "
            "evidence, and next_step fields so this report can drive closure."
        ),
    }


def evidence_capture_blocked_entry(source: Path, data: dict[str, Any]) -> dict[str, Any] | None:
    if not status_is_nonpass(data.get("status")):
        return None
    next_step = data.get("next_honest_capture")
    if not isinstance(next_step, str) or not next_step.strip():
        return None

    best_raw = data.get("best_raw_candidate")
    wrapper = data.get("wrapper_log")
    if not isinstance(best_raw, dict) and not isinstance(wrapper, dict):
        return None

    missing_markers = []
    if isinstance(best_raw, dict) and isinstance(best_raw.get("missing_required_markers"), list):
        missing_markers = best_raw["missing_required_markers"]
    evidence = {
        "destination": data.get("destination"),
        "destination_exists": data.get("destination_exists"),
        "best_raw_candidate": best_raw,
        "wrapper_log": wrapper,
        "missing_required_markers": missing_markers,
    }
    return {
        "source_report": rel(source),
        "kind": "evidence_capture_blocked",
        "code": f"evidence_capture_blocked_{code_from_text(source.stem, 'report')}",
        "severity": "blocker",
        "message": "runtime evidence capture is blocked until the raw transcript satisfies required markers",
        "evidence": evidence,
        "next_step": next_step,
    }


def collect_report_entries(source: Path, data: dict[str, Any]) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    evidence_entry = evidence_capture_blocked_entry(source, data)
    if evidence_entry:
        entries.append(evidence_entry)
    findings = data.get("findings", [])
    if isinstance(findings, list):
        for finding in findings:
            if isinstance(finding, dict):
                entry = finding_entry(source, finding)
                if entry:
                    entries.append(entry)
    for key in (
        "blockers",
        "errors",
        "failures",
        "entries",
        "blockers_to_on_chip_os_boot",
        "blockers_to_minimum_linux_npu_target",
    ):
        values = data.get(key, [])
        if isinstance(values, list):
            for value in values:
                kind = detail_kind_for_key(key)
                if isinstance(value, dict):
                    entries.append(dict_entry(source, kind, value))
                else:
                    entry = string_entry(source, kind, value)
                    if entry:
                        entries.append(entry)
    if not entries and status_is_nonpass(data.get("status")):
        gate_entry = gate_status_entry(source, data)
        if gate_entry:
            entries.append(gate_entry)
            return entries
        reason = data.get("reason") or data.get("summary") or data.get("status")
        entry = string_entry(source, "report_status", str(reason))
        if entry:
            entries.append(entry)
    return entries


def report_paths(report_dir: Path, aggregate: Path, explicit: Iterable[str]) -> list[Path]:
    if explicit:
        return [Path(path) for path in explicit]
    paths = sorted(report_dir.glob("*.json"))
    skipped = {
        aggregate.resolve(),
        REPORT.resolve(),
        FALLBACK_AGGREGATE.resolve(),
    }
    return [
        path
        for path in paths
        if path.resolve() not in skipped and path.name not in SURVEY_ONLY_REPORT_NAMES
    ]


def build_inventory(args: argparse.Namespace) -> tuple[dict[str, Any], int]:
    report: dict[str, Any]
    aggregate = aggregate_path(args.aggregate)
    missing = [path for path in (aggregate, Path(args.report_dir)) if not path.exists()]
    if missing:
        report = {
            "schema": SCHEMA,
            "status": "blocked",
            "claim_boundary": CLAIM_BOUNDARY,
            "summary": {
                "nonpassing_aggregate_gates": 0,
                "blocked_aggregate_gates": 0,
                "failed_aggregate_gates": 0,
                "uncovered_nonpassing_gates": 0,
                "nonpassing_reports_without_structured_details": 0,
                "detailed_blocker_entries": 0,
                "unique_detailed_blocker_codes": 0,
            },
            "sources": {"missing": [rel(path) for path in missing]},
            "nonpassing_aggregate_gates": [],
            "aggregate_gate_detail_coverage": [],
            "uncovered_nonpassing_gates": [],
            "nonpassing_reports_without_structured_details": [],
            "detailed_blockers": [],
            "detailed_blocker_codes": [],
        }
        return report, 2

    aggregate_data = read_json(aggregate)
    gates = collect_aggregate_gates(aggregate_data)
    specs = gate_specs_by_name()
    for gate in gates:
        spec = specs.get(str(gate.get("name")))
        if spec:
            gate["source_script"] = spec.get("script")
            gate["args"] = spec.get("args", [])
            gate["module"] = spec.get("module")
            gate["expected_report_candidates"] = expected_report_candidates(
                spec.get("script"), gate.get("name")
            )
    entries: list[dict[str, Any]] = []
    sources: list[str] = []
    report_statuses: dict[str, object] = {}
    report_mtimes: dict[str, float] = {}
    aggregate_mtime = aggregate.stat().st_mtime if aggregate.is_file() else 0.0
    shallow_detail_reports: list[dict[str, Any]] = []
    for path in report_paths(Path(args.report_dir), aggregate, args.finding_report):
        if not path.is_file():
            entries.append(
                {
                    "source_report": rel(path),
                    "kind": "missing_report",
                    "code": "missing_report",
                    "severity": "blocker",
                    "message": "expected detailed report is missing",
                    "evidence": rel(path),
                    "next_step": "Regenerate the missing report before treating the inventory as complete.",
                }
            )
            continue
        try:
            data = read_json(path)
        except (OSError, json.JSONDecodeError) as exc:
            entries.append(
                {
                    "source_report": rel(path),
                    "kind": "invalid_report",
                    "code": "invalid_report_json",
                    "severity": "blocker",
                    "message": f"report could not be parsed: {exc}",
                    "evidence": rel(path),
                    "next_step": "Fix or regenerate the invalid report.",
                }
            )
            continue
        source_rel = rel(path)
        report_statuses[source_rel] = data.get("status", "aggregate")
        report_mtimes[source_rel] = path.stat().st_mtime
        if status_is_nonpass(data.get("status")) and not has_structured_detail_rows(data):
            shallow_detail_reports.append(
                {
                    "source_report": rel(path),
                    "status": data.get("status"),
                    "summary_keys": sorted(data.get("summary", {}).keys())
                    if isinstance(data.get("summary"), dict)
                    else [],
                    "reason": data.get("reason"),
                }
            )
            entries.append(unstructured_nonpass_entry(path, data))
        report_entries = collect_report_entries(path, data)
        if report_entries:
            sources.append(rel(path))
            entries.extend(report_entries)

    gate_detail_coverage: list[dict[str, Any]] = []
    uncovered_gates: list[dict[str, Any]] = []
    for gate in gates:
        matches = matched_reports_for_gate(gate, report_statuses)
        matching_blocker_reports = sorted(
            {
                str(entry.get("source_report"))
                for entry in entries
                if str(entry.get("source_report")) in matches
            }
        )
        matching_current_pass_reports = [
            source
            for source in matches
            if source not in matching_blocker_reports
            and not status_is_nonpass(report_statuses[source])
            and report_mtimes.get(source, 0.0) > aggregate_mtime
        ]
        mismatched_reports = [
            source
            for source in matches
            if source not in matching_blocker_reports
            and not status_is_nonpass(report_statuses[source])
            and source not in matching_current_pass_reports
        ]
        matching_aggregate_blockers: list[str] = []
        if not matches:
            aggregate_entry = aggregate_gate_entry(gate)
            entries.append(aggregate_entry)
            matching_aggregate_blockers.append(str(aggregate_entry["code"]))
        coverage = {
            "name": gate.get("name"),
            "status": gate.get("status"),
            "source_script": gate.get("source_script"),
            "args": gate.get("args", []),
            "expected_report_candidates": gate.get("expected_report_candidates", []),
            "matched_detail_reports": matches,
            "matching_blocker_reports": matching_blocker_reports,
            "matching_aggregate_blockers": matching_aggregate_blockers,
            "matching_current_pass_reports": matching_current_pass_reports,
            "mismatched_detail_reports": mismatched_reports,
            "has_detailed_report": bool(matching_blocker_reports or matching_current_pass_reports),
            "has_structured_blocker": bool(
                matching_blocker_reports
                or matching_current_pass_reports
                or matching_aggregate_blockers
            ),
        }
        gate_detail_coverage.append(coverage)
        for source in matching_current_pass_reports:
            entries.append(stale_aggregate_entry(gate, source, report_statuses[source]))
        for source in mismatched_reports:
            entries.append(report_mismatch_entry(gate, source, report_statuses[source]))
        if not coverage["has_structured_blocker"]:
            uncovered_gates.append(coverage)

    codes = sorted({str(entry["code"]) for entry in entries})
    blocked_gates = [gate for gate in gates if gate["status"] == "BLOCKED"]
    failed_gates = [gate for gate in gates if gate["status"] == "FAIL"]
    status = "pass" if not gates and not entries else "blocked"
    report = {
        "schema": SCHEMA,
        "status": status,
        "claim_boundary": CLAIM_BOUNDARY,
        "summary": {
            "nonpassing_aggregate_gates": len(gates),
            "blocked_aggregate_gates": len(blocked_gates),
            "failed_aggregate_gates": len(failed_gates),
            "uncovered_nonpassing_gates": len(uncovered_gates),
            "nonpassing_reports_without_structured_details": len(shallow_detail_reports),
            "detailed_blocker_entries": len(entries),
            "unique_detailed_blocker_codes": len(codes),
        },
        "sources": {
            "aggregate": rel(aggregate),
            "report_dir": rel(Path(args.report_dir)),
            "detailed_reports_with_blockers": sorted(sources),
        },
        "nonpassing_aggregate_gates": gates,
        "aggregate_gate_detail_coverage": sorted(
            gate_detail_coverage,
            key=lambda row: (str(row["status"]), str(row["name"])),
        ),
        "uncovered_nonpassing_gates": sorted(
            uncovered_gates,
            key=lambda row: (str(row["status"]), str(row["name"])),
        ),
        "nonpassing_reports_without_structured_details": sorted(
            shallow_detail_reports,
            key=lambda row: str(row["source_report"]),
        ),
        "detailed_blockers": sorted(
            entries,
            key=lambda entry: (str(entry["source_report"]), str(entry["code"])),
        ),
        "detailed_blocker_codes": codes,
    }
    return report, 0


def write_report(report: dict[str, Any], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def parse_args(argv: Iterable[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--aggregate", help="aggregate report path")
    parser.add_argument("--report-dir", default=str(REPORT_DIR), help="directory of JSON reports")
    parser.add_argument("--report", default=str(REPORT), help="inventory output path")
    parser.add_argument(
        "--finding-report",
        action="append",
        default=[],
        help="explicit detailed report to include; may be passed more than once",
    )
    parser.add_argument("--json-only", action="store_true")
    return parser.parse_args(list(argv))


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    report, exit_code = build_inventory(args)
    write_report(report, Path(args.report))
    if not args.json_only:
        summary = report["summary"]
        print(
            "STATUS: "
            f"{str(report['status']).upper()} chip_os_boot_gap_inventory "
            f"nonpassing_gates={summary['nonpassing_aggregate_gates']} "
            f"blocked_gates={summary['blocked_aggregate_gates']} "
            f"failed_gates={summary['failed_aggregate_gates']} "
            f"uncovered_gates={summary['uncovered_nonpassing_gates']} "
            f"unstructured_reports={summary['nonpassing_reports_without_structured_details']} "
            f"blocker_entries={summary['detailed_blocker_entries']} "
            f"blocker_codes={summary['unique_detailed_blocker_codes']} "
            f"report={rel(Path(args.report))}"
        )
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
