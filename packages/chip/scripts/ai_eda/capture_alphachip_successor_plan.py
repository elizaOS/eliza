#!/usr/bin/env python3
"""Capture the AlphaChip-successor fallback training plan.

The public AlphaChip checkpoint and placement-cost binary remain externally
blocked. This manifest records the reproducible fallback route that is actually
available to this repo: normalized public corpora, a trainable PyTorch
macro-placement policy, replay-queued candidates, and an optional Circuit
Training scratch lane if `plc_wrapper_main` is supplied.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/alphachip_successor_plan"
SCHEMA = "eliza.ai_eda.alphachip_successor_plan.v1"
CLAIM_BOUNDARY = "alphachip_successor_plan_only_no_checkpoint_reproduction_or_release_claim"
FALSE_CLAIM_FLAGS = {
    "release_use_allowed": False,
    "completion_claim_allowed": False,
}


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def sha256_file(path: Path) -> str | None:
    if not path.is_file():
        return None
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def artifact(path: Path) -> dict[str, Any]:
    return {
        "path": rel(path),
        "status": "PRESENT" if path.is_file() else "MISSING",
        "sha256": sha256_file(path),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default="validation")
    parser.add_argument(
        "--training-corpus-run-id",
        default=None,
        help="Training corpus manifest run id; defaults to --run-id.",
    )
    parser.add_argument(
        "--training-handoff-run-id",
        default=None,
        help="Torch training/inference/replay evidence run id; defaults to --run-id.",
    )
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    training_corpus_run_id = args.training_corpus_run_id or args.run_id
    training_handoff_run_id = args.training_handoff_run_id or args.run_id
    evidence = {
        "checkpoint_blocker_doc": ROOT / "docs/toolchain/alphachip-checkpoint-blocker.md",
        "checkpoint_pin_manifest": ROOT / "external/circuit_training/pin-manifest.json",
        "training_corpus_manifest": ROOT
        / f"build/ai_eda/training_corpus_manifest/{training_corpus_run_id}/training_corpus_manifest.json",
        "torch_training": ROOT
        / f"build/ai_eda/macro_placement_torch_regressor/{training_handoff_run_id}/torch_training_run.json",
        "torch_inference": ROOT
        / f"build/ai_eda/macro_placement_torch_inference/{training_handoff_run_id}/torch_inference_run.json",
        "full_replay_plan": ROOT
        / f"build/ai_eda/macro_placement_full_replay/{training_handoff_run_id}/replay_plan.json",
        "replay_queue": ROOT
        / f"build/ai_eda/macro_placement_replay_queue/{training_handoff_run_id}/replay_queue.json",
        "ct_single_host_train": ROOT / "scripts/alphachip/ct_single_host_train.sh",
        "ct_e1_softmacro_train": ROOT / "scripts/alphachip/run_e1_softmacro_training.sh",
        "torch_train_script": ROOT / "scripts/ai_eda/train_macro_placement_torch_regressor.py",
        "torch_infer_script": ROOT / "scripts/ai_eda/infer_macro_placement_torch_regressor.py",
    }
    blockers = []
    if evidence["checkpoint_blocker_doc"].is_file():
        blockers.append("public AlphaChip checkpoint and plc_wrapper_main are still unavailable")
    else:
        blockers.append("AlphaChip blocker document is missing")
    if not evidence["training_corpus_manifest"].is_file():
        blockers.append("selected training corpus manifest is missing")
    if not evidence["torch_training"].is_file() or not evidence["torch_inference"].is_file():
        blockers.append("selected successor torch training/inference evidence is missing")
    if not evidence["replay_queue"].is_file():
        blockers.append("selected replay queue evidence is missing")

    plan = {
        "schema": SCHEMA,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "release_use_allowed": False,
        "completion_claim_allowed": False,
        "false_claim_flags": FALSE_CLAIM_FLAGS,
        "evidence_run_ids": {
            "training_corpus": training_corpus_run_id,
            "training_handoff": training_handoff_run_id,
        },
        "available_successor": {
            "id": "e1_public_corpus_torch_macro_placement_successor",
            "status": "READY_FOR_CUDA_SCALE_TRAINING" if len(blockers) == 1 else "PARTIAL",
            "description": (
                "Train the repo-native PyTorch macro-placement regressor on normalized public "
                "MacroPlacement, ChipBench-D, CircuitNet, iDATA, EDALearn, OpenABC-D, "
                "OpenROAD, fixture, and E1 softmacro records; run inference, candidate "
                "ranking, replay queue selection, then deterministic OpenLane/OpenROAD replay."
            ),
            "required_commands": [
                "python3 scripts/ai_eda/build_training_corpus_manifest.py --run-id <cuda-host>",
                "python3 scripts/ai_eda/build_macro_placement_supervised_dataset.py --run-id <cuda-host>",
                "python3 scripts/ai_eda/train_macro_placement_torch_regressor.py --run-id <cuda-host> --device auto --epochs 200",
                "python3 scripts/ai_eda/infer_macro_placement_torch_regressor.py --run-id <cuda-host> --device auto",
                "python3 scripts/ai_eda/evaluate_macro_placement_candidates.py --run-id <cuda-host> --candidate-dir build/ai_eda/macro_placement_policy/<cuda-host>/candidates --candidate-dir build/ai_eda/macro_placement_supervised_model/<cuda-host>/candidates --candidate-dir build/ai_eda/macro_placement_torch_inference/<cuda-host>/candidates --out-root build/ai_eda/macro_placement_full_candidate_eval",
                "python3 scripts/ai_eda/plan_macro_placement_replay.py --run-id <cuda-host> --candidate-dir build/ai_eda/macro_placement_policy/<cuda-host>/candidates --candidate-dir build/ai_eda/macro_placement_supervised_model/<cuda-host>/candidates --candidate-dir build/ai_eda/macro_placement_torch_inference/<cuda-host>/candidates --out-root build/ai_eda/macro_placement_full_replay",
                "python3 scripts/ai_eda/select_macro_placement_replay_queue.py --run-id <cuda-host>",
                "python3 scripts/ai_eda/capture_openlane_replay_prerequisites.py --run-id <cuda-host>",
            ],
        },
        "conditional_circuit_training_scratch_lane": {
            "id": "google_circuit_training_scratch_if_plc_binary_available",
            "status": "BLOCKED_BY_PLC_WRAPPER_MAIN",
            "required_external_artifact": "plc_wrapper_main",
            "required_commands": [
                "scripts/alphachip/build_container.sh",
                "scripts/alphachip/prepare_e1_softmacro_benchmark.sh",
                "USE_GPU=True scripts/alphachip/run_toy_training.sh",
                "USE_GPU=True scripts/alphachip/run_e1_softmacro_training.sh",
            ],
        },
        "input_artifacts": {name: artifact(path) for name, path in evidence.items()},
        "blockers": blockers,
        "next_required_actions": [
            "run the successor torch route on a CUDA host with the full selected corpus",
            "archive trained model, metrics, candidates, replay queue, and objective readiness audit",
            "only use Circuit Training scratch when plc_wrapper_main is legally supplied and hash-pinned",
            "execute deterministic E1 OpenLane/OpenROAD replay before optimization claims",
        ],
    }
    out_dir = args.out_root / args.run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "alphachip_successor_plan.json"
    path.write_text(json.dumps(plan, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(
        "STATUS: PASS ai_eda.alphachip_successor_plan "
        f"status={plan['available_successor']['status']} blockers={len(blockers)} {rel(path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
