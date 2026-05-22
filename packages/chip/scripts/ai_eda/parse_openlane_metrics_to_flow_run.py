#!/usr/bin/env python3
"""Parse OpenLane final metrics into an internal `eda.flow_run.v1` record."""

from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_BASE_FLOW_RUN = (
    ROOT / "build/ai_eda/e1_openlane_conversion/validation/records/flow-run.json"
)
DEFAULT_METRICS = ROOT / "docs/spec-db/ai-eda/openlane-metrics-fixtures/e1_final_metrics.clean.json"
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/openlane_flow_labels"
OPENLANE_RUNS = ROOT / "pd/openlane/runs"
CLAIM_BOUNDARY = "openlane_metric_parse_only_no_training_inference_signoff_or_release_claim"


METRIC_MAP = {
    "timing_wns_ns": ("timing__setup__wns", "timing__setup__ws"),
    "timing_tns_ns": ("timing__setup__tns",),
    "hold_wns_ns": ("timing__hold__wns", "timing__hold__ws"),
    "hold_tns_ns": ("timing__hold__tns",),
    "die_area_um2": ("design__die__area",),
    "core_area_um2": ("design__core__area",),
    "instance_area_um2": ("design__instance__area",),
    "stdcell_area_um2": ("design__instance__area__stdcell",),
    "instance_count": ("design__instance__count",),
    "stdcell_count": ("design__instance__count__stdcell",),
    "macro_count": ("design__instance__count__macros",),
    "utilization_pct": ("design__instance__utilization",),
    "wirelength_um": ("route__wirelength", "design__wirelength"),
    "route_drc_count": ("route__drc_errors",),
    "magic_drc_count": ("magic__drc_error__count",),
    "klayout_drc_count": ("klayout__drc_error__count",),
    "antenna_violating_nets": ("antenna__violating__nets",),
    "antenna_violating_pins": ("antenna__violating__pins",),
    "design_violation_count": ("design__violations",),
    "max_slew_violation_count": ("design__max_slew_violation__count",),
    "max_cap_violation_count": ("design__max_cap_violation__count",),
    "power_mw": ("power__total",),
    "internal_power_mw": ("power__internal__total",),
    "switching_power_mw": ("power__switching__total",),
    "leakage_power_mw": ("power__leakage__total",),
}


REQUIRED_LABELS = (
    "timing_wns_ns",
    "timing_tns_ns",
    "hold_wns_ns",
    "hold_tns_ns",
    "die_area_um2",
    "instance_area_um2",
    "wirelength_um",
    "route_drc_count",
    "design_violation_count",
)


def rel(path: Path) -> str:
    return str(path.relative_to(ROOT))


def load_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise SystemExit(f"{path}: expected JSON object")
    return data


def first_number(metrics: dict[str, Any], keys: tuple[str, ...]) -> float | int | None:
    for key in keys:
        value = metrics.get(key)
        if isinstance(value, bool):
            continue
        if isinstance(value, (int, float)):
            return value
    return None


def normalized_metrics(metrics: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    labels: dict[str, Any] = {}
    missing: list[str] = []
    for label, source_keys in METRIC_MAP.items():
        value = first_number(metrics, source_keys)
        labels[label] = value
        if value is None and label in REQUIRED_LABELS:
            missing.append(label)
    labels["raw_metric_count"] = len(metrics)
    labels["source_metric_keys"] = sorted(metrics)
    labels["missing_required_labels"] = missing
    return labels, missing


def label_status(metrics_path: Path, missing: list[str]) -> str:
    if missing:
        return "blocked_missing_required_openlane_metrics"
    if is_fixture_metrics(metrics_path):
        return "fixture_metrics_parser_smoke_no_ppa_claim"
    return "deterministic_openlane_metrics_unreviewed"


def discover_metrics_path(explicit: Path | None) -> tuple[Path, str, bool]:
    if explicit is not None:
        return (
            explicit.resolve(),
            "explicit_metrics_json",
            not is_fixture_metrics(explicit.resolve()),
        )
    candidates = sorted(OPENLANE_RUNS.glob("RUN_*/final/metrics.json"))
    if candidates:
        return candidates[-1].resolve(), "latest_local_openlane_run", True
    return DEFAULT_METRICS.resolve(), "fixture_fallback_no_local_openlane_run", False


def is_fixture_metrics(path: Path) -> bool:
    try:
        rel_path = rel(path)
    except ValueError:
        return False
    return "docs/spec-db/ai-eda/openlane-metrics-fixtures" in rel_path


def run_design_name(metrics_path: Path) -> str | None:
    """Read DESIGN_NAME from the run's resolved.json so downstream consumers can
    distinguish which design the parsed metrics belong to (e.g. a macro-less
    smoke top vs the full SoC carrying a hard SRAM macro)."""
    resolved = metrics_path.parent.parent / "resolved.json"
    if not resolved.is_file():
        return None
    data = json.loads(resolved.read_text(encoding="utf-8"))
    name = data.get("DESIGN_NAME")
    return name if isinstance(name, str) else None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-flow-run", type=Path, default=DEFAULT_BASE_FLOW_RUN)
    parser.add_argument(
        "--metrics-json",
        type=Path,
        default=None,
        help="OpenLane final metrics JSON. Defaults to the latest pd/openlane/runs/RUN_*/final/metrics.json, or the checked-in parser fixture if no local run exists.",
    )
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    parser.add_argument("--run-id", default=datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ"))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.base_flow_run.exists():
        raise SystemExit(f"base flow-run record missing: {args.base_flow_run}")
    metrics_path, selection_policy, deterministic_run_artifacts_present = discover_metrics_path(
        args.metrics_json
    )
    if not metrics_path.exists():
        raise SystemExit(f"OpenLane metrics JSON missing: {metrics_path}")
    base = load_json(args.base_flow_run)
    metrics = load_json(metrics_path)
    labels, missing = normalized_metrics(metrics)
    status = label_status(metrics_path, missing)
    flow_run = dict(base)
    flow_run["id"] = f"{base['id']}--metrics-{args.run_id}"
    flow_run["claim_boundary"] = CLAIM_BOUNDARY
    flow_run["metrics"] = {
        "label_status": status,
        "normalized": labels,
        "source_metrics": rel(metrics_path),
        "source_design": run_design_name(metrics_path),
        "macro_count": labels["macro_count"],
        "selection_policy": selection_policy,
        "deterministic_run_artifacts_present": deterministic_run_artifacts_present,
        "required_metrics": list(REQUIRED_LABELS),
    }
    flow_run["outputs"] = {
        **flow_run.get("outputs", {}),
        "reports": sorted(
            set(flow_run.get("outputs", {}).get("reports", []) + [rel(metrics_path)])
        ),
    }
    flow_run["status"] = {
        "result": "BLOCKED_MISSING_REQUIRED_METRICS"
        if missing
        else "PARSED_METRICS_REQUIRES_REPLAY_REVIEW",
        "blockers": [f"missing normalized labels: {', '.join(missing)}"]
        if missing
        else [
            "metrics parsed but still require deterministic run provenance, review, and train/test split assignment"
        ],
    }

    out_dir = args.out_root / args.run_id
    records_dir = out_dir / "records"
    records_dir.mkdir(parents=True, exist_ok=True)
    flow_path = records_dir / "flow-run-with-metrics.json"
    flow_path.write_text(json.dumps(flow_run, indent=2, sort_keys=True) + "\n")
    report = {
        "schema": "eliza.ai_eda.openlane_flow_label_parse_report.v1",
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "release_use_allowed": False,
        "base_flow_run": rel(args.base_flow_run.resolve()),
        "metrics_json": rel(metrics_path),
        "metrics_selection_policy": selection_policy,
        "deterministic_run_artifacts_present": deterministic_run_artifacts_present,
        "flow_run_record": rel(flow_path),
        "label_status": status,
        "missing_required_labels": missing,
        "source_design": run_design_name(metrics_path),
        "macro_count": labels["macro_count"],
    }
    report_path = out_dir / "label-parse-report.json"
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(
        "STATUS: PASS ai_eda.openlane_flow_labels "
        f"design={report['source_design']} macro_count={report['macro_count']} {report_path}"
    )
    return 0 if not missing else 2


if __name__ == "__main__":
    raise SystemExit(main())
