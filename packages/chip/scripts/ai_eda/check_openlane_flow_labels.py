#!/usr/bin/env python3
"""Validate normalized OpenLane flow-label records and their claim boundary."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REPORT = ROOT / "build/ai_eda/openlane_flow_labels/validation/label-parse-report.json"
CLAIM_BOUNDARY = "openlane_metric_parse_only_no_training_inference_signoff_or_release_claim"
FIXTURE_STATUS = "fixture_metrics_parser_smoke_no_ppa_claim"
REAL_STATUS = "deterministic_openlane_metrics_unreviewed"
BLOCKED_STATUS = "blocked_missing_required_openlane_metrics"


def rel(path: Path) -> str:
    return str(path.relative_to(ROOT))


def load_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{rel(path)}: expected JSON object")
    return data


def resolve_repo_path(value: Any, label: str) -> tuple[Path | None, list[str]]:
    if not isinstance(value, str) or not value:
        return None, [f"{label}: missing path"]
    path = (ROOT / value).resolve()
    if not path.is_file():
        return path, [f"{label}: missing file {value}"]
    return path, []


def validate(report_path: Path) -> list[str]:
    errors: list[str] = []
    report = load_json(report_path)
    if report.get("schema") != "eliza.ai_eda.openlane_flow_label_parse_report.v1":
        errors.append("report schema is not eliza.ai_eda.openlane_flow_label_parse_report.v1")
    if report.get("claim_boundary") != CLAIM_BOUNDARY:
        errors.append("report claim_boundary is missing or incorrect")
    if report.get("release_use_allowed") is not False:
        errors.append("report must set release_use_allowed=false")

    flow_path, path_errors = resolve_repo_path(report.get("flow_run_record"), "flow_run_record")
    errors.extend(path_errors)
    metrics_path, path_errors = resolve_repo_path(report.get("metrics_json"), "metrics_json")
    errors.extend(path_errors)
    if flow_path is None or metrics_path is None:
        return errors

    flow = load_json(flow_path)
    if flow.get("schema") != "eda.flow_run.v1":
        errors.append("flow record schema is not eda.flow_run.v1")
    if flow.get("claim_boundary") != CLAIM_BOUNDARY:
        errors.append("flow record claim_boundary is missing or incorrect")

    metrics = flow.get("metrics")
    if not isinstance(metrics, dict):
        errors.append("flow record metrics must be an object")
        return errors

    status = report.get("label_status")
    if status not in {FIXTURE_STATUS, REAL_STATUS, BLOCKED_STATUS}:
        errors.append(f"unexpected label_status {status!r}")
    if metrics.get("label_status") != status:
        errors.append("flow metrics label_status does not match report")

    source_metrics = metrics.get("source_metrics")
    if source_metrics != report.get("metrics_json"):
        errors.append("flow metrics source_metrics does not match report metrics_json")

    selection_policy = report.get("metrics_selection_policy")
    if metrics.get("selection_policy") != selection_policy:
        errors.append("flow metrics selection_policy does not match report")
    if selection_policy not in {
        "explicit_metrics_json",
        "latest_local_openlane_run",
        "fixture_fallback_no_local_openlane_run",
    }:
        errors.append(f"unexpected metrics_selection_policy {selection_policy!r}")

    deterministic = report.get("deterministic_run_artifacts_present")
    if metrics.get("deterministic_run_artifacts_present") != deterministic:
        errors.append("flow metrics deterministic flag does not match report")
    if not isinstance(deterministic, bool):
        errors.append("deterministic_run_artifacts_present must be boolean")

    metrics_rel = rel(metrics_path)
    if (
        deterministic
        and "pd/openlane/runs/RUN_" not in metrics_rel
        and selection_policy != "explicit_metrics_json"
    ):
        errors.append("deterministic auto-selected metrics must come from pd/openlane/runs/RUN_*")
    if not deterministic:
        if status != FIXTURE_STATUS:
            errors.append("fixture fallback must use fixture_metrics_parser_smoke_no_ppa_claim")
        if selection_policy != "fixture_fallback_no_local_openlane_run":
            errors.append(
                "non-deterministic fallback must record fixture_fallback_no_local_openlane_run"
            )
    if deterministic and status == FIXTURE_STATUS:
        errors.append("deterministic run metrics cannot use fixture label status")

    missing = report.get("missing_required_labels")
    if not isinstance(missing, list):
        errors.append("missing_required_labels must be a list")
    normalized = metrics.get("normalized")
    if not isinstance(normalized, dict):
        errors.append("metrics.normalized must be an object")
    elif normalized.get("missing_required_labels") != missing:
        errors.append("normalized missing_required_labels does not match report")

    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report_path = args.report.resolve()
    if not report_path.is_file():
        print(f"STATUS: FAIL ai_eda.openlane_flow_labels missing_report {report_path}")
        return 1
    try:
        errors = validate(report_path)
    except Exception as exc:  # noqa: BLE001 - keep CLI evidence readable.
        print(f"STATUS: FAIL ai_eda.openlane_flow_labels {exc}")
        return 1
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.openlane_flow_labels {error}")
        return 1
    report = load_json(report_path)
    status = report.get("label_status")
    deterministic = report.get("deterministic_run_artifacts_present")
    print(
        "STATUS: PASS ai_eda.openlane_flow_labels "
        f"status={status} deterministic_run_artifacts_present={deterministic} "
        f"report={rel(report_path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
