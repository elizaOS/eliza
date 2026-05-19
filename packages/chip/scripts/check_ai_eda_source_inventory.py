#!/usr/bin/env python3
"""Validate the local AI/EDA source registry and dry-run artifacts."""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
INVENTORY = ROOT / "research/alpha_chip_macro_placement/01_sources/ai_eda_source_inventory.yaml"
BACKLOG = ROOT / "research/alpha_chip_macro_placement/01_sources/ai_eda_integration_backlog.yaml"
RTL_EVAL_SCRIPT = ROOT / "scripts/ai_eda/evaluate_rtl_model.py"
RTL_EVAL_PLAN = (
    ROOT / "research/alpha_chip_macro_placement/05_experiments/e1_rtl_model_eval_plan.md"
)
RTL_EVAL_BUILD = ROOT / "build/ai_eda/rtl_model_eval"
RTL_CLAIM_BOUNDARY = "generated_rtl_artifact_only_not_source_or_release_evidence"
PD_PREDICTOR_SCRIPT = ROOT / "scripts/ai_eda/capture_openroad_ml_snapshot.py"
PD_PREDICTOR_BUILD = ROOT / "build/ai_eda/pd_predictor_dataset"
PD_CLAIM_BOUNDARY = "predictor_dataset_advisory_only_not_signoff_or_release_evidence"
SOTA_REVIEW = ROOT / "research/alpha_chip_macro_placement/01_sources/ai_eda_sota_review.md"
READINESS = ROOT / "research/alpha_chip_macro_placement/01_sources/ai_eda_automation_readiness.yaml"
PROVENANCE = ROOT / "research/alpha_chip_macro_placement/01_sources/ai_eda_provenance_matrix.yaml"
EXTERNAL_PROBE_SUMMARY = (
    ROOT
    / "research/alpha_chip_macro_placement/01_sources/ai_eda_external_source_probe_summary.yaml"
)
RAG_SCRIPT = ROOT / "scripts/ai_eda/build_local_eda_rag_index.py"
RAG_BUILD = ROOT / "build/ai_eda/rag_index"
RAG_CLAIM_BOUNDARY = "read_only_cited_triage_no_code_edit_or_evidence_claim"
COCOTB_SCRIPT = ROOT / "scripts/ai_eda/run_cocotb_stimulus_search.py"
COCOTB_BINS = ROOT / "verify/ai_eda/coverage_bins/e1_npu_descriptor_queue.yaml"
COCOTB_SEEDS = ROOT / "verify/regression_seeds/ai_eda_npu_descriptor_queue.yaml"
COCOTB_BUILD = ROOT / "build/ai_eda/cocotb_stimulus"
COCOTB_CLAIM_BOUNDARY = "no_ai_generated_stimulus_as_evidence_until_cocotb_regression_passes"
ZIGZAG_SCRIPT = ROOT / "scripts/ai_eda/run_zigzag_npu_dse.py"
ZIGZAG_CURRENT = ROOT / "compiler/runtime/ai_eda/zigzag/e1_npu_current.yaml"
ZIGZAG_TARGET = ROOT / "compiler/runtime/ai_eda/zigzag/e1_npu_target.yaml"
ZIGZAG_BUILD = ROOT / "build/ai_eda/zigzag"
ZIGZAG_CLAIM_BOUNDARY = "architecture_estimate_only_no_tops_android_or_tapeout_claim"
OPENROAD_AUTOTUNE_SCRIPT = ROOT / "scripts/ai_eda/run_openroad_autotune_e1.sh"
OPENROAD_AUTOTUNE_BUILD = ROOT / "build/ai_eda/openroad_autotuner"
OPENROAD_AUTOTUNE_CLAIM_BOUNDARY = "no_ppa_claim_no_signoff_claim_no_ai_output_as_evidence"
ASSERTION_CANDIDATES = ROOT / "verify/ai_eda/assertion_candidates/e1_npu_descriptor.yaml"
ASSERTION_CLAIM_BOUNDARY = "assertion_candidates_only_not_bound_to_rtl"
SIM_OPT_SCRIPT = ROOT / "scripts/ai_eda/capture_simulator_optimization_targets.py"
SIM_OPT_BUILD = ROOT / "build/ai_eda/simulator_optimization"
SIM_OPT_CLAIM_BOUNDARY = "optimization_targets_only_no_benchmark_or_product_claim"
EXTERNAL_PROBE_SCRIPT = ROOT / "scripts/ai_eda/probe_external_ai_eda_sources.py"
EXTERNAL_PROBE_BUILD = ROOT / "build/ai_eda/external_source_probe"
EXTERNAL_PROBE_CLAIM_BOUNDARY = "external_metadata_probe_only_no_import_no_release_use"
BACKEND_PREFLIGHT_SCRIPT = ROOT / "scripts/ai_eda/preflight_ai_eda_backends.py"
BACKEND_PREFLIGHT_BUILD = ROOT / "build/ai_eda/backend_preflight"
BACKEND_PREFLIGHT_CLAIM_BOUNDARY = "local_backend_preflight_only_no_external_import_or_release_use"
RTLMUL_PPA_SCRIPT = ROOT / "scripts/ai_eda/run_rtlmul_ppa_advisory.py"
RTLMUL_PPA_BUILD = ROOT / "build/ai_eda/rtlmul_ppa"
RTLMUL_PPA_CLAIM_BOUNDARY = "advisory_ppa_target_capture_only_no_prediction_no_design_decision"
HLS_TARGETS_SCRIPT = ROOT / "scripts/ai_eda/capture_hls_accelerator_targets.py"
HLS_TARGETS_BUILD = ROOT / "build/ai_eda/hls_accelerator_targets"
HLS_TARGETS_CLAIM_BOUNDARY = "hls_target_capture_only_no_generated_hls_or_rtl"
TIMING_TARGETS_SCRIPT = ROOT / "scripts/ai_eda/capture_timing_closure_targets.py"
TIMING_TARGETS_BUILD = ROOT / "build/ai_eda/timing_closure_targets"
TIMING_TARGETS_CLAIM_BOUNDARY = "timing_closure_target_capture_only_no_constraint_or_eco_change"
ANALOG_TARGETS_SCRIPT = ROOT / "scripts/ai_eda/capture_analog_mixed_signal_targets.py"
ANALOG_TARGETS_BUILD = ROOT / "build/ai_eda/analog_mixed_signal_targets"
ANALOG_TARGETS_CLAIM_BOUNDARY = (
    "analog_mixed_signal_target_capture_only_no_spice_layout_or_ip_generation"
)
MEMORY_TARGETS_SCRIPT = ROOT / "scripts/ai_eda/capture_memory_interconnect_targets.py"
MEMORY_TARGETS_BUILD = ROOT / "build/ai_eda/memory_interconnect_targets"
MEMORY_TARGETS_CLAIM_BOUNDARY = "memory_interconnect_target_capture_only_no_fabric_or_claim_change"
DFT_TARGETS_SCRIPT = ROOT / "scripts/ai_eda/capture_dft_atpg_targets.py"
DFT_TARGETS_BUILD = ROOT / "build/ai_eda/dft_atpg_targets"
DFT_TARGETS_CLAIM_BOUNDARY = "dft_atpg_target_capture_only_no_scan_or_pattern_generation"
POWER_THERMAL_TARGETS_SCRIPT = ROOT / "scripts/ai_eda/capture_power_thermal_targets.py"
POWER_THERMAL_TARGETS_BUILD = ROOT / "build/ai_eda/power_thermal_targets"
POWER_THERMAL_TARGETS_CLAIM_BOUNDARY = "power_thermal_target_capture_only_no_power_or_thermal_claim"
SECURITY_TARGETS_SCRIPT = ROOT / "scripts/ai_eda/capture_hardware_security_targets.py"
SECURITY_TARGETS_BUILD = ROOT / "build/ai_eda/hardware_security_targets"
SECURITY_TARGETS_CLAIM_BOUNDARY = (
    "hardware_security_target_capture_only_no_vulnerability_or_trojan_claim"
)
CDC_RDC_TARGETS_SCRIPT = ROOT / "scripts/ai_eda/capture_cdc_rdc_targets.py"
CDC_RDC_TARGETS_BUILD = ROOT / "build/ai_eda/cdc_rdc_targets"
CDC_RDC_TARGETS_CLAIM_BOUNDARY = "cdc_rdc_target_capture_only_no_constraint_waiver_or_signoff_claim"
SOFTWARE_BSP_TARGETS_SCRIPT = ROOT / "scripts/ai_eda/capture_software_bsp_firmware_targets.py"
SOFTWARE_BSP_TARGETS_BUILD = ROOT / "build/ai_eda/software_bsp_firmware_targets"
SOFTWARE_BSP_TARGETS_CLAIM_BOUNDARY = (
    "software_bsp_firmware_target_capture_only_no_boot_bsp_or_perf_claim"
)
RTL_REWRITE_TARGETS_SCRIPT = ROOT / "scripts/ai_eda/capture_rtl_rewrite_equivalence_targets.py"
RTL_REWRITE_TARGETS_BUILD = ROOT / "build/ai_eda/rtl_rewrite_equivalence_targets"
RTL_REWRITE_TARGETS_CLAIM_BOUNDARY = (
    "rtl_rewrite_equivalence_target_capture_only_no_rewrite_or_ppa_claim"
)
BOARD_PACKAGE_FPGA_TARGETS_SCRIPT = ROOT / "scripts/ai_eda/capture_board_package_fpga_targets.py"
BOARD_PACKAGE_FPGA_TARGETS_BUILD = ROOT / "build/ai_eda/board_package_fpga_targets"
BOARD_PACKAGE_FPGA_TARGETS_CLAIM_BOUNDARY = (
    "board_package_fpga_target_capture_only_no_fab_package_or_fpga_claim"
)
LOW_POWER_INTENT_TARGETS_SCRIPT = ROOT / "scripts/ai_eda/capture_low_power_intent_targets.py"
LOW_POWER_INTENT_TARGETS_BUILD = ROOT / "build/ai_eda/low_power_intent_targets"
LOW_POWER_INTENT_TARGETS_CLAIM_BOUNDARY = (
    "low_power_intent_target_capture_only_no_power_intent_or_rtl_change"
)
VERIFICATION_DEBUG_TARGETS_SCRIPT = ROOT / "scripts/ai_eda/capture_verification_debug_targets.py"
VERIFICATION_DEBUG_TARGETS_BUILD = ROOT / "build/ai_eda/verification_debug_targets"
VERIFICATION_DEBUG_TARGETS_CLAIM_BOUNDARY = (
    "verification_debug_target_capture_only_no_patch_testbench_or_assertion_binding"
)
POST_SILICON_TARGETS_SCRIPT = ROOT / "scripts/ai_eda/capture_post_silicon_validation_targets.py"
POST_SILICON_TARGETS_BUILD = ROOT / "build/ai_eda/post_silicon_validation_targets"
POST_SILICON_TARGETS_CLAIM_BOUNDARY = (
    "post_silicon_validation_target_capture_only_no_silicon_or_lab_claim"
)
CIRCUIT_FOUNDATION_TARGETS_SCRIPT = (
    ROOT / "scripts/ai_eda/capture_circuit_foundation_model_targets.py"
)
CIRCUIT_FOUNDATION_TARGETS_BUILD = ROOT / "build/ai_eda/circuit_foundation_model_targets"
CIRCUIT_FOUNDATION_TARGETS_CLAIM_BOUNDARY = (
    "circuit_foundation_model_target_capture_only_no_training_embedding_or_claim"
)

REQUIRED_SOURCES = {
    "agentic-eda-survey-2512-23189v2",
    "autoeda-mcp",
    "rtl-coder",
    "verilog-eval",
    "cvdp",
    "circuitnet",
    "circuitnet-2",
    "circuit-foundation-model-survey",
    "chipnemo",
    "geneda",
    "nettag",
    "deepgate4",
    "chiplingo",
    "google-circuit-training",
    "autodmp",
    "orassistant",
    "zigzag",
    "timeloop-accelergy",
    "llm4dv",
    "assertllm",
    "assertionforge",
    "codev-sva",
    "fault-dft",
    "deepoheat",
    "hardware-trojan-ml",
    "trojansaint",
    "gnn-mff",
    "securerag-rtl",
    "trojanwhisper",
    "trojangym",
    "ghost-benchmarks",
    "accellera-cdc-rdc-standard",
    "formal-cdc-msi",
    "questa-cdc-rdc-assist",
    "opencdc",
    "mcp4eda",
    "llm-firmware-validation",
    "eok-riscv-kernel-optimization",
    "intrintrans-rvv",
    "opensbi",
    "u-boot",
    "rtlrewriter-bench",
    "formalrtl",
    "rtl-timing-metamorphosis",
    "openabc-d",
    "rocketppa",
    "pcbschemagen",
    "pcb-bench",
    "pcbagent",
    "neurpcb",
    "pcb-migrator",
    "pcb-pr-app",
    "freerouting",
    "dreamplacefpga",
    "rapidwright-dreamplacefpga",
    "deeppcb-defect-dataset",
    "ieee-1801-upf",
    "ieee-upf-open-source",
    "yosys-clockgate",
    "codmas-rtlopt",
    "prompting-for-power",
    "poet-rtl-ppa",
    "rtl-ppa-sog",
    "openroad-two-phase-clock",
    "pro-v",
    "saarthi-formal-verification",
    "sangam-sva",
    "fvdebug",
    "siliconmind-v1",
    "symbolic-qed",
    "soc-trace-protocol-debug",
    "riscv-dv",
    "riscof",
    "riscv-arch-test",
    "opentitan-chip-tests",
    "ml-boot-failure-debug",
    "llm4sechw-debug",
    "rtlmul",
    "deeptpi",
    "deft-atpg",
    "lite-scan-instrumentation",
    "drl-atpg",
    "atpg-via-ai-survey",
    "atpg-toolkit",
    "nn-for-atpg",
    "thermedge-iredge",
    "waca-unet-ir-drop",
    "ir-drop-predictor",
    "eda-irdrop-prediction",
    "openpdn",
    "aieda",
    "hlsfactory",
    "hls-eval",
    "idse-hls",
    "secda-dse",
    "timingpredict",
    "e2eslack",
    "timingllm",
    "fluxeda",
    "openroad-resizer",
    "ir-aware-eco-rl",
    "align-analoglayout",
    "autockt",
    "genie-asi",
    "acdc-analog-llm",
    "ado-llm",
    "analoggenie",
    "masala-chai",
    "limca",
    "archgym",
    "ai-noc-dse",
    "booksim2",
    "ramulator2",
    "dramsim3",
    "dramsys",
    "gem5-aladdin",
    "gem5-accesys",
}

REQUIRED_WORK_ITEMS = {
    "p0-ai-eda-critical-sota-review",
    "p1-local-eda-rag-log-triage",
    "p1-external-source-metadata-probe",
    "p1-local-ai-eda-backend-preflight",
    "p1-openroad-openlane-autotune",
    "p1-llm4dv-cocotb-stimulus-loop",
    "p1-assertion-candidate-review",
    "p1-zigzag-npu-dse",
    "p1-simulator-benchmark-optimization",
    "p1-rtlmul-ppa-advisory",
    "p1-hls-accelerator-target-capture",
    "p1-timing-closure-target-capture",
    "p2-analog-mixed-signal-target-capture",
    "p1-memory-interconnect-target-capture",
    "p1-dft-atpg-target-capture",
    "p1-power-thermal-target-capture",
    "p1-hardware-security-target-capture",
    "p1-cdc-rdc-target-capture",
    "p1-software-bsp-firmware-target-capture",
    "p1-rtl-rewrite-equivalence-target-capture",
    "p1-board-package-fpga-target-capture",
    "p1-low-power-intent-target-capture",
    "p1-verification-debug-target-capture",
    "p1-post-silicon-validation-target-capture",
    "p1-circuit-foundation-model-target-capture",
    "p2-rtl-model-evaluation-harness",
    "p2-e1-pd-predictor-dataset",
    "p2-dft-atpg-watch",
    "p2-power-thermal-ai-watch",
    "p2-hardware-security-ai-watch",
}


def fail(errors: list[str], message: str) -> None:
    errors.append(message)


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_json(path: Path, errors: list[str]) -> Any:
    if not path.is_file():
        fail(errors, f"missing JSON report {path.relative_to(ROOT)}")
        return None
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        fail(errors, f"{path.relative_to(ROOT)}: invalid JSON: {exc}")
        return None
    return data


def require_fields(data: dict[str, Any], fields: set[str], label: str, errors: list[str]) -> None:
    missing = sorted(fields - set(data))
    if missing:
        fail(errors, f"{label}: missing fields: {', '.join(missing)}")


def check_inventory(errors: list[str]) -> set[str]:
    if not INVENTORY.is_file():
        fail(errors, f"missing {INVENTORY.relative_to(ROOT)}")
        return set()
    data = yaml.safe_load(INVENTORY.read_text())
    if not isinstance(data, dict):
        fail(errors, "inventory root must be a mapping")
        return set()
    require_fields(data, {"schema", "policy", "entries"}, "inventory", errors)
    if data.get("schema") != "eliza.ai_eda_source_inventory.v1":
        fail(errors, "unexpected inventory schema")
    policy = data.get("policy")
    if not isinstance(policy, dict) or policy.get("ai_output_is_not_evidence") is not True:
        fail(errors, "inventory policy must block AI output as evidence")
    ids: set[str] = set()
    for entry in data.get("entries") or []:
        if not isinstance(entry, dict):
            fail(errors, "inventory entry must be a mapping")
            continue
        require_fields(
            entry,
            {"id", "stage", "priority", "source_url", "evidence_gate", "risk"},
            f"entry {entry.get('id')}",
            errors,
        )
        entry_id = entry.get("id")
        if isinstance(entry_id, str):
            ids.add(entry_id)
        if not isinstance(entry.get("risk"), list) or not entry["risk"]:
            fail(errors, f"{entry_id}: risk must be a non-empty list")
        if not isinstance(entry.get("evidence_gate"), str) or len(entry["evidence_gate"]) < 20:
            fail(errors, f"{entry_id}: evidence_gate must be specific")
    for required in sorted(REQUIRED_SOURCES):
        if required not in ids:
            fail(errors, f"inventory missing required source {required}")
    return ids


def check_backlog(source_ids: set[str], errors: list[str]) -> int:
    if not BACKLOG.is_file():
        fail(errors, f"missing {BACKLOG.relative_to(ROOT)}")
        return 0
    data = yaml.safe_load(BACKLOG.read_text())
    if not isinstance(data, dict):
        fail(errors, "backlog root must be a mapping")
        return 0
    if data.get("schema") != "eliza.ai_eda_integration_backlog.v1":
        fail(errors, "unexpected backlog schema")
    items = data.get("work_items")
    if not isinstance(items, list) or not items:
        fail(errors, "backlog must contain work_items")
        return 0
    seen: set[str] = set()
    for item in items:
        if not isinstance(item, dict):
            fail(errors, "work item must be a mapping")
            continue
        item_id = item.get("id")
        if isinstance(item_id, str):
            seen.add(item_id)
        require_fields(
            item,
            {"id", "status", "source_ids", "deliverables", "evidence_gate", "validation_commands"},
            f"work item {item_id}",
            errors,
        )
        for source_id in item.get("source_ids") or []:
            if source_id not in source_ids:
                fail(errors, f"{item_id}: unknown source_id {source_id}")
        if "python3 scripts/check_ai_eda_source_inventory.py" not in (
            item.get("validation_commands") or []
        ):
            fail(errors, f"{item_id}: validation_commands must include inventory checker")
    for required in sorted(REQUIRED_WORK_ITEMS):
        if required not in seen:
            fail(errors, f"backlog missing required work item {required}")
    return len(items)


def check_sota_review(source_ids: set[str], errors: list[str]) -> None:
    if not SOTA_REVIEW.is_file():
        fail(errors, f"missing {SOTA_REVIEW.relative_to(ROOT)}")
        return
    text = SOTA_REVIEW.read_text()
    for phrase in (
        "AI outputs are not evidence",
        "RTL generation",
        "Physical-design ML",
        "Verification",
        "Simulator and NPU architecture search",
    ):
        if phrase not in text:
            fail(errors, f"{SOTA_REVIEW.relative_to(ROOT)}: missing review phrase {phrase!r}")
    for source_id in ("RTL-Coder", "CircuitNet", "AutoDMP", "CVDP"):
        if source_id not in text:
            fail(errors, f"{SOTA_REVIEW.relative_to(ROOT)}: missing source mention {source_id}")
    if "symrtlo" in source_ids and "equivalence" not in text.lower():
        fail(
            errors,
            f"{SOTA_REVIEW.relative_to(ROOT)}: RTL optimization review must mention equivalence",
        )


def check_readiness(source_ids: set[str], errors: list[str]) -> None:
    if not READINESS.is_file():
        fail(errors, f"missing {READINESS.relative_to(ROOT)}")
        return
    data = yaml.safe_load(READINESS.read_text())
    if not isinstance(data, dict):
        fail(errors, "readiness root must be a mapping")
        return
    if data.get("schema") != "eliza.ai_eda_automation_readiness.v1":
        fail(errors, "unexpected readiness schema")
    policy = data.get("policy")
    if not isinstance(policy, dict) or policy.get("ai_output_is_not_evidence") is not True:
        fail(errors, "readiness policy must block AI output as evidence")
    stages = data.get("stages")
    if not isinstance(stages, list) or not stages:
        fail(errors, "readiness must contain stages")
        return
    seen = {stage.get("id") for stage in stages if isinstance(stage, dict)}
    for required in (
        "rtl_generation",
        "external_source_provenance",
        "local_backend_readiness",
        "verification_stimulus",
        "assertion_generation",
        "physical_design_prediction",
        "circuit_foundation_models",
        "placement_optimization",
        "npu_architecture_dse",
        "software_bsp_and_firmware",
        "simulator_benchmark_optimization",
        "rtl_ppa_advisory_prediction",
        "hls_accelerator_automation",
        "timing_closure_automation",
        "analog_mixed_signal_automation",
        "memory_interconnect_automation",
        "dft_and_manufacturing_test",
        "power_thermal_prediction",
        "hardware_security_ai",
        "cdc_rdc_automation",
        "board_package_fpga_automation",
        "low_power_intent_automation",
        "verification_debug_and_planning",
        "post_silicon_validation_automation",
    ):
        if required not in seen:
            fail(errors, f"readiness missing stage {required}")
    for stage in stages:
        if not isinstance(stage, dict):
            fail(errors, "readiness stage must be a mapping")
            continue
        require_fields(
            stage,
            {"id", "rating", "source_ids", "local_lane", "current_artifacts", "next_gate"},
            f"readiness stage {stage.get('id')}",
            errors,
        )
        if stage.get("rating") not in {
            "READY_DRY_RUN",
            "READY_ADVISORY",
            "BLOCKED_NEEDS_EVIDENCE",
            "RESEARCH_ONLY",
        }:
            fail(errors, f"readiness stage {stage.get('id')}: invalid rating")
        for source_id in stage.get("source_ids") or []:
            if source_id not in source_ids:
                fail(errors, f"readiness stage {stage.get('id')}: unknown source_id {source_id}")


def check_provenance(source_ids: set[str], errors: list[str]) -> None:
    if not PROVENANCE.is_file():
        fail(errors, f"missing {PROVENANCE.relative_to(ROOT)}")
        return
    data = yaml.safe_load(PROVENANCE.read_text())
    if not isinstance(data, dict):
        fail(errors, "provenance root must be a mapping")
        return
    if data.get("schema") != "eliza.ai_eda_provenance_matrix.v1":
        fail(errors, "unexpected provenance schema")
    policy = data.get("policy")
    if not isinstance(policy, dict) or policy.get("unknown_license_blocks_release_use") is not True:
        fail(errors, "provenance policy must block unknown-license release use")
    entries = data.get("entries")
    if not isinstance(entries, list) or not entries:
        fail(errors, "provenance must contain entries")
        return
    seen: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            fail(errors, "provenance entry must be a mapping")
            continue
        require_fields(
            entry,
            {"source_id", "asset_type", "asset_url", "license_status", "release_use"},
            f"provenance entry {entry.get('source_id')}",
            errors,
        )
        source_id = entry.get("source_id")
        if isinstance(source_id, str):
            seen.add(source_id)
            if source_id not in source_ids:
                fail(errors, f"provenance references unknown source_id {source_id}")
        if "blocked" not in str(entry.get("release_use")):
            fail(errors, f"provenance {source_id}: release_use must be blocked pending review")
    for required in ("rtl-coder", "chipcraftx-rtlgen-7b", "circuitnet", "zigzag", "assertllm"):
        if required not in seen:
            fail(errors, f"provenance missing required source {required}")


def check_external_probe_summary(source_ids: set[str], errors: list[str]) -> None:
    if not EXTERNAL_PROBE_SUMMARY.is_file():
        fail(errors, f"missing {EXTERNAL_PROBE_SUMMARY.relative_to(ROOT)}")
        return
    data = yaml.safe_load(EXTERNAL_PROBE_SUMMARY.read_text())
    if not isinstance(data, dict):
        fail(errors, "external probe summary root must be a mapping")
        return
    if data.get("schema") != "eliza.ai_eda_external_source_probe_summary.v1":
        fail(errors, "unexpected external probe summary schema")
    if data.get("claim_boundary") != "metadata_probe_summary_only_no_import_no_release_use":
        fail(errors, "unsafe external probe summary claim boundary")
    policy = data.get("policy")
    if not isinstance(policy, dict):
        fail(errors, "external probe summary missing policy")
    elif (
        policy.get("imports_external_assets") is not False
        or policy.get("downloads_model_weights") is not False
        or policy.get("release_use_allowed") is not False
    ):
        fail(errors, "external probe summary policy allows unsafe use")
    hints = data.get("observed_license_hints")
    if not isinstance(hints, list) or not hints:
        fail(errors, "external probe summary must include observed license hints")
        return
    seen: set[str] = set()
    for hint in hints:
        if not isinstance(hint, dict):
            fail(errors, "external probe summary hint must be a mapping")
            continue
        source_id = hint.get("source_id")
        if isinstance(source_id, str):
            seen.add(source_id)
            if source_id not in source_ids:
                fail(errors, f"external probe summary references unknown source_id {source_id}")
        if "blocked" not in str(hint.get("release_use")):
            fail(errors, f"external probe summary {source_id}: release_use must remain blocked")
    for required in ("chipcraftx-rtlgen-7b", "rtlmul", "zigzag", "assertllm"):
        if required not in seen:
            fail(errors, f"external probe summary missing required hint {required}")


def check_rtl_eval(errors: list[str]) -> None:
    for path in (RTL_EVAL_SCRIPT, RTL_EVAL_PLAN):
        if not path.is_file():
            fail(errors, f"missing RTL model eval deliverable {path.relative_to(ROOT)}")
    if not RTL_EVAL_BUILD.is_dir():
        return
    for run_dir in sorted(path for path in RTL_EVAL_BUILD.iterdir() if path.is_dir()):
        report_path = run_dir / "eval_report.json"
        label = str(run_dir.relative_to(ROOT))
        if not report_path.is_file():
            fail(errors, f"{label}: missing eval_report.json")
            continue
        report = load_json(report_path, errors)
        if not isinstance(report, dict):
            continue
        if report.get("schema") != "eliza.ai_eda.rtl_model_eval.report.v1":
            fail(errors, f"{label}: unexpected RTL model eval schema")
        if report.get("status") != "DRY_RUN_NO_MODEL_EXECUTION":
            fail(errors, f"{label}: report must not execute models")
        if report.get("claim_boundary") != RTL_CLAIM_BOUNDARY:
            fail(errors, f"{label}: unsafe claim boundary")
        policy = report.get("evaluation_policy")
        if not isinstance(policy, dict):
            fail(errors, f"{label}: missing evaluation_policy")
        elif (
            policy.get("generated_rtl_committed") is not False
            or policy.get("generated_rtl_enters_source") is not False
            or policy.get("release_use_blocked") is not True
            or policy.get("model_quality_claim_allowed") is not False
        ):
            fail(errors, f"{label}: unsafe RTL model evaluation policy")
        for task in report.get("tasks") or []:
            if task.get("status") != "DRY_RUN_NOT_GENERATED":
                fail(errors, f"{label}/{task.get('id')}: dry-run task generated RTL")


def check_pd_predictor(errors: list[str]) -> None:
    if not PD_PREDICTOR_SCRIPT.is_file():
        fail(errors, f"missing {PD_PREDICTOR_SCRIPT.relative_to(ROOT)}")
    if not PD_PREDICTOR_BUILD.is_dir():
        return
    for run_dir in sorted(path for path in PD_PREDICTOR_BUILD.iterdir() if path.is_dir()):
        snapshot = load_json(run_dir / "snapshot_manifest.json", errors)
        labels = load_json(run_dir / "label_report.json", errors)
        label = str(run_dir.relative_to(ROOT))
        if not isinstance(snapshot, dict) or not isinstance(labels, dict):
            continue
        if snapshot.get("claim_boundary") != PD_CLAIM_BOUNDARY:
            fail(errors, f"{label}: unsafe predictor claim boundary")
        if labels.get("signoff_claim_allowed") is not False:
            fail(errors, f"{label}: label report cannot allow signoff claims")
        for artifact in snapshot.get("artifacts") or []:
            path_value = artifact.get("path")
            if artifact.get("status") == "PRESENT" and isinstance(path_value, str):
                path = ROOT / path_value
                if not path.is_file() or artifact.get("sha256") != sha256_file(path):
                    fail(errors, f"{label}/{artifact.get('name')}: stale artifact hash")


def check_rag(errors: list[str]) -> None:
    if not RAG_SCRIPT.is_file():
        fail(errors, f"missing {RAG_SCRIPT.relative_to(ROOT)}")
    if not RAG_BUILD.is_dir():
        return
    manifest = load_json(RAG_BUILD / "source_manifest.json", errors)
    smoke = load_json(RAG_BUILD / "citation_smoke_report.json", errors)
    if isinstance(manifest, dict):
        if manifest.get("claim_boundary") != RAG_CLAIM_BOUNDARY:
            fail(errors, "RAG manifest has unsafe claim boundary")
        policy = manifest.get("index_policy")
        if not isinstance(policy, dict) or policy.get("read_only") is not True:
            fail(errors, "RAG manifest must be read-only")
        for source in manifest.get("sources") or []:
            path_value = source.get("path")
            if isinstance(path_value, str):
                path = ROOT / path_value
                if not path.is_file() or source.get("sha256") != sha256_file(path):
                    fail(errors, f"RAG source {source.get('id')}: stale source hash")
    if isinstance(smoke, dict):
        if smoke.get("claim_boundary") != RAG_CLAIM_BOUNDARY:
            fail(errors, "RAG smoke report has unsafe claim boundary")
        for query in smoke.get("queries") or []:
            if not query.get("citations"):
                fail(errors, f"RAG query {query.get('id')}: missing citations")


def check_cocotb_stimulus(errors: list[str]) -> None:
    for path in (COCOTB_SCRIPT, COCOTB_BINS, COCOTB_SEEDS):
        if not path.is_file():
            fail(errors, f"missing cocotb AI/EDA deliverable {path.relative_to(ROOT)}")
    if COCOTB_BINS.is_file():
        bins = yaml.safe_load(COCOTB_BINS.read_text())
        if not isinstance(bins, dict) or not bins.get("bins"):
            fail(errors, "cocotb coverage bins must contain bins")
    if COCOTB_SEEDS.is_file():
        seeds = yaml.safe_load(COCOTB_SEEDS.read_text())
        if not isinstance(seeds, dict) or not seeds.get("seeds"):
            fail(errors, "cocotb seed manifest must contain seeds")
    if not COCOTB_BUILD.is_dir():
        return
    for run_dir in sorted(path for path in COCOTB_BUILD.iterdir() if path.is_dir()):
        report = load_json(run_dir / "coverage_report.json", errors)
        label = str(run_dir.relative_to(ROOT))
        if not isinstance(report, dict):
            continue
        if report.get("claim_boundary") != COCOTB_CLAIM_BOUNDARY:
            fail(errors, f"{label}: unsafe cocotb stimulus claim boundary")
        if report.get("generated_candidate_count") != 0:
            fail(errors, f"{label}: dry-run cannot generate candidate tests")
        if report.get("coverage_delta_available") is not False:
            fail(errors, f"{label}: dry-run cannot claim coverage delta")


def check_zigzag(errors: list[str]) -> None:
    for path in (ZIGZAG_SCRIPT, ZIGZAG_CURRENT, ZIGZAG_TARGET):
        if not path.is_file():
            fail(errors, f"missing ZigZag AI/EDA deliverable {path.relative_to(ROOT)}")
    for path in (ZIGZAG_CURRENT, ZIGZAG_TARGET):
        if path.is_file():
            data = yaml.safe_load(path.read_text())
            if not isinstance(data, dict) or "architecture" not in data:
                fail(errors, f"{path.relative_to(ROOT)}: missing architecture")
    if not ZIGZAG_BUILD.is_dir():
        return
    for run_dir in sorted(path for path in ZIGZAG_BUILD.iterdir() if path.is_dir()):
        report_path = run_dir / "dse_report.yaml"
        label = str(run_dir.relative_to(ROOT))
        if not report_path.is_file():
            fail(errors, f"{label}: missing dse_report.yaml")
            continue
        report = yaml.safe_load(report_path.read_text())
        if not isinstance(report, dict):
            fail(errors, f"{label}: DSE report must be a mapping")
            continue
        if report.get("claim_boundary") != ZIGZAG_CLAIM_BOUNDARY:
            fail(errors, f"{label}: unsafe ZigZag claim boundary")
        if report.get("estimates_available") is not False:
            fail(errors, f"{label}: dry-run cannot claim estimates")
        for artifact in report.get("input_artifacts") or []:
            path_value = artifact.get("path")
            if isinstance(path_value, str):
                path = ROOT / path_value
                if not path.is_file() or artifact.get("sha256") != sha256_file(path):
                    fail(errors, f"{label}/{path_value}: stale architecture hash")


def check_openroad_autotune(errors: list[str]) -> None:
    if not OPENROAD_AUTOTUNE_SCRIPT.is_file():
        fail(errors, f"missing {OPENROAD_AUTOTUNE_SCRIPT.relative_to(ROOT)}")
        return
    script_text = OPENROAD_AUTOTUNE_SCRIPT.read_text()
    for token in ("DRY_RUN_NOT_EXECUTED", OPENROAD_AUTOTUNE_CLAIM_BOUNDARY, "executes_openlane"):
        if token not in script_text:
            fail(
                errors,
                f"{OPENROAD_AUTOTUNE_SCRIPT.relative_to(ROOT)}: missing safety token {token}",
            )
    if not OPENROAD_AUTOTUNE_BUILD.is_dir():
        return
    for run_dir in sorted(path for path in OPENROAD_AUTOTUNE_BUILD.iterdir() if path.is_dir()):
        manifest = load_json(run_dir / "autotune_manifest.json", errors)
        label = str(run_dir.relative_to(ROOT))
        if not isinstance(manifest, dict):
            continue
        if manifest.get("claim_boundary") != OPENROAD_AUTOTUNE_CLAIM_BOUNDARY:
            fail(errors, f"{label}: unsafe OpenROAD autotune claim boundary")
        if manifest.get("executes_openlane") is not False:
            fail(errors, f"{label}: dry-run cannot execute OpenLane")
        if manifest.get("status") != "DRY_RUN_NOT_EXECUTED":
            fail(errors, f"{label}: unexpected OpenROAD autotune status")


def check_assertion_candidates(source_ids: set[str], errors: list[str]) -> None:
    if not ASSERTION_CANDIDATES.is_file():
        fail(errors, f"missing {ASSERTION_CANDIDATES.relative_to(ROOT)}")
        return
    data = yaml.safe_load(ASSERTION_CANDIDATES.read_text())
    if not isinstance(data, dict):
        fail(errors, "assertion candidate manifest must be a mapping")
        return
    if data.get("schema") != "eliza.ai_eda.assertion_candidate_manifest.v1":
        fail(errors, "unexpected assertion candidate schema")
    if data.get("claim_boundary") != ASSERTION_CLAIM_BOUNDARY:
        fail(errors, "unsafe assertion candidate claim boundary")
    for source_id in data.get("source_ids") or []:
        if source_id not in source_ids:
            fail(errors, f"assertion candidates reference unknown source_id {source_id}")
    policy = data.get("review_policy")
    if not isinstance(policy, dict):
        fail(errors, "assertion candidates missing review_policy")
    elif (
        policy.get("generated_assertions_committed_to_rtl") is not False
        or policy.get("requires_formal_or_simulation_pass") is not True
        or policy.get("requires_human_review") is not True
    ):
        fail(errors, "unsafe assertion candidate review policy")
    candidates = data.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        fail(errors, "assertion candidates must include candidates")
        return
    for candidate in candidates:
        if not isinstance(candidate, dict):
            fail(errors, "assertion candidate must be a mapping")
            continue
        require_fields(
            candidate,
            {
                "id",
                "status",
                "source_spec",
                "target_signal_group",
                "property_intent",
                "promotion_gate",
            },
            f"assertion candidate {candidate.get('id')}",
            errors,
        )
        if "make formal" not in (candidate.get("promotion_gate") or []):
            fail(errors, f"assertion candidate {candidate.get('id')}: missing formal gate")


def check_simulator_optimization(source_ids: set[str], errors: list[str]) -> None:
    if not SIM_OPT_SCRIPT.is_file():
        fail(errors, f"missing {SIM_OPT_SCRIPT.relative_to(ROOT)}")
    if not SIM_OPT_BUILD.is_dir():
        return
    for run_dir in sorted(path for path in SIM_OPT_BUILD.iterdir() if path.is_dir()):
        report = load_json(run_dir / "targets_report.json", errors)
        label = str(run_dir.relative_to(ROOT))
        if not isinstance(report, dict):
            continue
        if report.get("schema") != "eliza.ai_eda.simulator_optimization_targets.v1":
            fail(errors, f"{label}: unexpected simulator optimization schema")
        if report.get("claim_boundary") != SIM_OPT_CLAIM_BOUNDARY:
            fail(errors, f"{label}: unsafe simulator optimization claim boundary")
        if not report.get("targets"):
            fail(errors, f"{label}: simulator optimization report must contain targets")
        for source_id in report.get("source_ids") or []:
            if source_id not in source_ids:
                fail(errors, f"{label}: unknown source_id {source_id}")
        for artifact in report.get("input_artifacts") or []:
            path_value = artifact.get("path")
            if isinstance(path_value, str):
                path = ROOT / path_value
                if not path.is_file() or artifact.get("sha256") != sha256_file(path):
                    fail(errors, f"{label}/{path_value}: stale simulator input hash")
        gates = report.get("required_followup_gates") or []
        if "make benchmark-sim-metrics" not in gates:
            fail(errors, f"{label}: missing benchmark simulator follow-up gate")


def check_external_source_probe(source_ids: set[str], errors: list[str]) -> None:
    if not EXTERNAL_PROBE_SCRIPT.is_file():
        fail(errors, f"missing {EXTERNAL_PROBE_SCRIPT.relative_to(ROOT)}")
    if not EXTERNAL_PROBE_BUILD.is_dir():
        return
    for run_dir in sorted(path for path in EXTERNAL_PROBE_BUILD.iterdir() if path.is_dir()):
        report = load_json(run_dir / "source_probe_report.json", errors)
        label = str(run_dir.relative_to(ROOT))
        if not isinstance(report, dict):
            continue
        if report.get("schema") != "eliza.ai_eda.external_source_probe.v1":
            fail(errors, f"{label}: unexpected external source probe schema")
        if report.get("claim_boundary") != EXTERNAL_PROBE_CLAIM_BOUNDARY:
            fail(errors, f"{label}: unsafe external source probe claim boundary")
        policy = report.get("policy")
        if not isinstance(policy, dict):
            fail(errors, f"{label}: missing external source probe policy")
        elif (
            policy.get("imports_external_assets") is not False
            or policy.get("downloads_model_weights") is not False
            or policy.get("release_use_allowed") is not False
        ):
            fail(errors, f"{label}: external source probe policy allows unsafe use")
        if report.get("status") != "PROBED_WITH_RELEASE_USE_BLOCKED":
            fail(errors, f"{label}: external source probe status must block release use")
        probes = report.get("probes")
        if not isinstance(probes, list) or not probes:
            fail(errors, f"{label}: external source probe must contain probes")
            continue
        providers = {probe.get("provider") for probe in probes if isinstance(probe, dict)}
        if "github" not in providers or "huggingface" not in providers:
            fail(errors, f"{label}: external source probe must cover GitHub and Hugging Face")
        for probe in probes:
            if not isinstance(probe, dict):
                fail(errors, f"{label}: probe must be a mapping")
                continue
            source_id = probe.get("source_id")
            if source_id not in source_ids:
                fail(errors, f"{label}: unknown source_id {source_id}")
            if probe.get("release_use_allowed") is not False:
                fail(errors, f"{label}/{source_id}: probe cannot allow release use")


def check_backend_preflight(source_ids: set[str], errors: list[str]) -> None:
    if not BACKEND_PREFLIGHT_SCRIPT.is_file():
        fail(errors, f"missing {BACKEND_PREFLIGHT_SCRIPT.relative_to(ROOT)}")
    if not BACKEND_PREFLIGHT_BUILD.is_dir():
        return
    for run_dir in sorted(path for path in BACKEND_PREFLIGHT_BUILD.iterdir() if path.is_dir()):
        report = load_json(run_dir / "backend_preflight_report.json", errors)
        label = str(run_dir.relative_to(ROOT))
        if not isinstance(report, dict):
            continue
        if report.get("schema") != "eliza.ai_eda.backend_preflight.v1":
            fail(errors, f"{label}: unexpected backend preflight schema")
        if report.get("claim_boundary") != BACKEND_PREFLIGHT_CLAIM_BOUNDARY:
            fail(errors, f"{label}: unsafe backend preflight claim boundary")
        policy = report.get("policy")
        if not isinstance(policy, dict):
            fail(errors, f"{label}: missing backend preflight policy")
        elif (
            policy.get("installs_packages") is not False
            or policy.get("clones_repositories") is not False
            or policy.get("downloads_model_weights") is not False
            or policy.get("release_use_allowed") is not False
        ):
            fail(errors, f"{label}: backend preflight policy allows unsafe use")
        backends = report.get("backends")
        if not isinstance(backends, list) or not backends:
            fail(errors, f"{label}: backend preflight must contain backends")
            continue
        seen: set[str] = set()
        for backend in backends:
            if not isinstance(backend, dict):
                fail(errors, f"{label}: backend must be a mapping")
                continue
            source_id = backend.get("source_id")
            backend_id = backend.get("id")
            if isinstance(backend_id, str):
                seen.add(backend_id)
            if source_id not in source_ids:
                fail(errors, f"{label}: unknown source_id {source_id}")
            if backend.get("release_use_allowed") is not False:
                fail(errors, f"{label}/{backend_id}: backend cannot allow release use")
            if backend.get("status") not in {
                "LOCAL_BACKEND_CANDIDATE_PRESENT",
                "BLOCKED_BACKEND_NOT_INSTALLED",
            }:
                fail(errors, f"{label}/{backend_id}: invalid backend status")
        for required in (
            "zigzag",
            "timeloop_accelergy",
            "rtlmul",
            "llm4dv",
            "assertllm",
            "fault_dft",
        ):
            if required not in seen:
                fail(errors, f"{label}: missing backend {required}")


def check_rtlmul_ppa(source_ids: set[str], errors: list[str]) -> None:
    if not RTLMUL_PPA_SCRIPT.is_file():
        fail(errors, f"missing {RTLMUL_PPA_SCRIPT.relative_to(ROOT)}")
    if not RTLMUL_PPA_BUILD.is_dir():
        return
    for run_dir in sorted(path for path in RTLMUL_PPA_BUILD.iterdir() if path.is_dir()):
        report = load_json(run_dir / "ppa_advisory_report.json", errors)
        label = str(run_dir.relative_to(ROOT))
        if not isinstance(report, dict):
            continue
        if report.get("schema") != "eliza.ai_eda.rtlmul_ppa_advisory.v1":
            fail(errors, f"{label}: unexpected RTLMUL PPA advisory schema")
        if report.get("claim_boundary") != RTLMUL_PPA_CLAIM_BOUNDARY:
            fail(errors, f"{label}: unsafe RTLMUL PPA advisory claim boundary")
        if report.get("status") != "TARGET_CAPTURE_ONLY_NO_MODEL_EXECUTION":
            fail(errors, f"{label}: RTLMUL PPA advisory must not execute a model")
        for source_id in report.get("source_ids") or []:
            if source_id not in source_ids:
                fail(errors, f"{label}: unknown source_id {source_id}")
        policy = report.get("model_policy")
        if not isinstance(policy, dict):
            fail(errors, f"{label}: missing RTLMUL model_policy")
        elif (
            policy.get("model_weights_downloaded") is not False
            or policy.get("model_loaded") is not False
            or policy.get("prediction_generated") is not False
            or policy.get("release_use_allowed") is not False
        ):
            fail(errors, f"{label}: RTLMUL model_policy allows unsafe use")
        targets = report.get("targets")
        if not isinstance(targets, list) or not targets:
            fail(errors, f"{label}: RTLMUL advisory report must contain targets")
            continue
        for target in targets:
            if target.get("prediction") is not None:
                fail(errors, f"{label}/{target.get('module')}: prediction must be absent")
            if target.get("prediction_status") != "NOT_RUN_NO_MODEL_WEIGHTS_LOADED":
                fail(errors, f"{label}/{target.get('module')}: unsafe prediction status")
            rtl_path = target.get("rtl_path")
            if isinstance(rtl_path, str) and target.get("rtl_status") == "PRESENT":
                path = ROOT / rtl_path
                if not path.is_file() or target.get("rtl_sha256") != sha256_file(path):
                    fail(errors, f"{label}/{rtl_path}: stale RTL hash")
        for artifact in report.get("input_artifacts") or []:
            path_value = artifact.get("path")
            if artifact.get("status") == "PRESENT" and isinstance(path_value, str):
                path = ROOT / path_value
                if not path.is_file() or artifact.get("sha256") != sha256_file(path):
                    fail(errors, f"{label}/{path_value}: stale input artifact hash")
        gates = report.get("required_followup_gates") or []
        if "make synth" not in gates:
            fail(errors, f"{label}: missing synthesis follow-up gate")


def check_hls_accelerator_targets(source_ids: set[str], errors: list[str]) -> None:
    if not HLS_TARGETS_SCRIPT.is_file():
        fail(errors, f"missing {HLS_TARGETS_SCRIPT.relative_to(ROOT)}")
    if not HLS_TARGETS_BUILD.is_dir():
        return
    for run_dir in sorted(path for path in HLS_TARGETS_BUILD.iterdir() if path.is_dir()):
        report = load_json(run_dir / "targets_report.json", errors)
        label = str(run_dir.relative_to(ROOT))
        if not isinstance(report, dict):
            continue
        if report.get("schema") != "eliza.ai_eda.hls_accelerator_targets.v1":
            fail(errors, f"{label}: unexpected HLS accelerator targets schema")
        if report.get("claim_boundary") != HLS_TARGETS_CLAIM_BOUNDARY:
            fail(errors, f"{label}: unsafe HLS accelerator claim boundary")
        if report.get("status") != "TARGET_CAPTURE_ONLY_NO_HLS_GENERATION":
            fail(errors, f"{label}: HLS target capture must not generate code")
        for source_id in report.get("source_ids") or []:
            if source_id not in source_ids:
                fail(errors, f"{label}: unknown source_id {source_id}")
        policy = report.get("policy")
        if not isinstance(policy, dict):
            fail(errors, f"{label}: missing HLS target policy")
        elif (
            policy.get("generates_hls_code") is not False
            or policy.get("generates_rtl") is not False
            or policy.get("runs_hls_synthesis") is not False
            or policy.get("downloads_external_assets") is not False
            or policy.get("release_use_allowed") is not False
        ):
            fail(errors, f"{label}: HLS target policy allows unsafe use")
        tasks = report.get("candidate_tasks")
        if not isinstance(tasks, list) or not tasks:
            fail(errors, f"{label}: HLS target report must contain candidate tasks")
        for artifact in report.get("input_artifacts") or []:
            path_value = artifact.get("path")
            if artifact.get("status") == "PRESENT" and isinstance(path_value, str):
                path = ROOT / path_value
                if not path.is_file() or artifact.get("sha256") != sha256_file(path):
                    fail(errors, f"{label}/{path_value}: stale HLS input hash")
        gates = {
            gate
            for task in tasks or []
            if isinstance(task, dict)
            for gate in task.get("acceptance_gates", [])
        }
        if "make npu-runtime-contract-check" not in gates:
            fail(errors, f"{label}: missing NPU runtime contract follow-up gate")


def check_timing_closure_targets(source_ids: set[str], errors: list[str]) -> None:
    if not TIMING_TARGETS_SCRIPT.is_file():
        fail(errors, f"missing {TIMING_TARGETS_SCRIPT.relative_to(ROOT)}")
    if not TIMING_TARGETS_BUILD.is_dir():
        return
    for run_dir in sorted(path for path in TIMING_TARGETS_BUILD.iterdir() if path.is_dir()):
        report = load_json(run_dir / "targets_report.json", errors)
        label = str(run_dir.relative_to(ROOT))
        if not isinstance(report, dict):
            continue
        if report.get("schema") != "eliza.ai_eda.timing_closure_targets.v1":
            fail(errors, f"{label}: unexpected timing closure targets schema")
        if report.get("claim_boundary") != TIMING_TARGETS_CLAIM_BOUNDARY:
            fail(errors, f"{label}: unsafe timing closure claim boundary")
        if report.get("status") != "TARGET_CAPTURE_ONLY_NO_ECO_OR_CONSTRAINT_CHANGE":
            fail(errors, f"{label}: timing target capture must not edit constraints or ECOs")
        for source_id in report.get("source_ids") or []:
            if source_id not in source_ids:
                fail(errors, f"{label}: unknown source_id {source_id}")
        policy = report.get("policy")
        if not isinstance(policy, dict):
            fail(errors, f"{label}: missing timing target policy")
        elif (
            policy.get("changes_constraints") is not False
            or policy.get("changes_rtl") is not False
            or policy.get("changes_netlist") is not False
            or policy.get("runs_openroad") is not False
            or policy.get("applies_eco") is not False
            or policy.get("prediction_generated") is not False
            or policy.get("release_use_allowed") is not False
        ):
            fail(errors, f"{label}: timing target policy allows unsafe use")
        if not report.get("candidate_actions"):
            fail(errors, f"{label}: timing target report must contain candidate actions")
        for artifact in report.get("input_artifacts") or []:
            path_value = artifact.get("path")
            if artifact.get("status") == "PRESENT" and isinstance(path_value, str):
                path = ROOT / path_value
                if not path.is_file() or artifact.get("sha256") != sha256_file(path):
                    fail(errors, f"{label}/{path_value}: stale timing input hash")
        for artifact in report.get("timing_report_artifacts") or []:
            path_value = artifact.get("path")
            if isinstance(path_value, str):
                path = ROOT / path_value
                if not path.is_file() or artifact.get("sha256") != sha256_file(path):
                    fail(errors, f"{label}/{path_value}: stale timing report hash")
        gates = {
            gate
            for action in report.get("candidate_actions") or []
            if isinstance(action, dict)
            for gate in action.get("acceptance_gates", [])
        }
        if "python3 scripts/check_pd_closure.py" not in gates:
            fail(errors, f"{label}: missing PD closure follow-up gate")


def check_analog_mixed_signal_targets(source_ids: set[str], errors: list[str]) -> None:
    if not ANALOG_TARGETS_SCRIPT.is_file():
        fail(errors, f"missing {ANALOG_TARGETS_SCRIPT.relative_to(ROOT)}")
    if not ANALOG_TARGETS_BUILD.is_dir():
        return
    for run_dir in sorted(path for path in ANALOG_TARGETS_BUILD.iterdir() if path.is_dir()):
        report = load_json(run_dir / "targets_report.json", errors)
        label = str(run_dir.relative_to(ROOT))
        if not isinstance(report, dict):
            continue
        if report.get("schema") != "eliza.ai_eda.analog_mixed_signal_targets.v1":
            fail(errors, f"{label}: unexpected analog/mixed-signal targets schema")
        if report.get("claim_boundary") != ANALOG_TARGETS_CLAIM_BOUNDARY:
            fail(errors, f"{label}: unsafe analog/mixed-signal claim boundary")
        if report.get("status") != "TARGET_CAPTURE_ONLY_NO_ANALOG_GENERATION":
            fail(errors, f"{label}: analog target capture must not generate artifacts")
        for source_id in report.get("source_ids") or []:
            if source_id not in source_ids:
                fail(errors, f"{label}: unknown source_id {source_id}")
        policy = report.get("policy")
        if not isinstance(policy, dict):
            fail(errors, f"{label}: missing analog target policy")
        elif (
            policy.get("generates_spice_netlist") is not False
            or policy.get("generates_layout") is not False
            or policy.get("runs_spice") is not False
            or policy.get("runs_drc_lvs") is not False
            or policy.get("selects_foundry_ip") is not False
            or policy.get("changes_padframe") is not False
            or policy.get("release_use_allowed") is not False
        ):
            fail(errors, f"{label}: analog target policy allows unsafe use")
        tasks = report.get("candidate_tasks")
        if not isinstance(tasks, list) or not tasks:
            fail(errors, f"{label}: analog target report must contain candidate tasks")
        for artifact in report.get("input_artifacts") or []:
            path_value = artifact.get("path")
            if artifact.get("status") == "PRESENT" and isinstance(path_value, str):
                path = ROOT / path_value
                if not path.is_file() or artifact.get("sha256") != sha256_file(path):
                    fail(errors, f"{label}/{path_value}: stale analog input hash")
        gates = {
            gate
            for task in tasks or []
            if isinstance(task, dict)
            for gate in task.get("acceptance_gates", [])
        }
        if "make padframe-check" not in gates:
            fail(errors, f"{label}: missing padframe follow-up gate")


def check_memory_interconnect_targets(source_ids: set[str], errors: list[str]) -> None:
    if not MEMORY_TARGETS_SCRIPT.is_file():
        fail(errors, f"missing {MEMORY_TARGETS_SCRIPT.relative_to(ROOT)}")
    if not MEMORY_TARGETS_BUILD.is_dir():
        return
    for run_dir in sorted(path for path in MEMORY_TARGETS_BUILD.iterdir() if path.is_dir()):
        report = load_json(run_dir / "targets_report.json", errors)
        label = str(run_dir.relative_to(ROOT))
        if not isinstance(report, dict):
            continue
        if report.get("schema") != "eliza.ai_eda.memory_interconnect_targets.v1":
            fail(errors, f"{label}: unexpected memory/interconnect targets schema")
        if report.get("claim_boundary") != MEMORY_TARGETS_CLAIM_BOUNDARY:
            fail(errors, f"{label}: unsafe memory/interconnect claim boundary")
        if report.get("status") != "TARGET_CAPTURE_ONLY_NO_MEMORY_FABRIC_CHANGE":
            fail(errors, f"{label}: memory target capture must not edit fabric")
        for source_id in report.get("source_ids") or []:
            if source_id not in source_ids:
                fail(errors, f"{label}: unknown source_id {source_id}")
        policy = report.get("policy")
        if not isinstance(policy, dict):
            fail(errors, f"{label}: missing memory/interconnect target policy")
        elif (
            policy.get("changes_rtl") is not False
            or policy.get("changes_memory_map") is not False
            or policy.get("changes_coherency_policy") is not False
            or policy.get("generates_fabric") is not False
            or policy.get("runs_external_simulator") is not False
            or policy.get("downloads_external_assets") is not False
            or policy.get("prediction_generated") is not False
            or policy.get("release_use_allowed") is not False
        ):
            fail(errors, f"{label}: memory/interconnect target policy allows unsafe use")
        tasks = report.get("candidate_tasks")
        if not isinstance(tasks, list) or not tasks:
            fail(errors, f"{label}: memory/interconnect target report must contain tasks")
        for artifact in report.get("input_artifacts") or []:
            path_value = artifact.get("path")
            if artifact.get("status") == "PRESENT" and isinstance(path_value, str):
                path = ROOT / path_value
                if not path.is_file() or artifact.get("sha256") != sha256_file(path):
                    fail(errors, f"{label}/{path_value}: stale memory/interconnect hash")
        gates = {
            gate
            for task in tasks or []
            if isinstance(task, dict)
            for gate in task.get("acceptance_gates", [])
        }
        if "make memory-interconnect-contract-check" not in gates:
            fail(errors, f"{label}: missing memory/interconnect contract follow-up gate")


def check_dft_atpg_targets(source_ids: set[str], errors: list[str]) -> None:
    if not DFT_TARGETS_SCRIPT.is_file():
        fail(errors, f"missing {DFT_TARGETS_SCRIPT.relative_to(ROOT)}")
    if not DFT_TARGETS_BUILD.is_dir():
        return
    for run_dir in sorted(path for path in DFT_TARGETS_BUILD.iterdir() if path.is_dir()):
        report = load_json(run_dir / "targets_report.json", errors)
        label = str(run_dir.relative_to(ROOT))
        if not isinstance(report, dict):
            continue
        if report.get("schema") != "eliza.ai_eda.dft_atpg_targets.v1":
            fail(errors, f"{label}: unexpected DFT/ATPG targets schema")
        if report.get("claim_boundary") != DFT_TARGETS_CLAIM_BOUNDARY:
            fail(errors, f"{label}: unsafe DFT/ATPG claim boundary")
        if report.get("status") != "TARGET_CAPTURE_ONLY_NO_DFT_INSERTION":
            fail(errors, f"{label}: DFT target capture must not insert scan or tests")
        for source_id in report.get("source_ids") or []:
            if source_id not in source_ids:
                fail(errors, f"{label}: unknown source_id {source_id}")
        policy = report.get("policy")
        if not isinstance(policy, dict):
            fail(errors, f"{label}: missing DFT/ATPG target policy")
        elif (
            policy.get("inserts_scan") is not False
            or policy.get("inserts_test_points") is not False
            or policy.get("changes_rtl") is not False
            or policy.get("changes_netlist") is not False
            or policy.get("runs_atpg") is not False
            or policy.get("generates_test_patterns") is not False
            or policy.get("downloads_external_assets") is not False
            or policy.get("prediction_generated") is not False
            or policy.get("fault_coverage_claim_allowed") is not False
            or policy.get("release_use_allowed") is not False
        ):
            fail(errors, f"{label}: DFT/ATPG target policy allows unsafe use")
        tasks = report.get("candidate_tasks")
        if not isinstance(tasks, list) or not tasks:
            fail(errors, f"{label}: DFT/ATPG target report must contain tasks")
        for artifact in report.get("input_artifacts") or []:
            path_value = artifact.get("path")
            if artifact.get("status") == "PRESENT" and isinstance(path_value, str):
                path = ROOT / path_value
                if not path.is_file() or artifact.get("sha256") != sha256_file(path):
                    fail(errors, f"{label}/{path_value}: stale DFT/ATPG hash")
        gates = {
            gate
            for task in tasks or []
            if isinstance(task, dict)
            for gate in task.get("acceptance_gates", [])
        }
        if "make synth" not in gates:
            fail(errors, f"{label}: missing synthesis follow-up gate")
        if "make manufacturing-artifacts-check" not in gates:
            fail(errors, f"{label}: missing manufacturing follow-up gate")


def check_power_thermal_targets(source_ids: set[str], errors: list[str]) -> None:
    if not POWER_THERMAL_TARGETS_SCRIPT.is_file():
        fail(errors, f"missing {POWER_THERMAL_TARGETS_SCRIPT.relative_to(ROOT)}")
    if not POWER_THERMAL_TARGETS_BUILD.is_dir():
        return
    for run_dir in sorted(path for path in POWER_THERMAL_TARGETS_BUILD.iterdir() if path.is_dir()):
        report = load_json(run_dir / "targets_report.json", errors)
        label = str(run_dir.relative_to(ROOT))
        if not isinstance(report, dict):
            continue
        if report.get("schema") != "eliza.ai_eda.power_thermal_targets.v1":
            fail(errors, f"{label}: unexpected power/thermal targets schema")
        if report.get("claim_boundary") != POWER_THERMAL_TARGETS_CLAIM_BOUNDARY:
            fail(errors, f"{label}: unsafe power/thermal claim boundary")
        if report.get("status") != "TARGET_CAPTURE_ONLY_NO_POWER_THERMAL_CLAIM":
            fail(errors, f"{label}: power/thermal target capture must not claim evidence")
        for source_id in report.get("source_ids") or []:
            if source_id not in source_ids:
                fail(errors, f"{label}: unknown source_id {source_id}")
        policy = report.get("policy")
        if not isinstance(policy, dict):
            fail(errors, f"{label}: missing power/thermal target policy")
        elif (
            policy.get("generates_power_map") is not False
            or policy.get("generates_thermal_map") is not False
            or policy.get("generates_pdn") is not False
            or policy.get("changes_pdn") is not False
            or policy.get("changes_floorplan") is not False
            or policy.get("runs_power_analysis") is not False
            or policy.get("runs_thermal_analysis") is not False
            or policy.get("downloads_external_assets") is not False
            or policy.get("prediction_generated") is not False
            or policy.get("release_use_allowed") is not False
            or policy.get("tops_per_w_claim_allowed") is not False
            or policy.get("thermal_claim_allowed") is not False
            or policy.get("ir_drop_claim_allowed") is not False
        ):
            fail(errors, f"{label}: power/thermal target policy allows unsafe use")
        tasks = report.get("candidate_tasks")
        if not isinstance(tasks, list) or not tasks:
            fail(errors, f"{label}: power/thermal target report must contain tasks")
        for artifact in report.get("input_artifacts") or []:
            path_value = artifact.get("path")
            if artifact.get("status") == "PRESENT" and isinstance(path_value, str):
                path = ROOT / path_value
                if not path.is_file() or artifact.get("sha256") != sha256_file(path):
                    fail(errors, f"{label}/{path_value}: stale power/thermal hash")
        gates = {
            gate
            for task in tasks or []
            if isinstance(task, dict)
            for gate in task.get("acceptance_gates", [])
        }
        if "make power-thermal-evidence-check" not in gates:
            fail(errors, f"{label}: missing power/thermal evidence follow-up gate")
        if "make pd-signoff-manifest-check" not in gates:
            fail(errors, f"{label}: missing PD signoff follow-up gate")


def check_hardware_security_targets(source_ids: set[str], errors: list[str]) -> None:
    if not SECURITY_TARGETS_SCRIPT.is_file():
        fail(errors, f"missing {SECURITY_TARGETS_SCRIPT.relative_to(ROOT)}")
    if not SECURITY_TARGETS_BUILD.is_dir():
        return
    for run_dir in sorted(path for path in SECURITY_TARGETS_BUILD.iterdir() if path.is_dir()):
        report = load_json(run_dir / "targets_report.json", errors)
        label = str(run_dir.relative_to(ROOT))
        if not isinstance(report, dict):
            continue
        if report.get("schema") != "eliza.ai_eda.hardware_security_targets.v1":
            fail(errors, f"{label}: unexpected hardware security targets schema")
        if report.get("claim_boundary") != SECURITY_TARGETS_CLAIM_BOUNDARY:
            fail(errors, f"{label}: unsafe hardware security claim boundary")
        if report.get("status") != "TARGET_CAPTURE_ONLY_NO_SECURITY_CLAIM":
            fail(errors, f"{label}: hardware security target capture must not claim evidence")
        for source_id in report.get("source_ids") or []:
            if source_id not in source_ids:
                fail(errors, f"{label}: unknown source_id {source_id}")
        policy = report.get("policy")
        if not isinstance(policy, dict):
            fail(errors, f"{label}: missing hardware security target policy")
        elif (
            policy.get("changes_rtl") is not False
            or policy.get("changes_netlist") is not False
            or policy.get("imports_external_benchmarks") is not False
            or policy.get("downloads_external_assets") is not False
            or policy.get("runs_security_scanner") is not False
            or policy.get("runs_llm_classifier") is not False
            or policy.get("inserts_trojan") is not False
            or policy.get("generates_exploit") is not False
            or policy.get("prediction_generated") is not False
            or policy.get("vulnerability_claim_allowed") is not False
            or policy.get("trojan_claim_allowed") is not False
            or policy.get("release_use_allowed") is not False
        ):
            fail(errors, f"{label}: hardware security target policy allows unsafe use")
        tasks = report.get("candidate_tasks")
        if not isinstance(tasks, list) or not tasks:
            fail(errors, f"{label}: hardware security target report must contain tasks")
        for artifact in report.get("input_artifacts") or []:
            path_value = artifact.get("path")
            if artifact.get("status") != "PRESENT" or not isinstance(path_value, str):
                continue
            path = ROOT / path_value
            if not path.exists():
                fail(errors, f"{label}/{path_value}: missing hardware security input")
            elif path.is_file() and artifact.get("sha256") != sha256_file(path):
                fail(errors, f"{label}/{path_value}: stale hardware security hash")
        gates = {
            gate
            for task in tasks or []
            if isinstance(task, dict)
            for gate in task.get("acceptance_gates", [])
        }
        if "make no-hardware-action-check" not in gates:
            fail(errors, f"{label}: missing no-hardware-action follow-up gate")
        if "make formal" not in gates:
            fail(errors, f"{label}: missing formal follow-up gate")


def check_cdc_rdc_targets(source_ids: set[str], errors: list[str]) -> None:
    if not CDC_RDC_TARGETS_SCRIPT.is_file():
        fail(errors, f"missing {CDC_RDC_TARGETS_SCRIPT.relative_to(ROOT)}")
    if not CDC_RDC_TARGETS_BUILD.is_dir():
        return
    for run_dir in sorted(path for path in CDC_RDC_TARGETS_BUILD.iterdir() if path.is_dir()):
        report = load_json(run_dir / "targets_report.json", errors)
        label = str(run_dir.relative_to(ROOT))
        if not isinstance(report, dict):
            continue
        if report.get("schema") != "eliza.ai_eda.cdc_rdc_targets.v1":
            fail(errors, f"{label}: unexpected CDC/RDC targets schema")
        if report.get("claim_boundary") != CDC_RDC_TARGETS_CLAIM_BOUNDARY:
            fail(errors, f"{label}: unsafe CDC/RDC claim boundary")
        if report.get("status") != "TARGET_CAPTURE_ONLY_NO_CDC_RDC_SIGNOFF_CLAIM":
            fail(errors, f"{label}: CDC/RDC target capture must not claim evidence")
        for source_id in report.get("source_ids") or []:
            if source_id not in source_ids:
                fail(errors, f"{label}: unknown source_id {source_id}")
        policy = report.get("policy")
        if not isinstance(policy, dict):
            fail(errors, f"{label}: missing CDC/RDC target policy")
        elif (
            policy.get("changes_rtl") is not False
            or policy.get("changes_constraints") is not False
            or policy.get("generates_cdc_constraints") is not False
            or policy.get("generates_rdc_constraints") is not False
            or policy.get("creates_waivers") is not False
            or policy.get("runs_cdc_tool") is not False
            or policy.get("runs_rdc_tool") is not False
            or policy.get("downloads_external_assets") is not False
            or policy.get("prediction_generated") is not False
            or policy.get("cdc_signoff_claim_allowed") is not False
            or policy.get("rdc_signoff_claim_allowed") is not False
            or policy.get("release_use_allowed") is not False
        ):
            fail(errors, f"{label}: CDC/RDC target policy allows unsafe use")
        tasks = report.get("candidate_tasks")
        if not isinstance(tasks, list) or not tasks:
            fail(errors, f"{label}: CDC/RDC target report must contain tasks")
        for artifact in report.get("input_artifacts") or []:
            path_value = artifact.get("path")
            if artifact.get("status") == "PRESENT" and isinstance(path_value, str):
                path = ROOT / path_value
                if not path.is_file() or artifact.get("sha256") != sha256_file(path):
                    fail(errors, f"{label}/{path_value}: stale CDC/RDC hash")
        gates = {
            gate
            for task in tasks or []
            if isinstance(task, dict)
            for gate in task.get("acceptance_gates", [])
        }
        if "make rtl-check" not in gates:
            fail(errors, f"{label}: missing RTL follow-up gate")
        if "make formal" not in gates:
            fail(errors, f"{label}: missing formal follow-up gate")
        if "make cocotb-contract" not in gates:
            fail(errors, f"{label}: missing reset-domain cocotb follow-up gate")


def check_software_bsp_firmware_targets(source_ids: set[str], errors: list[str]) -> None:
    if not SOFTWARE_BSP_TARGETS_SCRIPT.is_file():
        fail(errors, f"missing {SOFTWARE_BSP_TARGETS_SCRIPT.relative_to(ROOT)}")
    if not SOFTWARE_BSP_TARGETS_BUILD.is_dir():
        return
    for run_dir in sorted(path for path in SOFTWARE_BSP_TARGETS_BUILD.iterdir() if path.is_dir()):
        report = load_json(run_dir / "targets_report.json", errors)
        label = str(run_dir.relative_to(ROOT))
        if not isinstance(report, dict):
            continue
        if report.get("schema") != "eliza.ai_eda.software_bsp_firmware_targets.v1":
            fail(errors, f"{label}: unexpected software BSP/firmware targets schema")
        if report.get("claim_boundary") != SOFTWARE_BSP_TARGETS_CLAIM_BOUNDARY:
            fail(errors, f"{label}: unsafe software BSP/firmware claim boundary")
        if report.get("status") != "TARGET_CAPTURE_ONLY_NO_BOOT_OR_BSP_CLAIM":
            fail(errors, f"{label}: software BSP/firmware target capture must not claim evidence")
        for source_id in report.get("source_ids") or []:
            if source_id not in source_ids:
                fail(errors, f"{label}: unknown source_id {source_id}")
        policy = report.get("policy")
        if not isinstance(policy, dict):
            fail(errors, f"{label}: missing software BSP/firmware target policy")
        elif (
            policy.get("changes_firmware") is not False
            or policy.get("changes_bsp") is not False
            or policy.get("changes_device_tree") is not False
            or policy.get("changes_linux_driver") is not False
            or policy.get("changes_bootloader") is not False
            or policy.get("runs_qemu") is not False
            or policy.get("runs_renode") is not False
            or policy.get("runs_external_build") is not False
            or policy.get("downloads_external_assets") is not False
            or policy.get("generates_patch") is not False
            or policy.get("prediction_generated") is not False
            or policy.get("boot_claim_allowed") is not False
            or policy.get("bsp_claim_allowed") is not False
            or policy.get("kernel_perf_claim_allowed") is not False
            or policy.get("release_use_allowed") is not False
        ):
            fail(errors, f"{label}: software BSP/firmware target policy allows unsafe use")
        tasks = report.get("candidate_tasks")
        if not isinstance(tasks, list) or not tasks:
            fail(errors, f"{label}: software BSP/firmware target report must contain tasks")
        for artifact in report.get("input_artifacts") or []:
            path_value = artifact.get("path")
            if artifact.get("status") == "PRESENT" and isinstance(path_value, str):
                path = ROOT / path_value
                if not path.is_file() or artifact.get("sha256") != sha256_file(path):
                    fail(errors, f"{label}/{path_value}: stale software BSP/firmware hash")
        gates = {
            gate
            for task in tasks or []
            if isinstance(task, dict)
            for gate in task.get("acceptance_gates", [])
        }
        if "make software-bsp-check" not in gates:
            fail(errors, f"{label}: missing software BSP follow-up gate")
        if "make qemu-check" not in gates:
            fail(errors, f"{label}: missing QEMU follow-up gate")
        if "make renode-check" not in gates:
            fail(errors, f"{label}: missing Renode follow-up gate")


def check_rtl_rewrite_equivalence_targets(source_ids: set[str], errors: list[str]) -> None:
    if not RTL_REWRITE_TARGETS_SCRIPT.is_file():
        fail(errors, f"missing {RTL_REWRITE_TARGETS_SCRIPT.relative_to(ROOT)}")
    if not RTL_REWRITE_TARGETS_BUILD.is_dir():
        return
    for run_dir in sorted(path for path in RTL_REWRITE_TARGETS_BUILD.iterdir() if path.is_dir()):
        report = load_json(run_dir / "targets_report.json", errors)
        label = str(run_dir.relative_to(ROOT))
        if not isinstance(report, dict):
            continue
        if report.get("schema") != "eliza.ai_eda.rtl_rewrite_equivalence_targets.v1":
            fail(errors, f"{label}: unexpected RTL rewrite equivalence targets schema")
        if report.get("claim_boundary") != RTL_REWRITE_TARGETS_CLAIM_BOUNDARY:
            fail(errors, f"{label}: unsafe RTL rewrite equivalence claim boundary")
        if report.get("status") != "TARGET_CAPTURE_ONLY_NO_REWRITE_OR_PPA_CLAIM":
            fail(errors, f"{label}: RTL rewrite target capture must not claim evidence")
        for source_id in report.get("source_ids") or []:
            if source_id not in source_ids:
                fail(errors, f"{label}: unknown source_id {source_id}")
        policy = report.get("policy")
        if not isinstance(policy, dict):
            fail(errors, f"{label}: missing RTL rewrite target policy")
        elif (
            policy.get("changes_rtl") is not False
            or policy.get("generates_rewrite") is not False
            or policy.get("runs_llm") is not False
            or policy.get("runs_equivalence") is not False
            or policy.get("runs_synthesis") is not False
            or policy.get("runs_simulation") is not False
            or policy.get("downloads_external_assets") is not False
            or policy.get("prediction_generated") is not False
            or policy.get("equivalence_claim_allowed") is not False
            or policy.get("ppa_claim_allowed") is not False
            or policy.get("release_use_allowed") is not False
        ):
            fail(errors, f"{label}: RTL rewrite target policy allows unsafe use")
        tasks = report.get("candidate_tasks")
        if not isinstance(tasks, list) or not tasks:
            fail(errors, f"{label}: RTL rewrite target report must contain tasks")
        for artifact in report.get("input_artifacts") or []:
            path_value = artifact.get("path")
            if artifact.get("status") == "PRESENT" and isinstance(path_value, str):
                path = ROOT / path_value
                if not path.is_file() or artifact.get("sha256") != sha256_file(path):
                    fail(errors, f"{label}/{path_value}: stale RTL rewrite/equivalence hash")
        gates = {
            gate
            for task in tasks or []
            if isinstance(task, dict)
            for gate in task.get("acceptance_gates", [])
        }
        if "make rtl-check" not in gates:
            fail(errors, f"{label}: missing RTL check follow-up gate")
        if "make formal" not in gates:
            fail(errors, f"{label}: missing formal/equivalence follow-up gate")
        if "make synth" not in gates:
            fail(errors, f"{label}: missing synthesis follow-up gate")
        if "make cocotb-npu" not in gates:
            fail(errors, f"{label}: missing NPU cocotb follow-up gate")


def check_board_package_fpga_targets(source_ids: set[str], errors: list[str]) -> None:
    if not BOARD_PACKAGE_FPGA_TARGETS_SCRIPT.is_file():
        fail(errors, f"missing {BOARD_PACKAGE_FPGA_TARGETS_SCRIPT.relative_to(ROOT)}")
    if not BOARD_PACKAGE_FPGA_TARGETS_BUILD.is_dir():
        return
    for run_dir in sorted(path for path in BOARD_PACKAGE_FPGA_TARGETS_BUILD.iterdir() if path.is_dir()):
        report = load_json(run_dir / "targets_report.json", errors)
        label = str(run_dir.relative_to(ROOT))
        if not isinstance(report, dict):
            continue
        if report.get("schema") != "eliza.ai_eda.board_package_fpga_targets.v1":
            fail(errors, f"{label}: unexpected board/package/FPGA targets schema")
        if report.get("claim_boundary") != BOARD_PACKAGE_FPGA_TARGETS_CLAIM_BOUNDARY:
            fail(errors, f"{label}: unsafe board/package/FPGA claim boundary")
        if report.get("status") != "TARGET_CAPTURE_ONLY_NO_BOARD_PACKAGE_FPGA_CLAIM":
            fail(errors, f"{label}: board/package/FPGA target capture must not claim evidence")
        for source_id in report.get("source_ids") or []:
            if source_id not in source_ids:
                fail(errors, f"{label}: unknown source_id {source_id}")
        policy = report.get("policy")
        if not isinstance(policy, dict):
            fail(errors, f"{label}: missing board/package/FPGA target policy")
        elif (
            policy.get("changes_board") is not False
            or policy.get("changes_package") is not False
            or policy.get("changes_pinout") is not False
            or policy.get("changes_fpga") is not False
            or policy.get("generates_schematic") is not False
            or policy.get("generates_pcb") is not False
            or policy.get("routes_board") is not False
            or policy.get("generates_gerbers") is not False
            or policy.get("runs_kicad_cli") is not False
            or policy.get("runs_fpga_flow") is not False
            or policy.get("runs_llm") is not False
            or policy.get("downloads_external_assets") is not False
            or policy.get("prediction_generated") is not False
            or policy.get("board_fab_claim_allowed") is not False
            or policy.get("package_release_claim_allowed") is not False
            or policy.get("fpga_release_claim_allowed") is not False
            or policy.get("release_use_allowed") is not False
        ):
            fail(errors, f"{label}: board/package/FPGA target policy allows unsafe use")
        tasks = report.get("candidate_tasks")
        if not isinstance(tasks, list) or not tasks:
            fail(errors, f"{label}: board/package/FPGA target report must contain tasks")
        for artifact in report.get("input_artifacts") or []:
            path_value = artifact.get("path")
            if artifact.get("status") == "PRESENT" and isinstance(path_value, str):
                path = ROOT / path_value
                if not path.is_file() or artifact.get("sha256") != sha256_file(path):
                    fail(errors, f"{label}/{path_value}: stale board/package/FPGA hash")
        gates = {
            gate
            for task in tasks or []
            if isinstance(task, dict)
            for gate in task.get("acceptance_gates", [])
        }
        for required_gate in (
            "make pinout-check",
            "make package-cross-probe-check",
            "make kicad-artifact-check",
            "make board-package-evidence-check",
            "make fpga-check",
            "make fpga-release-check",
            "make wifi-interface-check",
            "make antenna-metadata-check",
            "make manufacturing-artifacts-check",
            "make real-world-gates-check",
        ):
            if required_gate not in gates:
                fail(errors, f"{label}: missing follow-up gate {required_gate}")


def check_low_power_intent_targets(source_ids: set[str], errors: list[str]) -> None:
    if not LOW_POWER_INTENT_TARGETS_SCRIPT.is_file():
        fail(errors, f"missing {LOW_POWER_INTENT_TARGETS_SCRIPT.relative_to(ROOT)}")
    if not LOW_POWER_INTENT_TARGETS_BUILD.is_dir():
        return
    for run_dir in sorted(path for path in LOW_POWER_INTENT_TARGETS_BUILD.iterdir() if path.is_dir()):
        report = load_json(run_dir / "targets_report.json", errors)
        label = str(run_dir.relative_to(ROOT))
        if not isinstance(report, dict):
            continue
        if report.get("schema") != "eliza.ai_eda.low_power_intent_targets.v1":
            fail(errors, f"{label}: unexpected low-power intent targets schema")
        if report.get("claim_boundary") != LOW_POWER_INTENT_TARGETS_CLAIM_BOUNDARY:
            fail(errors, f"{label}: unsafe low-power intent claim boundary")
        if report.get("status") != "TARGET_CAPTURE_ONLY_NO_LOW_POWER_INTENT_CLAIM":
            fail(errors, f"{label}: low-power intent target capture must not claim evidence")
        for source_id in report.get("source_ids") or []:
            if source_id not in source_ids:
                fail(errors, f"{label}: unknown source_id {source_id}")
        policy = report.get("policy")
        if not isinstance(policy, dict):
            fail(errors, f"{label}: missing low-power intent target policy")
        elif (
            policy.get("changes_rtl") is not False
            or policy.get("changes_constraints") is not False
            or policy.get("generates_upf") is not False
            or policy.get("generates_power_domains") is not False
            or policy.get("generates_clock_gating") is not False
            or policy.get("generates_dvfs_policy") is not False
            or policy.get("generates_retention_or_isolation") is not False
            or policy.get("runs_clockgate") is not False
            or policy.get("runs_power_aware_simulation") is not False
            or policy.get("runs_synthesis") is not False
            or policy.get("runs_llm") is not False
            or policy.get("downloads_external_assets") is not False
            or policy.get("prediction_generated") is not False
            or policy.get("power_intent_claim_allowed") is not False
            or policy.get("power_saving_claim_allowed") is not False
            or policy.get("release_use_allowed") is not False
        ):
            fail(errors, f"{label}: low-power intent target policy allows unsafe use")
        tasks = report.get("candidate_tasks")
        if not isinstance(tasks, list) or not tasks:
            fail(errors, f"{label}: low-power intent target report must contain tasks")
        for artifact in report.get("input_artifacts") or []:
            path_value = artifact.get("path")
            if artifact.get("status") == "PRESENT" and isinstance(path_value, str):
                path = ROOT / path_value
                if not path.is_file() or artifact.get("sha256") != sha256_file(path):
                    fail(errors, f"{label}/{path_value}: stale low-power intent hash")
        gates = {
            gate
            for task in tasks or []
            if isinstance(task, dict)
            for gate in task.get("acceptance_gates", [])
        }
        for required_gate in (
            "make platform-contract-check",
            "make pd-contract-check",
            "make rtl-check",
            "make formal",
            "make synth",
            "make cpu-npu-burst-sustained-policy",
            "make cpu-npu-burst-thermal-transient",
            "make software-bsp-check",
            "make power-thermal-evidence-check",
        ):
            if required_gate not in gates:
                fail(errors, f"{label}: missing follow-up gate {required_gate}")


def check_verification_debug_targets(source_ids: set[str], errors: list[str]) -> None:
    if not VERIFICATION_DEBUG_TARGETS_SCRIPT.is_file():
        fail(errors, f"missing {VERIFICATION_DEBUG_TARGETS_SCRIPT.relative_to(ROOT)}")
    if not VERIFICATION_DEBUG_TARGETS_BUILD.is_dir():
        return
    for run_dir in sorted(
        path for path in VERIFICATION_DEBUG_TARGETS_BUILD.iterdir() if path.is_dir()
    ):
        report = load_json(run_dir / "targets_report.json", errors)
        label = str(run_dir.relative_to(ROOT))
        if not isinstance(report, dict):
            continue
        if report.get("schema") != "eliza.ai_eda.verification_debug_targets.v1":
            fail(errors, f"{label}: unexpected verification debug targets schema")
        if report.get("claim_boundary") != VERIFICATION_DEBUG_TARGETS_CLAIM_BOUNDARY:
            fail(errors, f"{label}: unsafe verification debug claim boundary")
        if report.get("status") != "TARGET_CAPTURE_ONLY_NO_VERIFICATION_PATCH_OR_CLAIM":
            fail(errors, f"{label}: verification debug target capture must not claim evidence")
        for source_id in report.get("source_ids") or []:
            if source_id not in source_ids:
                fail(errors, f"{label}: unknown source_id {source_id}")
        policy = report.get("policy")
        if not isinstance(policy, dict):
            fail(errors, f"{label}: missing verification debug target policy")
        elif (
            policy.get("changes_rtl") is not False
            or policy.get("changes_testbench") is not False
            or policy.get("changes_assertions") is not False
            or policy.get("generates_patch") is not False
            or policy.get("generates_testbench") is not False
            or policy.get("generates_assertion") is not False
            or policy.get("binds_assertion") is not False
            or policy.get("runs_llm") is not False
            or policy.get("runs_formal") is not False
            or policy.get("runs_simulation") is not False
            or policy.get("parses_waveforms") is not False
            or policy.get("downloads_external_assets") is not False
            or policy.get("imports_external_benchmarks") is not False
            or policy.get("prediction_generated") is not False
            or policy.get("debug_claim_allowed") is not False
            or policy.get("verification_closure_claim_allowed") is not False
            or policy.get("release_use_allowed") is not False
        ):
            fail(errors, f"{label}: verification debug target policy allows unsafe use")
        tasks = report.get("candidate_tasks")
        if not isinstance(tasks, list) or not tasks:
            fail(errors, f"{label}: verification debug target report must contain tasks")
        for artifact in report.get("input_artifacts") or []:
            path_value = artifact.get("path")
            if artifact.get("status") == "PRESENT" and isinstance(path_value, str):
                path = ROOT / path_value
                if not path.is_file() or artifact.get("sha256") != sha256_file(path):
                    fail(errors, f"{label}/{path_value}: stale verification debug hash")
        gates = {
            gate
            for task in tasks or []
            if isinstance(task, dict)
            for gate in task.get("acceptance_gates", [])
        }
        for required_gate in (
            "python3 scripts/check_ai_eda_source_inventory.py",
            "make formal",
            "make rtl-check",
            "make cocotb-contract",
            "make synth",
            "make no-hardware-action-check",
        ):
            if required_gate not in gates:
                fail(errors, f"{label}: missing follow-up gate {required_gate}")


def check_post_silicon_validation_targets(source_ids: set[str], errors: list[str]) -> None:
    if not POST_SILICON_TARGETS_SCRIPT.is_file():
        fail(errors, f"missing {POST_SILICON_TARGETS_SCRIPT.relative_to(ROOT)}")
    if not POST_SILICON_TARGETS_BUILD.is_dir():
        return
    for run_dir in sorted(path for path in POST_SILICON_TARGETS_BUILD.iterdir() if path.is_dir()):
        report = load_json(run_dir / "targets_report.json", errors)
        label = str(run_dir.relative_to(ROOT))
        if not isinstance(report, dict):
            continue
        if report.get("schema") != "eliza.ai_eda.post_silicon_validation_targets.v1":
            fail(errors, f"{label}: unexpected post-silicon validation targets schema")
        if report.get("claim_boundary") != POST_SILICON_TARGETS_CLAIM_BOUNDARY:
            fail(errors, f"{label}: unsafe post-silicon validation claim boundary")
        if report.get("status") != "TARGET_CAPTURE_ONLY_NO_POST_SILICON_OR_LAB_CLAIM":
            fail(errors, f"{label}: post-silicon validation target capture must not claim evidence")
        for source_id in report.get("source_ids") or []:
            if source_id not in source_ids:
                fail(errors, f"{label}: unknown source_id {source_id}")
        policy = report.get("policy")
        if not isinstance(policy, dict):
            fail(errors, f"{label}: missing post-silicon validation target policy")
        elif (
            policy.get("changes_rtl") is not False
            or policy.get("changes_firmware") is not False
            or policy.get("changes_board") is not False
            or policy.get("changes_fpga") is not False
            or policy.get("generates_lab_script") is not False
            or policy.get("generates_test_binary") is not False
            or policy.get("runs_on_hardware") is not False
            or policy.get("runs_fpga_flow") is not False
            or policy.get("runs_qemu") is not False
            or policy.get("runs_renode") is not False
            or policy.get("runs_llm") is not False
            or policy.get("downloads_external_assets") is not False
            or policy.get("imports_external_tests") is not False
            or policy.get("prediction_generated") is not False
            or policy.get("silicon_bringup_claim_allowed") is not False
            or policy.get("post_silicon_debug_claim_allowed") is not False
            or policy.get("riscv_compliance_claim_allowed") is not False
            or policy.get("lab_measurement_claim_allowed") is not False
            or policy.get("release_use_allowed") is not False
        ):
            fail(errors, f"{label}: post-silicon validation target policy allows unsafe use")
        tasks = report.get("candidate_tasks")
        if not isinstance(tasks, list) or not tasks:
            fail(errors, f"{label}: post-silicon validation target report must contain tasks")
        for artifact in report.get("input_artifacts") or []:
            path_value = artifact.get("path")
            if artifact.get("status") == "PRESENT" and isinstance(path_value, str):
                path = ROOT / path_value
                if not path.is_file() or artifact.get("sha256") != sha256_file(path):
                    fail(errors, f"{label}/{path_value}: stale post-silicon validation hash")
        gates = {
            gate
            for task in tasks or []
            if isinstance(task, dict)
            for gate in task.get("acceptance_gates", [])
        }
        for required_gate in (
            "make platform-contract-check",
            "make qemu-check",
            "make renode-check",
            "make fpga-check",
            "make real-world-gates-check",
            "make manufacturing-artifacts-check",
            "make product-check",
            "make no-hardware-action-check",
            "python3 scripts/check_ai_eda_source_inventory.py",
        ):
            if required_gate not in gates:
                fail(errors, f"{label}: missing follow-up gate {required_gate}")


def check_circuit_foundation_model_targets(source_ids: set[str], errors: list[str]) -> None:
    if not CIRCUIT_FOUNDATION_TARGETS_SCRIPT.is_file():
        fail(errors, f"missing {CIRCUIT_FOUNDATION_TARGETS_SCRIPT.relative_to(ROOT)}")
    if not CIRCUIT_FOUNDATION_TARGETS_BUILD.is_dir():
        return
    for run_dir in sorted(path for path in CIRCUIT_FOUNDATION_TARGETS_BUILD.iterdir() if path.is_dir()):
        report = load_json(run_dir / "targets_report.json", errors)
        label = str(run_dir.relative_to(ROOT))
        if not isinstance(report, dict):
            continue
        if report.get("schema") != "eliza.ai_eda.circuit_foundation_model_targets.v1":
            fail(errors, f"{label}: unexpected circuit foundation model targets schema")
        if report.get("claim_boundary") != CIRCUIT_FOUNDATION_TARGETS_CLAIM_BOUNDARY:
            fail(errors, f"{label}: unsafe circuit foundation model claim boundary")
        if report.get("status") != "TARGET_CAPTURE_ONLY_NO_FOUNDATION_MODEL_EXECUTION":
            fail(errors, f"{label}: circuit foundation model capture must not execute models")
        for source_id in report.get("source_ids") or []:
            if source_id not in source_ids:
                fail(errors, f"{label}: unknown source_id {source_id}")
        policy = report.get("policy")
        if not isinstance(policy, dict):
            fail(errors, f"{label}: missing circuit foundation model target policy")
        elif (
            policy.get("changes_rtl") is not False
            or policy.get("changes_constraints") is not False
            or policy.get("changes_training_data") is not False
            or policy.get("generates_embeddings") is not False
            or policy.get("trains_model") is not False
            or policy.get("finetunes_model") is not False
            or policy.get("runs_inference") is not False
            or policy.get("runs_llm") is not False
            or policy.get("exports_dataset") is not False
            or policy.get("imports_external_corpus") is not False
            or policy.get("downloads_external_assets") is not False
            or policy.get("downloads_model_weights") is not False
            or policy.get("prediction_generated") is not False
            or policy.get("embedding_claim_allowed") is not False
            or policy.get("model_quality_claim_allowed") is not False
            or policy.get("design_decision_claim_allowed") is not False
            or policy.get("release_use_allowed") is not False
        ):
            fail(errors, f"{label}: circuit foundation model target policy allows unsafe use")
        tasks = report.get("candidate_tasks")
        if not isinstance(tasks, list) or not tasks:
            fail(errors, f"{label}: circuit foundation model target report must contain tasks")
        for artifact in report.get("input_artifacts") or []:
            path_value = artifact.get("path")
            if artifact.get("status") == "PRESENT" and isinstance(path_value, str):
                path = ROOT / path_value
                if not path.is_file() or artifact.get("sha256") != sha256_file(path):
                    fail(errors, f"{label}/{path_value}: stale circuit foundation model hash")
        gates = {
            gate
            for task in tasks or []
            if isinstance(task, dict)
            for gate in task.get("acceptance_gates", [])
        }
        for required_gate in (
            "python3 scripts/check_ai_eda_source_inventory.py",
            "python3 scripts/ai_eda/build_local_eda_rag_index.py --run-id validation",
            "python3 scripts/ai_eda/capture_openroad_ml_snapshot.py --run-id validation",
            "python3 scripts/ai_eda/evaluate_rtl_model.py --dry-run --run-id validation",
            "python3 scripts/ai_eda/probe_external_ai_eda_sources.py --run-id validation",
            "python3 scripts/ai_eda/capture_rtl_rewrite_equivalence_targets.py --run-id validation",
            "python3 scripts/ai_eda/capture_verification_debug_targets.py --run-id validation",
            "make formal",
            "make synth",
            "make cocotb-contract",
            "make no-hardware-action-check",
            "make pd-contract-check",
        ):
            if required_gate not in gates:
                fail(errors, f"{label}: missing follow-up gate {required_gate}")


def main() -> int:
    errors: list[str] = []
    source_ids = check_inventory(errors)
    backlog_count = check_backlog(source_ids, errors)
    check_sota_review(source_ids, errors)
    check_readiness(source_ids, errors)
    check_provenance(source_ids, errors)
    check_external_probe_summary(source_ids, errors)
    check_assertion_candidates(source_ids, errors)
    check_rag(errors)
    check_cocotb_stimulus(errors)
    check_zigzag(errors)
    check_simulator_optimization(source_ids, errors)
    check_external_source_probe(source_ids, errors)
    check_backend_preflight(source_ids, errors)
    check_rtlmul_ppa(source_ids, errors)
    check_hls_accelerator_targets(source_ids, errors)
    check_timing_closure_targets(source_ids, errors)
    check_analog_mixed_signal_targets(source_ids, errors)
    check_memory_interconnect_targets(source_ids, errors)
    check_dft_atpg_targets(source_ids, errors)
    check_power_thermal_targets(source_ids, errors)
    check_hardware_security_targets(source_ids, errors)
    check_cdc_rdc_targets(source_ids, errors)
    check_software_bsp_firmware_targets(source_ids, errors)
    check_rtl_rewrite_equivalence_targets(source_ids, errors)
    check_board_package_fpga_targets(source_ids, errors)
    check_low_power_intent_targets(source_ids, errors)
    check_verification_debug_targets(source_ids, errors)
    check_post_silicon_validation_targets(source_ids, errors)
    check_circuit_foundation_model_targets(source_ids, errors)
    check_openroad_autotune(errors)
    check_rtl_eval(errors)
    check_pd_predictor(errors)
    if errors:
        for error in errors:
            print(f"FAIL: {error}", file=sys.stderr)
        return 1
    print(f"PASS: ai_eda_source_inventory entries={len(source_ids)} backlog={backlog_count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
