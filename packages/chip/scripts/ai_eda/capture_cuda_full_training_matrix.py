#!/usr/bin/env python3
"""Capture the full CUDA training/evaluation job matrix for AI-EDA.

This manifest is a planning and acceptance contract. It does not run training;
it records every large CUDA-host lane that must execute before large-training
or AlphaChip-successor reproduction can be claimed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/cuda_full_training_matrix"
CLAIM_BOUNDARY = "cuda_full_training_matrix_only_no_training_or_release_claim"
SCHEMA = "eliza.ai_eda.cuda_full_training_matrix.v1"


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


def load_json(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{rel(path)}: expected JSON object")
    return data


def artifact(path: Path) -> dict[str, Any]:
    return {
        "path": rel(path),
        "status": "PRESENT" if path.is_file() else "MISSING",
        "sha256": sha256_file(path),
    }


def has_command(plan: dict[str, Any] | None, needle: str) -> bool:
    commands = plan.get("required_remote_commands") if isinstance(plan, dict) else None
    return isinstance(commands, list) and any(
        isinstance(command, str) and needle in command for command in commands
    )


def has_output(plan: dict[str, Any] | None, expected: str) -> bool:
    outputs = plan.get("expected_outputs") if isinstance(plan, dict) else None
    return isinstance(outputs, list) and expected in outputs


def job(
    job_id: str,
    title: str,
    lane: str,
    command: str,
    required_inputs: list[str],
    expected_outputs: list[str],
    min_gpu_memory_gb: int,
    acceptance_gates: list[str],
) -> dict[str, Any]:
    return {
        "id": job_id,
        "title": title,
        "lane": lane,
        "command": command,
        "required_inputs": required_inputs,
        "expected_outputs": expected_outputs,
        "min_gpu_memory_gb": min_gpu_memory_gb,
        "acceptance_gates": acceptance_gates,
    }


def required_jobs() -> list[dict[str, Any]]:
    return [
        job(
            "host_preflight",
            "CUDA host and backend preflight",
            "host",
            "python3 scripts/ai_eda/preflight_cuda_training_stack.py --run-id <cuda-host>",
            ["CUDA-capable PyTorch environment", "resolved external asset manifests"],
            ["build/ai_eda/cuda_training_preflight/<run-id>/cuda_training_preflight.json"],
            8,
            ["cuda.available=true", "large_training_ready=true"],
        ),
        job(
            "asset_fetch_and_verify",
            "Fetch and verify every realistic public AI-EDA asset",
            "data",
            "python3 scripts/ai_eda/fetch_external_asset.py --all --execute --run-id <cuda-host>",
            ["external/SOURCES.lock.yaml", "network access", "license/storage review"],
            ["build/ai_eda/external_assets/<run-id>/*.json"],
            0,
            [
                "each fetched asset has a verify-only follow-up report",
                "no payload tarball embeds raw datasets",
            ],
        ),
        job(
            "normalized_training_corpus",
            "Convert public corpora and E1 records into normalized training records",
            "data",
            "python3 scripts/ai_eda/build_training_corpus_manifest.py --run-id <cuda-host>",
            [
                "OpenROAD EDA Corpus",
                "TILOS MacroPlacement",
                "CircuitNet3",
                "ChiPBench-D",
                "OpenABC-D",
                "AIEDA iDATA",
                "EDALearn",
                "Macro Placement Challenge 2026",
                "MLCAD 2023 FPGA Macro",
                "R-Zoo Rectilinear Floorplan",
                "E1 OpenLane/softmacro records",
            ],
            ["build/ai_eda/training_corpus_manifest/<run-id>/training_corpus_manifest.json"],
            0,
            ["all converted record directories pass check_internal_dataset_schemas.py"],
        ),
        job(
            "floorplanning_dataset_readiness",
            "Gate FloorSet and R-Zoo before floorplanning pretraining",
            "data",
            "python3 scripts/ai_eda/capture_floorplanning_dataset_readiness.py --run-id <cuda-host>",
            [
                "FloorSet and R-Zoo external intake manifests",
                "ignored payload directories after fetch",
            ],
            [
                "build/ai_eda/floorplanning_dataset_readiness/<run-id>/floorplanning_dataset_readiness.json"
            ],
            0,
            [
                "check_floorplanning_dataset_readiness.py passes",
                "conversion/training/E1 optimization claims remain blocked until payload, license, schema, legality, split, and replay gates pass",
            ],
        ),
        job(
            "circuitnet3_timing_power_surrogate",
            "Train timing/power surrogate over CircuitNet3-derived flow runs",
            "analysis",
            "python3 scripts/ai_eda/train_circuitnet3_timing_power_baseline.py --run-id <cuda-host> --record-dir build/ai_eda/circuitnet3/<cuda-host>/records",
            ["build/ai_eda/circuitnet3/<cuda-host>/records"],
            [
                "build/ai_eda/circuitnet3_surrogate/<run-id>/training_run.json",
                "build/ai_eda/circuitnet3_surrogate/<run-id>/metrics.json",
            ],
            0,
            ["check_circuitnet3_surrogate.py passes", "surrogate remains pretraining-only"],
        ),
        job(
            "r_zoo_rectilinear_legality_baseline",
            "Train R-Zoo rectilinear-floorplan legality baseline",
            "floorplanning",
            "python3 scripts/ai_eda/train_r_zoo_legality_baseline.py --run-id <cuda-host> --record-dir build/ai_eda/r_zoo_rectilinear_floorplan/<cuda-host>/records --split-manifest build/ai_eda/r_zoo_rectilinear_floorplan_splits/<cuda-host>/split_manifest.json",
            [
                "build/ai_eda/r_zoo_rectilinear_floorplan/<cuda-host>/records",
                "build/ai_eda/r_zoo_rectilinear_floorplan_splits/<cuda-host>/split_manifest.json",
                "build/ai_eda/r_zoo_license_review/<cuda-host>/license_review.json",
            ],
            [
                "build/ai_eda/r_zoo_legality_baseline/<run-id>/training_run.json",
                "build/ai_eda/r_zoo_legality_baseline/<run-id>/metrics.json",
                "build/ai_eda/r_zoo_legality_baseline/<run-id>/r_zoo_legality_model.json",
            ],
            0,
            [
                "check_r_zoo_legality_baseline.py passes",
                "model remains public R-Zoo training-only and not E1 signoff evidence",
            ],
        ),
        job(
            "macro_placement_supervised_dataset",
            "Build macro-placement supervised dataset from all placement sources",
            "placement",
            "python3 scripts/ai_eda/build_macro_placement_supervised_dataset.py --run-id <cuda-host>",
            ["build/ai_eda/training_corpus_manifest/<cuda-host>/training_corpus_manifest.json"],
            ["build/ai_eda/macro_placement_supervised_dataset/<run-id>/{train,val,test}.jsonl"],
            0,
            ["dataset checker passes", "train/val/test split hashes are archived"],
        ),
        job(
            "alphachip_successor_cuda_train",
            "Train repo-native AlphaChip successor macro-placement regressor on CUDA",
            "placement",
            "python3 scripts/ai_eda/train_macro_placement_torch_regressor.py --run-id <cuda-host> --device cuda --epochs 200",
            ["build/ai_eda/macro_placement_supervised_dataset/<cuda-host>/{train,val,test}.jsonl"],
            [
                "build/ai_eda/macro_placement_torch_regressor/<run-id>/torch_training_run.json",
                "build/ai_eda/macro_placement_torch_regressor/<run-id>/metrics.json",
                "build/ai_eda/macro_placement_torch_regressor/<run-id>/torch_regressor.pt",
            ],
            8,
            ["training report device is cuda", "check_macro_placement_torch_regressor.py passes"],
        ),
        job(
            "alphachip_successor_inference",
            "Run successor inference and candidate quarantine",
            "placement",
            "python3 scripts/ai_eda/infer_macro_placement_torch_regressor.py --run-id <cuda-host> --device cuda",
            ["build/ai_eda/macro_placement_torch_regressor/<cuda-host>/torch_regressor.pt"],
            [
                "build/ai_eda/macro_placement_torch_inference/<run-id>/torch_inference_run.json",
                "build/ai_eda/macro_placement_torch_inference/<run-id>/candidates/*.json",
            ],
            8,
            ["inference report device is cuda", "candidate manifests validate"],
        ),
        job(
            "candidate_ranking_replay_queue",
            "Rank deterministic/supervised/CUDA candidates and build replay queue",
            "placement",
            "python3 scripts/ai_eda/select_macro_placement_replay_queue.py --run-id <cuda-host>",
            [
                "deterministic candidates",
                "supervised candidates",
                "CUDA inference candidates",
                "full replay plan",
            ],
            ["build/ai_eda/macro_placement_replay_queue/<run-id>/replay_queue.json"],
            0,
            ["replay queue checker passes", "queue is hash-pinned and release-use blocked"],
        ),
        job(
            "openlane_replay_and_comparison",
            "Execute deterministic baseline/candidate replay and compare PPA/signoff metrics",
            "physical-design",
            "python3 scripts/ai_eda/capture_openlane_replay_comparison.py --run-id <cuda-host> --baseline-execution <baseline-openlane-replay-execution.json> --candidate-execution build/ai_eda/openlane_replay_execution/<cuda-host>/openlane_replay_execution.json",
            [
                "OpenLane/OpenROAD/PDK host prerequisites",
                "baseline replay execution report",
                "candidate replay execution report",
            ],
            ["build/ai_eda/openlane_replay_comparison/<run-id>/openlane_replay_comparison.json"],
            0,
            ["no signoff regression", "at least one objective metric improvement"],
        ),
        job(
            "logic_synthesis_policy_baseline",
            "Generate and run Yosys/ABC logic-synthesis policy baseline",
            "logic-synthesis",
            "python3 scripts/ai_eda/run_logic_synthesis_policy_baseline.py --run-id <cuda-host>",
            ["generated logic-synthesis recipe corpus", "Yosys/ABC host tools"],
            ["build/ai_eda/logic_synthesis_baselines/<run-id>/baseline_report.json"],
            0,
            ["logic-synthesis baseline checker passes", "no source modification claim"],
        ),
        job(
            "verification_analysis_optimization_targets",
            "Capture verification, physical-design, and optimization target lanes",
            "target-captures",
            "make PYTHON=python3 AI_EDA_RUN_ID=<cuda-host> ai-eda-all-target-captures",
            ["research watchlist", "repo AI-EDA capture scripts"],
            ["build/ai_eda/*_targets/<run-id>/targets_report.json"],
            0,
            ["verification/PD/optimization capture checkers pass"],
        ),
        job(
            "objective_readiness_closeout",
            "Repackage evidence and run objective readiness after CUDA/PD execution",
            "audit",
            "python3 scripts/ai_eda/capture_ai_eda_objective_readiness.py --run-id <cuda-host> --readiness-run-id <cuda-host> --evidence-bundle-run-id <cuda-host> --training-handoff-run-id <cuda-host>-training-handoff --replay-handoff-run-id <cuda-host>",
            ["CUDA readiness audit", "evidence bundle", "all job outputs above"],
            ["build/ai_eda/objective_readiness/<run-id>/objective_readiness.json"],
            0,
            [
                "objective checker passes",
                "completion remains false until all objective requirements are proven",
            ],
        ),
    ]


FULL_DATASET_CONVERTER_COMMANDS = {
    "CircuitNet3": "python3 scripts/ai_eda/convert_circuitnet3_to_internal_records.py --run-id <cuda-host> --all-records",
    "ChiPBench-D": "python3 scripts/ai_eda/convert_chipbench_d_to_internal_records.py --run-id <cuda-host> --all-records",
    "OpenABC-D": "python3 scripts/ai_eda/convert_openabc_d_to_internal_records.py --run-id <cuda-host> --all-records",
    "AIEDA iDATA": "python3 scripts/ai_eda/convert_aieda_idata_to_internal_records.py --run-id <cuda-host> --all-records",
    "EDALearn": "python3 scripts/ai_eda/convert_edalearn_to_internal_records.py --run-id <cuda-host> --all-records",
    "Macro Placement Challenge 2026": "python3 scripts/ai_eda/convert_macro_place_challenge_2026_to_internal_records.py --run-id <cuda-host> --all-records",
    "R-Zoo Rectilinear Floorplan": "python3 scripts/ai_eda/convert_r_zoo_to_internal_records.py --run-id <cuda-host>",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default="validation")
    parser.add_argument(
        "--payload-run-id",
        default=None,
        help="CUDA payload/run-plan run id; defaults to --run-id.",
    )
    parser.add_argument(
        "--preflight-run-id",
        default=None,
        help="CUDA preflight run id; defaults to --run-id.",
    )
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    payload_run_id = args.payload_run_id or args.run_id
    preflight_run_id = args.preflight_run_id or args.run_id
    run_plan_path = (
        ROOT / f"build/ai_eda/cuda_training_payloads/{payload_run_id}/cuda_training_run_plan.json"
    )
    preflight_path = (
        ROOT
        / f"build/ai_eda/cuda_training_preflight/{preflight_run_id}/cuda_training_preflight.json"
    )
    run_plan = load_json(run_plan_path)
    preflight = load_json(preflight_path)
    jobs = required_jobs()

    blockers: list[str] = []
    if run_plan is None:
        blockers.append("CUDA run plan is missing")
    if preflight is None:
        blockers.append("CUDA preflight is missing")
    elif not preflight.get("cuda", {}).get("large_training_ready"):
        cuda = preflight.get("cuda", {})
        blockers.append(
            f"CUDA preflight is not large-training ready: cuda.available={cuda.get('available')} large_training_ready={cuda.get('large_training_ready')}"
        )

    for item in jobs:
        if run_plan is not None and not has_command(run_plan, item["command"].split(" --")[0]):
            blockers.append(f"run plan missing command family for job {item['id']}")
        if run_plan is not None:
            for expected in item["expected_outputs"]:
                if "{" in expected or "*" in expected:
                    continue
                if not has_output(run_plan, expected):
                    blockers.append(
                        f"run plan missing expected output for job {item['id']}: {expected}"
                    )

    full_dataset_modes: dict[str, bool] = {}
    for dataset, command in FULL_DATASET_CONVERTER_COMMANDS.items():
        present = has_command(run_plan, command) if run_plan is not None else False
        full_dataset_modes[dataset] = present
        if run_plan is not None and not present:
            blockers.append(f"run plan missing reviewed all-record conversion mode for {dataset}")

    status = "MATRIX_READY_FOR_CUDA_HOST" if not blockers else "MATRIX_RECORDED_WITH_BLOCKERS"
    report = {
        "schema": SCHEMA,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "release_use_allowed": False,
        "large_training_claim_allowed": False,
        "false_claim_flags": {
            "release_use_allowed": False,
            "large_training_claim_allowed": False,
        },
        "status": status,
        "evidence_run_ids": {
            "payload": payload_run_id,
            "preflight": preflight_run_id,
        },
        "input_artifacts": {
            "cuda_run_plan": artifact(run_plan_path),
            "cuda_preflight": artifact(preflight_path),
        },
        "full_dataset_conversion_modes": full_dataset_modes,
        "job_count": len(jobs),
        "jobs": jobs,
        "blockers": blockers,
        "next_required_gates": [
            "run this matrix on a CUDA host after preflight reports large_training_ready=true",
            "execute the reviewed --all-records conversion modes for every available public corpus on the CUDA/storage host",
            "execute CUDA successor training and inference with device=cuda evidence",
            "execute baseline and candidate OpenLane/OpenROAD replay and compare metrics",
            "rerun CUDA readiness, evidence bundle, and objective readiness after all matrix jobs complete",
        ],
    }
    out_dir = args.out_root / args.run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "cuda_full_training_matrix.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(
        "STATUS: PASS ai_eda.cuda_full_training_matrix "
        f"status={status} jobs={len(jobs)} blockers={len(blockers)} {rel(path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
