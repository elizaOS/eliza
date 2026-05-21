#!/usr/bin/env python3
"""Package metadata and scripts for a remote CUDA AI-EDA training host.

The payload excludes external datasets, model weights, foundry files, OpenLane
run trees, and build outputs. It is a reproducibility handoff: source
manifests, selected scripts, and a machine-readable run plan.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import tarfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = ROOT.parent.parent
DEFAULT_OUT = ROOT / "build/ai_eda/cuda_training_payloads"
CLAIM_BOUNDARY = "cuda_training_payload_metadata_only_no_dataset_weights_or_training_claim"

BASE_INCLUDE = (
    "external/README.md",
    "external/SOURCES.lock.yaml",
    "external/schemas/ai_eda_external_asset_manifest.v1.yaml",
    "external/schemas/ai_eda_external_intake_manifest.v1.yaml",
    "external/circuit_training/pin-manifest.json",
    "docs/toolchain/alphachip-checkpoint-blocker.md",
    "docs/spec-db/ai-eda/internal-dataset-schemas.yaml",
    "docs/spec-db/ai-eda/examples/e1-candidate.example.yaml",
    "docs/spec-db/ai-eda/examples/e1-design-bundle.example.yaml",
    "docs/spec-db/ai-eda/examples/e1-flow-run.example.yaml",
    "docs/spec-db/ai-eda/examples/e1-graph-sample.example.yaml",
    "docs/spec-db/ai-eda/examples/e1-placement-case.example.yaml",
    "docs/spec-db/ai-eda/examples/e1-tool-action.example.yaml",
    "docs/spec-db/ai-eda/examples/text_instruction_sample.yaml",
    "docs/spec-db/ai-eda/tool-action-schemas.yaml",
    "docs/spec-db/ai-eda/tool-action-examples/blocked-rtl-patch.example.yaml",
    "docs/spec-db/ai-eda/tool-action-examples/cocotb-seed-search.example.yaml",
    "docs/spec-db/ai-eda/tool-action-examples/openroad-route-parse.example.yaml",
    "docs/spec-db/ai-eda/tool-action-examples/yosys-recipe-baseline.example.yaml",
    "docs/spec-db/ai-eda/openlane-metrics-fixtures/e1_final_metrics.clean.json",
    "research/alpha_chip_macro_placement/08_full_stack_ai_chip_optimization_plan_2026-05-20.md",
    "research/alpha_chip_macro_placement/03_datasets/training_and_reference_inputs_2026-05-19.md",
    "scripts/ai_eda/check_external_asset_manifests.py",
    "scripts/ai_eda/check_external_intake_manifests.py",
    "scripts/ai_eda/check_alphachip_checkpoint_blocker.py",
    "scripts/ai_eda/check_candidate_manifests.py",
    "scripts/ai_eda/check_macro_placement_replay_plan.py",
    "scripts/ai_eda/check_macro_placement_supervised_dataset.py",
    "scripts/ai_eda/check_macro_placement_supervised_model.py",
    "scripts/ai_eda/check_macro_placement_torch_regressor.py",
    "scripts/ai_eda/check_internal_dataset_schemas.py",
    "scripts/ai_eda/check_tool_action_manifests.py",
    "scripts/ai_eda/check_tool_action_schemas.py",
    "scripts/ai_eda/convert_e1_openlane_to_internal_records.py",
    "scripts/ai_eda/convert_external_fixture_corpora.py",
    "scripts/ai_eda/convert_openroad_eda_corpus.py",
    "scripts/ai_eda/convert_tilos_macroplacement.py",
    "scripts/ai_eda/build_macro_placement_supervised_dataset.py",
    "scripts/ai_eda/train_macro_placement_supervised_model.py",
    "scripts/ai_eda/train_macro_placement_torch_regressor.py",
    "scripts/ai_eda/infer_macro_placement_torch_regressor.py",
    "scripts/ai_eda/fetch_external_asset.py",
    "scripts/ai_eda/materialize_internal_dataset_fixtures.py",
    "scripts/ai_eda/materialize_e1_softmacro_cases.py",
    "scripts/ai_eda/parse_openlane_metrics_to_flow_run.py",
    "scripts/ai_eda/evaluate_macro_placement_candidates.py",
    "scripts/ai_eda/plan_macro_placement_replay.py",
    "scripts/ai_eda/preflight_cuda_training_stack.py",
    "scripts/ai_eda/package_cuda_training_payload.py",
    "scripts/ai_eda/train_macro_placement_policy.py",
    "scripts/ai_eda/train_fixture_placement_smoke.py",
    "scripts/ai_eda/train_pd_surrogate_smoke.py",
    "scripts/ai_eda/run_cocotb_stimulus_search.py",
    "verify/ai_eda/coverage_bins/e1_npu_descriptor_queue.yaml",
    "verify/ai_eda/coverage_bins/e1_dma_backpressure_error.yaml",
    "verify/ai_eda/coverage_bins/e1_iommu_translation_fault.yaml",
    "verify/ai_eda/coverage_bins/e1_interrupt_reset_edges.yaml",
    "verify/ai_eda/coverage_bins/e1_npu_command_buffer.yaml",
    "verify/regression_seeds/ai_eda_npu_descriptor_queue.yaml",
    "verify/regression_seeds/ai_eda_dma_backpressure_error.yaml",
    "verify/regression_seeds/ai_eda_iommu_translation_fault.yaml",
    "verify/regression_seeds/ai_eda_interrupt_reset_edges.yaml",
    "verify/regression_seeds/ai_eda_npu_command_buffer.yaml",
    "scripts/ai_eda/run_openroad_autotune_e1.sh",
    "scripts/ai_eda/run_zigzag_npu_dse.py",
    "scripts/alphachip/check_setup.sh",
    "scripts/alphachip/run_toy_training.sh",
    "scripts/alphachip/run_e1_softmacro_training.sh",
    "scripts/alphachip/package_nebius_payload.sh",
    "scripts/alphachip/nebius_h200_runbook.md",
    "pd/openlane/config.sky130.json",
    "pd/openlane/config.gf180.json",
    "pd/openlane/config.ihp-sg13g2.json",
    "pd/openlane/config.asap7.yaml",
    "compiler/runtime/ai_eda/zigzag/e1_npu_current.yaml",
    "compiler/runtime/ai_eda/zigzag/e1_npu_target.yaml",
)

METADATA_GLOBS = (
    "external/repos/*/manifest.yaml",
    "external/datasets/*/manifest.yaml",
    "external/models/*/manifest.yaml",
)


def git_output(args: list[str]) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=REPO_ROOT,
        check=False,
        capture_output=True,
        text=True,
        timeout=20,
    )
    return result.stdout.strip() if result.returncode == 0 else "UNKNOWN"


def load_lock() -> dict[str, Any]:
    with (ROOT / "external/SOURCES.lock.yaml").open("r", encoding="utf-8") as handle:
        data = yaml.safe_load(handle)
    if not isinstance(data, dict):
        raise SystemExit("external/SOURCES.lock.yaml must be a YAML mapping")
    return data


def include_files() -> list[Path]:
    paths = [ROOT / rel for rel in BASE_INCLUDE if (ROOT / rel).exists()]
    for pattern in METADATA_GLOBS:
        paths.extend(sorted(ROOT.glob(pattern)))

    deduped: list[Path] = []
    seen: set[Path] = set()
    for path in paths:
        resolved = path.resolve()
        if resolved in seen:
            continue
        seen.add(resolved)
        deduped.append(path)
    return deduped


def select_assets(lock: dict[str, Any], requested: list[str]) -> list[dict[str, Any]]:
    entries = [entry for entry in lock.get("entries", []) if isinstance(entry, dict)]
    if not requested:
        return entries
    selected = [entry for entry in entries if entry.get("id") in set(requested)]
    missing = sorted(set(requested) - {entry["id"] for entry in selected})
    if missing:
        raise SystemExit(f"unknown asset ids: {', '.join(missing)}")
    return selected


def write_run_plan(out_dir: Path, selected: list[dict[str, Any]], args: argparse.Namespace) -> Path:
    dirty = git_output(["status", "--short", "--", "packages/chip"])
    plan = {
        "schema": "eliza.ai_eda.cuda_training_payload.v1",
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "git": {
            "commit": git_output(["rev-parse", "HEAD"]),
            "branch": git_output(["branch", "--show-current"]),
            "dirty_packages_chip": bool(dirty),
            "dirty_status_short": dirty.splitlines(),
        },
        "policy": {
            "contains_external_datasets": False,
            "contains_model_weights": False,
            "contains_foundry_confidential_files": False,
            "release_use_allowed": False,
        },
        "selected_assets": [
            {
                "id": entry["id"],
                "kind": entry["kind"],
                "priority": entry["priority"],
                "source_url": entry["source_url"],
                "revision": entry["revision"],
                "license_status": entry["license_status"],
                "allowed_use": entry["allowed_use"],
            }
            for entry in selected
        ],
        "required_remote_commands": [
            "python3 scripts/ai_eda/preflight_cuda_training_stack.py --run-id <cuda-host>",
            "python3 scripts/ai_eda/check_external_asset_manifests.py",
            "python3 scripts/ai_eda/check_external_intake_manifests.py --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --all --dry-run --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset <asset-id> --execute --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset <asset-id> --verify-only --run-id <cuda-host>",
            "python3 scripts/ai_eda/convert_openroad_eda_corpus.py --run-id <cuda-host>",
            "python3 scripts/ai_eda/convert_tilos_macroplacement.py --run-id <cuda-host>",
            "python3 scripts/ai_eda/materialize_e1_softmacro_cases.py --run-id <cuda-host>",
            "python3 scripts/ai_eda/build_macro_placement_supervised_dataset.py --run-id <cuda-host>",
            "python3 scripts/ai_eda/check_macro_placement_supervised_dataset.py --report build/ai_eda/macro_placement_supervised_dataset/<cuda-host>/macro_placement_supervised_dataset_report.json",
            "python3 scripts/ai_eda/train_macro_placement_supervised_model.py --run-id <cuda-host>",
            "python3 scripts/ai_eda/check_macro_placement_supervised_model.py --report build/ai_eda/macro_placement_supervised_model/<cuda-host>/supervised_training_run.json",
            "python3 scripts/ai_eda/check_candidate_manifests.py --candidate-dir build/ai_eda/macro_placement_supervised_model/<cuda-host>/candidates",
            "python3 scripts/ai_eda/train_macro_placement_torch_regressor.py --run-id <cuda-host> --device auto --epochs 200",
            "python3 scripts/ai_eda/check_macro_placement_torch_regressor.py --report build/ai_eda/macro_placement_torch_regressor/<cuda-host>/torch_training_run.json",
            "python3 scripts/ai_eda/infer_macro_placement_torch_regressor.py --run-id <cuda-host> --device auto",
            "python3 scripts/ai_eda/check_candidate_manifests.py --candidate-dir build/ai_eda/macro_placement_torch_inference/<cuda-host>/candidates",
            "python3 scripts/ai_eda/plan_macro_placement_replay.py --run-id <cuda-host> --candidate-dir build/ai_eda/macro_placement_supervised_model/<cuda-host>/candidates --out-root build/ai_eda/macro_placement_supervised_replay",
            "python3 scripts/ai_eda/check_macro_placement_replay_plan.py --report build/ai_eda/macro_placement_supervised_replay/<cuda-host>/replay_plan.json",
            "python3 scripts/ai_eda/check_tool_action_manifests.py --manifests-dir build/ai_eda/macro_placement_supervised_replay/<cuda-host>/tool_actions",
            "python3 scripts/ai_eda/train_macro_placement_policy.py --run-id <cuda-host>",
            "python3 scripts/ai_eda/check_candidate_manifests.py --candidate build/ai_eda/macro_placement_policy/<cuda-host>/candidates/<candidate>.json",
            "python3 scripts/ai_eda/evaluate_macro_placement_candidates.py --run-id <cuda-host>",
            "python3 scripts/ai_eda/evaluate_macro_placement_candidates.py --run-id <cuda-host> --candidate-dir build/ai_eda/macro_placement_policy/<cuda-host>/candidates --candidate-dir build/ai_eda/macro_placement_supervised_model/<cuda-host>/candidates --candidate-dir build/ai_eda/macro_placement_torch_inference/<cuda-host>/candidates --out-root build/ai_eda/macro_placement_combined_candidate_eval",
            "python3 scripts/ai_eda/plan_macro_placement_replay.py --run-id <cuda-host>",
            "python3 scripts/ai_eda/plan_macro_placement_replay.py --run-id <cuda-host> --candidate-dir build/ai_eda/macro_placement_policy/<cuda-host>/candidates --candidate-dir build/ai_eda/macro_placement_supervised_model/<cuda-host>/candidates --candidate-dir build/ai_eda/macro_placement_torch_inference/<cuda-host>/candidates --out-root build/ai_eda/macro_placement_combined_replay",
            "python3 scripts/ai_eda/check_macro_placement_replay_plan.py --report build/ai_eda/macro_placement_combined_replay/<cuda-host>/replay_plan.json",
            "python3 scripts/ai_eda/check_tool_action_manifests.py --manifests-dir build/ai_eda/macro_placement_combined_replay/<cuda-host>/tool_actions",
            "python3 scripts/ai_eda/check_macro_placement_replay_plan.py --report build/ai_eda/macro_placement_replay/<cuda-host>/replay_plan.json",
            "python3 scripts/ai_eda/check_tool_action_manifests.py --manifests-dir build/ai_eda/macro_placement_replay/<cuda-host>/tool_actions",
            "scripts/alphachip/check_setup.sh",
            "scripts/alphachip/run_toy_training.sh",
            "scripts/alphachip/run_e1_softmacro_training.sh",
        ],
        "expected_outputs": [
            "build/ai_eda/cuda_training_preflight/<run-id>/cuda_training_preflight.json",
            "build/ai_eda/external_assets/<run-id>/*.json",
            "build/ai_eda/openroad_eda_corpus/<run-id>/conversion_report.json",
            "build/ai_eda/tilos_macroplacement/<run-id>/conversion_report.json",
            "build/ai_eda/macro_placement_supervised_dataset/<run-id>/macro_placement_supervised_dataset_report.json",
            "build/ai_eda/macro_placement_supervised_dataset/<run-id>/{train,val,test}.jsonl",
            "build/ai_eda/macro_placement_supervised_model/<run-id>/supervised_training_run.json",
            "build/ai_eda/macro_placement_supervised_model/<run-id>/metrics.json",
            "build/ai_eda/macro_placement_supervised_model/<run-id>/supervised_mean_model.json",
            "build/ai_eda/macro_placement_supervised_model/<run-id>/candidates/*.json",
            "build/ai_eda/macro_placement_torch_regressor/<run-id>/torch_training_run.json",
            "build/ai_eda/macro_placement_torch_regressor/<run-id>/metrics.json",
            "build/ai_eda/macro_placement_torch_regressor/<run-id>/torch_regressor.pt",
            "build/ai_eda/macro_placement_torch_inference/<run-id>/torch_inference_run.json",
            "build/ai_eda/macro_placement_torch_inference/<run-id>/candidates/*.json",
            "build/ai_eda/macro_placement_supervised_replay/<run-id>/replay_plan.json",
            "build/ai_eda/macro_placement_supervised_replay/<run-id>/tool_actions/*.tool-action.json",
            "build/ai_eda/e1_softmacro_cases/<run-id>/materialization_report.json",
            "build/ai_eda/macro_placement_policy/<run-id>/macro_placement_baseline_report.json",
            "build/ai_eda/macro_placement_policy/<run-id>/candidates/*.json",
            "build/ai_eda/macro_placement_candidate_eval/<run-id>/macro_placement_candidate_eval_report.json",
            "build/ai_eda/macro_placement_combined_candidate_eval/<run-id>/macro_placement_candidate_eval_report.json",
            "build/ai_eda/macro_placement_combined_replay/<run-id>/replay_plan.json",
            "build/ai_eda/macro_placement_combined_replay/<run-id>/tool_actions/*.tool-action.json",
            "build/ai_eda/macro_placement_combined_replay/<run-id>/bundles/*/macro_placement.cfg",
            "build/ai_eda/macro_placement_replay/<run-id>/replay_plan.json",
            "build/ai_eda/macro_placement_replay/<run-id>/tool_actions/*.tool-action.json",
            "build/ai_eda/macro_placement_replay/<run-id>/bundles/*/macro_placement.cfg",
            "build/ai_eda/training_runs/<run-id>/training_run.json",
            "build/ai_eda/training_runs/<run-id>/metrics.json",
            "build/ai_eda/inference_runs/<run-id>/candidate_manifest.json",
            "build/ai_eda/candidate_replay/<run-id>/replay_report.json",
        ],
    }
    path = out_dir / "cuda_training_run_plan.json"
    path.write_text(json.dumps(plan, indent=2, sort_keys=True) + "\n")
    return path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default=datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ"))
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--asset", action="append", default=[])
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    out_dir = args.out_root / args.run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    lock = load_lock()
    selected = select_assets(lock, args.asset)
    plan_path = write_run_plan(out_dir, selected, args)
    tar_path = out_dir / "cuda_training_payload.tar.gz"
    include_paths = include_files()
    with tarfile.open(tar_path, "w:gz") as archive:
        for path in include_paths:
            archive.add(path, arcname=str(path.relative_to(ROOT)))
        archive.add(plan_path, arcname="cuda_training_run_plan.json")
    report = {
        "schema": "eliza.ai_eda.cuda_training_payload_report.v1",
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "asset_count": len(selected),
        "included_file_count": len(include_paths) + 1,
        "payload": str(tar_path.relative_to(ROOT)),
        "run_plan": str(plan_path.relative_to(ROOT)),
        "release_use_allowed": False,
    }
    report_path = out_dir / "cuda_training_payload_report.json"
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(f"STATUS: PASS ai_eda.cuda_training_payload {report_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
