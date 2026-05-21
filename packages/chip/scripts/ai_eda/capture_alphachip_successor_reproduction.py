#!/usr/bin/env python3
"""Capture AlphaChip-successor reproduction evidence.

This is a strict evidence manifest, not a training runner. It only records
whether an already executed successor route is strong enough to stand in for
AlphaChip reproduction: CUDA training, CUDA inference, full-matrix coverage,
hash-pinned model/metrics/candidates, and replay comparison evidence.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/alphachip_successor_reproduction"
SCHEMA = "eliza.ai_eda.alphachip_successor_reproduction.v1"
CLAIM_BOUNDARY = "alphachip_successor_reproduction_evidence_only_no_release_claim"
TRAINING_SCHEMA = "eliza.ai_eda.macro_placement_torch_regressor_training_run.v1"
INFERENCE_SCHEMA = "eliza.ai_eda.macro_placement_torch_inference_run.v1"
REPLAY_QUEUE_SCHEMA = "eliza.ai_eda.macro_placement_replay_queue.v1"
FULL_MATRIX_SCHEMA = "eliza.ai_eda.cuda_full_training_matrix.v1"
REPLAY_COMPARISON_SCHEMA = "eliza.ai_eda.openlane_replay_comparison.v1"
MIN_CUDA_EPOCHS = 200


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def repo_path(value: str | None) -> Path | None:
    if not value:
        return None
    path = Path(value)
    return path if path.is_absolute() else ROOT / path


def sha256_file(path: Path) -> str | None:
    if not path.is_file():
        return None
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{rel(path)}: expected JSON object")
    return data


def artifact(path: Path | None) -> dict[str, Any]:
    if path is None:
        return {"path": None, "status": "MISSING", "sha256": None, "size_bytes": None}
    return {
        "path": rel(path),
        "status": "PRESENT" if path.is_file() else "MISSING",
        "sha256": sha256_file(path),
        "size_bytes": path.stat().st_size if path.is_file() else None,
    }


def all_full_dataset_modes(matrix: dict[str, Any] | None) -> bool:
    if not isinstance(matrix, dict):
        return False
    modes = matrix.get("full_dataset_conversion_modes")
    return isinstance(modes, dict) and bool(modes) and all(value is True for value in modes.values())


def queue_ready_count(queue: dict[str, Any] | None) -> int:
    if not isinstance(queue, dict):
        return 0
    ready_count = queue.get("ready_count")
    if isinstance(ready_count, int):
        return ready_count
    items = queue.get("queue")
    if not isinstance(items, list):
        return 0
    return sum(1 for item in items if isinstance(item, dict) and item.get("ready_for_execution") is True)


def candidate_artifacts(inference: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not isinstance(inference, dict):
        return []
    candidates = inference.get("candidates")
    if not isinstance(candidates, list):
        return []
    items: list[dict[str, Any]] = []
    for candidate in candidates[:25]:
        if not isinstance(candidate, dict):
            continue
        path = repo_path(candidate.get("path") if isinstance(candidate.get("path"), str) else None)
        row = artifact(path)
        row["candidate_id"] = candidate.get("id")
        items.append(row)
    return items


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default="validation")
    parser.add_argument(
        "--training-handoff-run-id",
        default=None,
        help="Torch training/inference/replay evidence run id; defaults to '<run-id>-training-handoff'.",
    )
    parser.add_argument(
        "--full-training-matrix-run-id",
        default=None,
        help="Full CUDA training matrix run id; defaults to --run-id.",
    )
    parser.add_argument(
        "--replay-comparison-run-id",
        default=None,
        help="OpenLane replay comparison run id; defaults to --run-id.",
    )
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    training_handoff_run_id = args.training_handoff_run_id or f"{args.run_id}-training-handoff"
    full_training_matrix_run_id = args.full_training_matrix_run_id or args.run_id
    replay_comparison_run_id = args.replay_comparison_run_id or args.run_id

    training_path = (
        ROOT
        / f"build/ai_eda/macro_placement_torch_regressor/{training_handoff_run_id}/torch_training_run.json"
    )
    inference_path = (
        ROOT
        / f"build/ai_eda/macro_placement_torch_inference/{training_handoff_run_id}/torch_inference_run.json"
    )
    replay_queue_path = (
        ROOT / f"build/ai_eda/macro_placement_replay_queue/{training_handoff_run_id}/replay_queue.json"
    )
    full_matrix_path = (
        ROOT
        / f"build/ai_eda/cuda_full_training_matrix/{full_training_matrix_run_id}/cuda_full_training_matrix.json"
    )
    replay_comparison_path = (
        ROOT
        / f"build/ai_eda/openlane_replay_comparison/{replay_comparison_run_id}/openlane_replay_comparison.json"
    )

    training = load_json(training_path)
    inference = load_json(inference_path)
    replay_queue = load_json(replay_queue_path)
    full_matrix = load_json(full_matrix_path)
    replay_comparison = load_json(replay_comparison_path)

    model_path = repo_path(training.get("model") if isinstance(training, dict) else None)
    metrics_path = repo_path(training.get("metrics") if isinstance(training, dict) else None)
    candidate_hashes = candidate_artifacts(inference)

    blockers: list[str] = []
    if not training or training.get("schema") != TRAINING_SCHEMA:
        blockers.append("successor torch training report is missing or has wrong schema")
    else:
        if training.get("device") != "cuda":
            blockers.append(f"successor training was not run on CUDA: device={training.get('device')}")
        if int(training.get("epochs", 0)) < MIN_CUDA_EPOCHS:
            blockers.append(
                f"successor training epochs below CUDA-scale threshold: epochs={training.get('epochs')}"
            )
        for field in ("train_sample_count", "val_sample_count", "test_sample_count"):
            if int(training.get(field, 0)) <= 0:
                blockers.append(f"successor training {field} is empty")
        if model_path is None or not model_path.is_file():
            blockers.append("successor trained model artifact is missing")
        if metrics_path is None or not metrics_path.is_file():
            blockers.append("successor metrics artifact is missing")

    if not inference or inference.get("schema") != INFERENCE_SCHEMA:
        blockers.append("successor torch inference report is missing or has wrong schema")
    else:
        if inference.get("device") != "cuda":
            blockers.append(f"successor inference was not run on CUDA: device={inference.get('device')}")
        if int(inference.get("candidate_count", 0)) <= 0:
            blockers.append("successor inference produced no candidates")
        if candidate_hashes and any(item.get("status") != "PRESENT" for item in candidate_hashes):
            blockers.append("one or more successor candidate manifests are missing")

    ready_count = queue_ready_count(replay_queue)
    if not replay_queue or replay_queue.get("schema") != REPLAY_QUEUE_SCHEMA:
        blockers.append("successor replay queue is missing or has wrong schema")
    else:
        if int(replay_queue.get("queue_count", 0)) <= 0:
            blockers.append("successor replay queue is empty")
        if ready_count <= 0:
            blockers.append("successor replay queue has no ready OpenLane/OpenROAD item")

    if not full_matrix or full_matrix.get("schema") != FULL_MATRIX_SCHEMA:
        blockers.append("full CUDA training matrix is missing or has wrong schema")
    else:
        if not all_full_dataset_modes(full_matrix):
            blockers.append("full CUDA training matrix lacks all full-dataset conversion modes")
        if full_matrix.get("status") != "MATRIX_READY_FOR_CUDA_HOST":
            blockers.append(f"full CUDA training matrix is not ready: status={full_matrix.get('status')}")

    if not replay_comparison or replay_comparison.get("schema") != REPLAY_COMPARISON_SCHEMA:
        blockers.append("OpenLane replay comparison evidence is missing or has wrong schema")
    else:
        if replay_comparison.get("status") != "COMPARISON_READY":
            blockers.append(f"OpenLane replay comparison is not ready: status={replay_comparison.get('status')}")
        if replay_comparison.get("optimization_claim_allowed") is not True:
            blockers.append("OpenLane replay comparison does not allow an optimization claim")

    status = "SUCCESSOR_REPRODUCTION_READY" if not blockers else "BLOCKED_REPRODUCTION_EVIDENCE"
    report = {
        "schema": SCHEMA,
        "created_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "release_use_allowed": False,
        "optimization_claim_allowed": status == "SUCCESSOR_REPRODUCTION_READY",
        "reproduction_claim_allowed": status == "SUCCESSOR_REPRODUCTION_READY",
        "status": status,
        "minimum_cuda_epochs": MIN_CUDA_EPOCHS,
        "evidence_run_ids": {
            "training_handoff": training_handoff_run_id,
            "full_training_matrix": full_training_matrix_run_id,
            "replay_comparison": replay_comparison_run_id,
        },
        "observed": {
            "training_device": training.get("device") if isinstance(training, dict) else None,
            "training_epochs": training.get("epochs") if isinstance(training, dict) else None,
            "train_sample_count": training.get("train_sample_count") if isinstance(training, dict) else None,
            "val_sample_count": training.get("val_sample_count") if isinstance(training, dict) else None,
            "test_sample_count": training.get("test_sample_count") if isinstance(training, dict) else None,
            "inference_device": inference.get("device") if isinstance(inference, dict) else None,
            "candidate_count": inference.get("candidate_count") if isinstance(inference, dict) else None,
            "replay_queue_count": replay_queue.get("queue_count") if isinstance(replay_queue, dict) else None,
            "replay_queue_ready_count": ready_count,
            "full_training_matrix_status": full_matrix.get("status") if isinstance(full_matrix, dict) else None,
            "full_dataset_conversion_modes": full_matrix.get("full_dataset_conversion_modes")
            if isinstance(full_matrix, dict)
            else None,
            "replay_comparison_status": replay_comparison.get("status")
            if isinstance(replay_comparison, dict)
            else None,
        },
        "input_artifacts": {
            "torch_training": artifact(training_path),
            "torch_inference": artifact(inference_path),
            "trained_model": artifact(model_path),
            "training_metrics": artifact(metrics_path),
            "replay_queue": artifact(replay_queue_path),
            "full_training_matrix": artifact(full_matrix_path),
            "replay_comparison": artifact(replay_comparison_path),
            "candidate_manifests": candidate_hashes,
        },
        "blockers": blockers,
        "next_required_gates": [
            "run successor training on a CUDA host for at least 200 epochs over the full selected corpus",
            "run successor inference on CUDA and archive candidate hashes",
            "produce at least one ready deterministic OpenLane/OpenROAD replay queue item",
            "compare replayed baseline and candidate metrics before claiming optimization",
        ],
    }
    out_dir = args.out_root / args.run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "alphachip_successor_reproduction.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(
        "STATUS: PASS ai_eda.alphachip_successor_reproduction "
        f"status={status} blockers={len(blockers)} {rel(path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
