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
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = ROOT.parent.parent
DEFAULT_OUT = ROOT / "build/ai_eda/cuda_training_payloads"
CLAIM_BOUNDARY = "cuda_training_payload_metadata_only_no_dataset_weights_or_training_claim"

BASE_INCLUDE = (
    "README.md",
    "Makefile",
    "requirements.txt",
    "external/README.md",
    "external/SOURCES.lock.yaml",
    "external/schemas/ai_eda_external_asset_manifest.v1.yaml",
    "external/schemas/ai_eda_external_intake_manifest.v1.yaml",
    "external/circuit_training/pin-manifest.json",
    "docs/toolchain/alphachip-checkpoint-blocker.md",
    "docs/spec-db/ai-eda/internal-dataset-schemas.yaml",
    "docs/spec-db/ai-eda/e1-ai-workload-manifest.yaml",
    "docs/spec-db/ai-eda/external-method-wrapper-readiness.yaml",
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
    "verify/ai_eda/assertion_candidates/e1_npu_descriptor.yaml",
    "research/alpha_chip_macro_placement/08_full_stack_ai_chip_optimization_plan_2026-05-20.md",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_current_research_watchlist_2026.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_source_inventory.yaml",
    "research/alpha_chip_macro_placement/03_datasets/training_and_reference_inputs_2026-05-19.md",
    "scripts/ai_eda/check_external_asset_manifests.py",
    "scripts/ai_eda/check_external_intake_manifests.py",
    "scripts/ai_eda/check_alphachip_checkpoint_blocker.py",
    "scripts/ai_eda/build_local_eda_rag_index.py",
    "scripts/ai_eda/check_local_eda_rag_index.py",
    "scripts/ai_eda/check_backend_preflight.py",
    "scripts/ai_eda/check_ai_workload_manifest.py",
    "scripts/ai_eda/check_external_method_wrapper_readiness.py",
    "scripts/ai_eda/check_assertion_candidate_manifests.py",
    "scripts/ai_eda/check_cuda_training_payload.py",
    "scripts/ai_eda/execute_cuda_run_plan.py",
    "scripts/ai_eda/check_cuda_run_plan_execution.py",
    "scripts/ai_eda/check_cuda_run_plan_safety_matrix.py",
    "scripts/ai_eda/capture_cuda_readiness_audit.py",
    "scripts/ai_eda/check_cuda_readiness_audit.py",
    "scripts/ai_eda/bootstrap_ai_eda_stack.py",
    "scripts/ai_eda/build_training_corpus_manifest.py",
    "scripts/ai_eda/check_candidate_manifests.py",
    "scripts/ai_eda/check_current_research_watchlist.py",
    "scripts/ai_eda/check_current_research_watchlist_records.py",
    "scripts/ai_eda/check_training_corpus_manifest.py",
    "scripts/ai_eda/check_macro_placement_baseline.py",
    "scripts/ai_eda/check_macro_placement_replay_plan.py",
    "scripts/ai_eda/check_macro_placement_supervised_dataset.py",
    "scripts/ai_eda/check_macro_placement_supervised_model.py",
    "scripts/ai_eda/check_macro_placement_torch_regressor.py",
    "scripts/ai_eda/check_macro_placement_torch_inference.py",
    "scripts/ai_eda/check_logic_synthesis_policy_baseline.py",
    "scripts/ai_eda/check_circuitnet3_surrogate.py",
    "scripts/ai_eda/check_chipbench_d_conversion.py",
    "scripts/ai_eda/check_openabc_d_conversion.py",
    "scripts/ai_eda/check_aieda_idata_conversion.py",
    "scripts/ai_eda/check_edalearn_conversion.py",
    "scripts/ai_eda/check_macro_place_challenge_2026_conversion.py",
    "scripts/ai_eda/check_mlcad_2023_fpga_macro_conversion.py",
    "scripts/ai_eda/check_research_code_assets_conversion.py",
    "scripts/ai_eda/check_internal_dataset_schemas.py",
    "scripts/ai_eda/check_openlane_flow_labels.py",
    "scripts/ai_eda/check_openroad_ml_snapshot.py",
    "scripts/ai_eda/check_tool_action_manifests.py",
    "scripts/ai_eda/check_tool_action_schemas.py",
    "scripts/ai_eda/convert_e1_openlane_to_internal_records.py",
    "scripts/ai_eda/convert_external_fixture_corpora.py",
    "scripts/ai_eda/convert_openroad_eda_corpus.py",
    "scripts/ai_eda/convert_circuitnet3_to_internal_records.py",
    "scripts/ai_eda/convert_chipbench_d_to_internal_records.py",
    "scripts/ai_eda/convert_openabc_d_to_internal_records.py",
    "scripts/ai_eda/convert_aieda_idata_to_internal_records.py",
    "scripts/ai_eda/convert_edalearn_to_internal_records.py",
    "scripts/ai_eda/convert_macro_place_challenge_2026_to_internal_records.py",
    "scripts/ai_eda/convert_mlcad_2023_fpga_macro_to_internal_records.py",
    "scripts/ai_eda/convert_current_research_watchlist_to_internal_records.py",
    "scripts/ai_eda/convert_research_code_assets_to_internal_records.py",
    "scripts/ai_eda/convert_tilos_macroplacement.py",
    "scripts/ai_eda/build_macro_placement_supervised_dataset.py",
    "scripts/ai_eda/train_macro_placement_supervised_model.py",
    "scripts/ai_eda/train_macro_placement_torch_regressor.py",
    "scripts/ai_eda/infer_macro_placement_torch_regressor.py",
    "scripts/ai_eda/train_circuitnet3_timing_power_baseline.py",
    "scripts/ai_eda/fetch_external_asset.py",
    "scripts/ai_eda/materialize_internal_dataset_fixtures.py",
    "scripts/ai_eda/materialize_e1_softmacro_cases.py",
    "scripts/ai_eda/parse_openlane_metrics_to_flow_run.py",
    "scripts/ai_eda/capture_openroad_ml_snapshot.py",
    "scripts/ai_eda/evaluate_macro_placement_candidates.py",
    "scripts/ai_eda/plan_macro_placement_replay.py",
    "scripts/ai_eda/replay_macro_placement_on_e1.py",
    "scripts/ai_eda/check_macro_placement_replay_preflight.py",
    "scripts/ai_eda/preflight_cuda_training_stack.py",
    "scripts/ai_eda/preflight_ai_eda_backends.py",
    "scripts/ai_eda/package_cuda_training_payload.py",
    "scripts/ai_eda/train_macro_placement_policy.py",
    "scripts/ai_eda/train_fixture_placement_smoke.py",
    "scripts/ai_eda/train_pd_surrogate_smoke.py",
    "scripts/ai_eda/run_cocotb_stimulus_search.py",
    "scripts/ai_eda/capture_logic_synthesis_targets.py",
    "scripts/ai_eda/capture_rtl_rewrite_equivalence_targets.py",
    "scripts/ai_eda/capture_netlist_equivalence_targets.py",
    "scripts/ai_eda/check_verification_target_captures.py",
    "scripts/ai_eda/capture_timing_closure_targets.py",
    "scripts/ai_eda/capture_routing_congestion_targets.py",
    "scripts/ai_eda/capture_placement_legalization_targets.py",
    "scripts/ai_eda/capture_physical_verification_targets.py",
    "scripts/ai_eda/check_physical_design_target_captures.py",
    "scripts/ai_eda/capture_current_research_watchlist.py",
    "scripts/ai_eda/capture_circuit_foundation_model_targets.py",
    "scripts/ai_eda/capture_eda_tool_agent_interop_targets.py",
    "scripts/ai_eda/capture_dfm_yield_lithography_targets.py",
    "scripts/ai_eda/capture_low_power_intent_targets.py",
    "scripts/ai_eda/capture_post_silicon_validation_targets.py",
    "scripts/ai_eda/capture_hardware_security_targets.py",
    "scripts/ai_eda/check_ai_optimization_target_captures.py",
    "scripts/ai_eda/generate_logic_synthesis_recipe_corpus.py",
    "scripts/ai_eda/run_logic_synthesis_policy_baseline.py",
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

RECURSIVE_INCLUDE_GLOBS = (
    "scripts/ai_eda/capture_*_targets.py",
    "docs/spec-db/ai-eda/external-fixtures/**/*",
    "docs/spec-db/ai-eda/templates/**/*",
    "research/alpha_chip_macro_placement/06_e1_notes/**/*",
    "rtl/npu/e1_npu.sv",
    "sw/platform/e1_platform_contract.json",
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
    for pattern in RECURSIVE_INCLUDE_GLOBS:
        paths.extend(path for path in sorted(ROOT.glob(pattern)) if path.is_file())

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
        "created_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
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
            "python3 scripts/ai_eda/bootstrap_ai_eda_stack.py --profile metadata --run-id <cuda-host>",
            "python3 scripts/ai_eda/bootstrap_ai_eda_stack.py --profile setup-check --run-id <cuda-host> --asset tilos-macroplacement --asset openroad-eda-corpus --asset circuitnet3 --asset chipbench-d --asset openabc-d --asset aieda-idata --asset edalearn --asset macro-place-challenge-2026 --asset mlcad-2023-fpga-macro --asset chipdiffusion --asset chipformer --asset core-placement --asset maptune --asset abc-rl --asset abcrl --asset rl4ls --asset mcp4eda --asset orfs-agent --asset openroad-agent --asset openroad-mcp --asset open3dbench --asset dreamplace --asset chiplingo --asset veoplace-vlm --asset audopeda --asset ppa-3dic-surrogate-2026",
            "python3 scripts/ai_eda/bootstrap_ai_eda_stack.py --profile local-smoke --run-id <cuda-host> --asset tilos-macroplacement --asset openroad-eda-corpus --asset circuitnet3 --asset chipbench-d --asset openabc-d --asset aieda-idata --asset edalearn --asset macro-place-challenge-2026 --asset mlcad-2023-fpga-macro --asset chipdiffusion --asset chipformer --asset core-placement --asset maptune --asset abc-rl --asset abcrl --asset rl4ls --asset mcp4eda --asset orfs-agent --asset openroad-agent --asset openroad-mcp --asset open3dbench --asset dreamplace --asset chiplingo --asset veoplace-vlm --asset audopeda --asset ppa-3dic-surrogate-2026",
            "python3 scripts/ai_eda/bootstrap_ai_eda_stack.py --profile training-handoff --run-id <cuda-host>-training-handoff --asset tilos-macroplacement --asset openroad-eda-corpus --asset circuitnet3 --asset chipbench-d --asset openabc-d --asset aieda-idata --asset edalearn --asset macro-place-challenge-2026 --asset mlcad-2023-fpga-macro --asset chipdiffusion --asset chipformer --asset core-placement --asset maptune --asset abc-rl --asset abcrl --asset rl4ls --asset mcp4eda --asset orfs-agent --asset openroad-agent --asset openroad-mcp --asset open3dbench --asset dreamplace --asset chiplingo --asset veoplace-vlm --asset audopeda --asset ppa-3dic-surrogate-2026 --include-torch",
            "python3 scripts/ai_eda/build_local_eda_rag_index.py --run-id <cuda-host>",
            "python3 scripts/ai_eda/check_local_eda_rag_index.py",
            "python3 scripts/ai_eda/preflight_cuda_training_stack.py --run-id <cuda-host>",
            "python3 scripts/ai_eda/preflight_ai_eda_backends.py --run-id <cuda-host>",
            "python3 scripts/ai_eda/check_backend_preflight.py --report build/ai_eda/backend_preflight/<cuda-host>/backend_preflight_report.json",
            "python3 scripts/ai_eda/check_ai_workload_manifest.py",
            "python3 scripts/ai_eda/check_external_method_wrapper_readiness.py",
            "python3 scripts/ai_eda/check_assertion_candidate_manifests.py",
            "python3 scripts/ai_eda/execute_cuda_run_plan.py --plan build/ai_eda/cuda_training_payloads/<cuda-host>/cuda_training_run_plan.json --run-id <cuda-host>",
            "python3 scripts/ai_eda/check_cuda_run_plan_execution.py --report build/ai_eda/cuda_run_plan_execution/<cuda-host>/cuda_run_plan_execution.json",
            "python3 scripts/ai_eda/check_cuda_run_plan_safety_matrix.py --plan build/ai_eda/cuda_training_payloads/<cuda-host>/cuda_training_run_plan.json --run-id <cuda-host>",
            "make PYTHON=python3 AI_EDA_RUN_ID=<cuda-host> ai-eda-cuda-readiness-audit",
            "python3 scripts/ai_eda/capture_cuda_readiness_audit.py --run-id <cuda-host>",
            "python3 scripts/ai_eda/check_cuda_readiness_audit.py --report build/ai_eda/cuda_readiness_audit/<cuda-host>/cuda_readiness_audit.json",
            "python3 scripts/ai_eda/check_external_asset_manifests.py",
            "python3 scripts/ai_eda/check_external_intake_manifests.py --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --all --dry-run --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset <asset-id> --execute --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset <asset-id> --verify-only --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset circuitnet3 --execute --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset circuitnet3 --verify-only --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset chipbench-d --execute --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset chipbench-d --verify-only --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset openabc-d --execute --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset openabc-d --verify-only --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset aieda-idata --execute --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset aieda-idata --verify-only --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset edalearn --execute --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset edalearn --verify-only --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset rtlmul --execute --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset rtlmul --verify-only --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset llm4dv --execute --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset llm4dv --verify-only --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset assertllm --execute --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset assertllm --verify-only --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset fault-dft --execute --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset fault-dft --verify-only --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset macro-place-challenge-2026 --execute --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset macro-place-challenge-2026 --verify-only --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset mlcad-2023-fpga-macro --execute --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset mlcad-2023-fpga-macro --verify-only --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset chipdiffusion --execute --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset chipdiffusion --verify-only --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset chipformer --execute --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset chipformer --verify-only --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset core-placement --execute --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset core-placement --verify-only --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset maptune --execute --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset maptune --verify-only --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset abc-rl --execute --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset abc-rl --verify-only --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset abcrl --execute --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset abcrl --verify-only --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset rl4ls --execute --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset rl4ls --verify-only --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset mcp4eda --execute --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset mcp4eda --verify-only --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset orfs-agent --execute --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset orfs-agent --verify-only --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset openroad-agent --execute --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset openroad-agent --verify-only --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset openroad-mcp --execute --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset openroad-mcp --verify-only --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset open3dbench --execute --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset open3dbench --verify-only --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset dreamplace --execute --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset dreamplace --verify-only --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset chiplingo --execute --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset chiplingo --verify-only --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset veoplace-vlm --execute --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset veoplace-vlm --verify-only --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset audopeda --execute --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset audopeda --verify-only --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset ppa-3dic-surrogate-2026 --execute --run-id <cuda-host>",
            "python3 scripts/ai_eda/fetch_external_asset.py --asset ppa-3dic-surrogate-2026 --verify-only --run-id <cuda-host>",
            "python3 scripts/ai_eda/materialize_internal_dataset_fixtures.py --run-id <cuda-host>",
            "python3 scripts/ai_eda/convert_openroad_eda_corpus.py --run-id <cuda-host>",
            "python3 scripts/ai_eda/convert_tilos_macroplacement.py --run-id <cuda-host>",
            "python3 scripts/ai_eda/convert_circuitnet3_to_internal_records.py --run-id <cuda-host> --sample-limit 32",
            "python3 scripts/ai_eda/check_internal_dataset_schemas.py --records-dir build/ai_eda/circuitnet3/<cuda-host>/records",
            "python3 scripts/ai_eda/convert_chipbench_d_to_internal_records.py --run-id <cuda-host> --sample-limit 20",
            "python3 scripts/ai_eda/check_internal_dataset_schemas.py --records-dir build/ai_eda/chipbench_d/<cuda-host>/records",
            "python3 scripts/ai_eda/check_chipbench_d_conversion.py --report build/ai_eda/chipbench_d/<cuda-host>/conversion_report.json",
            "python3 scripts/ai_eda/train_circuitnet3_timing_power_baseline.py --run-id <cuda-host> --record-dir build/ai_eda/circuitnet3/<cuda-host>/records",
            "python3 scripts/ai_eda/check_circuitnet3_surrogate.py --report build/ai_eda/circuitnet3_surrogate/<cuda-host>/training_run.json",
            "python3 scripts/ai_eda/convert_openabc_d_to_internal_records.py --run-id <cuda-host> --sample-limit 64",
            "python3 scripts/ai_eda/check_internal_dataset_schemas.py --records-dir build/ai_eda/openabc_d/<cuda-host>/records",
            "python3 scripts/ai_eda/check_openabc_d_conversion.py --report build/ai_eda/openabc_d/<cuda-host>/conversion_report.json",
            "python3 scripts/ai_eda/convert_aieda_idata_to_internal_records.py --run-id <cuda-host> --sample-limit 64",
            "python3 scripts/ai_eda/check_internal_dataset_schemas.py --records-dir build/ai_eda/aieda_idata/<cuda-host>/records",
            "python3 scripts/ai_eda/check_aieda_idata_conversion.py --report build/ai_eda/aieda_idata/<cuda-host>/conversion_report.json",
            "python3 scripts/ai_eda/convert_edalearn_to_internal_records.py --run-id <cuda-host> --sample-limit 64",
            "python3 scripts/ai_eda/check_internal_dataset_schemas.py --records-dir build/ai_eda/edalearn/<cuda-host>/records",
            "python3 scripts/ai_eda/check_edalearn_conversion.py --report build/ai_eda/edalearn/<cuda-host>/conversion_report.json",
            "python3 scripts/ai_eda/convert_macro_place_challenge_2026_to_internal_records.py --run-id <cuda-host> --sample-limit 32",
            "python3 scripts/ai_eda/check_internal_dataset_schemas.py --records-dir build/ai_eda/macro_place_challenge_2026/<cuda-host>/records",
            "python3 scripts/ai_eda/check_macro_place_challenge_2026_conversion.py --report build/ai_eda/macro_place_challenge_2026/<cuda-host>/conversion_report.json",
            "python3 scripts/ai_eda/convert_mlcad_2023_fpga_macro_to_internal_records.py --run-id <cuda-host>",
            "python3 scripts/ai_eda/check_internal_dataset_schemas.py --records-dir build/ai_eda/mlcad_2023_fpga_macro/<cuda-host>/records",
            "python3 scripts/ai_eda/check_mlcad_2023_fpga_macro_conversion.py --report build/ai_eda/mlcad_2023_fpga_macro/<cuda-host>/conversion_report.json",
            "python3 scripts/ai_eda/convert_research_code_assets_to_internal_records.py --run-id <cuda-host>",
            "python3 scripts/ai_eda/check_internal_dataset_schemas.py --records-dir build/ai_eda/research_code_assets/<cuda-host>/records",
            "python3 scripts/ai_eda/check_research_code_assets_conversion.py --report build/ai_eda/research_code_assets/<cuda-host>/conversion_report.json",
            "python3 scripts/ai_eda/convert_current_research_watchlist_to_internal_records.py --run-id <cuda-host>",
            "python3 scripts/ai_eda/check_internal_dataset_schemas.py --records-dir build/ai_eda/current_research_watchlist_records/<cuda-host>/records",
            "python3 scripts/ai_eda/check_current_research_watchlist_records.py --report build/ai_eda/current_research_watchlist_records/<cuda-host>/conversion_report.json",
            "python3 scripts/ai_eda/convert_e1_openlane_to_internal_records.py --run-id <cuda-host>",
            "python3 scripts/ai_eda/check_internal_dataset_schemas.py --records-dir build/ai_eda/e1_openlane_conversion/<cuda-host>/records",
            "python3 scripts/ai_eda/convert_external_fixture_corpora.py --run-id <cuda-host>",
            "python3 scripts/ai_eda/check_internal_dataset_schemas.py --records-dir build/ai_eda/converted_external_fixtures/<cuda-host>/records",
            "python3 scripts/ai_eda/parse_openlane_metrics_to_flow_run.py --run-id <cuda-host>",
            "python3 scripts/ai_eda/check_internal_dataset_schemas.py --records-dir build/ai_eda/openlane_flow_labels/<cuda-host>/records",
            "python3 scripts/ai_eda/check_openlane_flow_labels.py --report build/ai_eda/openlane_flow_labels/<cuda-host>/label-parse-report.json",
            "python3 scripts/ai_eda/capture_openroad_ml_snapshot.py --run-id <cuda-host>",
            "python3 scripts/ai_eda/check_openroad_ml_snapshot.py --report build/ai_eda/pd_predictor_dataset/<cuda-host>/snapshot_manifest.json",
            "python3 scripts/ai_eda/train_pd_surrogate_smoke.py --run-id <cuda-host>",
            "python3 scripts/ai_eda/materialize_e1_softmacro_cases.py --run-id <cuda-host>",
            "python3 scripts/ai_eda/check_internal_dataset_schemas.py --records-dir build/ai_eda/e1_softmacro_cases/<cuda-host>/records",
            "python3 scripts/ai_eda/build_training_corpus_manifest.py --run-id <cuda-host>",
            "python3 scripts/ai_eda/check_training_corpus_manifest.py --manifest build/ai_eda/training_corpus_manifest/<cuda-host>/training_corpus_manifest.json",
            "python3 scripts/ai_eda/build_macro_placement_supervised_dataset.py --run-id <cuda-host>",
            "python3 scripts/ai_eda/check_macro_placement_supervised_dataset.py --report build/ai_eda/macro_placement_supervised_dataset/<cuda-host>/macro_placement_supervised_dataset_report.json",
            "python3 scripts/ai_eda/train_macro_placement_supervised_model.py --run-id <cuda-host>",
            "python3 scripts/ai_eda/check_macro_placement_supervised_model.py --report build/ai_eda/macro_placement_supervised_model/<cuda-host>/supervised_training_run.json",
            "python3 scripts/ai_eda/check_candidate_manifests.py --candidate-dir build/ai_eda/macro_placement_supervised_model/<cuda-host>/candidates",
            "python3 scripts/ai_eda/train_macro_placement_torch_regressor.py --run-id <cuda-host> --device auto --epochs 200",
            "python3 scripts/ai_eda/check_macro_placement_torch_regressor.py --report build/ai_eda/macro_placement_torch_regressor/<cuda-host>/torch_training_run.json",
            "python3 scripts/ai_eda/infer_macro_placement_torch_regressor.py --run-id <cuda-host> --device auto",
            "python3 scripts/ai_eda/check_macro_placement_torch_inference.py --report build/ai_eda/macro_placement_torch_inference/<cuda-host>/torch_inference_run.json",
            "python3 scripts/ai_eda/check_candidate_manifests.py --candidate-dir build/ai_eda/macro_placement_torch_inference/<cuda-host>/candidates",
            "python3 scripts/ai_eda/plan_macro_placement_replay.py --run-id <cuda-host> --candidate-dir build/ai_eda/macro_placement_supervised_model/<cuda-host>/candidates --out-root build/ai_eda/macro_placement_supervised_replay",
            "python3 scripts/ai_eda/check_macro_placement_replay_plan.py --report build/ai_eda/macro_placement_supervised_replay/<cuda-host>/replay_plan.json",
            "python3 scripts/ai_eda/check_tool_action_manifests.py --manifests-dir build/ai_eda/macro_placement_supervised_replay/<cuda-host>/tool_actions",
            "python3 scripts/ai_eda/train_macro_placement_policy.py --run-id <cuda-host>",
            "python3 scripts/ai_eda/check_macro_placement_baseline.py --report build/ai_eda/macro_placement_policy/<cuda-host>/macro_placement_baseline_report.json",
            "python3 scripts/ai_eda/check_candidate_manifests.py --candidate-dir build/ai_eda/macro_placement_policy/<cuda-host>/candidates",
            "python3 scripts/ai_eda/evaluate_macro_placement_candidates.py --run-id <cuda-host>",
            "python3 scripts/ai_eda/evaluate_macro_placement_candidates.py --run-id <cuda-host> --candidate-dir build/ai_eda/macro_placement_policy/<cuda-host>/candidates --candidate-dir build/ai_eda/macro_placement_supervised_model/<cuda-host>/candidates --candidate-dir build/ai_eda/macro_placement_torch_inference/<cuda-host>/candidates --out-root build/ai_eda/macro_placement_combined_candidate_eval",
            "python3 scripts/ai_eda/plan_macro_placement_replay.py --run-id <cuda-host>",
            "python3 scripts/ai_eda/plan_macro_placement_replay.py --run-id <cuda-host> --candidate-dir build/ai_eda/macro_placement_policy/<cuda-host>/candidates --candidate-dir build/ai_eda/macro_placement_supervised_model/<cuda-host>/candidates --candidate-dir build/ai_eda/macro_placement_torch_inference/<cuda-host>/candidates --out-root build/ai_eda/macro_placement_combined_replay",
            "python3 scripts/ai_eda/check_macro_placement_replay_plan.py --report build/ai_eda/macro_placement_combined_replay/<cuda-host>/replay_plan.json",
            "python3 scripts/ai_eda/check_tool_action_manifests.py --manifests-dir build/ai_eda/macro_placement_combined_replay/<cuda-host>/tool_actions",
            "python3 scripts/ai_eda/check_macro_placement_replay_plan.py --report build/ai_eda/macro_placement_replay/<cuda-host>/replay_plan.json",
            "python3 scripts/ai_eda/check_tool_action_manifests.py --manifests-dir build/ai_eda/macro_placement_replay/<cuda-host>/tool_actions",
            "python3 scripts/ai_eda/replay_macro_placement_on_e1.py --run-id <cuda-host> --plan build/ai_eda/macro_placement_replay/<cuda-host>/replay_plan.json",
            "python3 scripts/ai_eda/check_macro_placement_replay_preflight.py --report build/ai_eda/macro_placement_replay_preflight/<cuda-host>/replay_preflight_report.json",
            "python3 scripts/ai_eda/capture_logic_synthesis_targets.py --run-id <cuda-host>",
            "python3 scripts/ai_eda/capture_rtl_rewrite_equivalence_targets.py --run-id <cuda-host>",
            "python3 scripts/ai_eda/capture_netlist_equivalence_targets.py --run-id <cuda-host>",
            "python3 scripts/ai_eda/check_verification_target_captures.py --run-id <cuda-host>",
            "python3 scripts/ai_eda/capture_timing_closure_targets.py --run-id <cuda-host>",
            "python3 scripts/ai_eda/capture_routing_congestion_targets.py --run-id <cuda-host>",
            "python3 scripts/ai_eda/capture_placement_legalization_targets.py --run-id <cuda-host>",
            "python3 scripts/ai_eda/capture_physical_verification_targets.py --run-id <cuda-host>",
            "python3 scripts/ai_eda/check_physical_design_target_captures.py --run-id <cuda-host>",
            "python3 scripts/ai_eda/capture_current_research_watchlist.py --run-id <cuda-host>",
            "python3 scripts/ai_eda/check_current_research_watchlist.py --report build/ai_eda/current_research_watchlist/<cuda-host>/targets_report.json",
            "python3 scripts/ai_eda/capture_circuit_foundation_model_targets.py --run-id <cuda-host>",
            "python3 scripts/ai_eda/capture_eda_tool_agent_interop_targets.py --run-id <cuda-host>",
            "python3 scripts/ai_eda/capture_dfm_yield_lithography_targets.py --run-id <cuda-host>",
            "python3 scripts/ai_eda/capture_low_power_intent_targets.py --run-id <cuda-host>",
            "python3 scripts/ai_eda/capture_post_silicon_validation_targets.py --run-id <cuda-host>",
            "python3 scripts/ai_eda/capture_hardware_security_targets.py --run-id <cuda-host>",
            "python3 scripts/ai_eda/check_ai_optimization_target_captures.py --run-id <cuda-host>",
            "make PYTHON=python3 AI_EDA_RUN_ID=<cuda-host> ai-eda-all-target-captures",
            "python3 scripts/ai_eda/generate_logic_synthesis_recipe_corpus.py --run-id <cuda-host>",
            "python3 scripts/ai_eda/check_logic_synthesis_policy_baseline.py --corpus build/ai_eda/logic_synthesis_recipes/<cuda-host>/recipe_corpus.json --corpus-only",
            "python3 scripts/ai_eda/run_logic_synthesis_policy_baseline.py --run-id <cuda-host>",
            "python3 scripts/ai_eda/check_logic_synthesis_policy_baseline.py --corpus build/ai_eda/logic_synthesis_recipes/<cuda-host>/recipe_corpus.json --report build/ai_eda/logic_synthesis_baselines/<cuda-host>/baseline_report.json",
            "scripts/alphachip/check_setup.sh",
            "scripts/alphachip/run_toy_training.sh",
            "scripts/alphachip/run_e1_softmacro_training.sh",
        ],
        "expected_outputs": [
            "build/ai_eda/cuda_training_preflight/<run-id>/cuda_training_preflight.json",
            "build/ai_eda/cuda_readiness_audit/<run-id>/cuda_readiness_audit.json",
            "build/ai_eda/cuda_run_plan_execution/<run-id>/cuda_run_plan_execution.json",
            "build/ai_eda/cuda_run_plan_safety_matrix/<run-id>/cuda_run_plan_safety_matrix.json",
            "build/ai_eda/rag_index/source_manifest.json",
            "build/ai_eda/rag_index/citation_smoke_report.json",
            "build/ai_eda/backend_preflight/<run-id>/backend_preflight_report.json",
            "build/ai_eda/external_assets/<run-id>/*.json",
            "build/ai_eda/internal_dataset_fixtures/<run-id>/internal_dataset_fixture_report.json",
            "build/ai_eda/internal_dataset_fixtures/<run-id>/records/*.json",
            "build/ai_eda/openroad_eda_corpus/<run-id>/conversion_report.json",
            "build/ai_eda/openroad_eda_corpus/<run-id>/records/*.json",
            "build/ai_eda/openroad_eda_corpus/<run-id>/train.jsonl",
            "build/ai_eda/openroad_eda_corpus/<run-id>/val.jsonl",
            "build/ai_eda/openroad_eda_corpus/<run-id>/test.jsonl",
            "build/ai_eda/tilos_macroplacement/<run-id>/conversion_report.json",
            "build/ai_eda/circuitnet3/<run-id>/conversion_report.json",
            "build/ai_eda/circuitnet3/<run-id>/records/*.json",
            "build/ai_eda/chipbench_d/<run-id>/conversion_report.json",
            "build/ai_eda/chipbench_d/<run-id>/records/*.json",
            "build/ai_eda/circuitnet3_surrogate/<run-id>/training_run.json",
            "build/ai_eda/circuitnet3_surrogate/<run-id>/metrics.json",
            "build/ai_eda/circuitnet3_surrogate/<run-id>/circuitnet3_surrogate_model.json",
            "build/ai_eda/openabc_d/<run-id>/conversion_report.json",
            "build/ai_eda/openabc_d/<run-id>/records/*.json",
            "build/ai_eda/aieda_idata/<run-id>/conversion_report.json",
            "build/ai_eda/aieda_idata/<run-id>/records/*.json",
            "build/ai_eda/edalearn/<run-id>/conversion_report.json",
            "build/ai_eda/edalearn/<run-id>/records/*.json",
            "build/ai_eda/openlane_flow_labels/<run-id>/label-parse-report.json",
            "build/ai_eda/openlane_flow_labels/<run-id>/records/*.json",
            "build/ai_eda/pd_predictor_dataset/<run-id>/snapshot_manifest.json",
            "build/ai_eda/pd_predictor_dataset/<run-id>/label_report.json",
            "build/ai_eda/converted_external_fixtures/<run-id>/conversion_report.json",
            "build/ai_eda/converted_external_fixtures/<run-id>/records/*.json",
            "build/ai_eda/macro_place_challenge_2026/<run-id>/conversion_report.json",
            "build/ai_eda/macro_place_challenge_2026/<run-id>/records/*.json",
            "build/ai_eda/mlcad_2023_fpga_macro/<run-id>/conversion_report.json",
            "build/ai_eda/mlcad_2023_fpga_macro/<run-id>/records/*.json",
            "build/ai_eda/research_code_assets/<run-id>/conversion_report.json",
            "build/ai_eda/research_code_assets/<run-id>/records/*.json",
            "build/ai_eda/current_research_watchlist_records/<run-id>/conversion_report.json",
            "build/ai_eda/current_research_watchlist_records/<run-id>/records/*.json",
            "build/ai_eda/training_corpus_manifest/<run-id>/training_corpus_manifest.json",
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
            "build/ai_eda/e1_softmacro_cases/<run-id>/records/*.json",
            "build/ai_eda/macro_placement_policy/<run-id>/macro_placement_baseline_report.json",
            "build/ai_eda/macro_placement_policy/<run-id>/candidates/*.json",
            "build/ai_eda/macro_placement_candidate_eval/<run-id>/macro_placement_candidate_eval_report.json",
            "build/ai_eda/macro_placement_combined_candidate_eval/<run-id>/macro_placement_candidate_eval_report.json",
            "build/ai_eda/macro_placement_full_candidate_eval/<run-id>/macro_placement_candidate_eval_report.json",
            "build/ai_eda/macro_placement_combined_replay/<run-id>/replay_plan.json",
            "build/ai_eda/macro_placement_combined_replay/<run-id>/tool_actions/*.tool-action.json",
            "build/ai_eda/macro_placement_combined_replay/<run-id>/bundles/*/macro_placement.cfg",
            "build/ai_eda/macro_placement_full_replay/<run-id>/replay_plan.json",
            "build/ai_eda/macro_placement_full_replay/<run-id>/tool_actions/*.tool-action.json",
            "build/ai_eda/macro_placement_full_replay/<run-id>/bundles/*/macro_placement.cfg",
            "build/ai_eda/macro_placement_replay/<run-id>/replay_plan.json",
            "build/ai_eda/macro_placement_replay/<run-id>/tool_actions/*.tool-action.json",
            "build/ai_eda/macro_placement_replay/<run-id>/bundles/*/macro_placement.cfg",
            "build/ai_eda/macro_placement_replay_preflight/<run-id>/replay_preflight_report.json",
            "build/ai_eda/analog_mixed_signal_targets/<run-id>/targets_report.json",
            "build/ai_eda/benchmark_evaluation_hygiene_targets/<run-id>/targets_report.json",
            "build/ai_eda/board_package_fpga_targets/<run-id>/targets_report.json",
            "build/ai_eda/cdc_rdc_targets/<run-id>/targets_report.json",
            "build/ai_eda/chiplet_3dic_package_targets/<run-id>/targets_report.json",
            "build/ai_eda/clock_tree_targets/<run-id>/targets_report.json",
            "build/ai_eda/compiler_autotuning_targets/<run-id>/targets_report.json",
            "build/ai_eda/cpu_microarchitecture_targets/<run-id>/targets_report.json",
            "build/ai_eda/dft_atpg_targets/<run-id>/targets_report.json",
            "build/ai_eda/external_model_corpus_intake_targets/<run-id>/targets_report.json",
            "build/ai_eda/extraction_parasitic_targets/<run-id>/targets_report.json",
            "build/ai_eda/floorplan_io_pdn_targets/<run-id>/targets_report.json",
            "build/ai_eda/hls_accelerator_targets/<run-id>/targets_report.json",
            "build/ai_eda/ip_register_contract_targets/<run-id>/targets_report.json",
            "build/ai_eda/logic_synthesis_targets/<run-id>/targets_report.json",
            "build/ai_eda/rtl_rewrite_equivalence_targets/<run-id>/targets_report.json",
            "build/ai_eda/netlist_equivalence_targets/<run-id>/targets_report.json",
            "build/ai_eda/logic_synthesis_recipes/<run-id>/recipe_corpus.json",
            "build/ai_eda/logic_synthesis_baselines/<run-id>/baseline_report.json",
            "build/ai_eda/logic_synthesis_baselines/<run-id>/*.ys",
            "build/ai_eda/logic_synthesis_baselines/<run-id>/*.yosys.log",
            "build/ai_eda/timing_closure_targets/<run-id>/targets_report.json",
            "build/ai_eda/routing_congestion_targets/<run-id>/targets_report.json",
            "build/ai_eda/placement_legalization_targets/<run-id>/targets_report.json",
            "build/ai_eda/physical_verification_targets/<run-id>/targets_report.json",
            "build/ai_eda/circuit_foundation_model_targets/<run-id>/targets_report.json",
            "build/ai_eda/current_research_watchlist/<run-id>/targets_report.json",
            "build/ai_eda/eda_tool_agent_interop_targets/<run-id>/targets_report.json",
            "build/ai_eda/dfm_yield_lithography_targets/<run-id>/targets_report.json",
            "build/ai_eda/low_power_intent_targets/<run-id>/targets_report.json",
            "build/ai_eda/memory_interconnect_targets/<run-id>/targets_report.json",
            "build/ai_eda/memory_macro_library_targets/<run-id>/targets_report.json",
            "build/ai_eda/post_silicon_validation_targets/<run-id>/targets_report.json",
            "build/ai_eda/power_thermal_targets/<run-id>/targets_report.json",
            "build/ai_eda/reliability_resilience_targets/<run-id>/targets_report.json",
            "build/ai_eda/simulator_optimization/<run-id>/targets_report.json",
            "build/ai_eda/software_bsp_firmware_targets/<run-id>/targets_report.json",
            "build/ai_eda/spec_traceability_targets/<run-id>/targets_report.json",
            "build/ai_eda/verification_debug_targets/<run-id>/targets_report.json",
            "build/ai_eda/hardware_security_targets/<run-id>/targets_report.json",
            "build/ai_eda/training_runs/<run-id>/training_run.json",
            "build/ai_eda/training_runs/<run-id>/metrics.json",
            "build/ai_eda/inference_runs/<run-id>/candidate_manifest.json",
            "build/ai_eda/candidate_replay/<run-id>/replay_report.json",
        ],
    }
    path = out_dir / "cuda_training_run_plan.json"
    path.write_text(json.dumps(plan, indent=2, sort_keys=True) + "\n")
    return path


def write_runbook(out_dir: Path, plan_path: Path, args: argparse.Namespace) -> Path:
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    if not isinstance(plan, dict):
        raise SystemExit(f"{plan_path}: expected JSON object")
    commands = [command for command in plan.get("required_remote_commands", []) if isinstance(command, str)]
    outputs = [output for output in plan.get("expected_outputs", []) if isinstance(output, str)]
    anchors = [
        "python3 scripts/ai_eda/execute_cuda_run_plan.py --plan build/ai_eda/cuda_training_payloads/<cuda-host>/cuda_training_run_plan.json --run-id <cuda-host>",
        "python3 scripts/ai_eda/check_cuda_run_plan_execution.py --report build/ai_eda/cuda_run_plan_execution/<cuda-host>/cuda_run_plan_execution.json",
        "python3 scripts/ai_eda/check_cuda_run_plan_safety_matrix.py --plan build/ai_eda/cuda_training_payloads/<cuda-host>/cuda_training_run_plan.json --run-id <cuda-host>",
        "make PYTHON=python3 AI_EDA_RUN_ID=<cuda-host> ai-eda-cuda-readiness-audit",
        "python3 scripts/ai_eda/build_training_corpus_manifest.py --run-id <cuda-host>",
        "python3 scripts/ai_eda/train_macro_placement_torch_regressor.py --run-id <cuda-host> --device auto --epochs 200",
        "python3 scripts/ai_eda/infer_macro_placement_torch_regressor.py --run-id <cuda-host> --device auto",
        "python3 scripts/ai_eda/replay_macro_placement_on_e1.py --run-id <cuda-host> --plan build/ai_eda/macro_placement_replay/<cuda-host>/replay_plan.json",
    ]
    missing = [command for command in anchors if command not in commands]
    if missing:
        raise SystemExit(f"runbook anchor commands missing from plan: {', '.join(missing)}")

    path = out_dir / "cuda_handoff_README.md"
    lines = [
        "# CUDA AI-EDA Handoff Runbook",
        "",
        f"Run ID: `{args.run_id}`",
        "",
        "This runbook is generated from `cuda_training_run_plan.json`. It is an",
        "operator guide only: the payload contains source manifests and scripts, not",
        "external datasets, model weights, foundry confidential files, build outputs,",
        "or release/signoff evidence.",
        "",
        "## Required First Pass",
        "",
        "Use a host-specific run id in place of `<cuda-host>` and validate the run",
        "plan before executing any risky stage.",
        "",
        "```sh",
        anchors[0],
        anchors[1],
        anchors[2],
        "```",
        "",
        "## Metadata And Readiness Gates",
        "",
        "```sh",
        commands[0],
        commands[1],
        commands[2],
        commands[3],
        commands[4],
        commands[5],
        commands[6],
        commands[7],
        commands[8],
        commands[9],
        commands[10],
        anchors[3],
        "```",
        "",
        "## Corpus, Training, Inference, Replay",
        "",
        "These commands are still subject to `execute_cuda_run_plan.py --execute`",
        "stage selection and explicit allow flags for downloads, training, inference,",
        "replay, and AlphaChip actions.",
        "",
        "```sh",
        anchors[4],
        anchors[5],
        anchors[6],
        anchors[7],
        "```",
        "",
        "## Expected Anchor Outputs",
        "",
    ]
    for output in outputs:
        if any(token in output for token in ("cuda_run_plan_execution", "cuda_readiness_audit", "training_corpus_manifest", "macro_placement_torch", "macro_placement_replay_preflight")):
            lines.append(f"- `{output}`")
    lines.extend(
        [
            "",
            "## Claim Boundary",
            "",
            f"`{CLAIM_BOUNDARY}`",
            "",
            "No result from this runbook is an E1 optimization, PPA, signoff, or release",
            "claim until the deterministic E1 replay and evidence gates accept it.",
            "",
        ]
    )
    path.write_text("\n".join(lines), encoding="utf-8")
    return path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
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
    runbook_path = write_runbook(out_dir, plan_path, args)
    tar_path = out_dir / "cuda_training_payload.tar.gz"
    include_paths = include_files()
    with tarfile.open(tar_path, "w:gz") as archive:
        for path in include_paths:
            archive.add(path, arcname=str(path.relative_to(ROOT)))
        archive.add(plan_path, arcname="cuda_training_run_plan.json")
        archive.add(runbook_path, arcname="cuda_handoff_README.md")
    report = {
        "schema": "eliza.ai_eda.cuda_training_payload_report.v1",
        "created_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "asset_count": len(selected),
        "included_file_count": len(include_paths) + 2,
        "payload": str(tar_path.relative_to(ROOT)),
        "run_plan": str(plan_path.relative_to(ROOT)),
        "runbook": str(runbook_path.relative_to(ROOT)),
        "release_use_allowed": False,
    }
    report_path = out_dir / "cuda_training_payload_report.json"
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(f"STATUS: PASS ai_eda.cuda_training_payload {report_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
