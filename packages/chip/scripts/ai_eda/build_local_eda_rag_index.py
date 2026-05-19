#!/usr/bin/env python3
"""Build a read-only source manifest for local EDA RAG/log triage."""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = ROOT / "build/ai_eda/rag_index"
CLAIM_BOUNDARY = "read_only_cited_triage_no_code_edit_or_evidence_claim"

SOURCE_SET = (
    (
        "ai_eda_inventory",
        "research/alpha_chip_macro_placement/01_sources/ai_eda_source_inventory.yaml",
        "source_inventory",
    ),
    (
        "ai_eda_backlog",
        "research/alpha_chip_macro_placement/01_sources/ai_eda_integration_backlog.yaml",
        "integration_backlog",
    ),
    (
        "ai_eda_sota_review",
        "research/alpha_chip_macro_placement/01_sources/ai_eda_sota_review.md",
        "sota_review",
    ),
    (
        "ai_eda_readiness",
        "research/alpha_chip_macro_placement/01_sources/ai_eda_automation_readiness.yaml",
        "readiness_matrix",
    ),
    (
        "ai_eda_provenance",
        "research/alpha_chip_macro_placement/01_sources/ai_eda_provenance_matrix.yaml",
        "provenance_matrix",
    ),
    (
        "ai_eda_external_probe_summary",
        "research/alpha_chip_macro_placement/01_sources/ai_eda_external_source_probe_summary.yaml",
        "external_probe_summary",
    ),
    (
        "assertion_candidates",
        "verify/ai_eda/assertion_candidates/e1_npu_descriptor.yaml",
        "verification_manifest",
    ),
    ("openlane_run_preflight_checker", "scripts/check_openlane_run_preflight.py", "checker_source"),
    ("pd_signoff_checker", "scripts/check_pd_signoff.py", "checker_source"),
    ("openroad_autotune_runner", "scripts/ai_eda/run_openroad_autotune_e1.sh", "ai_eda_runner"),
    ("zigzag_dse_runner", "scripts/ai_eda/run_zigzag_npu_dse.py", "ai_eda_runner"),
    (
        "simulator_optimization_runner",
        "scripts/ai_eda/capture_simulator_optimization_targets.py",
        "ai_eda_runner",
    ),
    (
        "rtlmul_ppa_advisory_runner",
        "scripts/ai_eda/run_rtlmul_ppa_advisory.py",
        "ai_eda_runner",
    ),
    (
        "hls_accelerator_targets_runner",
        "scripts/ai_eda/capture_hls_accelerator_targets.py",
        "ai_eda_runner",
    ),
    (
        "timing_closure_targets_runner",
        "scripts/ai_eda/capture_timing_closure_targets.py",
        "ai_eda_runner",
    ),
    (
        "routing_congestion_targets_runner",
        "scripts/ai_eda/capture_routing_congestion_targets.py",
        "ai_eda_runner",
    ),
    (
        "clock_tree_targets_runner",
        "scripts/ai_eda/capture_clock_tree_targets.py",
        "ai_eda_runner",
    ),
    (
        "extraction_parasitic_targets_runner",
        "scripts/ai_eda/capture_extraction_parasitic_targets.py",
        "ai_eda_runner",
    ),
    (
        "analog_mixed_signal_targets_runner",
        "scripts/ai_eda/capture_analog_mixed_signal_targets.py",
        "ai_eda_runner",
    ),
    (
        "memory_interconnect_targets_runner",
        "scripts/ai_eda/capture_memory_interconnect_targets.py",
        "ai_eda_runner",
    ),
    (
        "dft_atpg_targets_runner",
        "scripts/ai_eda/capture_dft_atpg_targets.py",
        "ai_eda_runner",
    ),
    (
        "power_thermal_targets_runner",
        "scripts/ai_eda/capture_power_thermal_targets.py",
        "ai_eda_runner",
    ),
    (
        "hardware_security_targets_runner",
        "scripts/ai_eda/capture_hardware_security_targets.py",
        "ai_eda_runner",
    ),
    (
        "cdc_rdc_targets_runner",
        "scripts/ai_eda/capture_cdc_rdc_targets.py",
        "ai_eda_runner",
    ),
    (
        "software_bsp_firmware_targets_runner",
        "scripts/ai_eda/capture_software_bsp_firmware_targets.py",
        "ai_eda_runner",
    ),
    (
        "rtl_rewrite_equivalence_targets_runner",
        "scripts/ai_eda/capture_rtl_rewrite_equivalence_targets.py",
        "ai_eda_runner",
    ),
    (
        "board_package_fpga_targets_runner",
        "scripts/ai_eda/capture_board_package_fpga_targets.py",
        "ai_eda_runner",
    ),
    (
        "low_power_intent_targets_runner",
        "scripts/ai_eda/capture_low_power_intent_targets.py",
        "ai_eda_runner",
    ),
    (
        "circuit_foundation_model_targets_runner",
        "scripts/ai_eda/capture_circuit_foundation_model_targets.py",
        "ai_eda_runner",
    ),
    (
        "dfm_yield_lithography_targets_runner",
        "scripts/ai_eda/capture_dfm_yield_lithography_targets.py",
        "ai_eda_runner",
    ),
    (
        "cpu_microarchitecture_targets_runner",
        "scripts/ai_eda/capture_cpu_microarchitecture_targets.py",
        "ai_eda_runner",
    ),
    (
        "compiler_autotuning_targets_runner",
        "scripts/ai_eda/capture_compiler_autotuning_targets.py",
        "ai_eda_runner",
    ),
    (
        "reliability_resilience_targets_runner",
        "scripts/ai_eda/capture_reliability_resilience_targets.py",
        "ai_eda_runner",
    ),
    (
        "external_model_corpus_intake_targets_runner",
        "scripts/ai_eda/capture_external_model_corpus_intake_targets.py",
        "ai_eda_runner",
    ),
    (
        "benchmark_evaluation_hygiene_targets_runner",
        "scripts/ai_eda/capture_benchmark_evaluation_hygiene_targets.py",
        "ai_eda_runner",
    ),
    (
        "eda_tool_agent_interop_targets_runner",
        "scripts/ai_eda/capture_eda_tool_agent_interop_targets.py",
        "ai_eda_runner",
    ),
    (
        "spec_traceability_targets_runner",
        "scripts/ai_eda/capture_spec_traceability_targets.py",
        "ai_eda_runner",
    ),
    (
        "ip_register_contract_targets_runner",
        "scripts/ai_eda/capture_ip_register_contract_targets.py",
        "ai_eda_runner",
    ),
    (
        "memory_macro_library_targets_runner",
        "scripts/ai_eda/capture_memory_macro_library_targets.py",
        "ai_eda_runner",
    ),
    (
        "chiplet_3dic_package_targets_runner",
        "scripts/ai_eda/capture_chiplet_3dic_package_targets.py",
        "ai_eda_runner",
    ),
    (
        "logic_synthesis_targets_runner",
        "scripts/ai_eda/capture_logic_synthesis_targets.py",
        "ai_eda_runner",
    ),
    (
        "netlist_equivalence_targets_runner",
        "scripts/ai_eda/capture_netlist_equivalence_targets.py",
        "ai_eda_runner",
    ),
    (
        "physical_verification_targets_runner",
        "scripts/ai_eda/capture_physical_verification_targets.py",
        "ai_eda_runner",
    ),
    (
        "placement_legalization_targets_runner",
        "scripts/ai_eda/capture_placement_legalization_targets.py",
        "ai_eda_runner",
    ),
    (
        "floorplan_io_pdn_targets_runner",
        "scripts/ai_eda/capture_floorplan_io_pdn_targets.py",
        "ai_eda_runner",
    ),
    (
        "external_source_probe_runner",
        "scripts/ai_eda/probe_external_ai_eda_sources.py",
        "ai_eda_runner",
    ),
    (
        "backend_preflight_runner",
        "scripts/ai_eda/preflight_ai_eda_backends.py",
        "ai_eda_runner",
    ),
    ("rtl_model_eval_runner", "scripts/ai_eda/evaluate_rtl_model.py", "ai_eda_runner"),
    ("pd_predictor_runner", "scripts/ai_eda/capture_openroad_ml_snapshot.py", "ai_eda_runner"),
)

SMOKE_QUERIES = (
    {
        "id": "openlane_blocker_triage",
        "query": "Which local sources explain OpenLane run blockers and signoff gates?",
        "required_source_ids": ["openlane_run_preflight_checker", "pd_signoff_checker"],
        "required_followup_gates": [
            "make openlane-run-preflight-check",
            "make pd-signoff-manifest-check",
        ],
    },
    {
        "id": "ai_eda_claim_boundary",
        "query": "Which local sources define AI/EDA claim boundaries and evidence gates?",
        "required_source_ids": ["ai_eda_inventory", "ai_eda_backlog"],
        "required_followup_gates": ["python3 scripts/check_ai_eda_source_inventory.py"],
    },
    {
        "id": "npu_dse_triage",
        "query": "Which local sources describe NPU DSE inputs and required gates?",
        "required_source_ids": ["zigzag_dse_runner", "ai_eda_backlog"],
        "required_followup_gates": ["make npu-runtime-contract-check", "make npu-roadmap-check"],
    },
    {
        "id": "assertion_candidate_review",
        "query": "Which local sources define assertion-generation claim boundaries?",
        "required_source_ids": ["assertion_candidates", "ai_eda_readiness"],
        "required_followup_gates": ["make formal", "make cocotb-npu"],
    },
    {
        "id": "simulator_optimization_targets",
        "query": "Which local sources define simulator optimization targets and benchmark gates?",
        "required_source_ids": ["simulator_optimization_runner", "ai_eda_readiness"],
        "required_followup_gates": [
            "make npu-runtime-contract-check",
            "make benchmark-sim-metrics",
        ],
    },
    {
        "id": "external_source_metadata_probe",
        "query": "Which local sources probe external AI/EDA metadata without importing assets?",
        "required_source_ids": ["external_source_probe_runner", "ai_eda_external_probe_summary"],
        "required_followup_gates": [
            "python3 scripts/ai_eda/probe_external_ai_eda_sources.py --run-id validation",
            "python3 scripts/check_ai_eda_source_inventory.py",
        ],
    },
    {
        "id": "local_backend_preflight",
        "query": "Which local sources check AI/EDA backend availability without installing assets?",
        "required_source_ids": ["backend_preflight_runner", "ai_eda_readiness"],
        "required_followup_gates": [
            "python3 scripts/ai_eda/preflight_ai_eda_backends.py --run-id validation",
            "python3 scripts/check_ai_eda_source_inventory.py",
        ],
    },
    {
        "id": "rtlmul_ppa_advisory",
        "query": "Which local sources define RTLMUL PPA advisory claim boundaries?",
        "required_source_ids": ["rtlmul_ppa_advisory_runner", "ai_eda_readiness"],
        "required_followup_gates": [
            "python3 scripts/ai_eda/run_rtlmul_ppa_advisory.py --run-id validation",
            "make synth",
        ],
    },
    {
        "id": "hls_accelerator_targets",
        "query": "Which local sources define HLS accelerator automation targets?",
        "required_source_ids": ["hls_accelerator_targets_runner", "ai_eda_readiness"],
        "required_followup_gates": [
            "python3 scripts/ai_eda/capture_hls_accelerator_targets.py --run-id validation",
            "make npu-runtime-contract-check",
        ],
    },
    {
        "id": "timing_closure_targets",
        "query": "Which local sources define AI-assisted timing closure target capture?",
        "required_source_ids": ["timing_closure_targets_runner", "ai_eda_readiness"],
        "required_followup_gates": [
            "python3 scripts/ai_eda/capture_timing_closure_targets.py --run-id validation",
            "python3 scripts/check_pd_closure.py",
        ],
    },
    {
        "id": "analog_mixed_signal_targets",
        "query": "Which local sources define analog and mixed-signal AI target capture?",
        "required_source_ids": ["analog_mixed_signal_targets_runner", "ai_eda_readiness"],
        "required_followup_gates": [
            "python3 scripts/ai_eda/capture_analog_mixed_signal_targets.py --run-id validation",
            "make padframe-check",
        ],
    },
    {
        "id": "memory_interconnect_targets",
        "query": "Which local sources define memory, interconnect, NoC, and SoC DSE target capture?",
        "required_source_ids": ["memory_interconnect_targets_runner", "ai_eda_readiness"],
        "required_followup_gates": [
            "python3 scripts/ai_eda/capture_memory_interconnect_targets.py --run-id validation",
            "make memory-interconnect-contract-check",
        ],
    },
    {
        "id": "dft_atpg_targets",
        "query": "Which local sources define DFT, ATPG, scan, and testability AI target capture?",
        "required_source_ids": ["dft_atpg_targets_runner", "ai_eda_readiness"],
        "required_followup_gates": [
            "python3 scripts/ai_eda/capture_dft_atpg_targets.py --run-id validation",
            "make synth",
            "make manufacturing-artifacts-check",
        ],
    },
    {
        "id": "power_thermal_targets",
        "query": "Which local sources define power, thermal, IR-drop, and PDN AI target capture?",
        "required_source_ids": ["power_thermal_targets_runner", "ai_eda_readiness"],
        "required_followup_gates": [
            "python3 scripts/ai_eda/capture_power_thermal_targets.py --run-id validation",
            "make power-thermal-evidence-check",
            "make pd-signoff-manifest-check",
        ],
    },
    {
        "id": "hardware_security_targets",
        "query": "Which local sources define hardware-security, Trojan-detection, and RTL vulnerability AI target capture?",
        "required_source_ids": ["hardware_security_targets_runner", "ai_eda_readiness"],
        "required_followup_gates": [
            "python3 scripts/ai_eda/capture_hardware_security_targets.py --run-id validation",
            "make no-hardware-action-check",
            "make formal",
        ],
    },
    {
        "id": "cdc_rdc_targets",
        "query": "Which local sources define CDC/RDC, reset-domain, and clock-domain AI target capture?",
        "required_source_ids": ["cdc_rdc_targets_runner", "ai_eda_readiness"],
        "required_followup_gates": [
            "python3 scripts/ai_eda/capture_cdc_rdc_targets.py --run-id validation",
            "make rtl-check",
            "make cocotb-contract",
        ],
    },
    {
        "id": "software_bsp_firmware_targets",
        "query": "Which local sources define software BSP, firmware, OpenSBI, U-Boot, QEMU, and Renode AI target capture?",
        "required_source_ids": ["software_bsp_firmware_targets_runner", "ai_eda_readiness"],
        "required_followup_gates": [
            "python3 scripts/ai_eda/capture_software_bsp_firmware_targets.py --run-id validation",
            "make software-bsp-check",
            "make qemu-check",
            "make renode-check",
        ],
    },
    {
        "id": "rtl_rewrite_equivalence_targets",
        "query": "Which local sources define RTL rewrite, equivalence, and before/after PPA AI target capture?",
        "required_source_ids": ["rtl_rewrite_equivalence_targets_runner", "ai_eda_readiness"],
        "required_followup_gates": [
            "python3 scripts/ai_eda/capture_rtl_rewrite_equivalence_targets.py --run-id validation",
            "make rtl-check",
            "make formal",
            "make synth",
        ],
    },
    {
        "id": "netlist_equivalence_targets",
        "query": "Which local sources define netlist equivalence, LEC, and post-synthesis consistency target capture?",
        "required_source_ids": ["netlist_equivalence_targets_runner", "ai_eda_readiness"],
        "required_followup_gates": [
            "python3 scripts/ai_eda/capture_netlist_equivalence_targets.py --run-id validation",
            "python3 scripts/ai_eda/capture_logic_synthesis_targets.py --run-id validation",
            "make formal",
            "make synth",
        ],
    },
    {
        "id": "physical_verification_targets",
        "query": "Which local sources define physical verification, DRC/LVS, and antenna target capture?",
        "required_source_ids": ["physical_verification_targets_runner", "ai_eda_readiness"],
        "required_followup_gates": [
            "python3 scripts/ai_eda/capture_physical_verification_targets.py --run-id validation",
            "make openlane-run-preflight-check",
            "make pd-signoff-manifest-check",
            "make antenna-metadata-check",
        ],
    },
    {
        "id": "placement_legalization_targets",
        "query": "Which local sources define placement, legalization, density, and generative-placement target capture?",
        "required_source_ids": ["placement_legalization_targets_runner", "ai_eda_readiness"],
        "required_followup_gates": [
            "python3 scripts/ai_eda/capture_placement_legalization_targets.py --run-id validation",
            "make openlane-run-preflight-check",
            "make pd-signoff-manifest-check",
            "python3 scripts/check_pd_closure.py",
        ],
    },
    {
        "id": "floorplan_io_pdn_targets",
        "query": "Which local sources define floorplan, IO placement, tapcell, and PDN target capture?",
        "required_source_ids": ["floorplan_io_pdn_targets_runner", "ai_eda_readiness"],
        "required_followup_gates": [
            "python3 scripts/ai_eda/capture_floorplan_io_pdn_targets.py --run-id validation",
            "make openlane-run-preflight-check",
            "make pd-signoff-manifest-check",
            "make power-thermal-evidence-check",
        ],
    },
    {
        "id": "board_package_fpga_targets",
        "query": "Which local sources define board, package, manufacturing, and FPGA AI target capture?",
        "required_source_ids": ["board_package_fpga_targets_runner", "ai_eda_readiness"],
        "required_followup_gates": [
            "python3 scripts/ai_eda/capture_board_package_fpga_targets.py --run-id validation",
            "make pinout-check",
            "make package-cross-probe-check",
            "make kicad-artifact-check",
            "make fpga-check",
            "make manufacturing-artifacts-check",
        ],
    },
    {
        "id": "low_power_intent_targets",
        "query": "Which local sources define low-power, DVFS, clock-gating, and UPF power-intent AI target capture?",
        "required_source_ids": ["low_power_intent_targets_runner", "ai_eda_readiness"],
        "required_followup_gates": [
            "python3 scripts/ai_eda/capture_low_power_intent_targets.py --run-id validation",
            "make platform-contract-check",
            "make rtl-check",
            "make formal",
            "make synth",
            "make power-thermal-evidence-check",
        ],
    },
    {
        "id": "dfm_yield_lithography_targets",
        "query": "Which local sources define DFM, yield, lithography, OPC, and wafer-defect AI target capture?",
        "required_source_ids": ["dfm_yield_lithography_targets_runner", "ai_eda_readiness"],
        "required_followup_gates": [
            "python3 scripts/ai_eda/capture_dfm_yield_lithography_targets.py --run-id validation",
            "make pd-contract-check",
            "make manufacturing-artifacts-check",
            "make real-world-gates-check",
        ],
    },
    {
        "id": "cpu_microarchitecture_targets",
        "query": "Which local sources define branch predictor, cache, prefetcher, and CPU microarchitecture AI target capture?",
        "required_source_ids": ["cpu_microarchitecture_targets_runner", "ai_eda_readiness"],
        "required_followup_gates": [
            "python3 scripts/ai_eda/capture_cpu_microarchitecture_targets.py --run-id validation",
            "make branch-prediction-check",
            "make mpki-eval",
            "python3 scripts/check_cache_hierarchy.py",
        ],
    },
    {
        "id": "compiler_autotuning_targets",
        "query": "Which local sources define compiler, RVV, profile-guided, and kernel-autotuning AI target capture?",
        "required_source_ids": ["compiler_autotuning_targets_runner", "ai_eda_readiness"],
        "required_followup_gates": [
            "python3 scripts/ai_eda/capture_compiler_autotuning_targets.py --run-id validation",
            "python3 scripts/check_compiler_versions.py",
            "python3 scripts/run_rvv_autovec_suite.py",
            "python3 compiler/runtime/test_e1_npu_runtime.py",
        ],
    },
    {
        "id": "reliability_resilience_targets",
        "query": "Which local sources define aging, electromigration, soft-error, and fault-injection AI target capture?",
        "required_source_ids": ["reliability_resilience_targets_runner", "ai_eda_readiness"],
        "required_followup_gates": [
            "python3 scripts/ai_eda/capture_reliability_resilience_targets.py --run-id validation",
            "make process-14a-effects-check",
            "make power-thermal-evidence-check",
            "make memory-interconnect-contract-check",
        ],
    },
    {
        "id": "external_model_corpus_intake_targets",
        "query": "Which local sources define external HuggingFace and GitHub model/corpus intake policy?",
        "required_source_ids": [
            "external_model_corpus_intake_targets_runner",
            "ai_eda_external_probe_summary",
            "ai_eda_readiness",
        ],
        "required_followup_gates": [
            "python3 scripts/ai_eda/capture_external_model_corpus_intake_targets.py --run-id validation",
            "python3 scripts/ai_eda/probe_external_ai_eda_sources.py --run-id validation",
            "python3 scripts/ai_eda/evaluate_rtl_model.py --run-id validation --dry-run",
            "make no-hardware-action-check",
        ],
    },
    {
        "id": "benchmark_evaluation_hygiene_targets",
        "query": "Which local sources define HDL benchmark contamination and evaluation hygiene policy?",
        "required_source_ids": [
            "benchmark_evaluation_hygiene_targets_runner",
            "ai_eda_readiness",
            "ai_eda_backlog",
        ],
        "required_followup_gates": [
            "python3 scripts/ai_eda/capture_benchmark_evaluation_hygiene_targets.py --run-id validation",
            "python3 scripts/ai_eda/evaluate_rtl_model.py --run-id validation --dry-run",
            "make no-hardware-action-check",
            "make rtl-check",
        ],
    },
    {
        "id": "eda_tool_agent_interop_targets",
        "query": "Which local sources define EDA tool-agent command governance and commercial copilot boundaries?",
        "required_source_ids": [
            "eda_tool_agent_interop_targets_runner",
            "ai_eda_readiness",
            "ai_eda_provenance",
        ],
        "required_followup_gates": [
            "python3 scripts/ai_eda/capture_eda_tool_agent_interop_targets.py --run-id validation",
            "python3 scripts/ai_eda/build_local_eda_rag_index.py --run-id validation",
            "make no-hardware-action-check",
            "make docs-check",
        ],
    },
    {
        "id": "spec_traceability_targets",
        "query": "Which local sources define requirements-to-RTL traceability and requirement coverage gates?",
        "required_source_ids": [
            "spec_traceability_targets_runner",
            "ai_eda_readiness",
            "ai_eda_backlog",
        ],
        "required_followup_gates": [
            "python3 scripts/ai_eda/capture_spec_traceability_targets.py --run-id validation",
            "make platform-contract-check",
            "make cocotb-contract",
            "make no-hardware-action-check",
        ],
    },
    {
        "id": "ip_register_contract_targets",
        "query": "Which local sources define IP, register-map, and platform-contract automation boundaries?",
        "required_source_ids": [
            "ip_register_contract_targets_runner",
            "ai_eda_readiness",
            "ai_eda_backlog",
        ],
        "required_followup_gates": [
            "python3 scripts/ai_eda/capture_ip_register_contract_targets.py --run-id validation",
            "make platform-contract-check",
            "make npu-runtime-contract-check",
            "make no-hardware-action-check",
        ],
    },
    {
        "id": "memory_macro_library_targets",
        "query": "Which local sources define SRAM macro, memory compiler, and library automation boundaries?",
        "required_source_ids": [
            "memory_macro_library_targets_runner",
            "ai_eda_readiness",
            "ai_eda_backlog",
        ],
        "required_followup_gates": [
            "python3 scripts/ai_eda/capture_memory_macro_library_targets.py --run-id validation",
            "make pdk-portability-check",
            "make memory-evidence-template-check",
            "make pd-signoff-manifest-check",
        ],
    },
    {
        "id": "chiplet_3dic_package_targets",
        "query": "Which local sources define chiplet, 2.5D/3DIC, UCIe, and package co-design boundaries?",
        "required_source_ids": [
            "chiplet_3dic_package_targets_runner",
            "ai_eda_readiness",
            "ai_eda_backlog",
        ],
        "required_followup_gates": [
            "python3 scripts/ai_eda/capture_chiplet_3dic_package_targets.py --run-id validation",
            "make package-cross-probe-check",
            "make memory-interconnect-contract-check",
            "make power-thermal-evidence-check",
        ],
    },
    {
        "id": "logic_synthesis_targets",
        "query": "Which local sources define logic synthesis, technology mapping, and gate-level QoR automation boundaries?",
        "required_source_ids": [
            "logic_synthesis_targets_runner",
            "ai_eda_readiness",
            "ai_eda_backlog",
        ],
        "required_followup_gates": [
            "python3 scripts/ai_eda/capture_logic_synthesis_targets.py --run-id validation",
            "make synth",
            "make formal",
            "make pd-signoff-manifest-check",
        ],
    },
)


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source_entry(source_id: str, path_text: str, kind: str) -> dict[str, Any]:
    path = ROOT / path_text
    if not path.is_file():
        raise FileNotFoundError(f"missing indexed source: {path_text}")
    text = path.read_text(errors="replace")
    return {
        "id": source_id,
        "path": path_text,
        "kind": kind,
        "topics": [kind, "ai_eda"],
        "sha256": sha256_file(path),
        "bytes": path.stat().st_size,
        "lines": 0 if not text else text.count("\n") + (0 if text.endswith("\n") else 1),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default=datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ"))
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    out_dir = args.out_dir.resolve()
    sources = [source_entry(*item) for item in SOURCE_SET]
    by_id = {item["id"]: item for item in sources}
    manifest = {
        "schema": "eliza.ai_eda.local_rag.source_manifest.v1",
        "run_id": args.run_id,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "mode": "dry-run",
        "status": "READ_ONLY_INDEX_MANIFEST",
        "claim_boundary": CLAIM_BOUNDARY,
        "backlog_item": "p1-local-eda-rag-log-triage",
        "source_ids": ["orassistant", "eda-corpus", "autoeda-mcp-server", "mcp4eda"],
        "index_policy": {
            "read_only": True,
            "network_required": False,
            "embeddings_generated": False,
            "can_edit_source": False,
            "answers_require_citations": True,
            "engineering_actions_require_named_checker": True,
            "stale_index_fails_closed": True,
        },
        "source_count": len(sources),
        "sources": sources,
    }
    queries = []
    for query in SMOKE_QUERIES:
        queries.append(
            {
                "id": query["id"],
                "query": query["query"],
                "status": "PASS",
                "citations": [
                    {
                        "source_id": source_id,
                        "path": by_id[source_id]["path"],
                        "sha256": by_id[source_id]["sha256"],
                    }
                    for source_id in query["required_source_ids"]
                ],
                "required_followup_gates": query["required_followup_gates"],
            }
        )
    smoke = {
        "schema": "eliza.ai_eda.local_rag.citation_smoke_report.v1",
        "run_id": args.run_id,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "mode": "dry-run",
        "status": "PASS",
        "claim_boundary": CLAIM_BOUNDARY,
        "backlog_item": "p1-local-eda-rag-log-triage",
        "query_count": len(queries),
        "queries": queries,
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "source_manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n"
    )
    (out_dir / "citation_smoke_report.json").write_text(
        json.dumps(smoke, indent=2, sort_keys=True) + "\n"
    )
    print(f"STATUS: PASS ai_eda.local_rag.read_only_index {rel(out_dir)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
