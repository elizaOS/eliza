#!/usr/bin/env python3
"""Run a tiny dependency-free placement training smoke on internal fixtures.

This is a plumbing test, not a useful placement model. It proves that a training
run can consume internal schema fixtures, emit metrics/model artifacts, and
produce a quarantined `eda.e1_candidate.v1` record before CUDA-scale training.
"""

from __future__ import annotations

import argparse
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2]
EXAMPLES_DIR = ROOT / "docs/spec-db/ai-eda/examples"
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/training_runs"
CLAIM_BOUNDARY = "fixture_training_smoke_only_no_placement_quality_or_release_claim"


def load_yaml(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected YAML mapping")
    return data


def find_record(schema: str) -> dict[str, Any]:
    for path in EXAMPLES_DIR.glob("*.yaml"):
        data = load_yaml(path)
        if data.get("schema") == schema:
            return data
    raise SystemExit(f"missing fixture schema: {schema}")


def train_target_coordinate(
    initial_x: float,
    initial_y: float,
    target_x: float,
    target_y: float,
    *,
    steps: int,
    lr: float,
) -> tuple[float, float, list[dict[str, float]]]:
    x = initial_x
    y = initial_y
    trace: list[dict[str, float]] = []
    for step in range(steps):
        dx = x - target_x
        dy = y - target_y
        loss = dx * dx + dy * dy
        trace.append({"step": float(step), "loss": loss, "x_um": x, "y_um": y})
        x -= lr * 2.0 * dx
        y -= lr * 2.0 * dy
    final_loss = (x - target_x) ** 2 + (y - target_y) ** 2
    trace.append({"step": float(steps), "loss": final_loss, "x_um": x, "y_um": y})
    return x, y, trace


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    parser.add_argument("--steps", type=int, default=32)
    parser.add_argument("--learning-rate", type=float, default=0.18)
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--device", choices=("cpu", "mps", "cuda"), default="cpu")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.device != "cpu":
        raise SystemExit("fixture placement smoke is dependency-free and only supports --device cpu")
    placement = find_record("eda.placement_case.v1")
    candidate = find_record("eda.e1_candidate.v1")
    core = placement["floorplan"]["core_area_um"]
    initial_x = (float(core[0]) + float(core[2])) / 2.0
    initial_y = (float(core[1]) + float(core[3])) / 2.0
    move = candidate["proposed_changes"][0]["value"]
    target_x = float(move["x_um"])
    target_y = float(move["y_um"])
    pred_x, pred_y, trace = train_target_coordinate(
        initial_x,
        initial_y,
        target_x,
        target_y,
        steps=args.steps,
        lr=args.learning_rate,
    )
    final_error_um = math.hypot(pred_x - target_x, pred_y - target_y)
    status = "PASS_SMOKE" if final_error_um < 1.0 else "FAIL_DID_NOT_OVERFIT_FIXTURE"

    out_dir = args.out_root / args.run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    model_path = out_dir / "fixture_placement_model.json"
    metrics_path = out_dir / "metrics.json"
    candidate_path = out_dir / "candidate_manifest.json"
    training_path = out_dir / "training_run.json"

    model = {
        "schema": "eliza.ai_eda.fixture_placement_model.v1",
        "claim_boundary": CLAIM_BOUNDARY,
        "model_type": "learned_target_coordinate_smoke",
        "device": args.device,
        "seed": args.seed,
        "parameters": {"x_um": pred_x, "y_um": pred_y},
        "release_use_allowed": False,
    }
    model_path.write_text(json.dumps(model, indent=2, sort_keys=True) + "\n")

    metrics = {
        "schema": "eliza.ai_eda.fixture_training_metrics.v1",
        "claim_boundary": CLAIM_BOUNDARY,
        "status": status,
        "initial_error_um": math.hypot(initial_x - target_x, initial_y - target_y),
        "final_error_um": final_error_um,
        "steps": args.steps,
        "learning_rate": args.learning_rate,
        "loss_trace_tail": trace[-5:],
        "release_use_allowed": False,
    }
    metrics_path.write_text(json.dumps(metrics, indent=2, sort_keys=True) + "\n")

    generated_candidate = {
        "schema": "eda.e1_candidate.v1",
        "id": f"fixture-placement-smoke-{args.run_id}",
        "candidate_type": "macro_placement",
        "design_bundle_id": placement["design_bundle_id"],
        "claim_boundary": CLAIM_BOUNDARY,
        "generated_by": {
            "source": "scripts/ai_eda/train_fixture_placement_smoke.py",
            "model_or_tool": str(model_path.relative_to(ROOT)),
        },
        "proposed_changes": [
            {
                "target": "placement.npu_softmacro",
                "action": "move",
                "value": {"x_um": round(pred_x, 6), "y_um": round(pred_y, 6)},
            }
        ],
        "validation_ladder": {
            "required_gates": [
                "schema_validation",
                "deterministic_openroad_replay",
                "timing_check",
                "drc_check",
                "human_review",
            ],
            "completed_gates": ["fixture_training_smoke"],
        },
        "decision": {
            "status": "replayed_blocked",
            "reason": "fixture smoke candidate requires deterministic OpenROAD replay and human review",
        },
    }
    candidate_path.write_text(json.dumps(generated_candidate, indent=2, sort_keys=True) + "\n")

    training = {
        "schema": "eliza.ai_eda.fixture_training_run.v1",
        "created_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "status": status,
        "inputs": {
            "placement_case": "docs/spec-db/ai-eda/examples/e1-placement-case.example.yaml",
            "target_candidate": "docs/spec-db/ai-eda/examples/e1-candidate.example.yaml",
        },
        "outputs": {
            "model": str(model_path.relative_to(ROOT)),
            "metrics": str(metrics_path.relative_to(ROOT)),
            "candidate_manifest": str(candidate_path.relative_to(ROOT)),
        },
        "release_use_allowed": False,
    }
    training_path.write_text(json.dumps(training, indent=2, sort_keys=True) + "\n")

    print(f"STATUS: {status} ai_eda.fixture_placement_training {training_path}")
    return 0 if status == "PASS_SMOKE" else 1


if __name__ == "__main__":
    raise SystemExit(main())
