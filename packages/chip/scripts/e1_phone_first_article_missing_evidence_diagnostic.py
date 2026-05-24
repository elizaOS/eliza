#!/usr/bin/env python3
"""Generate a fail-closed E1 phone first-article missing evidence diagnostic."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

import yaml


ROOT = Path(__file__).resolve().parents[1]
BOARD = ROOT / "board/kicad/e1-phone"
REPORT_DATE = "2026-05-22"
DEFAULT_MATRIX = (
    BOARD
    / "production/test/readiness/"
    "e1-phone-first-article-bench-acceptance-matrix-2026-05-22.yaml"
)
DEFAULT_REPORT = (
    BOARD
    / "production/test/readiness/"
    f"e1-phone-first-article-missing-evidence-{REPORT_DATE}.yaml"
)


class NoAliasDumper(yaml.SafeDumper):
    def ignore_aliases(self, data: Any) -> bool:
        return True


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def read_yaml(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise SystemExit(f"{rel(path)}: expected YAML mapping")
    return data


def row_path(row: dict[str, Any]) -> str:
    value = row.get("path")
    return str(value) if value else ""


def evidence_entry(row: dict[str, Any]) -> dict[str, Any]:
    current_presence = row.get("current_presence")
    if not isinstance(current_presence, dict):
        current_presence = {}
    return {
        "path": row_path(row),
        "evidence_kind": row.get("evidence_kind"),
        "acceptance_state": row.get("acceptance_state"),
        "current_presence": {
            "present": current_presence.get("present") is True,
            "artifact_kind": current_presence.get("artifact_kind", "unknown"),
        },
        "release_evidence": row.get("release_evidence") is True,
        "template_only": row.get("template_only") is True,
        "next_unblock_action": row.get("next_unblock_action"),
    }


def evidence_packet_for_path(path: str) -> tuple[str, str, int]:
    if path.startswith("board/kicad/e1-phone/production/reports/"):
        return (
            "executed_first_article_bench_logs",
            "Capture executed bench logs on routed first article hardware and bind board serial, fixture ID, limits, operator, measured results, and pass/fail disposition.",
            10,
        )
    if path.startswith("board/kicad/e1-phone/production/test/fixture-quote/"):
        return (
            "fixture_and_probe_quotes",
            "Obtain fixture or flying-probe and RF shield-box quotes against routed probe coordinates and fixture requirements.",
            8,
        )
    if path.startswith("board/kicad/e1-phone/production/stackup/"):
        return (
            "fabricator_stackup_impedance_pack",
            "Archive fabricator-controlled stackup, coupon geometry, and field-solved impedance evidence for the routed board.",
            7,
        )
    if path.startswith("board/kicad/e1-phone/production/fab-quote"):
        return (
            "fabricator_assembler_quote_pack",
            "Archive commercial quote responses from the board fabricator and assembler for the routed release package.",
            6,
        )
    if path.startswith("board/kicad/e1-phone/production/dfm/"):
        return (
            "assembler_dfm_dfa_pack",
            "Archive assembler DFM/DFA and stencil review evidence for the routed assembly package.",
            5,
        )
    if path == "board/kicad/e1-phone/production/first-article":
        return (
            "signed_first_article_traveler",
            "Create the signed first-article traveler with board serial, supplier lots, fixture IDs, measured results, waivers, and owner signoff.",
            9,
        )
    if path == "board/kicad/e1-phone/production/test/factory-test-limits.yaml":
        return (
            "factory_limits_file",
            "Derive stop-on-fail factory limits from routed first-article measurements and archive the signed limits file.",
            9,
        )
    return (
        "other_required_release_evidence",
        "Produce and sign the required production release artifact from routed board, supplier, factory, or first-article evidence.",
        1,
    )


def build_recommended_packets(
    missing_required: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    packets: dict[str, dict[str, Any]] = {}
    for item in missing_required:
        path = str(item.get("path", ""))
        packet_id, next_action, priority = evidence_packet_for_path(path)
        packet = packets.setdefault(
            packet_id,
            {
                "id": packet_id,
                "release_credit": False,
                "priority": priority,
                "missing_path_count": 0,
                "missing_paths": [],
                "next_unblock_action": next_action,
            },
        )
        packet["missing_path_count"] += 1
        packet["missing_paths"].append(path)

    def packet_key(packet: dict[str, Any]) -> tuple[int, int, str]:
        return (
            -int(packet["priority"]),
            -int(packet["missing_path_count"]),
            str(packet["id"]),
        )

    result = sorted(packets.values(), key=packet_key)
    for packet in result:
        packet["missing_paths"] = sorted(packet["missing_paths"])
    return result


def split_rows(matrix: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    rows = matrix.get("acceptance_matrix", [])
    if not isinstance(rows, list):
        raise SystemExit("acceptance_matrix must be a list")

    missing_required = []
    template_only = []
    present_unvalidated = []
    other_blocked = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        state = row.get("acceptance_state")
        if row.get("template_only") is True:
            template_only.append(evidence_entry(row))
        elif state == "blocked_fail_closed_missing_required_evidence":
            missing_required.append(evidence_entry(row))
        elif state == "present_unvalidated_still_fail_closed":
            present_unvalidated.append(evidence_entry(row))
        elif state != "accepted_release_evidence":
            other_blocked.append(evidence_entry(row))

    key = lambda item: str(item.get("path", ""))
    return {
        "missing_required_non_template": sorted(missing_required, key=key),
        "template_only": sorted(template_only, key=key),
        "present_unvalidated": sorted(present_unvalidated, key=key),
        "other_blocked": sorted(other_blocked, key=key),
    }


def build_report(matrix_path: Path, report_path: Path) -> dict[str, Any]:
    matrix = read_yaml(matrix_path)
    split = split_rows(matrix)
    recommended_packets = build_recommended_packets(split["missing_required_non_template"])
    summary = matrix.get("summary")
    if not isinstance(summary, dict):
        summary = {}

    missing_count = len(split["missing_required_non_template"])
    template_count = len(split["template_only"])
    present_count = len(split["present_unvalidated"])
    other_count = len(split["other_blocked"])
    required_count = missing_count + present_count + other_count
    row_count = missing_count + template_count + present_count + other_count

    return {
        "schema": "eliza.e1_phone_first_article_missing_evidence_diagnostic.v1",
        "status": "blocked_fail_closed_diagnostic_only",
        "date": REPORT_DATE,
        "claim_boundary": (
            "Diagnostic-only split of the first-article acceptance matrix into missing "
            "required evidence, template-only rows, and present-but-unvalidated rows. "
            "It is not executed bench evidence, not a first-article pass, not factory "
            "release evidence, and grants no release credit."
        ),
        "inputs": {
            "first_article_bench_acceptance_matrix": rel(matrix_path),
            "report_path": rel(report_path),
        },
        "summary": {
            "release_allowed": False,
            "release_credit": False,
            "matrix_row_count": row_count,
            "template_row_count": template_count,
            "required_non_template_row_count": required_count,
            "present_required_non_template_row_count": present_count,
            "missing_required_non_template_row_count": missing_count,
            "other_blocked_row_count": other_count,
            "recommended_next_evidence_packet_count": len(recommended_packets),
            "highest_leverage_next_packet": (
                recommended_packets[0]["id"] if recommended_packets else None
            ),
            "source_matrix_row_count": summary.get("matrix_row_count"),
            "source_release_state": summary.get("release_state"),
        },
        "fail_closed_policy": {
            "templates_are_release_evidence": False,
            "present_unvalidated_rows_are_release_evidence": False,
            "presence_only_inventory_unlocks_release": False,
            "executed_logs_and_signed_traveler_required": True,
            "release_allowed": False,
        },
        "missing_required_non_template_evidence": split["missing_required_non_template"],
        "recommended_next_evidence_packets": recommended_packets,
        "template_only_evidence": split["template_only"],
        "present_unvalidated_evidence": split["present_unvalidated"],
        "other_blocked_evidence": split["other_blocked"],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--matrix", type=Path, default=DEFAULT_MATRIX)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--write-report", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = build_report(args.matrix, args.report)
    text = yaml.dump(report, Dumper=NoAliasDumper, sort_keys=False, width=100)
    if args.write_report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(text, encoding="utf-8")
    else:
        print(text, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
