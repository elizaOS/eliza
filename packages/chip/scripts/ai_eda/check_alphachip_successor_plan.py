#!/usr/bin/env python3
"""Validate AlphaChip-successor fallback training manifests."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REPORT = (
    ROOT / "build/ai_eda/alphachip_successor_plan/validation/alphachip_successor_plan.json"
)
EXPECTED_SCHEMA = "eliza.ai_eda.alphachip_successor_plan.v1"
EXPECTED_CLAIM_BOUNDARY = "alphachip_successor_plan_only_no_checkpoint_reproduction_or_release_claim"
REQUIRED_TORCH_COMMANDS = {
    "python3 scripts/ai_eda/build_training_corpus_manifest.py --run-id <cuda-host>",
    "python3 scripts/ai_eda/build_macro_placement_supervised_dataset.py --run-id <cuda-host>",
    "python3 scripts/ai_eda/train_macro_placement_torch_regressor.py --run-id <cuda-host> --device auto --epochs 200",
    "python3 scripts/ai_eda/infer_macro_placement_torch_regressor.py --run-id <cuda-host> --device auto",
    "python3 scripts/ai_eda/select_macro_placement_replay_queue.py --run-id <cuda-host>",
    "python3 scripts/ai_eda/capture_openlane_replay_prerequisites.py --run-id <cuda-host>",
}


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def repo_path(value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else ROOT / path


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{rel(path)}: expected JSON object")
    return data


def validate_artifact(label: str, item: Any) -> list[str]:
    if not isinstance(item, dict):
        return [f"{label} must be a mapping"]
    path_value = item.get("path")
    if not isinstance(path_value, str) or not path_value:
        return [f"{label}.path must be present"]
    if item.get("status") not in {"PRESENT", "MISSING"}:
        return [f"{label}.status is invalid"]
    errors: list[str] = []
    if item.get("status") == "PRESENT":
        path = repo_path(path_value)
        if not path.is_file():
            errors.append(f"{label}.path missing on disk")
        elif item.get("sha256") != sha256_file(path):
            errors.append(f"{label}.sha256 is stale")
    return errors


def validate(report: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if report.get("schema") != EXPECTED_SCHEMA:
        errors.append("schema mismatch")
    if report.get("claim_boundary") != EXPECTED_CLAIM_BOUNDARY:
        errors.append("claim_boundary mismatch")
    if report.get("release_use_allowed") is not False:
        errors.append("release_use_allowed must be false")
    if report.get("completion_claim_allowed") is not False:
        errors.append("completion_claim_allowed must be false")
    run_ids = report.get("evidence_run_ids")
    if not isinstance(run_ids, dict):
        errors.append("evidence_run_ids must be a mapping")
    else:
        for field in ("training_corpus", "training_handoff"):
            if not isinstance(run_ids.get(field), str) or not run_ids[field]:
                errors.append(f"evidence_run_ids.{field} must be non-empty")
    successor = report.get("available_successor")
    if not isinstance(successor, dict):
        errors.append("available_successor must be a mapping")
    else:
        if successor.get("id") != "e1_public_corpus_torch_macro_placement_successor":
            errors.append("available_successor.id mismatch")
        if successor.get("status") not in {"READY_FOR_CUDA_SCALE_TRAINING", "PARTIAL"}:
            errors.append("available_successor.status mismatch")
        commands = successor.get("required_commands")
        command_set = set(commands) if isinstance(commands, list) else set()
        missing = sorted(REQUIRED_TORCH_COMMANDS - command_set)
        if missing:
            errors.append(f"available_successor missing commands: {', '.join(missing)}")
    ct = report.get("conditional_circuit_training_scratch_lane")
    if not isinstance(ct, dict):
        errors.append("conditional_circuit_training_scratch_lane must be a mapping")
    elif ct.get("status") != "BLOCKED_BY_PLC_WRAPPER_MAIN":
        errors.append("Circuit Training scratch lane must remain blocked without plc_wrapper_main")
    artifacts = report.get("input_artifacts")
    if not isinstance(artifacts, dict):
        errors.append("input_artifacts must be a mapping")
    else:
        for name in (
            "checkpoint_blocker_doc",
            "checkpoint_pin_manifest",
            "ct_single_host_train",
            "ct_e1_softmacro_train",
            "torch_train_script",
            "torch_infer_script",
        ):
            errors.extend(validate_artifact(name, artifacts.get(name)))
            if isinstance(artifacts.get(name), dict) and artifacts[name].get("status") != "PRESENT":
                errors.append(f"{name} must be present")
    blockers = report.get("blockers")
    if not isinstance(blockers, list) or not blockers:
        errors.append("blockers must record checkpoint/plc and any missing local evidence")
    actions = report.get("next_required_actions")
    if not isinstance(actions, list) or len(actions) < 3:
        errors.append("next_required_actions must be concrete")
    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.report.is_file():
        print(f"STATUS: FAIL ai_eda.alphachip_successor_plan missing_report {rel(args.report)}")
        return 1
    try:
        report = load_json(args.report)
        errors = validate(report)
    except Exception as exc:  # noqa: BLE001
        print(f"STATUS: FAIL ai_eda.alphachip_successor_plan {exc}")
        return 1
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.alphachip_successor_plan {error}")
        return 1
    print(
        "STATUS: PASS ai_eda.alphachip_successor_plan "
        f"status={report['available_successor']['status']} blockers={len(report['blockers'])}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
