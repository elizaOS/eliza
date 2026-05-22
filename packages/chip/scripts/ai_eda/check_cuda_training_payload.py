#!/usr/bin/env python3
"""Validate CUDA AI-EDA training payload reports and tarballs."""

from __future__ import annotations

import argparse
import json
import re
import tarfile
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REPORT = (
    ROOT / "build/ai_eda/cuda_training_payloads/validation/cuda_training_payload_report.json"
)
LOCKFILE = ROOT / "external/SOURCES.lock.yaml"
EXPECTED_REPORT_SCHEMA = "eliza.ai_eda.cuda_training_payload_report.v1"
EXPECTED_PLAN_SCHEMA = "eliza.ai_eda.cuda_training_payload.v1"
EXPECTED_CLAIM_BOUNDARY = "cuda_training_payload_metadata_only_no_dataset_weights_or_training_claim"

CRITICAL_FETCH_ASSETS = {
    "abc-rl",
    "abcrl",
    "aieda-idata",
    "assertllm",
    "audopeda",
    "chipbench-d",
    "chipdiffusion",
    "chipformer",
    "chiplingo",
    "circuitnet3",
    "core-placement",
    "dreamplace",
    "edalearn",
    "fault-dft",
    "intel-floorset",
    "llm4dv",
    "macro-place-challenge-2026",
    "maptune",
    "mcp4eda",
    "mlcad-2023-fpga-macro",
    "openabc-d",
    "open3dbench",
    "openroad-agent",
    "openroad-mcp",
    "orfs-agent",
    "ppa-3dic-surrogate-2026",
    "r-zoo-rectilinear-floorplan",
    "rl4ls",
    "rtlmul",
    "veoplace-vlm",
    "verireason",
    "verireason-rtl-coder-reasoning-combined",
    "verireason-rtl-coder-reasoning-hard",
    "verireason-rtl-coder-reasoning-simple",
    "verireason-rtl-coder-small",
}

REQUIRED_PLAN_COMMANDS = (
    "python3 scripts/ai_eda/bootstrap_ai_eda_stack.py --profile metadata --run-id <cuda-host>",
    "python3 scripts/ai_eda/preflight_cuda_training_stack.py --run-id <cuda-host>",
    "python3 scripts/ai_eda/preflight_ai_eda_backends.py --run-id <cuda-host>",
    "python3 scripts/ai_eda/check_backend_preflight.py --report build/ai_eda/backend_preflight/<cuda-host>/backend_preflight_report.json",
    "python3 scripts/ai_eda/check_ai_workload_manifest.py",
    "python3 scripts/ai_eda/check_external_method_wrapper_readiness.py",
    "python3 scripts/ai_eda/check_assertion_candidate_manifests.py",
    "python3 scripts/ai_eda/evaluate_rtl_model.py --run-id <cuda-host> --dry-run",
    "python3 scripts/ai_eda/check_rtl_model_evaluation.py --report build/ai_eda/rtl_model_eval/<cuda-host>/eval_report.json",
    "python3 scripts/ai_eda/execute_cuda_run_plan.py --plan build/ai_eda/cuda_training_payloads/<cuda-host>/cuda_training_run_plan.json --run-id <cuda-host>",
    "python3 scripts/ai_eda/check_cuda_run_plan_execution.py --report build/ai_eda/cuda_run_plan_execution/<cuda-host>/cuda_run_plan_execution.json",
    "python3 scripts/ai_eda/check_cuda_run_plan_safety_matrix.py --plan build/ai_eda/cuda_training_payloads/<cuda-host>/cuda_training_run_plan.json --run-id <cuda-host>",
    "python3 scripts/ai_eda/capture_cuda_full_training_matrix.py --run-id <cuda-host> --payload-run-id <cuda-host> --preflight-run-id <cuda-host>",
    "python3 scripts/ai_eda/check_cuda_full_training_matrix.py --report build/ai_eda/cuda_full_training_matrix/<cuda-host>/cuda_full_training_matrix.json",
    "python3 scripts/ai_eda/capture_formal_verification_prerequisites.py --run-id <cuda-host>",
    "python3 scripts/ai_eda/check_formal_verification_prerequisites.py --report build/ai_eda/formal_verification_prerequisites/<cuda-host>/formal_verification_prerequisites.json",
    "scripts/run_formal.sh",
    "python3 scripts/ai_eda/capture_formal_execution_evidence.py --run-id <cuda-host>",
    "python3 scripts/ai_eda/check_formal_execution_evidence.py --report build/ai_eda/formal_execution_evidence/<cuda-host>/formal_execution_evidence.json",
    "python3 scripts/ai_eda/run_formal_solver_isolation.py --run-id <cuda-host>",
    "python3 scripts/ai_eda/check_formal_solver_isolation.py --report build/ai_eda/formal_solver_isolation/<cuda-host>/formal_solver_isolation.json",
    "make PYTHON=python3 AI_EDA_RUN_ID=<cuda-host> ai-eda-cuda-readiness-audit",
    "python3 scripts/ai_eda/capture_cuda_readiness_audit.py --run-id <cuda-host> --formal-prerequisites-run-id <cuda-host> --formal-execution-run-id <cuda-host>",
    "python3 scripts/ai_eda/check_cuda_readiness_audit.py --report build/ai_eda/cuda_readiness_audit/<cuda-host>/cuda_readiness_audit.json",
    "python3 scripts/ai_eda/package_cuda_evidence_bundle.py --run-id <cuda-host>",
    "python3 scripts/ai_eda/check_cuda_evidence_bundle.py --report build/ai_eda/cuda_evidence_bundles/<cuda-host>/cuda_evidence_bundle.json",
    "python3 scripts/ai_eda/capture_ai_eda_objective_readiness.py --run-id <cuda-host> --readiness-run-id <cuda-host> --evidence-bundle-run-id <cuda-host> --training-handoff-run-id <cuda-host>-training-handoff --replay-handoff-run-id <cuda-host>",
    "python3 scripts/ai_eda/check_ai_eda_objective_readiness.py --report build/ai_eda/objective_readiness/<cuda-host>/objective_readiness.json",
    "python3 scripts/ai_eda/capture_alphachip_successor_plan.py --run-id <cuda-host> --training-corpus-run-id <cuda-host> --training-handoff-run-id <cuda-host>-training-handoff",
    "python3 scripts/ai_eda/check_alphachip_successor_plan.py --report build/ai_eda/alphachip_successor_plan/<cuda-host>/alphachip_successor_plan.json",
    "python3 scripts/ai_eda/capture_alphachip_successor_reproduction.py --run-id <cuda-host> --training-handoff-run-id <cuda-host>-training-handoff --full-training-matrix-run-id <cuda-host> --replay-comparison-run-id <cuda-host>",
    "python3 scripts/ai_eda/check_alphachip_successor_reproduction.py --report build/ai_eda/alphachip_successor_reproduction/<cuda-host>/alphachip_successor_reproduction.json",
    "python3 scripts/ai_eda/train_macro_placement_torch_regressor.py --run-id <cuda-host> --device auto --epochs 200",
    "python3 scripts/ai_eda/infer_macro_placement_torch_regressor.py --run-id <cuda-host> --device auto",
    "python3 scripts/ai_eda/convert_circuitnet3_to_internal_records.py --run-id <cuda-host> --all-records",
    "python3 scripts/ai_eda/convert_chipbench_d_to_internal_records.py --run-id <cuda-host> --all-records",
    "python3 scripts/ai_eda/convert_openabc_d_to_internal_records.py --run-id <cuda-host> --all-records",
    "python3 scripts/ai_eda/convert_aieda_idata_to_internal_records.py --run-id <cuda-host> --all-records",
    "python3 scripts/ai_eda/convert_edalearn_to_internal_records.py --run-id <cuda-host> --all-records",
    "python3 scripts/ai_eda/check_edalearn_conversion.py --report build/ai_eda/edalearn/<cuda-host>/conversion_report.json",
    "python3 scripts/ai_eda/convert_macro_place_challenge_2026_to_internal_records.py --run-id <cuda-host> --all-records",
    "python3 scripts/ai_eda/check_macro_place_challenge_2026_conversion.py --report build/ai_eda/macro_place_challenge_2026/<cuda-host>/conversion_report.json",
    "python3 scripts/ai_eda/convert_mlcad_2023_fpga_macro_to_internal_records.py --run-id <cuda-host>",
    "python3 scripts/ai_eda/check_mlcad_2023_fpga_macro_conversion.py --report build/ai_eda/mlcad_2023_fpga_macro/<cuda-host>/conversion_report.json",
    "python3 scripts/ai_eda/capture_floorset_license_review.py --run-id <cuda-host>",
    "python3 scripts/ai_eda/check_floorset_license_review.py --report build/ai_eda/floorset_license_review/<cuda-host>/license_review.json",
    "python3 scripts/ai_eda/capture_floorset_hf_archive_manifest.py --run-id <cuda-host>",
    "python3 scripts/ai_eda/check_floorset_hf_archive_manifest.py --report build/ai_eda/floorset_hf_archives/<cuda-host>/archive_manifest.json",
    "python3 scripts/ai_eda/convert_floorset_lite_to_internal_records.py --run-id <cuda-host>",
    "python3 scripts/ai_eda/check_floorset_lite_conversion.py --report build/ai_eda/floorset_lite/<cuda-host>/conversion_report.json",
    "python3 scripts/ai_eda/capture_floorset_split_manifest.py --run-id <cuda-host>",
    "python3 scripts/ai_eda/check_floorset_split_manifest.py --report build/ai_eda/floorset_lite_splits/<cuda-host>/split_manifest.json",
    "python3 scripts/ai_eda/convert_r_zoo_to_internal_records.py --run-id <cuda-host>",
    "python3 scripts/ai_eda/check_r_zoo_conversion.py --report build/ai_eda/r_zoo_rectilinear_floorplan/<cuda-host>/conversion_report.json",
    "python3 scripts/ai_eda/capture_r_zoo_split_manifest.py --run-id <cuda-host>",
    "python3 scripts/ai_eda/check_r_zoo_split_manifest.py --report build/ai_eda/r_zoo_rectilinear_floorplan_splits/<cuda-host>/split_manifest.json",
    "python3 scripts/ai_eda/capture_r_zoo_license_review.py --run-id <cuda-host>",
    "python3 scripts/ai_eda/check_r_zoo_license_review.py --report build/ai_eda/r_zoo_license_review/<cuda-host>/license_review.json",
    "python3 scripts/ai_eda/capture_floorplanning_dataset_readiness.py --run-id <cuda-host>",
    "python3 scripts/ai_eda/check_floorplanning_dataset_readiness.py --report build/ai_eda/floorplanning_dataset_readiness/<cuda-host>/floorplanning_dataset_readiness.json",
    "python3 scripts/ai_eda/train_r_zoo_legality_baseline.py --run-id <cuda-host> --record-dir build/ai_eda/r_zoo_rectilinear_floorplan/<cuda-host>/records --split-manifest build/ai_eda/r_zoo_rectilinear_floorplan_splits/<cuda-host>/split_manifest.json",
    "python3 scripts/ai_eda/check_r_zoo_legality_baseline.py --report build/ai_eda/r_zoo_legality_baseline/<cuda-host>/training_run.json",
    "python3 scripts/ai_eda/convert_research_code_assets_to_internal_records.py --run-id <cuda-host>",
    "python3 scripts/ai_eda/check_research_code_assets_conversion.py --report build/ai_eda/research_code_assets/<cuda-host>/conversion_report.json",
    "python3 scripts/ai_eda/convert_current_research_watchlist_to_internal_records.py --run-id <cuda-host>",
    "python3 scripts/ai_eda/check_current_research_watchlist_records.py --report build/ai_eda/current_research_watchlist_records/<cuda-host>/conversion_report.json",
    "python3 scripts/ai_eda/convert_verireason_rtl_coder_to_internal_records.py --run-id <cuda-host>",
    "python3 scripts/ai_eda/check_verireason_rtl_coder_conversion.py --report build/ai_eda/verireason_rtl_coder/<cuda-host>/conversion_report.json",
    "python3 scripts/ai_eda/materialize_internal_dataset_fixtures.py --run-id <cuda-host>",
    "python3 scripts/ai_eda/parse_openlane_metrics_to_flow_run.py --run-id <cuda-host>",
    "python3 scripts/ai_eda/check_openlane_flow_labels.py --report build/ai_eda/openlane_flow_labels/<cuda-host>/label-parse-report.json",
    "python3 scripts/ai_eda/convert_external_fixture_corpora.py --run-id <cuda-host>",
    "python3 scripts/ai_eda/check_internal_dataset_schemas.py --records-dir build/ai_eda/converted_external_fixtures/<cuda-host>/records",
    "python3 scripts/ai_eda/materialize_e1_softmacro_cases.py --run-id <cuda-host>",
    "python3 scripts/ai_eda/check_internal_dataset_schemas.py --records-dir build/ai_eda/e1_softmacro_cases/<cuda-host>/records",
    "python3 scripts/ai_eda/build_training_corpus_manifest.py --run-id <cuda-host>",
    "python3 scripts/ai_eda/check_training_corpus_manifest.py --manifest build/ai_eda/training_corpus_manifest/<cuda-host>/training_corpus_manifest.json",
    "python3 scripts/ai_eda/capture_openroad_ml_snapshot.py --run-id <cuda-host>",
    "python3 scripts/ai_eda/check_openroad_ml_snapshot.py --report build/ai_eda/pd_predictor_dataset/<cuda-host>/snapshot_manifest.json",
    "python3 scripts/ai_eda/check_macro_placement_baseline.py --report build/ai_eda/macro_placement_policy/<cuda-host>/macro_placement_baseline_report.json",
    "python3 scripts/ai_eda/select_macro_placement_replay_queue.py --run-id <cuda-host>",
    "python3 scripts/ai_eda/check_macro_placement_replay_queue.py --report build/ai_eda/macro_placement_replay_queue/<cuda-host>/replay_queue.json",
    "python3 scripts/ai_eda/capture_openlane_replay_prerequisites.py --run-id <cuda-host>",
    "python3 scripts/ai_eda/check_openlane_replay_prerequisites.py --report build/ai_eda/openlane_replay_prerequisites/<cuda-host>/openlane_replay_prerequisites.json",
    "python3 scripts/ai_eda/replay_macro_placement_on_e1.py --run-id <cuda-host> --plan build/ai_eda/macro_placement_replay/<cuda-host>/replay_plan.json",
    "python3 scripts/ai_eda/check_macro_placement_replay_preflight.py --report build/ai_eda/macro_placement_replay_preflight/<cuda-host>/replay_preflight_report.json",
    "python3 scripts/ai_eda/package_openlane_replay_handoff.py --run-id <cuda-host>",
    "python3 scripts/ai_eda/check_openlane_replay_handoff.py --report build/ai_eda/openlane_replay_handoff/<cuda-host>/openlane_replay_handoff.json",
    "python3 scripts/ai_eda/capture_openlane_replay_execution.py --run-id <cuda-host>-baseline --replay-role baseline --candidate-id e1-openlane-baseline --metrics <baseline-final-metrics.json> --openlane-log <baseline-openlane.log> --openroad-log <baseline-openroad.log> --def-file <baseline-final.def> --gds-file <baseline-final.gds>",
    "python3 scripts/ai_eda/check_openlane_replay_execution.py --report build/ai_eda/openlane_replay_execution/<cuda-host>-baseline/openlane_replay_execution.json",
    "python3 scripts/ai_eda/capture_openlane_replay_execution.py --run-id <cuda-host> --replay-role candidate --candidate-id <candidate-id> --metrics <candidate-final-metrics.json> --openlane-log <candidate-openlane.log> --openroad-log <candidate-openroad.log> --def-file <candidate-final.def> --gds-file <candidate-final.gds> --replay-queue build/ai_eda/macro_placement_replay_queue/<cuda-host>/replay_queue.json --replay-preflight build/ai_eda/macro_placement_replay_preflight/<cuda-host>/replay_preflight_report.json --replay-handoff build/ai_eda/openlane_replay_handoff/<cuda-host>/openlane_replay_handoff.json",
    "python3 scripts/ai_eda/check_openlane_replay_execution.py --report build/ai_eda/openlane_replay_execution/<cuda-host>/openlane_replay_execution.json",
    "python3 scripts/ai_eda/capture_openlane_replay_comparison.py --run-id <cuda-host> --baseline-execution build/ai_eda/openlane_replay_execution/<cuda-host>-baseline/openlane_replay_execution.json --candidate-execution build/ai_eda/openlane_replay_execution/<cuda-host>/openlane_replay_execution.json",
    "python3 scripts/ai_eda/check_openlane_replay_comparison.py --report build/ai_eda/openlane_replay_comparison/<cuda-host>/openlane_replay_comparison.json",
    "python3 scripts/ai_eda/check_verification_target_captures.py --run-id <cuda-host>",
    "python3 scripts/ai_eda/check_physical_design_target_captures.py --run-id <cuda-host>",
    "python3 scripts/ai_eda/capture_current_research_watchlist.py --run-id <cuda-host>",
    "python3 scripts/ai_eda/check_current_research_watchlist.py --report build/ai_eda/current_research_watchlist/<cuda-host>/targets_report.json",
    "python3 scripts/ai_eda/check_ai_optimization_target_captures.py --run-id <cuda-host>",
    "make PYTHON=python3 AI_EDA_RUN_ID=<cuda-host> ai-eda-all-target-captures",
)

REQUIRED_RUNBOOK_MEMBER = "cuda_handoff_README.md"
REQUIRED_RUNBOOK_COMMANDS = (
    "python3 scripts/ai_eda/execute_cuda_run_plan.py --plan build/ai_eda/cuda_training_payloads/<cuda-host>/cuda_training_run_plan.json --run-id <cuda-host>",
    "python3 scripts/ai_eda/check_cuda_run_plan_execution.py --report build/ai_eda/cuda_run_plan_execution/<cuda-host>/cuda_run_plan_execution.json",
    "python3 scripts/ai_eda/check_cuda_run_plan_safety_matrix.py --plan build/ai_eda/cuda_training_payloads/<cuda-host>/cuda_training_run_plan.json --run-id <cuda-host>",
    "python3 scripts/ai_eda/capture_cuda_full_training_matrix.py --run-id <cuda-host> --payload-run-id <cuda-host> --preflight-run-id <cuda-host>",
    "python3 scripts/ai_eda/check_cuda_full_training_matrix.py --report build/ai_eda/cuda_full_training_matrix/<cuda-host>/cuda_full_training_matrix.json",
    "python3 scripts/ai_eda/capture_formal_verification_prerequisites.py --run-id <cuda-host>",
    "python3 scripts/ai_eda/check_formal_verification_prerequisites.py --report build/ai_eda/formal_verification_prerequisites/<cuda-host>/formal_verification_prerequisites.json",
    "make PYTHON=python3 AI_EDA_RUN_ID=<cuda-host> ai-eda-cuda-readiness-audit",
    "python3 scripts/ai_eda/build_training_corpus_manifest.py --run-id <cuda-host>",
    "python3 scripts/ai_eda/train_macro_placement_torch_regressor.py --run-id <cuda-host> --device auto --epochs 200",
    "python3 scripts/ai_eda/infer_macro_placement_torch_regressor.py --run-id <cuda-host> --device auto",
    "python3 scripts/ai_eda/replay_macro_placement_on_e1.py --run-id <cuda-host> --plan build/ai_eda/macro_placement_replay/<cuda-host>/replay_plan.json",
    "python3 scripts/ai_eda/capture_alphachip_successor_reproduction.py --run-id <cuda-host> --training-handoff-run-id <cuda-host>-training-handoff --full-training-matrix-run-id <cuda-host> --replay-comparison-run-id <cuda-host>",
    "python3 scripts/ai_eda/check_alphachip_successor_reproduction.py --report build/ai_eda/alphachip_successor_reproduction/<cuda-host>/alphachip_successor_reproduction.json",
    "python3 scripts/ai_eda/convert_verireason_rtl_coder_to_internal_records.py --run-id <cuda-host>",
    "python3 scripts/ai_eda/check_verireason_rtl_coder_conversion.py --report build/ai_eda/verireason_rtl_coder/<cuda-host>/conversion_report.json",
)

REQUIRED_OUTPUTS = {
    "build/ai_eda/analog_mixed_signal_targets/<run-id>/targets_report.json",
    "build/ai_eda/backend_preflight/<run-id>/backend_preflight_report.json",
    "build/ai_eda/benchmark_evaluation_hygiene_targets/<run-id>/targets_report.json",
    "build/ai_eda/board_package_fpga_targets/<run-id>/targets_report.json",
    "build/ai_eda/cdc_rdc_targets/<run-id>/targets_report.json",
    "build/ai_eda/chiplet_3dic_package_targets/<run-id>/targets_report.json",
    "build/ai_eda/circuit_foundation_model_targets/<run-id>/targets_report.json",
    "build/ai_eda/clock_tree_targets/<run-id>/targets_report.json",
    "build/ai_eda/compiler_autotuning_targets/<run-id>/targets_report.json",
    "build/ai_eda/cpu_microarchitecture_targets/<run-id>/targets_report.json",
    "build/ai_eda/current_research_watchlist/<run-id>/targets_report.json",
    "build/ai_eda/current_research_watchlist_records/<run-id>/conversion_report.json",
    "build/ai_eda/current_research_watchlist_records/<run-id>/records/*.json",
    "build/ai_eda/verireason_rtl_coder/<run-id>/conversion_report.json",
    "build/ai_eda/verireason_rtl_coder/<run-id>/records/*.json",
    "build/ai_eda/rtl_model_eval/<run-id>/eval_report.json",
    "build/ai_eda/training_corpus_manifest/<run-id>/training_corpus_manifest.json",
    "build/ai_eda/cuda_readiness_audit/<run-id>/cuda_readiness_audit.json",
    "build/ai_eda/cuda_run_plan_execution/<run-id>/cuda_run_plan_execution.json",
    "build/ai_eda/cuda_run_plan_safety_matrix/<run-id>/cuda_run_plan_safety_matrix.json",
    "build/ai_eda/cuda_full_training_matrix/<run-id>/cuda_full_training_matrix.json",
    "build/ai_eda/cuda_evidence_bundles/<run-id>/cuda_evidence_bundle.json",
    "build/ai_eda/objective_readiness/<run-id>/objective_readiness.json",
    "build/ai_eda/alphachip_successor_plan/<run-id>/alphachip_successor_plan.json",
    "build/ai_eda/alphachip_successor_reproduction/<run-id>/alphachip_successor_reproduction.json",
    "build/ai_eda/cuda_training_preflight/<run-id>/cuda_training_preflight.json",
    "build/ai_eda/dfm_yield_lithography_targets/<run-id>/targets_report.json",
    "build/ai_eda/dft_atpg_targets/<run-id>/targets_report.json",
    "build/ai_eda/eda_tool_agent_interop_targets/<run-id>/targets_report.json",
    "build/ai_eda/edalearn/<run-id>/conversion_report.json",
    "build/ai_eda/edalearn/<run-id>/records/*.json",
    "build/ai_eda/external_model_corpus_intake_targets/<run-id>/targets_report.json",
    "build/ai_eda/internal_dataset_fixtures/<run-id>/internal_dataset_fixture_report.json",
    "build/ai_eda/internal_dataset_fixtures/<run-id>/records/*.json",
    "build/ai_eda/extraction_parasitic_targets/<run-id>/targets_report.json",
    "build/ai_eda/floorplan_io_pdn_targets/<run-id>/targets_report.json",
    "build/ai_eda/formal_verification_prerequisites/<run-id>/formal_verification_prerequisites.json",
    "build/ai_eda/formal_execution_evidence/<run-id>/formal_execution_evidence.json",
    "build/ai_eda/formal_solver_isolation/<run-id>/formal_solver_isolation.json",
    "build/ai_eda/hardware_security_targets/<run-id>/targets_report.json",
    "build/ai_eda/hls_accelerator_targets/<run-id>/targets_report.json",
    "build/ai_eda/ip_register_contract_targets/<run-id>/targets_report.json",
    "build/ai_eda/logic_synthesis_targets/<run-id>/targets_report.json",
    "build/ai_eda/low_power_intent_targets/<run-id>/targets_report.json",
    "build/ai_eda/macro_place_challenge_2026/<run-id>/conversion_report.json",
    "build/ai_eda/macro_place_challenge_2026/<run-id>/records/*.json",
    "build/ai_eda/mlcad_2023_fpga_macro/<run-id>/conversion_report.json",
    "build/ai_eda/mlcad_2023_fpga_macro/<run-id>/records/*.json",
    "build/ai_eda/floorset_license_review/<run-id>/license_review.json",
    "build/ai_eda/floorset_hf_archives/<run-id>/archive_manifest.json",
    "build/ai_eda/floorset_lite/<run-id>/conversion_report.json",
    "build/ai_eda/floorset_lite/<run-id>/records/*.json",
    "build/ai_eda/floorset_lite_splits/<run-id>/split_manifest.json",
    "build/ai_eda/floorplanning_dataset_readiness/<run-id>/floorplanning_dataset_readiness.json",
    "build/ai_eda/r_zoo_rectilinear_floorplan/<run-id>/conversion_report.json",
    "build/ai_eda/r_zoo_rectilinear_floorplan/<run-id>/records/*.json",
    "build/ai_eda/r_zoo_rectilinear_floorplan_splits/<run-id>/split_manifest.json",
    "build/ai_eda/r_zoo_license_review/<run-id>/license_review.json",
    "build/ai_eda/r_zoo_legality_baseline/<run-id>/training_run.json",
    "build/ai_eda/r_zoo_legality_baseline/<run-id>/r_zoo_legality_model.json",
    "build/ai_eda/r_zoo_legality_baseline/<run-id>/metrics.json",
    "build/ai_eda/openroad_eda_corpus/<run-id>/conversion_report.json",
    "build/ai_eda/openroad_eda_corpus/<run-id>/records/*.json",
    "build/ai_eda/openroad_eda_corpus/<run-id>/train.jsonl",
    "build/ai_eda/openroad_eda_corpus/<run-id>/val.jsonl",
    "build/ai_eda/openroad_eda_corpus/<run-id>/test.jsonl",
    "build/ai_eda/openlane_flow_labels/<run-id>/label-parse-report.json",
    "build/ai_eda/openlane_flow_labels/<run-id>/records/*.json",
    "build/ai_eda/converted_external_fixtures/<run-id>/conversion_report.json",
    "build/ai_eda/converted_external_fixtures/<run-id>/records/*.json",
    "build/ai_eda/pd_predictor_dataset/<run-id>/snapshot_manifest.json",
    "build/ai_eda/pd_predictor_dataset/<run-id>/label_report.json",
    "build/ai_eda/research_code_assets/<run-id>/conversion_report.json",
    "build/ai_eda/research_code_assets/<run-id>/records/*.json",
    "build/ai_eda/e1_softmacro_cases/<run-id>/materialization_report.json",
    "build/ai_eda/e1_softmacro_cases/<run-id>/records/*.json",
    "build/ai_eda/macro_placement_replay_preflight/<run-id>/replay_preflight_report.json",
    "build/ai_eda/openlane_replay_handoff/<run-id>/openlane_replay_handoff.json",
    "build/ai_eda/openlane_replay_handoff/<run-id>/pd_host_replay_runbook.md",
    "build/ai_eda/openlane_replay_handoff/<run-id>/pd_host_replay_commands.sh",
    "build/ai_eda/openlane_replay_execution/<run-id>/openlane_replay_execution.json",
    "build/ai_eda/openlane_replay_comparison/<run-id>/openlane_replay_comparison.json",
    "build/ai_eda/macro_placement_replay_queue/<run-id>/replay_queue.json",
    "build/ai_eda/openlane_replay_prerequisites/<run-id>/openlane_replay_prerequisites.json",
    "build/ai_eda/macro_placement_torch_regressor/<run-id>/torch_regressor.pt",
    "build/ai_eda/memory_interconnect_targets/<run-id>/targets_report.json",
    "build/ai_eda/memory_macro_library_targets/<run-id>/targets_report.json",
    "build/ai_eda/netlist_equivalence_targets/<run-id>/targets_report.json",
    "build/ai_eda/physical_verification_targets/<run-id>/targets_report.json",
    "build/ai_eda/placement_legalization_targets/<run-id>/targets_report.json",
    "build/ai_eda/post_silicon_validation_targets/<run-id>/targets_report.json",
    "build/ai_eda/power_thermal_targets/<run-id>/targets_report.json",
    "build/ai_eda/reliability_resilience_targets/<run-id>/targets_report.json",
    "build/ai_eda/routing_congestion_targets/<run-id>/targets_report.json",
    "build/ai_eda/rtl_rewrite_equivalence_targets/<run-id>/targets_report.json",
    "build/ai_eda/simulator_optimization/<run-id>/targets_report.json",
    "build/ai_eda/software_bsp_firmware_targets/<run-id>/targets_report.json",
    "build/ai_eda/spec_traceability_targets/<run-id>/targets_report.json",
    "build/ai_eda/timing_closure_targets/<run-id>/targets_report.json",
    "build/ai_eda/verification_debug_targets/<run-id>/targets_report.json",
}

ORDER_CONSTRAINTS = (
    (
        "python3 scripts/ai_eda/check_cuda_run_plan_safety_matrix.py --plan build/ai_eda/cuda_training_payloads/<cuda-host>/cuda_training_run_plan.json --run-id <cuda-host>",
        "python3 scripts/ai_eda/capture_cuda_full_training_matrix.py --run-id <cuda-host> --payload-run-id <cuda-host> --preflight-run-id <cuda-host>",
        "safety matrix before full training matrix",
    ),
    (
        "python3 scripts/ai_eda/capture_cuda_full_training_matrix.py --run-id <cuda-host> --payload-run-id <cuda-host> --preflight-run-id <cuda-host>",
        "python3 scripts/ai_eda/check_cuda_full_training_matrix.py --report build/ai_eda/cuda_full_training_matrix/<cuda-host>/cuda_full_training_matrix.json",
        "full training matrix before matrix check",
    ),
    (
        "python3 scripts/ai_eda/check_cuda_full_training_matrix.py --report build/ai_eda/cuda_full_training_matrix/<cuda-host>/cuda_full_training_matrix.json",
        "python3 scripts/ai_eda/capture_formal_verification_prerequisites.py --run-id <cuda-host>",
        "full training matrix check before formal prerequisite capture",
    ),
    (
        "python3 scripts/ai_eda/capture_formal_verification_prerequisites.py --run-id <cuda-host>",
        "python3 scripts/ai_eda/check_formal_verification_prerequisites.py --report build/ai_eda/formal_verification_prerequisites/<cuda-host>/formal_verification_prerequisites.json",
        "formal prerequisite capture before formal prerequisite check",
    ),
    (
        "python3 scripts/ai_eda/check_formal_verification_prerequisites.py --report build/ai_eda/formal_verification_prerequisites/<cuda-host>/formal_verification_prerequisites.json",
        "make PYTHON=python3 AI_EDA_RUN_ID=<cuda-host> ai-eda-cuda-readiness-audit",
        "formal prerequisite check before readiness audit",
    ),
    (
        "python3 scripts/ai_eda/check_cuda_readiness_audit.py --report build/ai_eda/cuda_readiness_audit/<cuda-host>/cuda_readiness_audit.json",
        "python3 scripts/ai_eda/package_cuda_evidence_bundle.py --run-id <cuda-host>",
        "readiness audit check before evidence bundle",
    ),
    (
        "python3 scripts/ai_eda/package_cuda_evidence_bundle.py --run-id <cuda-host>",
        "python3 scripts/ai_eda/check_cuda_evidence_bundle.py --report build/ai_eda/cuda_evidence_bundles/<cuda-host>/cuda_evidence_bundle.json",
        "evidence bundle before evidence bundle check",
    ),
    (
        "python3 scripts/ai_eda/check_cuda_evidence_bundle.py --report build/ai_eda/cuda_evidence_bundles/<cuda-host>/cuda_evidence_bundle.json",
        "python3 scripts/ai_eda/capture_ai_eda_objective_readiness.py --run-id <cuda-host> --readiness-run-id <cuda-host> --evidence-bundle-run-id <cuda-host> --training-handoff-run-id <cuda-host>-training-handoff --replay-handoff-run-id <cuda-host>",
        "evidence bundle check before objective readiness audit",
    ),
    (
        "python3 scripts/ai_eda/capture_ai_eda_objective_readiness.py --run-id <cuda-host> --readiness-run-id <cuda-host> --evidence-bundle-run-id <cuda-host> --training-handoff-run-id <cuda-host>-training-handoff --replay-handoff-run-id <cuda-host>",
        "python3 scripts/ai_eda/check_ai_eda_objective_readiness.py --report build/ai_eda/objective_readiness/<cuda-host>/objective_readiness.json",
        "objective readiness audit before objective readiness check",
    ),
    (
        "python3 scripts/ai_eda/check_formal_verification_prerequisites.py --report build/ai_eda/formal_verification_prerequisites/<cuda-host>/formal_verification_prerequisites.json",
        "scripts/run_formal.sh",
        "formal prerequisites check before formal execution",
    ),
    (
        "scripts/run_formal.sh",
        "python3 scripts/ai_eda/capture_formal_execution_evidence.py --run-id <cuda-host>",
        "formal execution before formal evidence capture",
    ),
    (
        "python3 scripts/ai_eda/capture_formal_execution_evidence.py --run-id <cuda-host>",
        "python3 scripts/ai_eda/check_formal_execution_evidence.py --report build/ai_eda/formal_execution_evidence/<cuda-host>/formal_execution_evidence.json",
        "formal evidence capture before formal evidence check",
    ),
    (
        "python3 scripts/ai_eda/check_formal_execution_evidence.py --report build/ai_eda/formal_execution_evidence/<cuda-host>/formal_execution_evidence.json",
        "python3 scripts/ai_eda/run_formal_solver_isolation.py --run-id <cuda-host>",
        "formal evidence check before solver isolation",
    ),
    (
        "python3 scripts/ai_eda/run_formal_solver_isolation.py --run-id <cuda-host>",
        "python3 scripts/ai_eda/check_formal_solver_isolation.py --report build/ai_eda/formal_solver_isolation/<cuda-host>/formal_solver_isolation.json",
        "formal solver isolation before solver isolation check",
    ),
    (
        "python3 scripts/ai_eda/build_training_corpus_manifest.py --run-id <cuda-host>",
        "python3 scripts/ai_eda/capture_alphachip_successor_plan.py --run-id <cuda-host> --training-corpus-run-id <cuda-host> --training-handoff-run-id <cuda-host>-training-handoff",
        "training corpus before AlphaChip successor plan",
    ),
    (
        "python3 scripts/ai_eda/capture_alphachip_successor_plan.py --run-id <cuda-host> --training-corpus-run-id <cuda-host> --training-handoff-run-id <cuda-host>-training-handoff",
        "python3 scripts/ai_eda/check_alphachip_successor_plan.py --report build/ai_eda/alphachip_successor_plan/<cuda-host>/alphachip_successor_plan.json",
        "AlphaChip successor plan before successor plan check",
    ),
    (
        "python3 scripts/ai_eda/check_alphachip_successor_plan.py --report build/ai_eda/alphachip_successor_plan/<cuda-host>/alphachip_successor_plan.json",
        "python3 scripts/ai_eda/capture_alphachip_successor_reproduction.py --run-id <cuda-host> --training-handoff-run-id <cuda-host>-training-handoff --full-training-matrix-run-id <cuda-host> --replay-comparison-run-id <cuda-host>",
        "AlphaChip successor plan check before successor reproduction capture",
    ),
    (
        "python3 scripts/ai_eda/capture_alphachip_successor_reproduction.py --run-id <cuda-host> --training-handoff-run-id <cuda-host>-training-handoff --full-training-matrix-run-id <cuda-host> --replay-comparison-run-id <cuda-host>",
        "python3 scripts/ai_eda/check_alphachip_successor_reproduction.py --report build/ai_eda/alphachip_successor_reproduction/<cuda-host>/alphachip_successor_reproduction.json",
        "AlphaChip successor reproduction capture before reproduction check",
    ),
    (
        "python3 scripts/ai_eda/check_openlane_replay_comparison.py --report build/ai_eda/openlane_replay_comparison/<cuda-host>/openlane_replay_comparison.json",
        "python3 scripts/ai_eda/capture_alphachip_successor_reproduction.py --run-id <cuda-host> --training-handoff-run-id <cuda-host>-training-handoff --full-training-matrix-run-id <cuda-host> --replay-comparison-run-id <cuda-host>",
        "OpenLane replay comparison before successor reproduction capture",
    ),
    (
        "python3 scripts/ai_eda/check_alphachip_successor_reproduction.py --report build/ai_eda/alphachip_successor_reproduction/<cuda-host>/alphachip_successor_reproduction.json",
        "python3 scripts/ai_eda/capture_ai_eda_objective_readiness.py --run-id <cuda-host> --readiness-run-id <cuda-host> --evidence-bundle-run-id <cuda-host> --training-handoff-run-id <cuda-host>-training-handoff --replay-handoff-run-id <cuda-host>",
        "AlphaChip successor reproduction check before objective readiness audit",
    ),
    (
        "python3 scripts/ai_eda/materialize_internal_dataset_fixtures.py --run-id <cuda-host>",
        "python3 scripts/ai_eda/build_training_corpus_manifest.py --run-id <cuda-host>",
        "internal fixtures before corpus manifest",
    ),
    (
        "python3 scripts/ai_eda/convert_openroad_eda_corpus.py --run-id <cuda-host>",
        "python3 scripts/ai_eda/build_training_corpus_manifest.py --run-id <cuda-host>",
        "OpenROAD EDA Corpus conversion before corpus manifest",
    ),
    (
        "python3 scripts/ai_eda/convert_tilos_macroplacement.py --run-id <cuda-host>",
        "python3 scripts/ai_eda/build_training_corpus_manifest.py --run-id <cuda-host>",
        "TILOS conversion before corpus manifest",
    ),
    (
        "python3 scripts/ai_eda/convert_circuitnet3_to_internal_records.py --run-id <cuda-host> --all-records",
        "python3 scripts/ai_eda/build_training_corpus_manifest.py --run-id <cuda-host>",
        "CircuitNet3 conversion before corpus manifest",
    ),
    (
        "python3 scripts/ai_eda/convert_chipbench_d_to_internal_records.py --run-id <cuda-host> --all-records",
        "python3 scripts/ai_eda/build_training_corpus_manifest.py --run-id <cuda-host>",
        "ChiPBench-D conversion before corpus manifest",
    ),
    (
        "python3 scripts/ai_eda/convert_openabc_d_to_internal_records.py --run-id <cuda-host> --all-records",
        "python3 scripts/ai_eda/build_training_corpus_manifest.py --run-id <cuda-host>",
        "OpenABC-D conversion before corpus manifest",
    ),
    (
        "python3 scripts/ai_eda/convert_aieda_idata_to_internal_records.py --run-id <cuda-host> --all-records",
        "python3 scripts/ai_eda/build_training_corpus_manifest.py --run-id <cuda-host>",
        "AIEDA iDATA conversion before corpus manifest",
    ),
    (
        "python3 scripts/ai_eda/convert_edalearn_to_internal_records.py --run-id <cuda-host> --all-records",
        "python3 scripts/ai_eda/build_training_corpus_manifest.py --run-id <cuda-host>",
        "EDALearn conversion before corpus manifest",
    ),
    (
        "python3 scripts/ai_eda/convert_macro_place_challenge_2026_to_internal_records.py --run-id <cuda-host> --all-records",
        "python3 scripts/ai_eda/build_training_corpus_manifest.py --run-id <cuda-host>",
        "Macro Placement Challenge 2026 conversion before corpus manifest",
    ),
    (
        "python3 scripts/ai_eda/convert_r_zoo_to_internal_records.py --run-id <cuda-host>",
        "python3 scripts/ai_eda/capture_r_zoo_split_manifest.py --run-id <cuda-host>",
        "R-Zoo conversion before split manifest",
    ),
    (
        "python3 scripts/ai_eda/check_r_zoo_split_manifest.py --report build/ai_eda/r_zoo_rectilinear_floorplan_splits/<cuda-host>/split_manifest.json",
        "python3 scripts/ai_eda/capture_floorplanning_dataset_readiness.py --run-id <cuda-host>",
        "R-Zoo split manifest before floorplanning readiness",
    ),
    (
        "python3 scripts/ai_eda/check_r_zoo_license_review.py --report build/ai_eda/r_zoo_license_review/<cuda-host>/license_review.json",
        "python3 scripts/ai_eda/capture_floorplanning_dataset_readiness.py --run-id <cuda-host>",
        "R-Zoo license review before floorplanning readiness",
    ),
    (
        "python3 scripts/ai_eda/capture_r_zoo_license_review.py --run-id <cuda-host>",
        "python3 scripts/ai_eda/check_r_zoo_license_review.py --report build/ai_eda/r_zoo_license_review/<cuda-host>/license_review.json",
        "R-Zoo license review before license check",
    ),
    (
        "python3 scripts/ai_eda/check_r_zoo_split_manifest.py --report build/ai_eda/r_zoo_rectilinear_floorplan_splits/<cuda-host>/split_manifest.json",
        "python3 scripts/ai_eda/train_r_zoo_legality_baseline.py --run-id <cuda-host> --record-dir build/ai_eda/r_zoo_rectilinear_floorplan/<cuda-host>/records --split-manifest build/ai_eda/r_zoo_rectilinear_floorplan_splits/<cuda-host>/split_manifest.json",
        "R-Zoo split manifest before legality baseline",
    ),
    (
        "python3 scripts/ai_eda/check_r_zoo_license_review.py --report build/ai_eda/r_zoo_license_review/<cuda-host>/license_review.json",
        "python3 scripts/ai_eda/train_r_zoo_legality_baseline.py --run-id <cuda-host> --record-dir build/ai_eda/r_zoo_rectilinear_floorplan/<cuda-host>/records --split-manifest build/ai_eda/r_zoo_rectilinear_floorplan_splits/<cuda-host>/split_manifest.json",
        "R-Zoo training-only license review before legality baseline",
    ),
    (
        "python3 scripts/ai_eda/train_r_zoo_legality_baseline.py --run-id <cuda-host> --record-dir build/ai_eda/r_zoo_rectilinear_floorplan/<cuda-host>/records --split-manifest build/ai_eda/r_zoo_rectilinear_floorplan_splits/<cuda-host>/split_manifest.json",
        "python3 scripts/ai_eda/check_r_zoo_legality_baseline.py --report build/ai_eda/r_zoo_legality_baseline/<cuda-host>/training_run.json",
        "R-Zoo legality baseline before baseline check",
    ),
    (
        "python3 scripts/ai_eda/check_r_zoo_legality_baseline.py --report build/ai_eda/r_zoo_legality_baseline/<cuda-host>/training_run.json",
        "python3 scripts/ai_eda/build_training_corpus_manifest.py --run-id <cuda-host>",
        "R-Zoo legality baseline check before corpus manifest",
    ),
    (
        "python3 scripts/ai_eda/convert_research_code_assets_to_internal_records.py --run-id <cuda-host>",
        "python3 scripts/ai_eda/build_training_corpus_manifest.py --run-id <cuda-host>",
        "research-code records before corpus manifest",
    ),
    (
        "python3 scripts/ai_eda/convert_current_research_watchlist_to_internal_records.py --run-id <cuda-host>",
        "python3 scripts/ai_eda/build_training_corpus_manifest.py --run-id <cuda-host>",
        "current-research records before corpus manifest",
    ),
    (
        "python3 scripts/ai_eda/convert_verireason_rtl_coder_to_internal_records.py --run-id <cuda-host>",
        "python3 scripts/ai_eda/check_verireason_rtl_coder_conversion.py --report build/ai_eda/verireason_rtl_coder/<cuda-host>/conversion_report.json",
        "VeriReason RTL-Coder conversion before conversion check",
    ),
    (
        "python3 scripts/ai_eda/check_verireason_rtl_coder_conversion.py --report build/ai_eda/verireason_rtl_coder/<cuda-host>/conversion_report.json",
        "python3 scripts/ai_eda/build_training_corpus_manifest.py --run-id <cuda-host>",
        "VeriReason RTL-Coder records before corpus manifest",
    ),
    (
        "python3 scripts/ai_eda/convert_external_fixture_corpora.py --run-id <cuda-host>",
        "python3 scripts/ai_eda/build_training_corpus_manifest.py --run-id <cuda-host>",
        "external fixtures before corpus manifest",
    ),
    (
        "python3 scripts/ai_eda/convert_e1_openlane_to_internal_records.py --run-id <cuda-host>",
        "python3 scripts/ai_eda/build_training_corpus_manifest.py --run-id <cuda-host>",
        "E1 OpenLane conversion before corpus manifest",
    ),
    (
        "python3 scripts/ai_eda/parse_openlane_metrics_to_flow_run.py --run-id <cuda-host>",
        "python3 scripts/ai_eda/build_training_corpus_manifest.py --run-id <cuda-host>",
        "OpenLane flow labels before corpus manifest",
    ),
    (
        "python3 scripts/ai_eda/materialize_e1_softmacro_cases.py --run-id <cuda-host>",
        "python3 scripts/ai_eda/build_training_corpus_manifest.py --run-id <cuda-host>",
        "E1 softmacro cases before corpus manifest",
    ),
    (
        "python3 scripts/ai_eda/build_training_corpus_manifest.py --run-id <cuda-host>",
        "python3 scripts/ai_eda/check_training_corpus_manifest.py --manifest build/ai_eda/training_corpus_manifest/<cuda-host>/training_corpus_manifest.json",
        "corpus manifest before corpus manifest check",
    ),
    (
        "python3 scripts/ai_eda/build_training_corpus_manifest.py --run-id <cuda-host>",
        "python3 scripts/ai_eda/build_macro_placement_supervised_dataset.py --run-id <cuda-host>",
        "corpus manifest before supervised dataset build",
    ),
    (
        "python3 scripts/ai_eda/build_macro_placement_supervised_dataset.py --run-id <cuda-host>",
        "python3 scripts/ai_eda/train_macro_placement_supervised_model.py --run-id <cuda-host>",
        "supervised dataset before dependency-free supervised train",
    ),
    (
        "python3 scripts/ai_eda/build_macro_placement_supervised_dataset.py --run-id <cuda-host>",
        "python3 scripts/ai_eda/train_macro_placement_torch_regressor.py --run-id <cuda-host> --device auto --epochs 200",
        "supervised dataset before torch train",
    ),
    (
        "python3 scripts/ai_eda/train_macro_placement_torch_regressor.py --run-id <cuda-host> --device auto --epochs 200",
        "python3 scripts/ai_eda/infer_macro_placement_torch_regressor.py --run-id <cuda-host> --device auto",
        "torch train before torch inference",
    ),
    (
        "python3 scripts/ai_eda/plan_macro_placement_replay.py --run-id <cuda-host> --candidate-dir build/ai_eda/macro_placement_policy/<cuda-host>/candidates --candidate-dir build/ai_eda/macro_placement_supervised_model/<cuda-host>/candidates --candidate-dir build/ai_eda/macro_placement_torch_inference/<cuda-host>/candidates --out-root build/ai_eda/macro_placement_full_replay",
        "python3 scripts/ai_eda/select_macro_placement_replay_queue.py --run-id <cuda-host>",
        "full replay plan before replay queue",
    ),
    (
        "python3 scripts/ai_eda/select_macro_placement_replay_queue.py --run-id <cuda-host>",
        "python3 scripts/ai_eda/check_macro_placement_replay_queue.py --report build/ai_eda/macro_placement_replay_queue/<cuda-host>/replay_queue.json",
        "replay queue before replay queue check",
    ),
    (
        "python3 scripts/ai_eda/check_macro_placement_replay_queue.py --report build/ai_eda/macro_placement_replay_queue/<cuda-host>/replay_queue.json",
        "python3 scripts/ai_eda/capture_openlane_replay_prerequisites.py --run-id <cuda-host>",
        "replay queue check before OpenLane replay prerequisites",
    ),
    (
        "python3 scripts/ai_eda/capture_openlane_replay_prerequisites.py --run-id <cuda-host>",
        "python3 scripts/ai_eda/check_openlane_replay_prerequisites.py --report build/ai_eda/openlane_replay_prerequisites/<cuda-host>/openlane_replay_prerequisites.json",
        "OpenLane replay prerequisites before prerequisite check",
    ),
    (
        "python3 scripts/ai_eda/plan_macro_placement_replay.py --run-id <cuda-host>",
        "python3 scripts/ai_eda/replay_macro_placement_on_e1.py --run-id <cuda-host> --plan build/ai_eda/macro_placement_replay/<cuda-host>/replay_plan.json",
        "replay plan before replay preflight",
    ),
    (
        "python3 scripts/ai_eda/check_macro_placement_replay_preflight.py --report build/ai_eda/macro_placement_replay_preflight/<cuda-host>/replay_preflight_report.json",
        "python3 scripts/ai_eda/package_openlane_replay_handoff.py --run-id <cuda-host>",
        "replay preflight before replay handoff packaging",
    ),
    (
        "python3 scripts/ai_eda/package_openlane_replay_handoff.py --run-id <cuda-host>",
        "python3 scripts/ai_eda/check_openlane_replay_handoff.py --report build/ai_eda/openlane_replay_handoff/<cuda-host>/openlane_replay_handoff.json",
        "replay handoff package before handoff check",
    ),
    (
        "python3 scripts/ai_eda/check_openlane_replay_handoff.py --report build/ai_eda/openlane_replay_handoff/<cuda-host>/openlane_replay_handoff.json",
        "python3 scripts/ai_eda/capture_openlane_replay_execution.py --run-id <cuda-host> --replay-role candidate --candidate-id <candidate-id> --metrics <candidate-final-metrics.json> --openlane-log <candidate-openlane.log> --openroad-log <candidate-openroad.log> --def-file <candidate-final.def> --gds-file <candidate-final.gds> --replay-queue build/ai_eda/macro_placement_replay_queue/<cuda-host>/replay_queue.json --replay-preflight build/ai_eda/macro_placement_replay_preflight/<cuda-host>/replay_preflight_report.json --replay-handoff build/ai_eda/openlane_replay_handoff/<cuda-host>/openlane_replay_handoff.json",
        "replay handoff check before candidate replay execution evidence capture",
    ),
    (
        "python3 scripts/ai_eda/capture_openlane_replay_execution.py --run-id <cuda-host>-baseline --replay-role baseline --candidate-id e1-openlane-baseline --metrics <baseline-final-metrics.json> --openlane-log <baseline-openlane.log> --openroad-log <baseline-openroad.log> --def-file <baseline-final.def> --gds-file <baseline-final.gds>",
        "python3 scripts/ai_eda/check_openlane_replay_execution.py --report build/ai_eda/openlane_replay_execution/<cuda-host>-baseline/openlane_replay_execution.json",
        "baseline replay execution evidence before baseline replay execution check",
    ),
    (
        "python3 scripts/ai_eda/capture_openlane_replay_execution.py --run-id <cuda-host> --replay-role candidate --candidate-id <candidate-id> --metrics <candidate-final-metrics.json> --openlane-log <candidate-openlane.log> --openroad-log <candidate-openroad.log> --def-file <candidate-final.def> --gds-file <candidate-final.gds> --replay-queue build/ai_eda/macro_placement_replay_queue/<cuda-host>/replay_queue.json --replay-preflight build/ai_eda/macro_placement_replay_preflight/<cuda-host>/replay_preflight_report.json --replay-handoff build/ai_eda/openlane_replay_handoff/<cuda-host>/openlane_replay_handoff.json",
        "python3 scripts/ai_eda/check_openlane_replay_execution.py --report build/ai_eda/openlane_replay_execution/<cuda-host>/openlane_replay_execution.json",
        "candidate replay execution evidence before replay execution check",
    ),
    (
        "python3 scripts/ai_eda/check_openlane_replay_execution.py --report build/ai_eda/openlane_replay_execution/<cuda-host>-baseline/openlane_replay_execution.json",
        "python3 scripts/ai_eda/capture_openlane_replay_comparison.py --run-id <cuda-host> --baseline-execution build/ai_eda/openlane_replay_execution/<cuda-host>-baseline/openlane_replay_execution.json --candidate-execution build/ai_eda/openlane_replay_execution/<cuda-host>/openlane_replay_execution.json",
        "baseline replay execution check before replay comparison",
    ),
    (
        "python3 scripts/ai_eda/check_openlane_replay_execution.py --report build/ai_eda/openlane_replay_execution/<cuda-host>/openlane_replay_execution.json",
        "python3 scripts/ai_eda/capture_openlane_replay_comparison.py --run-id <cuda-host> --baseline-execution build/ai_eda/openlane_replay_execution/<cuda-host>-baseline/openlane_replay_execution.json --candidate-execution build/ai_eda/openlane_replay_execution/<cuda-host>/openlane_replay_execution.json",
        "replay execution check before replay comparison",
    ),
    (
        "python3 scripts/ai_eda/capture_openlane_replay_comparison.py --run-id <cuda-host> --baseline-execution build/ai_eda/openlane_replay_execution/<cuda-host>-baseline/openlane_replay_execution.json --candidate-execution build/ai_eda/openlane_replay_execution/<cuda-host>/openlane_replay_execution.json",
        "python3 scripts/ai_eda/check_openlane_replay_comparison.py --report build/ai_eda/openlane_replay_comparison/<cuda-host>/openlane_replay_comparison.json",
        "replay comparison before replay comparison check",
    ),
    (
        "python3 scripts/ai_eda/check_openlane_replay_comparison.py --report build/ai_eda/openlane_replay_comparison/<cuda-host>/openlane_replay_comparison.json",
        "python3 scripts/ai_eda/capture_ai_eda_objective_readiness.py --run-id <cuda-host> --readiness-run-id <cuda-host> --evidence-bundle-run-id <cuda-host> --training-handoff-run-id <cuda-host>-training-handoff --replay-handoff-run-id <cuda-host>",
        "replay comparison check before objective readiness audit",
    ),
)

FORBIDDEN_MEMBER_PATTERNS = (
    re.compile(r"(^|/)payload(/|$)"),
    re.compile(r"(^|/)build/"),
    re.compile(r"\.(pt|pth|ckpt|safetensors|onnx|h5|hdf5)$", re.IGNORECASE),
    re.compile(r"\.(zip|tar|tgz|tar\.gz|7z)$", re.IGNORECASE),
)


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
        raise ValueError(f"{path}: expected JSON object")
    return data


def load_lock_ids() -> set[str]:
    data = yaml.safe_load(LOCKFILE.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{LOCKFILE}: expected YAML mapping")
    return {
        entry["id"]
        for entry in data.get("entries", [])
        if isinstance(entry, dict) and isinstance(entry.get("id"), str)
    }


def command_script(command: str) -> str | None:
    parts = command.split()
    if not parts:
        return None
    if parts[0].startswith("python") and len(parts) > 1 and parts[1].endswith(".py"):
        return parts[1]
    if parts[0].startswith("scripts/"):
        return parts[0]
    return None


def validate_tar_members(members: set[str]) -> list[str]:
    errors: list[str] = []
    for member in sorted(members):
        if member == "cuda_training_run_plan.json":
            continue
        for pattern in FORBIDDEN_MEMBER_PATTERNS:
            if pattern.search(member):
                errors.append(f"forbidden payload member {member}")
                break
    return errors


def validate_plan(plan: dict[str, Any], members: set[str], lock_ids: set[str]) -> list[str]:
    errors: list[str] = []
    if plan.get("schema") != EXPECTED_PLAN_SCHEMA:
        errors.append("run plan schema mismatch")
    if plan.get("claim_boundary") != EXPECTED_CLAIM_BOUNDARY:
        errors.append("run plan claim_boundary mismatch")
    policy = plan.get("policy")
    if not isinstance(policy, dict):
        errors.append("run plan policy must be a mapping")
    else:
        for field in (
            "contains_external_datasets",
            "contains_model_weights",
            "contains_foundry_confidential_files",
            "release_use_allowed",
        ):
            if policy.get(field) is not False:
                errors.append(f"run plan policy.{field} must be false")
    selected_assets = plan.get("selected_assets")
    if not isinstance(selected_assets, list) or not selected_assets:
        errors.append("run plan selected_assets must be non-empty")
        selected_ids: set[str] = set()
    else:
        selected_ids = {
            asset_id
            for asset in selected_assets
            if isinstance(asset, dict)
            for asset_id in [asset.get("id")]
            if isinstance(asset_id, str)
        }
        unknown = sorted(asset_id for asset_id in selected_ids if asset_id not in lock_ids)
        if unknown:
            errors.append(f"selected_assets contain unknown ids: {', '.join(unknown)}")
        missing = sorted(CRITICAL_FETCH_ASSETS - selected_ids)
        if missing:
            errors.append(f"critical assets missing from selected_assets: {', '.join(missing)}")
    commands = plan.get("required_remote_commands")
    if not isinstance(commands, list) or not commands:
        errors.append("required_remote_commands must be non-empty")
        commands = []
    command_set = {command for command in commands if isinstance(command, str)}
    for command in REQUIRED_PLAN_COMMANDS:
        if command not in command_set:
            errors.append(f"missing required remote command: {command}")
    command_positions = {
        command: index for index, command in enumerate(commands) if isinstance(command, str)
    }
    for before, after, label in ORDER_CONSTRAINTS:
        before_index = command_positions.get(before)
        after_index = command_positions.get(after)
        if before_index is None:
            errors.append(f"missing order prerequisite command for {label}: {before}")
        elif after_index is None:
            errors.append(f"missing order dependent command for {label}: {after}")
        elif before_index >= after_index:
            errors.append(f"run plan order violation: {label}")
    for asset_id in sorted(CRITICAL_FETCH_ASSETS):
        execute = f"python3 scripts/ai_eda/fetch_external_asset.py --asset {asset_id} --execute --run-id <cuda-host>"
        verify = f"python3 scripts/ai_eda/fetch_external_asset.py --asset {asset_id} --verify-only --run-id <cuda-host>"
        if execute not in command_set:
            errors.append(f"missing execute command for critical asset {asset_id}")
        if verify not in command_set:
            errors.append(f"missing verify command for critical asset {asset_id}")
    for command in command_set:
        script = command_script(command)
        if script and script not in members:
            errors.append(f"remote command references script missing from payload: {script}")
    outputs = plan.get("expected_outputs")
    if not isinstance(outputs, list) or not outputs:
        errors.append("expected_outputs must be non-empty")
    else:
        missing_outputs = sorted(
            REQUIRED_OUTPUTS - {item for item in outputs if isinstance(item, str)}
        )
        if missing_outputs:
            errors.append(f"missing expected output patterns: {', '.join(missing_outputs)}")
    return errors


def validate_report(report: dict[str, Any], report_path: Path) -> list[str]:
    errors: list[str] = []
    if report.get("schema") != EXPECTED_REPORT_SCHEMA:
        errors.append("report schema mismatch")
    if report.get("claim_boundary") != EXPECTED_CLAIM_BOUNDARY:
        errors.append("report claim_boundary mismatch")
    if report.get("release_use_allowed") is not False:
        errors.append("release_use_allowed must be false")
    payload = report.get("payload")
    run_plan = report.get("run_plan")
    runbook = report.get("runbook")
    if (
        not isinstance(payload, str)
        or not isinstance(run_plan, str)
        or not isinstance(runbook, str)
    ):
        return errors + ["payload, run_plan, and runbook paths are required"]
    payload_path = repo_path(payload)
    run_plan_path = repo_path(run_plan)
    runbook_path = repo_path(runbook)
    if not payload_path.is_file():
        return errors + [f"payload tarball missing: {rel(payload_path)}"]
    if not run_plan_path.is_file():
        return errors + [f"run plan missing: {rel(run_plan_path)}"]
    if not runbook_path.is_file():
        return errors + [f"runbook missing: {rel(runbook_path)}"]
    try:
        plan = load_json(run_plan_path)
    except Exception as exc:  # noqa: BLE001
        return errors + [f"{rel(run_plan_path)}: {exc}"]
    try:
        with tarfile.open(payload_path, "r:gz") as archive:
            members = {member.name for member in archive.getmembers() if member.isfile()}
            embedded_file = archive.extractfile("cuda_training_run_plan.json")
            embedded = json.loads(embedded_file.read().decode("utf-8")) if embedded_file else None
            runbook_file = (
                archive.extractfile(REQUIRED_RUNBOOK_MEMBER)
                if REQUIRED_RUNBOOK_MEMBER in members
                else None
            )
            embedded_runbook = runbook_file.read().decode("utf-8") if runbook_file else None
    except Exception as exc:  # noqa: BLE001
        return errors + [f"{rel(payload_path)}: {exc}"]
    if report.get("included_file_count") != len(members):
        errors.append("included_file_count does not match tarball file count")
    if embedded != plan:
        errors.append("embedded run plan does not match reported run_plan")
    if REQUIRED_RUNBOOK_MEMBER not in members:
        errors.append(f"missing {REQUIRED_RUNBOOK_MEMBER} in payload tarball")
    if embedded_runbook != runbook_path.read_text(encoding="utf-8"):
        errors.append("embedded runbook does not match reported runbook")
    if embedded_runbook:
        for command in REQUIRED_RUNBOOK_COMMANDS:
            if command not in embedded_runbook:
                errors.append(f"runbook missing command anchor: {command}")
        if EXPECTED_CLAIM_BOUNDARY not in embedded_runbook:
            errors.append("runbook missing payload claim boundary")
    try:
        lock_ids = load_lock_ids()
    except Exception as exc:  # noqa: BLE001
        errors.append(f"{rel(LOCKFILE)}: {exc}")
        lock_ids = set()
    if isinstance(report.get("asset_count"), int) and report["asset_count"] > len(lock_ids):
        errors.append("asset_count exceeds lockfile entry count")
    errors.extend(validate_tar_members(members))
    errors.extend(validate_plan(plan, members, lock_ids))
    if report_path.resolve() == payload_path.resolve():
        errors.append("report path must not be the payload tarball")
    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.report.exists():
        print(f"STATUS: FAIL ai_eda.cuda_training_payload_check missing_report {rel(args.report)}")
        return 1
    try:
        report = load_json(args.report)
    except Exception as exc:  # noqa: BLE001
        print(f"STATUS: FAIL ai_eda.cuda_training_payload_check {rel(args.report)}: {exc}")
        return 1
    errors = validate_report(report, args.report)
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.cuda_training_payload_check {error}")
        return 1
    print(
        "STATUS: PASS ai_eda.cuda_training_payload_check "
        f"assets={report['asset_count']} files={report['included_file_count']} report={rel(args.report)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
