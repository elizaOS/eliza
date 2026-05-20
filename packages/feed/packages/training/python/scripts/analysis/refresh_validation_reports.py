#!/usr/bin/env python3
"""
Refresh saved validation_report.json files after validator logic changes.

This is primarily used to:
- repair Action/Reason prefills that were dropped by older inference wrappers
- recompute summaries and pass/fail fields under the current schema
- add primary-vs-auxiliary gate metadata to older reports
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent.parent / "src" / "training"))

from deterministic_eval import (
    ACTION_REASON_ASSISTANT_PREFIX,
    ACTION_REASON_PROMPTS,
    passes_action_reason_gate,
    passes_json_format_gate,
    passes_natural_message_gate,
    score_action_reason_response,
    score_decision_response,
    summarize_action_reason_results,
    summarize_decision_results,
)
from local_inference import restore_assistant_prefix


def action_prompt_specs() -> dict[str, dict[str, Any]]:
    return {str(prompt["id"]): dict(prompt) for prompt in ACTION_REASON_PROMPTS}


def refresh_action_reason_section(section: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    specs = action_prompt_specs()
    refreshed_results: list[dict[str, Any]] = []
    for result in list(section.get("results") or []):
        prompt_id = str(result.get("prompt_id") or "")
        repaired_response = restore_assistant_prefix(
            str(result.get("response") or ""),
            ACTION_REASON_ASSISTANT_PREFIX,
        )
        refreshed_results.append(
            {
                **result,
                "response": repaired_response,
                "score": score_action_reason_response(
                    repaired_response,
                    prompt_spec=specs.get(prompt_id),
                ),
            }
        )
    summary = summarize_action_reason_results(refreshed_results)
    return (
        {
            **section,
            "summary": summary,
            "passed": passes_action_reason_gate(summary),
            "results": refreshed_results,
        },
        passes_action_reason_gate(summary),
    )


def refresh_scam_section(
    section: dict[str, Any],
    *,
    json_gate: bool,
) -> tuple[dict[str, Any], bool]:
    refreshed_results: list[dict[str, Any]] = []
    prompt_specs = {
        str(result.get("prompt_id") or ""): {
            "prompt": result.get("prompt"),
            "expected_safe": result.get("expected_safe"),
            "category": result.get("category"),
        }
        for result in list(section.get("results") or [])
    }
    for result in list(section.get("results") or []):
        prompt_id = str(result.get("prompt_id") or "")
        refreshed_results.append(
            {
                **result,
                "score": score_decision_response(
                    str(result.get("response") or ""),
                    prompt_spec=prompt_specs.get(prompt_id),
                ),
            }
        )
    summary = summarize_decision_results(refreshed_results)
    passed = passes_json_format_gate(summary) if json_gate else passes_natural_message_gate(summary)
    return (
        {
            **section,
            "summary": summary,
            "passed": passed,
            "results": refreshed_results,
        },
        passed,
    )


def refresh_report_payload(report: dict[str, Any]) -> dict[str, Any]:
    refreshed = dict(report)

    action_reason_section, ar_passed = refresh_action_reason_section(
        dict(refreshed.get("action_reason") or {})
    )
    refreshed["action_reason"] = action_reason_section

    natural_section = refreshed.get("natural_message")
    if isinstance(natural_section, dict):
        natural_message_section, natural_passed = refresh_scam_section(
            dict(natural_section),
            json_gate=False,
        )
        refreshed["natural_message"] = natural_message_section
    else:
        natural_message_section = None
        natural_passed = False

    decision_section = refreshed.get("decision_format")
    if isinstance(decision_section, dict):
        decision_format_section, json_passed = refresh_scam_section(
            dict(decision_section),
            json_gate=True,
        )
        refreshed["decision_format"] = decision_format_section
        refreshed["json_format_aux"] = dict(decision_format_section)
    else:
        decision_format_section = None
        json_passed = False

    primary_passed = ar_passed or natural_passed
    primary_components = {
        "action_reason": ar_passed,
        "natural_message": natural_passed,
    }
    if ar_passed and natural_passed:
        primary_label = "pass (action_reason + natural_message)"
    elif ar_passed:
        primary_label = "pass (action_reason)"
    elif natural_passed:
        primary_label = "pass (natural_message)"
    else:
        primary_label = "fail"

    refreshed["validation_schema_version"] = 2
    refreshed["primary_gate"] = {
        "passed": primary_passed,
        "label": primary_label,
        "components": primary_components,
    }
    refreshed["combined_passed"] = primary_passed
    refreshed["passed"] = primary_passed
    refreshed["json_format_aux_passed"] = json_passed
    return refreshed


def iter_validation_reports(paths: list[Path]) -> list[Path]:
    reports: list[Path] = []
    for path in paths:
        resolved = path.resolve()
        if resolved.is_file() and resolved.name == "validation_report.json":
            reports.append(resolved)
            continue
        if resolved.is_dir():
            reports.extend(sorted(resolved.rglob("validation_report.json")))
    deduped: list[Path] = []
    seen: set[Path] = set()
    for path in reports:
        if path not in seen:
            deduped.append(path)
            seen.add(path)
    return deduped


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Refresh saved validation reports.")
    parser.add_argument(
        "paths",
        nargs="+",
        help="Validation report files or directories to scan recursively.",
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    reports = iter_validation_reports([Path(path) for path in args.paths])
    if not reports:
        print("No validation_report.json files found.", file=sys.stderr)
        return 1

    updated = 0
    for report_path in reports:
        payload = json.loads(report_path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            continue
        refreshed = refresh_report_payload(payload)
        report_path.write_text(json.dumps(refreshed, indent=2), encoding="utf-8")
        updated += 1
        print(
            json.dumps(
                {
                    "path": str(report_path),
                    "passed": refreshed.get("passed"),
                    "primary_gate": refreshed.get("primary_gate"),
                    "json_format_aux_passed": refreshed.get("json_format_aux_passed"),
                }
            )
        )

    print(f"Refreshed {updated} validation report(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
