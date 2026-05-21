#!/usr/bin/env python3
"""Validate advisory OpenROAD/OpenLane ML snapshot capture reports."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REPORT = ROOT / "build/ai_eda/pd_predictor_dataset/validation/snapshot_manifest.json"
EXPECTED_MANIFEST_SCHEMA = "eliza.ai_eda.pd_predictor.snapshot_manifest.v1"
EXPECTED_LABEL_SCHEMA = "eliza.ai_eda.pd_predictor.label_report.v1"
CLAIM_BOUNDARY = "predictor_dataset_advisory_only_not_signoff_or_release_evidence"


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def repo_path(value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else ROOT / path


def load_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{rel(path)}: expected JSON object")
    return data


def validate_manifest(manifest: dict[str, Any], manifest_path: Path) -> list[str]:
    errors: list[str] = []
    if manifest.get("schema") != EXPECTED_MANIFEST_SCHEMA:
        errors.append("manifest schema mismatch")
    if manifest.get("claim_boundary") != CLAIM_BOUNDARY:
        errors.append("manifest claim_boundary mismatch")
    if manifest.get("status") not in {"OPENLANE_RUN_FOUND", "NO_OPENLANE_RUN_FOUND"}:
        errors.append(f"unexpected manifest status {manifest.get('status')!r}")
    run_path = manifest.get("source_run")
    if manifest.get("status") == "OPENLANE_RUN_FOUND":
        if not isinstance(run_path, str) or not repo_path(run_path).is_dir():
            errors.append("OPENLANE_RUN_FOUND requires an existing source_run directory")
    elif run_path is not None:
        errors.append("NO_OPENLANE_RUN_FOUND must not set source_run")

    tool_versions = manifest.get("tool_versions")
    if not isinstance(tool_versions, dict) or not isinstance(tool_versions.get("python"), str):
        errors.append("tool_versions.python must be present")
    split_policy = manifest.get("split_policy")
    if not isinstance(split_policy, dict):
        errors.append("split_policy must be a mapping")
    else:
        if split_policy.get("predictor_outputs_advisory_only") is not True:
            errors.append("split_policy.predictor_outputs_advisory_only must be true")
        if split_policy.get("holdout_ready") is not False:
            errors.append("split_policy.holdout_ready must be false until repeated runs exist")
        if not isinstance(split_policy.get("minimum_runs_before_training"), int):
            errors.append("split_policy.minimum_runs_before_training must be an integer")

    artifacts = manifest.get("artifacts")
    if manifest.get("status") == "OPENLANE_RUN_FOUND":
        if not isinstance(artifacts, list) or not artifacts:
            errors.append("OPENLANE_RUN_FOUND requires artifact inventory")
        else:
            for artifact in artifacts:
                if not isinstance(artifact, dict):
                    errors.append("artifact entries must be mappings")
                    continue
                if artifact.get("status") not in {"PRESENT", "MISSING"}:
                    errors.append(f"{artifact.get('name')}: artifact status invalid")
                if artifact.get("status") == "PRESENT":
                    path_value = artifact.get("path")
                    if not isinstance(path_value, str) or not repo_path(path_value).is_file():
                        errors.append(f"{artifact.get('name')}: present artifact path missing")
                    if not isinstance(artifact.get("sha256"), str) or len(artifact["sha256"]) != 64:
                        errors.append(f"{artifact.get('name')}: present artifact needs sha256")
    elif artifacts != []:
        errors.append("NO_OPENLANE_RUN_FOUND must have empty artifacts")

    label_path = manifest_path.parent / "label_report.json"
    if not label_path.is_file():
        errors.append(f"missing label report {rel(label_path)}")
        return errors
    labels = load_json(label_path)
    if labels.get("schema") != EXPECTED_LABEL_SCHEMA:
        errors.append("label report schema mismatch")
    if labels.get("claim_boundary") != CLAIM_BOUNDARY:
        errors.append("label report claim_boundary mismatch")
    if labels.get("signoff_claim_allowed") is not False:
        errors.append("label report signoff_claim_allowed must be false")
    if labels.get("status") != "DRY_RUN_LABEL_CAPTURE":
        errors.append("label report status must be DRY_RUN_LABEL_CAPTURE")
    label_values = labels.get("labels")
    if not isinstance(label_values, dict):
        errors.append("label report labels must be a mapping")
    else:
        for key in ("timing", "power", "congestion", "drc"):
            if key not in label_values:
                errors.append(f"label report missing {key}")
    blockers = labels.get("blocked_by")
    if not isinstance(blockers, list) or len(blockers) < 3:
        errors.append("label report must list concrete blockers")
    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report_path = repo_path(str(args.report))
    if not report_path.is_file():
        print(f"STATUS: FAIL ai_eda.openroad_ml_snapshot missing_report {rel(report_path)}")
        return 1
    try:
        manifest = load_json(report_path)
        errors = validate_manifest(manifest, report_path)
    except Exception as exc:  # noqa: BLE001
        print(f"STATUS: FAIL ai_eda.openroad_ml_snapshot {exc}")
        return 1
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.openroad_ml_snapshot {error}")
        return 1
    print(
        "STATUS: PASS ai_eda.openroad_ml_snapshot "
        f"status={manifest['status']} report={rel(report_path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
