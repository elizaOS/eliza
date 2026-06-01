#!/usr/bin/env python3
"""Aggregate every fail-closed tapeout-readiness gate into one JSON report.

This is a view-only aggregator. It does not promote any silicon, boot, MLPerf,
or release claim and it does not modify any individual gate. It re-executes the
existing ``scripts/check_*.py`` gates that the chip package already exposes via
Makefile targets, classifies each result by exit code + stdout prefix, and
writes a single JSON report at ``build/reports/tapeout-readiness.json``.

Classification policy (exact prefix-based rule):

* ``STATUS: BLOCKED`` anywhere in combined stdout/stderr  -> ``BLOCKED``
* non-zero exit code                                       -> ``FAIL``
* zero exit code                                           -> ``PASS``

``BLOCKED`` is tracked separately from ``FAIL`` so the report can distinguish
external/evidence blockers from regressions. ``FAIL`` flips ``release_blocker``;
either ``FAIL`` or ``BLOCKED`` flips ``effective_release_blocker``.

The ``--strict`` flag escalates ``BLOCKED`` to a release blocker as well, which
is what ``make tapeout-readiness-strict`` uses to assert silicon-class
readiness.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
from collections.abc import Iterable
from dataclasses import asdict, dataclass
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Literal, cast

ROOT = Path(__file__).resolve().parents[1]
REPORT_PATH = ROOT / "build/reports/tapeout-readiness.json"
PRODUCT_RELEASE_STATUS_PATH = ROOT / "build/reports/product_release_status.json"
PD_SIGNOFF_REPORT_PATH = ROOT / "build/reports/pd_signoff.json"
PD_RELEASE_EVIDENCE_REPORT_PATH = ROOT / "build/reports/pd_release_evidence.json"
OPENLANE_RELEASE_PREFLIGHT_REPORT_PATH = ROOT / "build/reports/openlane_run_release_preflight.json"
FPGA_RELEASE_REPORT_PATH = ROOT / "build/reports/fpga_release.json"
PACKAGE_CROSS_PROBE_REPORT_PATH = ROOT / "build/reports/package_cross_probe.json"
KICAD_ARTIFACTS_REPORT_PATH = ROOT / "build/reports/kicad_artifacts.json"
MANUFACTURING_ARTIFACTS_REPORT_PATH = ROOT / "build/reports/manufacturing_artifacts.json"
ANDROID_RELEASE_READINESS_REPORT_PATH = (
    ROOT / "build/reports/android_release_readiness_contract.json"
)
CPU_AP_COMPLETION_REPORT_PATH = ROOT / "build/reports/cpu_ap_completion_gate.json"
ANTENNA_METADATA_REPORT_PATH = ROOT / "build/reports/antenna_metadata.json"
PDK_ACCESS_GATE_REPORT_PATH = ROOT / "build/reports/pdk_access_gate.json"
PDN_WORKLOAD_SIGNOFF_REPORT_PATH = ROOT / "build/reports/pdn_workload_signoff.json"
IO_CELL_CONTRACT_REPORT_PATH = ROOT / "build/reports/io_cell_contract.json"
ANDROID_SIMULATED_PERIPHERAL_REPORT_PATH = (
    ROOT / "build/reports/android_simulated_peripheral_evidence.json"
)
ANDROID_SYSTEM_BRIDGE_REPORT_PATH = ROOT / "build/reports/android_system_bridge_contract.json"
LINUX_BOOT_ARTIFACTS_REPORT_PATH = ROOT / "build/reports/linux_boot_artifacts.json"
MINIMUM_LINUX_NPU_TARGET_REPORT_PATH = ROOT / "build/reports/minimum_linux_npu_target.json"
OS_RV64_CHIP_BOOT_CONTRACT_REPORT_PATH = ROOT / "build/reports/os_rv64_chip_boot_contract.json"
E1_PHONE_ROUTED_OUTPUT_REPORT_PATH = ROOT / "build/reports/e1_phone_routed_output_content.json"
E1_PHONE_FACTORY_OUTPUT_REPORT_PATH = ROOT / "build/reports/e1_phone_factory_output_content.json"
E1_PHONE_FIRST_ARTICLE_REPORT_PATH = ROOT / "build/reports/e1_phone_first_article_content.json"
E1_PHONE_SUPPLIER_RETURN_REPORT_PATH = ROOT / "build/reports/e1_phone_supplier_return_content.json"
E1_PHONE_RELEASE_APPROVAL_REPORT_PATH = (
    ROOT / "build/reports/e1_phone_release_approval_signatures.json"
)
E1_PHONE_ASSEMBLY_VERIFICATION_PATH = ROOT / "mechanical/e1-phone/review/assembly-verification.json"
E1_PHONE_BOOLEAN_INTERFERENCE_PATH = (
    ROOT / "mechanical/e1-phone/review/full-cad-boolean-interference.json"
)
PHONE_RUNTIME_READINESS_REPORT_PATH = ROOT / "build/reports/phone_runtime_readiness_contract.json"
BOOT_SECURITY_CHAIN_CONTRACT_REPORT_PATH = ROOT / "build/reports/boot_security_chain_contract.json"
LINUX_FIRMWARE_BOOT_CHAIN_CONTRACT_REPORT_PATH = (
    ROOT / "build/reports/linux_firmware_boot_chain_contract.json"
)
AOSP_LINUX_HANDOFF_CONTRACT_REPORT_PATH = ROOT / "build/reports/aosp_linux_handoff_contract.json"
SCHEMA = "eliza.tapeout_readiness.v1"
CLAIM_BOUNDARY = "tapeout_readiness_aggregator_view_only_no_silicon_or_release_claim"
GATE_TIMEOUT_SECONDS = int(os.environ.get("ELIZA_TAPEOUT_GATE_TIMEOUT_SECONDS", "180"))

Status = Literal["PASS", "FAIL", "BLOCKED"]
BlockerDependency = Literal[
    "not_blocked",
    "repo_artifact_generation",
    "live_device_validation",
    "actionable_external_dependency",
]
Subsystem = Literal[
    "cpu",
    "memory",
    "security",
    "npu",
    "process",
    "pd",
    "platform",
    "bsp",
    "verify",
    "benchmarks",
    "os_rv64",
]
Tier = Literal["spec", "rtl", "pd", "silicon"]
Scope = Literal["chip", "phone"]


@dataclass(frozen=True)
class GateSpec:
    """Static description of one gate the aggregator re-runs.

    ``script`` may be either a chip-relative path (resolved against ``ROOT``)
    or an absolute path to a sibling-package script. Absolute-path entries
    let the aggregator span the chip and OS variants without duplicating
    logic. When ``module`` is set, the gate is invoked as
    ``python -m unittest <module>`` from the directory of ``script``'s
    parent's parent (i.e. the package root that owns the test module).
    """

    name: str
    script: str
    subsystem: Subsystem
    tier: Tier
    args: tuple[str, ...] = ()
    module: str | None = None
    scope: Scope = "chip"


# Curated set of fail-closed gates that already exist in scripts/check_*.py
# and that map to a Makefile target. Each entry is grouped by subsystem so the
# emitted report stays auditable. Long-running gates (cocotb, formal,
# openlane, verilator, qemu) are intentionally excluded: they belong to the
# CI lanes (`make smoke`, `make ci-fast`, `make ci-pd`) not to a single-shot
# readiness probe.
GATES: tuple[GateSpec, ...] = (
    # ---- CPU / AP -----------------------------------------------------------
    GateSpec(
        name="cpu-2028-target-check",
        script="scripts/check_cpu_2028_target.py",
        subsystem="cpu",
        tier="spec",
    ),
    GateSpec(
        name="core-selection-check",
        script="scripts/check_core_selection.py",
        subsystem="cpu",
        tier="spec",
    ),
    GateSpec(
        name="cpu-ap-completion-gate",
        script="scripts/check_cpu_ap_completion_gate.py",
        subsystem="cpu",
        tier="rtl",
    ),
    GateSpec(
        name="boot-security-chain-contract-check",
        script="scripts/check_boot_security_chain_contract.py",
        subsystem="cpu",
        tier="silicon",
    ),
    GateSpec(
        name="chipyard-ap-abi-contract-check",
        script="scripts/check_chipyard_ap_abi_contract.py",
        subsystem="cpu",
        tier="spec",
    ),
    GateSpec(
        name="chipyard-generated-linux-contract-check",
        script="scripts/check_chipyard_generated_linux_contract.py",
        subsystem="cpu",
        tier="silicon",
        args=("--require-boot-evidence",),
    ),
    GateSpec(
        name="rva23-compliance",
        script="scripts/check_rva23_compliance.py",
        subsystem="cpu",
        tier="spec",
    ),
    # ---- Memory / interconnect ---------------------------------------------
    GateSpec(
        name="memory-2028-target-check",
        script="scripts/check_memory_2028_target.py",
        subsystem="memory",
        tier="spec",
    ),
    GateSpec(
        name="memory-uma-claim-gate",
        script="scripts/check_memory_uma_claim_gate.py",
        subsystem="memory",
        tier="spec",
    ),
    GateSpec(
        name="memory-evidence-template-check",
        script="scripts/check_memory_evidence_templates.py",
        subsystem="memory",
        tier="spec",
    ),
    GateSpec(
        name="memory-interconnect-contract-check",
        script="scripts/check_memory_interconnect_contract.py",
        subsystem="memory",
        tier="spec",
    ),
    GateSpec(
        name="iommu-evidence-check",
        script="scripts/check_iommu_evidence.py",
        subsystem="memory",
        tier="rtl",
    ),
    # ---- Security -----------------------------------------------------------
    GateSpec(
        name="security-2028-target-check",
        script="scripts/check_security_2028_target.py",
        subsystem="security",
        tier="spec",
    ),
    # ---- NPU ----------------------------------------------------------------
    GateSpec(
        name="npu-2028-target-check",
        script="scripts/check_npu_2028_targets.py",
        subsystem="npu",
        tier="spec",
    ),
    GateSpec(
        name="npu-runtime-contract-check",
        script="scripts/check_e1_npu_runtime_contract.py",
        subsystem="npu",
        tier="rtl",
    ),
    GateSpec(
        name="npu-roadmap-check",
        script="scripts/check_npu_roadmap.py",
        subsystem="npu",
        tier="spec",
    ),
    GateSpec(
        name="npu-open-scale-model-check",
        script="scripts/check_npu_open_scale_model.py",
        subsystem="npu",
        tier="spec",
    ),
    GateSpec(
        name="npu-scale-sim-check",
        script="scripts/check_npu_scale_sim.py",
        subsystem="npu",
        tier="spec",
    ),
    GateSpec(
        name="scale-feasibility-gate",
        script="scripts/check_scale_feasibility_gate.py",
        subsystem="npu",
        tier="spec",
    ),
    GateSpec(
        name="mlperf-inference-check",
        script="scripts/check_mlperf_inference.py",
        subsystem="npu",
        tier="spec",
    ),
    GateSpec(
        name="multi-pdk-closure-check",
        script="scripts/check_multi_pdk_closure.py",
        subsystem="pd",
        tier="spec",
    ),
    # ---- Process / packaging ------------------------------------------------
    GateSpec(
        name="process-14a-effects-check",
        script="scripts/check_process_14a_effects.py",
        subsystem="process",
        tier="spec",
    ),
    GateSpec(
        name="pdk-portability-check",
        script="scripts/check_pdk_portability.py",
        subsystem="process",
        tier="pd",
    ),
    GateSpec(
        name="pdk-access-gate",
        script="scripts/check_pdk_access_gate.py",
        subsystem="process",
        tier="pd",
    ),
    GateSpec(
        name="die-area-budget-check",
        script="scripts/check_die_area_budget.py",
        subsystem="process",
        tier="pd",
    ),
    # ---- Physical design (PD) ----------------------------------------------
    GateSpec(
        name="pd-preflight-check",
        script="scripts/check_pd_preflight.py",
        subsystem="pd",
        tier="pd",
    ),
    GateSpec(
        name="pd-soc-input-contract-check",
        script="scripts/check_e1_soc_pd_input_contract.py",
        subsystem="pd",
        tier="pd",
        args=("--strict",),
    ),
    GateSpec(
        name="pd-signoff-manifest-check",
        script="scripts/check_pd_signoff.py",
        subsystem="pd",
        tier="pd",
        args=("--manifest-only",),
    ),
    GateSpec(
        name="pd-signoff-check",
        script="scripts/check_pd_signoff.py",
        subsystem="pd",
        tier="pd",
    ),
    GateSpec(
        name="pd-release-evidence-check",
        script="scripts/check_pd_release_evidence.py",
        subsystem="pd",
        tier="pd",
    ),
    GateSpec(
        name="pd-evidence-gates",
        script="scripts/check_pd_evidence_gates.py",
        subsystem="pd",
        tier="pd",
    ),
    GateSpec(
        name="pd-util-check",
        script="scripts/check_pd_utilization.py",
        subsystem="pd",
        tier="pd",
    ),
    GateSpec(
        name="padframe-check",
        script="scripts/check_padframe_contract.py",
        subsystem="pd",
        tier="pd",
    ),
    GateSpec(
        name="pinout-check",
        script="package/scripts/validate_pinout.py",
        subsystem="pd",
        tier="spec",
        args=("package/e1-demo-pinout.yaml",),
    ),
    GateSpec(
        name="io-cell-contract-check",
        script="scripts/check_io_cell_contract.py",
        subsystem="pd",
        tier="pd",
    ),
    GateSpec(
        name="antenna-metadata-check",
        script="scripts/check_antenna_metadata.py",
        subsystem="pd",
        tier="pd",
    ),
    GateSpec(
        name="antenna-metadata-release-check",
        script="scripts/check_antenna_metadata.py",
        subsystem="pd",
        tier="pd",
        args=("--release",),
    ),
    GateSpec(
        name="openlane-run-preflight-check",
        script="scripts/check_openlane_run_preflight.py",
        subsystem="pd",
        tier="pd",
    ),
    GateSpec(
        name="openlane-run-release-preflight-check",
        script="scripts/check_openlane_run_preflight.py",
        subsystem="pd",
        tier="pd",
        args=("--release",),
    ),
    GateSpec(
        name="physical-closure-work-order-check",
        script="scripts/check_physical_closure_work_order.py",
        subsystem="pd",
        tier="pd",
    ),
    GateSpec(
        name="manufacturing-tapeout-scope-check",
        script="scripts/check_manufacturing_tapeout_scope.py",
        subsystem="pd",
        tier="pd",
    ),
    GateSpec(
        name="rail-plan-check",
        script="scripts/check_rail_plan.py",
        subsystem="pd",
        tier="pd",
    ),
    GateSpec(
        name="upf-check",
        script="scripts/check_upf_consistency.py",
        subsystem="pd",
        tier="pd",
    ),
    GateSpec(
        name="pdn-workload-signoff",
        script="scripts/check_pdn_workload_signoff.py",
        subsystem="pd",
        tier="pd",
    ),
    GateSpec(
        name="pmic-procurement-gate",
        script="scripts/check_pdn_workload_signoff.py",
        subsystem="pd",
        tier="pd",
        args=("--allow-blocked",),
    ),
    # ---- Platform / board / package ----------------------------------------
    GateSpec(
        name="platform-contract-check",
        script="scripts/check_platform_contract.py",
        subsystem="platform",
        tier="spec",
    ),
    GateSpec(
        name="chip-stats-consistency-check",
        script="scripts/check_chip_stats_consistency.py",
        subsystem="platform",
        tier="spec",
    ),
    GateSpec(
        name="board-package-evidence-check",
        script="scripts/check_board_package_evidence.py",
        subsystem="platform",
        tier="spec",
    ),
    GateSpec(
        name="e1-phone-board-package-check",
        script="scripts/check_e1_phone_board_package.py",
        subsystem="platform",
        tier="pd",
        scope="phone",
    ),
    GateSpec(
        name="e1-phone-fabrication-release-check",
        script="scripts/check_e1_phone_fabrication_release.py",
        subsystem="platform",
        tier="pd",
        scope="phone",
    ),
    GateSpec(
        name="e1-phone-release-approval-signature-check",
        script="scripts/check_e1_phone_release_approval_signatures.py",
        subsystem="platform",
        tier="pd",
        scope="phone",
    ),
    GateSpec(
        name="e1-phone-supplier-return-content-check",
        script="scripts/check_e1_phone_supplier_return_content.py",
        subsystem="platform",
        tier="pd",
        scope="phone",
    ),
    GateSpec(
        name="e1-phone-routed-output-content-check",
        script="scripts/check_e1_phone_routed_output_content.py",
        subsystem="platform",
        tier="pd",
        scope="phone",
    ),
    GateSpec(
        name="e1-phone-factory-output-content-check",
        script="scripts/check_e1_phone_factory_output_content.py",
        subsystem="platform",
        tier="pd",
        scope="phone",
    ),
    GateSpec(
        name="e1-phone-first-article-content-check",
        script="scripts/check_e1_phone_first_article_content.py",
        subsystem="platform",
        tier="pd",
        scope="phone",
    ),
    GateSpec(
        name="e1-phone-release-evidence-regeneration-check",
        script="scripts/check_e1_phone_release_evidence_regeneration.py",
        subsystem="platform",
        tier="pd",
        scope="phone",
    ),
    GateSpec(
        name="e1-phone-enclosure-mechanical-content-check",
        script="scripts/check_e1_phone_enclosure_mechanical_content.py",
        subsystem="platform",
        tier="pd",
        scope="phone",
    ),
    GateSpec(
        name="e1-phone-assemblability-check",
        script="scripts/check_e1_phone_assemblability.py",
        subsystem="platform",
        tier="pd",
        scope="phone",
    ),
    GateSpec(
        name="e1-phone-button-orientation-check",
        script="scripts/check_e1_phone_button_orientation.py",
        subsystem="platform",
        tier="pd",
        scope="phone",
    ),
    GateSpec(
        name="e1-phone-boolean-interference-check",
        script="scripts/check_e1_phone_boolean_interference.py",
        subsystem="platform",
        tier="pd",
        scope="phone",
    ),
    GateSpec(
        name="product-release-status-check",
        script="scripts/product_check.py",
        subsystem="platform",
        tier="pd",
        args=("--release",),
        scope="phone",
    ),
    GateSpec(
        name="e1-phone-manufacturing-artifacts-check",
        script="scripts/check_manufacturing_artifacts.py",
        subsystem="platform",
        tier="pd",
        args=("--manifest", "board/kicad/e1-phone/artifact-manifest.yaml"),
    ),
    GateSpec(
        name="package-cross-probe-check",
        script="scripts/check_package_cross_probe.py",
        subsystem="platform",
        tier="spec",
    ),
    GateSpec(
        name="package-cross-probe-release-check",
        script="scripts/check_package_cross_probe.py",
        subsystem="platform",
        tier="pd",
        args=("--release",),
    ),
    GateSpec(
        name="kicad-artifact-check",
        script="scripts/check_kicad_artifacts.py",
        subsystem="platform",
        tier="spec",
    ),
    GateSpec(
        name="kicad-artifacts-release-check",
        script="scripts/check_kicad_artifacts.py",
        subsystem="platform",
        tier="pd",
        args=("--release",),
    ),
    GateSpec(
        name="manufacturing-artifacts-check",
        script="scripts/check_manufacturing_artifacts.py",
        subsystem="platform",
        tier="pd",
    ),
    GateSpec(
        name="manufacturing-artifacts-release-check",
        script="scripts/check_manufacturing_artifacts.py",
        subsystem="platform",
        tier="pd",
        args=("--release",),
    ),
    GateSpec(
        name="real-world-gates-check",
        script="scripts/check_real_world_gates.py",
        subsystem="platform",
        tier="silicon",
    ),
    GateSpec(
        name="wifi-interface-check",
        script="scripts/check_wifi_interface.py",
        subsystem="platform",
        tier="spec",
    ),
    GateSpec(
        name="fpga-target-check",
        script="scripts/check_fpga_target.py",
        subsystem="platform",
        tier="spec",
    ),
    GateSpec(
        name="fpga-release-check",
        script="scripts/check_fpga_release.py",
        subsystem="platform",
        tier="silicon",
        args=("--release",),
    ),
    GateSpec(
        name="phone-soc-claim-check",
        script="scripts/check_phone_soc_claims.py",
        subsystem="platform",
        tier="spec",
        scope="phone",
    ),
    GateSpec(
        name="product-feature-gates-check",
        script="scripts/check_product_feature_gates.py",
        subsystem="platform",
        tier="spec",
        scope="phone",
    ),
    GateSpec(
        name="phone-runtime-readiness-contract-check",
        script="scripts/check_phone_runtime_readiness_contract.py",
        subsystem="platform",
        tier="silicon",
        scope="phone",
    ),
    GateSpec(
        name="no-hardware-action-check",
        script="scripts/check_no_hardware_action_matrix.py",
        subsystem="platform",
        tier="spec",
    ),
    GateSpec(
        name="chip-stats-consistency",
        script="scripts/check_chip_stats_consistency.py",
        subsystem="platform",
        tier="spec",
    ),
    GateSpec(
        name="chip-topology-pkg-sync",
        script="scripts/gen_e1_topology_pkg.py",
        subsystem="platform",
        tier="spec",
        args=("--check",),
    ),
    # ---- BSP / Linux / Android ---------------------------------------------
    GateSpec(
        name="dts-soc-consistency",
        script="scripts/check_dts_soc_consistency.py",
        subsystem="bsp",
        tier="spec",
    ),
    GateSpec(
        name="software-bsp-scaffold-check",
        script="scripts/check_software_bsp.py",
        subsystem="bsp",
        tier="spec",
        args=("all", "--scaffold-only"),
    ),
    GateSpec(
        name="linux-bsp-contract-check",
        script="scripts/check_linux_bsp_contract.py",
        subsystem="bsp",
        tier="spec",
    ),
    GateSpec(
        name="linux-boot-artifacts-check",
        script="scripts/check_linux_boot_artifacts.py",
        subsystem="bsp",
        tier="silicon",
        args=("--require-pass",),
    ),
    GateSpec(
        name="linux-firmware-boot-chain-contract-check",
        script="scripts/check_linux_firmware_boot_chain_contract.py",
        subsystem="bsp",
        tier="silicon",
    ),
    GateSpec(
        name="linux-memory-platform-contract-check",
        script="scripts/check_linux_memory_platform_contract.py",
        subsystem="bsp",
        tier="silicon",
    ),
    GateSpec(
        name="chipyard-verilator-linux-smoke-check",
        script="scripts/check_chipyard_verilator_linux_smoke.py",
        subsystem="bsp",
        tier="silicon",
    ),
    GateSpec(
        name="cross-fork-agent-payload-contract-check",
        script="scripts/check_cross_fork_agent_payload_contract.py",
        subsystem="bsp",
        tier="spec",
    ),
    GateSpec(
        name="chip-os-bringup-workflow-contract-check",
        script="scripts/check_chip_os_bringup_workflow_contract.py",
        subsystem="bsp",
        tier="spec",
    ),
    GateSpec(
        name="aosp-simulator-completion-check",
        script="scripts/check_aosp_simulator_completion_gate.py",
        subsystem="bsp",
        tier="silicon",
    ),
    GateSpec(
        name="aosp-linux-handoff-contract-check",
        script="scripts/check_aosp_linux_handoff_contract.py",
        subsystem="bsp",
        tier="silicon",
    ),
    GateSpec(
        name="aosp-product-contract-check",
        script="scripts/check_aosp_product_contract.py",
        subsystem="bsp",
        tier="spec",
    ),
    GateSpec(
        name="aosp-hal-service-contract-check",
        script="scripts/check_aosp_hal_service_contract.py",
        subsystem="bsp",
        tier="spec",
    ),
    GateSpec(
        name="android-app-runtime-contract-check",
        script="scripts/check_android_app_runtime_contract.py",
        subsystem="bsp",
        tier="spec",
    ),
    GateSpec(
        name="android-system-apk-payload-check",
        script="scripts/check_android_system_apk_payload.py",
        subsystem="bsp",
        tier="spec",
        args=("--allow-missing-aapt",),
    ),
    GateSpec(
        name="android-launcher-runtime-evidence-check",
        script="scripts/check_android_launcher_runtime_evidence.py",
        subsystem="bsp",
        tier="silicon",
    ),
    GateSpec(
        name="android-evidence-capture-contract-check",
        script="scripts/check_android_evidence_capture_contract.py",
        subsystem="bsp",
        tier="spec",
    ),
    GateSpec(
        name="android-simulated-peripheral-evidence-check",
        script="scripts/check_android_simulated_peripheral_evidence.py",
        subsystem="bsp",
        tier="silicon",
    ),
    GateSpec(
        name="android-system-bridge-contract-check",
        script="scripts/check_android_system_bridge_contract.py",
        subsystem="bsp",
        tier="spec",
    ),
    GateSpec(
        name="android-release-readiness-contract-check",
        script="scripts/check_android_release_readiness_contract.py",
        subsystem="bsp",
        tier="spec",
    ),
    GateSpec(
        name="minimum-linux-target-check",
        script="scripts/check_minimum_linux_target.py",
        subsystem="bsp",
        tier="silicon",
    ),
    GateSpec(
        name="minimum-linux-npu-target-check",
        script="scripts/check_minimum_linux_npu_target.py",
        subsystem="bsp",
        tier="silicon",
    ),
    GateSpec(
        name="mvp-npu-ml-evidence-check",
        script="scripts/check_mvp_npu_ml_evidence.py",
        subsystem="bsp",
        tier="silicon",
        args=("--run",),
    ),
    GateSpec(
        name="os-rv64-chip-boot-contract-check",
        script="scripts/check_os_rv64_chip_boot_contract.py",
        subsystem="bsp",
        tier="silicon",
    ),
    # ---- Verification maturity ---------------------------------------------
    GateSpec(
        name="verification-maturity-matrix-check",
        script="scripts/check_verification_maturity_matrix.py",
        subsystem="verify",
        tier="rtl",
    ),
    GateSpec(
        name="stub-audit",
        script="verify/check_stub_audit.py",
        subsystem="verify",
        tier="rtl",
    ),
    # ---- Benchmarks / project plan -----------------------------------------
    GateSpec(
        name="project-plan-check",
        script="scripts/check_project_plan.py",
        subsystem="benchmarks",
        tier="spec",
    ),
    GateSpec(
        name="prototype-status-dashboard-check",
        script="scripts/check_prototype_status_dashboard.py",
        subsystem="benchmarks",
        tier="spec",
    ),
    # ---- OS RV64 (elizaOS unified Linux build, ARCH=riscv64) ----------------
    # These two gates live in packages/os/linux/elizaos and are invoked via
    # chip-relative sibling-package paths so the chip aggregator can present a
    # unified chip + OS bring-up view without duplicating their logic. The
    # OS-side scripts are stable; the aggregator only re-runs them and
    # classifies their PASS/FAIL/BLOCKED output with the same policy.
    GateSpec(
        name="os-rv64-release-check",
        script="../os/linux/elizaos/scripts/check_release_manifest.py",
        subsystem="os_rv64",
        tier="spec",
    ),
    GateSpec(
        name="os-rv64-qemu-virt-boot-test",
        script="../os/linux/elizaos/scripts/qemu_virt_smoke.py",
        subsystem="os_rv64",
        tier="spec",
        args=(
            "--validate-existing",
            "--evidence",
            "../os/linux/elizaos/evidence/qemu_virt_boot_20260524T030430Z.json",
        ),
    ),
)

CHIP_TAPEOUT_GATES: tuple[GateSpec, ...] = tuple(spec for spec in GATES if spec.scope == "chip")
PHONE_PRODUCT_GATES: tuple[GateSpec, ...] = tuple(spec for spec in GATES if spec.scope == "phone")


def select_gates(scope: str) -> tuple[GateSpec, ...]:
    if scope == "all":
        return GATES
    if scope == "chip":
        return CHIP_TAPEOUT_GATES
    if scope == "phone":
        return PHONE_PRODUCT_GATES
    raise ValueError(f"unknown aggregate scope: {scope}")


def provenance_safe(value: object) -> object:
    if isinstance(value, dict):
        return {key: provenance_safe(item) for key, item in value.items()}
    if isinstance(value, list):
        return [provenance_safe(item) for item in value]
    if isinstance(value, str):
        return value.replace(str(ROOT), "packages/chip")
    return value


@dataclass(frozen=True)
class GateResult:
    name: str
    status: Status
    evidence: str
    subsystem: Subsystem
    tier: Tier
    script: str = ""
    args: tuple[str, ...] = ()
    module: str | None = None
    blocker_dependency: BlockerDependency = "not_blocked"


def _classify(returncode: int, combined_output: str) -> Status:
    blob = combined_output
    # Any check that prints a recognised BLOCKED preamble is BLOCKED, no matter
    # what its exit code says: BLOCKED is a planning state, not a regression.
    blocked_markers = (
        "STATUS: BLOCKED",
        "BLOCKED:",
        "gate BLOCKED",
        "release blocked",
        "blocked_until_evidence",
        "release gate remains blocked",
        "release remains blocked",
        "metadata blocker:",
        "PDN signoff gate is BLOCKED",
        "FPGA release check failed:",
    )
    if any(marker in blob for marker in blocked_markers):
        return "BLOCKED"
    # Conventional 2 == soft-fail / blocked for several existing checks.
    if returncode == 2:
        return "BLOCKED"
    if returncode != 0:
        return "FAIL"
    return "PASS"


def _first_evidence_line(name: str, combined_output: str, returncode: int) -> str:
    """Return up to 200 chars of evidence, preferring the most informative line.

    Picks the first ``STATUS: BLOCKED``, ``BLOCKED``, ``FAIL:``, or ``failed``
    line. If none is present, picks the first ``STATUS:`` or non-empty line.
    Falls back to a synthetic stub when the script printed nothing.
    """
    lines = [line.strip() for line in combined_output.splitlines() if line.strip()]
    preferred: str | None = None
    for line in lines:
        if "STATUS: BLOCKED" in line:
            preferred = line
            break
    if preferred is None:
        for line in lines:
            if "BLOCKED:" in line or "release blocked" in line:
                preferred = line
                break
    if preferred is None:
        for line in lines:
            if line.startswith("FAIL:") or "failed" in line:
                preferred = line
                break
    if preferred is None:
        for line in lines:
            if line.startswith("STATUS:"):
                preferred = line
                break
    if preferred is None and lines:
        preferred = lines[0]
    if preferred is None:
        preferred = f"{name}: no output (exit={returncode})"
    return preferred[:200]


def classify_blocker_dependency(result: GateResult) -> BlockerDependency:
    if result.status != "BLOCKED":
        return "not_blocked"

    if result.name in (
        "e1-phone-board-package-check",
        "e1-phone-assemblability-check",
        "e1-phone-boolean-interference-check",
    ):
        return "actionable_external_dependency"
    if result.name == "product-release-status-check":
        product_dependency = product_release_status_dependency()
        if product_dependency is not None:
            return product_dependency
    if result.name == "pd-soc-input-contract-check":
        return "actionable_external_dependency"
    if result.name in ("cpu-ap-completion-gate", "aosp-simulator-completion-check"):
        return "live_device_validation"
    chip_release_dependency = chip_release_report_dependency(result.name)
    if chip_release_dependency is not None:
        return chip_release_dependency
    if result.name == "e1-phone-routed-output-content-check":
        routed_dependency = routed_output_content_dependency()
        if routed_dependency is not None:
            return routed_dependency
    if result.name == "chipyard-generated-linux-contract-check":
        chipyard_dependency = chipyard_generated_linux_dependency(result)
        if chipyard_dependency is not None:
            return chipyard_dependency

    blob = " ".join(
        (
            result.name,
            result.evidence,
            result.script,
            " ".join(result.args),
        )
    ).lower()
    if any(
        token in blob
        for token in (
            "phone-runtime",
            "runtime",
            "adb",
            "booted",
            "launcher",
            "system bridge",
            "live marker",
            "device/emulator",
        )
    ):
        return "live_device_validation"
    if any(
        token in blob
        for token in (
            "supplier",
            "approval",
            "approvals",
            "first-article",
            "first article",
            "enclosure",
            "mechanical",
            "fabrication",
            "factory",
            "procurement",
            "calibration",
            "external",
        )
    ):
        return "actionable_external_dependency"
    return "repo_artifact_generation"


CHIP_RELEASE_REPORTS_BY_GATE: dict[str, Path] = {
    "pdk-access-gate": PDK_ACCESS_GATE_REPORT_PATH,
    "pd-signoff-check": PD_SIGNOFF_REPORT_PATH,
    "pd-release-evidence-check": PD_RELEASE_EVIDENCE_REPORT_PATH,
    "pdn-workload-signoff": PDN_WORKLOAD_SIGNOFF_REPORT_PATH,
    "io-cell-contract-check": IO_CELL_CONTRACT_REPORT_PATH,
    "openlane-run-release-preflight-check": OPENLANE_RELEASE_PREFLIGHT_REPORT_PATH,
    "fpga-release-check": FPGA_RELEASE_REPORT_PATH,
    "package-cross-probe-check": PACKAGE_CROSS_PROBE_REPORT_PATH,
    "package-cross-probe-release-check": PACKAGE_CROSS_PROBE_REPORT_PATH,
    "kicad-artifact-check": KICAD_ARTIFACTS_REPORT_PATH,
    "kicad-artifacts-release-check": KICAD_ARTIFACTS_REPORT_PATH,
    "manufacturing-artifacts-release-check": MANUFACTURING_ARTIFACTS_REPORT_PATH,
    "android-release-readiness-contract-check": ANDROID_RELEASE_READINESS_REPORT_PATH,
    "antenna-metadata-check": ANTENNA_METADATA_REPORT_PATH,
    "antenna-metadata-release-check": ANTENNA_METADATA_REPORT_PATH,
    "linux-boot-artifacts-check": LINUX_BOOT_ARTIFACTS_REPORT_PATH,
    "android-simulated-peripheral-evidence-check": ANDROID_SIMULATED_PERIPHERAL_REPORT_PATH,
    "android-system-bridge-contract-check": ANDROID_SYSTEM_BRIDGE_REPORT_PATH,
    "minimum-linux-npu-target-check": MINIMUM_LINUX_NPU_TARGET_REPORT_PATH,
    "os-rv64-chip-boot-contract-check": OS_RV64_CHIP_BOOT_CONTRACT_REPORT_PATH,
    "boot-security-chain-contract-check": BOOT_SECURITY_CHAIN_CONTRACT_REPORT_PATH,
    "linux-firmware-boot-chain-contract-check": LINUX_FIRMWARE_BOOT_CHAIN_CONTRACT_REPORT_PATH,
    "aosp-linux-handoff-contract-check": AOSP_LINUX_HANDOFF_CONTRACT_REPORT_PATH,
}


def chip_release_report_dependency(gate_name: str) -> BlockerDependency | None:
    """Classify chip release gates from their structured nested reports."""
    path = CHIP_RELEASE_REPORTS_BY_GATE.get(gate_name)
    if path is None:
        return None
    report = read_report(path)
    if not report:
        return None
    fixed_dependency = fixed_chip_release_report_dependency(gate_name)
    if fixed_dependency is not None:
        return fixed_dependency

    dependency_from_counts = dependency_from_blocker_counts(report)
    if dependency_from_counts is not None:
        return dependency_from_counts

    if report_has_repo_generatable_now(report):
        return "repo_artifact_generation"
    dependency_from_rows = dependency_from_blocker_rows(report)
    if dependency_from_rows is not None:
        return dependency_from_rows
    if report_has_blocked_generation_without_repo_close(report):
        return "actionable_external_dependency"
    if report_text_has_live_dependency(report):
        return "live_device_validation"
    if report_text_has_external_dependency(report):
        return "actionable_external_dependency"

    summary = report.get("summary")
    if isinstance(summary, dict):
        blocker_classes = summary.get("blocker_classes")
        blocker_category_counts = summary.get("blocker_category_counts")
        class_blob = json.dumps(
            {
                "blocker_classes": blocker_classes,
                "blocker_category_counts": blocker_category_counts,
            },
            sort_keys=True,
        ).lower()
        if any(
            token in class_blob
            for token in (
                "external",
                "vendor",
                "foundry",
                "approval",
                "release_gate_blocked",
                "missing_vendor_evidence",
            )
        ):
            return "actionable_external_dependency"
    return None


def fixed_chip_release_report_dependency(gate_name: str) -> BlockerDependency | None:
    if gate_name in ("boot-security-chain-contract-check",):
        return "actionable_external_dependency"
    if gate_name in ("antenna-metadata-check", "antenna-metadata-release-check"):
        return "actionable_external_dependency"
    if gate_name == "aosp-linux-handoff-contract-check":
        return "live_device_validation"
    return None


def chipyard_generated_linux_dependency(result: GateResult) -> BlockerDependency | None:
    blob = " ".join((result.name, result.evidence, result.script)).lower()
    if "--require-boot-evidence" in result.args:
        return "live_device_validation"
    if "missing executable ap evidence" in blob or "eliza_e1_ap_benchmarks.log" in blob:
        return "live_device_validation"
    return None


def dependency_from_blocker_rows(report: dict[str, object]) -> BlockerDependency | None:
    rows: list[object] = []
    for key in ("blockers", "findings"):
        value = report.get(key)
        if isinstance(value, list):
            rows.extend(value)
    dependencies: set[str] = {
        str(row.get("blocker_dependency") or row.get("dependency_type"))
        for row in rows
        if isinstance(row, dict) and (row.get("blocker_dependency") or row.get("dependency_type"))
    }
    if "repo_artifact_generation" in dependencies:
        return "repo_artifact_generation"
    if "live_device_validation" in dependencies:
        return "live_device_validation"
    if "actionable_external_dependency" in dependencies:
        return "actionable_external_dependency"
    return None


def report_text_has_live_dependency(value: object) -> bool:
    text = json.dumps(value, sort_keys=True).lower()
    return any(
        token in text
        for token in (
            "adb",
            "booted target",
            "boot cuttlefish",
            "capture generated",
            "capture a generated",
            "live evidence",
            "runtime evidence",
            "serial transcript",
        )
    )


def report_text_has_external_dependency(value: object) -> bool:
    text = json.dumps(value, sort_keys=True).lower()
    return any(
        token in text
        for token in (
            "foundry",
            "commercial",
            "eda seat",
            "vendor",
            "supplier",
            "hard-ip",
            "wafer",
            "mask/nre",
            "external approval",
            "external checkout",
            "external linux",
            "external buildroot",
            "external opensbi",
        )
    )


def dependency_from_blocker_counts(report: dict[str, object]) -> BlockerDependency | None:
    counts = report.get("blocker_dependency_counts")
    if not isinstance(counts, dict):
        return None
    try:
        repo = int(counts.get("repo_artifact_generation") or 0)
        live = int(counts.get("live_device_validation") or 0)
        external = int(counts.get("actionable_external_dependency") or 0)
    except (TypeError, ValueError):
        return None
    if repo > 0:
        return "repo_artifact_generation"
    if live > 0:
        return "live_device_validation"
    if external > 0:
        return "actionable_external_dependency"
    return None


def report_has_repo_generatable_now(value: object) -> bool:
    if isinstance(value, dict):
        for key, item in value.items():
            if key in ("repo_generatable_now", "can_generate_from_repo_now") and item is True:
                return True
            if key in ("repo_generatable_now_count", "can_close_from_current_repo_count"):
                try:
                    if int(item or 0) > 0:
                        return True
                except (TypeError, ValueError):
                    pass
            if report_has_repo_generatable_now(item):
                return True
    elif isinstance(value, list):
        return any(report_has_repo_generatable_now(item) for item in value)
    return False


def report_has_blocked_generation_without_repo_close(value: object) -> bool:
    if isinstance(value, dict):
        has_blocked_generation = False
        repo_close_count: int | None = None
        for key, item in value.items():
            if key in ("blocked_generation_count", "blocked_repo_generation_count"):
                try:
                    has_blocked_generation = int(item or 0) > 0
                except (TypeError, ValueError):
                    has_blocked_generation = False
            if key in ("repo_generatable_now_count", "can_close_from_current_repo_count"):
                try:
                    repo_close_count = int(item or 0)
                except (TypeError, ValueError):
                    repo_close_count = None
            if report_has_blocked_generation_without_repo_close(item):
                return True
        return has_blocked_generation and repo_close_count == 0
    if isinstance(value, list):
        return any(report_has_blocked_generation_without_repo_close(item) for item in value)
    return False


def product_release_status_dependency() -> BlockerDependency | None:
    """Classify the product rollup from its structured dependency summary."""
    try:
        report = json.loads(PRODUCT_RELEASE_STATUS_PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None

    groups = report.get("repo_artifact_generation_groups")
    if isinstance(groups, list) and groups:
        has_repo_generatable_now = False
        all_groups_categorized = True
        for group in groups:
            if not isinstance(group, dict):
                continue
            counts = group.get("repo_generation_category_counts")
            if not isinstance(counts, dict):
                all_groups_categorized = False
                continue
            try:
                has_repo_generatable_now = (
                    has_repo_generatable_now or int(counts.get("repo_generatable_now") or 0) > 0
                )
            except (TypeError, ValueError):
                all_groups_categorized = False
        if has_repo_generatable_now:
            return "repo_artifact_generation"
        if not all_groups_categorized:
            return None

    counts = report.get("blocker_dependency_counts")
    if not isinstance(counts, dict):
        return None
    try:
        live = int(counts.get("live_device_validation") or 0)
        external = int(counts.get("actionable_external_dependency") or 0)
        repo = int(counts.get("repo_artifact_generation") or 0)
    except (TypeError, ValueError):
        return None
    if repo > 0 and (external > 0 or live > 0):
        return "live_device_validation" if live > external else "actionable_external_dependency"
    if external > 0:
        return "actionable_external_dependency"
    if live > 0:
        return "live_device_validation"
    if repo > 0:
        return "repo_artifact_generation"
    return None


def routed_output_content_dependency() -> BlockerDependency | None:
    """Classify routed-output blockers from the routed content report."""
    try:
        report = json.loads(E1_PHONE_ROUTED_OUTPUT_REPORT_PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None
    summary = report.get("summary")
    if not isinstance(summary, dict):
        return None
    try:
        closes_release = int(summary.get("repo_generation_closes_release_blocker_count") or 0)
        external_required = int(summary.get("external_release_evidence_required_count") or 0)
        missing_generated = int(summary.get("true_missing_generated_output_count") or 0)
        missing_outputs = int(summary.get("missing_outputs") or 0)
    except (TypeError, ValueError):
        return None
    if closes_release > 0 or missing_generated > 0 or missing_outputs > 0:
        return "repo_artifact_generation"
    if external_required > 0:
        return "actionable_external_dependency"
    return None


def read_report(path: Path) -> dict[str, object]:
    try:
        report = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}
    return report if isinstance(report, dict) else {}


def report_summary(path: Path) -> dict[str, object]:
    report = read_report(path)
    summary = report.get("summary")
    return summary if isinstance(summary, dict) else {}


def count_value(summary: dict[str, object], key: str) -> int:
    try:
        return int(summary.get(key) or 0)
    except (TypeError, ValueError):
        return 0


def chip_report_findings(path: Path) -> list[dict[str, object]]:
    report = read_report(path)
    findings = report.get("findings")
    return [row for row in findings if isinstance(row, dict)] if isinstance(findings, list) else []


def dependency_counts_text(path: Path) -> str:
    report = read_report(path)
    counts = report.get("blocker_dependency_counts")
    if not isinstance(counts, dict):
        summary = report.get("summary")
        if isinstance(summary, dict):
            counts = summary.get("blocker_dependency_counts")
    if not isinstance(counts, dict):
        return ""
    external = count_value(counts, "actionable_external_dependency")
    live = count_value(counts, "live_device_validation")
    repo = count_value(counts, "repo_artifact_generation")
    return f" Dependency counts: external={external}, live={live}, repo={repo}."


def unique_finding_next_steps(path: Path, limit: int = 4) -> list[str]:
    steps: list[str] = []
    seen: set[str] = set()
    findings = chip_report_findings(path)
    blocker_findings = [row for row in findings if row.get("severity") == "blocker"]
    for row in blocker_findings or findings:
        step = row.get("next_step")
        if not isinstance(step, str) or not step or step in seen:
            continue
        steps.append(step)
        seen.add(step)
        if len(steps) >= limit:
            break
    return steps


def pd_signoff_action() -> str:
    summary = report_summary(PD_SIGNOFF_REPORT_PATH)
    findings = chip_report_findings(PD_SIGNOFF_REPORT_PATH)
    closest_run = summary.get("closest_run")
    missing = count_value(summary, "closest_run_missing_artifact_count")
    gates = count_value(summary, "blocked_release_gate_count")
    first_steps = [
        str(row.get("message")) for row in findings[:3] if isinstance(row.get("message"), str)
    ]
    detail = (
        f" Closest run: {closest_run}; missing artifact classes: {missing}." if closest_run else ""
    )
    samples = f" Current blockers: {'; '.join(first_steps)}." if first_steps else ""
    return (
        "Archive a complete release-clean PD signoff run with run manifest, DRC, LVS, "
        "antenna, STA, IR/EM, density, SI/PI/current-budget, padframe/package, and "
        "tool-version evidence; rerun python3 scripts/check_pd_signoff.py. "
        f"Blocked release gates: {gates}." + detail + samples
    )


def pd_release_evidence_action() -> str:
    summary = report_summary(PD_RELEASE_EVIDENCE_REPORT_PATH)
    bucket_actions = summary.get("bucket_next_actions")
    rows = (
        [row for row in bucket_actions if isinstance(row, dict)]
        if isinstance(bucket_actions, list)
        else []
    )
    top = [
        f"{row.get('bucket')}={row.get('count')} via {row.get('next_command')}" for row in rows[:5]
    ]
    bucket_text = f" Top blocker buckets: {'; '.join(top)}." if top else ""
    return (
        "Replace prohibited/draft PD evidence manifests with release-ready, externally "
        "reviewed signoff evidence and close each bucket in "
        "build/reports/pd_release_evidence.json; rerun python3 scripts/check_pd_release_evidence.py."
        + bucket_text
    )


def pdk_access_action() -> str:
    summary = report_summary(PDK_ACCESS_GATE_REPORT_PATH)
    return (
        "Execute and record foundry, commercial EDA, hard-IP, mask/NRE, tapeout budget, "
        "and wafer-allocation agreements in docs/evidence/process/pdk-access-gate.yaml; "
        "rerun python3 scripts/check_pdk_access_gate.py. "
        f"Global unmet: {count_value(summary, 'global_unmet')}; "
        f"advanced targets blocked: {count_value(summary, 'blocked_targets')}/"
        f"{count_value(summary, 'advanced_targets')}; checklist items not started: "
        f"{count_value(summary, 'checklist_not_started')}."
    )


def io_cell_contract_action() -> str:
    summary = report_summary(IO_CELL_CONTRACT_REPORT_PATH)
    findings = chip_report_findings(IO_CELL_CONTRACT_REPORT_PATH)
    classes = []
    for row in findings[:5]:
        evidence = row.get("evidence")
        if isinstance(evidence, dict) and evidence.get("class"):
            classes.append(str(evidence["class"]))
    class_text = f" Sample blocked classes: {', '.join(classes)}." if classes else ""
    return (
        "Archive foundry IO-cell Liberty, LEF, GDS, SPICE, IBIS, ESD/latchup, "
        "and corner-coverage deliverables for each blocked pad class, then rerun "
        "python3 scripts/check_io_cell_contract.py. "
        f"Classes blocked: {count_value(summary, 'classes_blocked')}/"
        f"{count_value(summary, 'classes_total')}." + class_text
    )


def antenna_metadata_action() -> str:
    summary = report_summary(ANTENNA_METADATA_REPORT_PATH)
    return (
        "Instantiate release IO/pad cells and archive padframe-inclusive antenna gate/diffusion "
        "metadata for every top-level pin; rerun python3 scripts/check_antenna_metadata.py --release. "
        f"Missing input gate metadata: {count_value(summary, 'missing_input_gate_metadata_count')}; "
        f"missing output diffusion metadata: {count_value(summary, 'missing_output_diffusion_metadata_count')}; "
        f"pins blocked: {count_value(summary, 'missing_pin_count')}."
    )


def boot_security_chain_action() -> str:
    findings = chip_report_findings(BOOT_SECURITY_CHAIN_CONTRACT_REPORT_PATH)
    next_steps = [
        str(row.get("next_step")) for row in findings if isinstance(row.get("next_step"), str)
    ]
    suffix = f" Required promotion step: {next_steps[0]}" if next_steps else ""
    return (
        "Promote the boot security chain only after secure boot, AVB/rollback, key ceremony, "
        "negative tests, provisioning records, and boot transcripts are implemented and archived; "
        "rerun python3 scripts/check_boot_security_chain_contract.py." + suffix
    )


def openlane_release_preflight_action() -> str:
    summary = report_summary(OPENLANE_RELEASE_PREFLIGHT_REPORT_PATH)
    findings = chip_report_findings(OPENLANE_RELEASE_PREFLIGHT_REPORT_PATH)
    messages = [
        str(row.get("message")) for row in findings[:3] if isinstance(row.get("message"), str)
    ]
    sample = f" Current gates: {'; '.join(messages)}." if messages else ""
    return (
        "Run a complete pinned OpenLane release flow and archive release-clean PD, tapeout, "
        "and board-fabrication gate evidence; rerun python3 scripts/check_openlane_run_preflight.py --release. "
        f"Blocked release gates: {count_value(summary, 'blocked_release_gate_count')}." + sample
    )


def openlane_preflight_action() -> str:
    report = read_report(ROOT / "build/reports/openlane_run_preflight.json")
    findings = report.get("findings")
    messages: list[str] = []
    next_steps: list[str] = []
    if isinstance(findings, list):
        for row in findings:
            if not isinstance(row, dict):
                continue
            message = row.get("message")
            if isinstance(message, str) and message and len(messages) < 3:
                messages.append(message)
            next_step = row.get("next_step")
            if isinstance(next_step, str) and next_step and next_step not in next_steps:
                next_steps.append(next_step)
    current = f" Current blockers: {'; '.join(messages)}." if messages else ""
    steps = f" Required next steps: {'; '.join(next_steps[:3])}." if next_steps else ""
    return (
        "Let the active pinned OpenLane run finish, then rerun "
        "python3 scripts/check_openlane_run_preflight.py; if the lock persists after the run exits, "
        "inspect the lock before starting another flow." + current + steps
    )


def os_rv64_release_action() -> str:
    manifest_dir = ROOT.parent / "os/linux/elizaos"
    return (
        "Promote the OS RV64 release only after replacing the template manifest with a filled "
        "manifest.json that has the real ISO filename, byte size, SHA-256, collected qemu-virt, "
        "GRUB EFI RISC-V, agent-live, and riscv64-agent-runtime evidence rows; rerun "
        "python3 ../os/linux/elizaos/scripts/check_release_manifest.py. Current manifest source: "
        f"{manifest_dir.relative_to(ROOT.parent)}/manifest.json or manifest.json.template."
    )


def fpga_release_action() -> str:
    summary = report_summary(FPGA_RELEASE_REPORT_PATH)
    category_counts = summary.get("blocker_category_counts")
    categories: list[str] = []
    if isinstance(category_counts, dict):
        ordered = sorted(
            category_counts.items(),
            key=lambda item: int(item[1] or 0) if isinstance(item[1], int) else 0,
            reverse=True,
        )
        categories = [f"{name}={count}" for name, count in ordered[:5]]
    category_text = f" FPGA blocker categories: {'; '.join(categories)}." if categories else ""
    steps = unique_finding_next_steps(FPGA_RELEASE_REPORT_PATH)
    step_text = f" Next commands: {'; '.join(steps)}." if steps else ""
    return (
        "Close the FPGA release packet with final board/pin revision, release bitstream, "
        "timing/route reports, pack transcript, programming transcript, and tool versions; "
        "rerun python3 scripts/check_fpga_release.py --release."
        + dependency_counts_text(FPGA_RELEASE_REPORT_PATH)
        + category_text
        + step_text
    )


def linux_firmware_boot_chain_action() -> str:
    steps = unique_finding_next_steps(LINUX_FIRMWARE_BOOT_CHAIN_CONTRACT_REPORT_PATH, limit=2)
    step_text = f" Required capture: {'; '.join(steps)}." if steps else ""
    return (
        "Capture a real OpenSBI fw_dynamic handoff transcript from the selected QEMU, Renode, "
        "or board flow; rerun python3 scripts/check_linux_firmware_boot_chain_contract.py. "
        "U-Boot alternate evidence and Buildroot qemu-virt evidence are reference-only unless "
        "that path is selected."
        + dependency_counts_text(LINUX_FIRMWARE_BOOT_CHAIN_CONTRACT_REPORT_PATH)
        + step_text
    )


def android_release_readiness_action() -> str:
    report = read_report(ANDROID_RELEASE_READINESS_REPORT_PATH)
    evidence = report.get("evidence")
    inventory = (
        evidence.get("android_release_artifact_inventory") if isinstance(evidence, dict) else None
    )
    missing_archives: list[str] = []
    command_keys: list[str] = []
    if isinstance(inventory, dict):
        missing = inventory.get("missing")
        if isinstance(missing, dict):
            archives = missing.get("umbrellaAndroidArchives")
            if isinstance(archives, list):
                missing_archives = [str(path) for path in archives[:3]]
        commands = inventory.get("commands")
        if isinstance(commands, dict):
            command_keys = [str(key) for key in commands][:6]
    missing_text = (
        f" Missing staged archives: {', '.join(missing_archives)}." if missing_archives else ""
    )
    command_text = (
        f" Use evidence.android_release_artifact_inventory.commands groups: {', '.join(command_keys)}."
        if command_keys
        else ""
    )
    return (
        "Close Android release readiness in two packets: first stage/hash the missing Android "
        "archives and copy only measured size/SHA-256 values into manifests, then collect the "
        "per-target live launcher/agent evidence; rerun python3 scripts/check_android_release_readiness_contract.py."
        + dependency_counts_text(ANDROID_RELEASE_READINESS_REPORT_PATH)
        + missing_text
        + command_text
    )


def android_system_bridge_action() -> str:
    steps = unique_finding_next_steps(ANDROID_SYSTEM_BRIDGE_REPORT_PATH, limit=3)
    step_text = f" Required captures: {'; '.join(steps)}." if steps else ""
    return (
        "Boot the Android target and replace system-bridge fail-closed rows with collected "
        "runtime evidence showing PASS status and result=0; rerun python3 scripts/check_android_system_bridge_contract.py."
        + dependency_counts_text(ANDROID_SYSTEM_BRIDGE_REPORT_PATH)
        + step_text
    )


def externalized_candidate_action(
    *,
    noun: str,
    summary: dict[str, object],
    external_key: str,
    candidate_key: str,
    missing_key: str,
    validation_command: str,
) -> str:
    external_count = count_value(summary, external_key)
    candidate_count = count_value(summary, candidate_key)
    missing_count = count_value(summary, missing_key)
    if external_count > 0 and missing_count == 0:
        return (
            f"Replace {candidate_count} present candidate/non-release {noun} rows with "
            f"approved, hash-bound release evidence; {external_count} rows still require "
            f"external approval or supplier/factory evidence. Rerun {validation_command}."
        )
    if missing_count > 0:
        return (
            f"Generate or attach {missing_count} missing {noun} rows, then replace any "
            f"candidate rows with approved release evidence and rerun {validation_command}."
        )
    return (
        f"Inspect the {noun} report, replace placeholders with approved release evidence, "
        f"and rerun {validation_command}."
    )


def phone_assemblability_action() -> str:
    report = read_report(E1_PHONE_ASSEMBLY_VERIFICATION_PATH)
    trapped = report.get("trapped_parts")
    trapped_count = len(trapped) if isinstance(trapped, list) else 0
    fpc = report.get("fpc_routing")
    pinched_routes: list[str] = []
    if isinstance(fpc, dict):
        routes = fpc.get("routes")
        if isinstance(routes, list):
            for route in routes:
                if isinstance(route, dict) and route.get("unpinched") is False:
                    pinched_routes.append(str(route.get("flex") or route.get("keepout")))
    details: list[str] = []
    if trapped_count:
        details.append(f"{trapped_count} trapped part(s): {', '.join(map(str, trapped[:4]))}")
    if pinched_routes:
        details.append(
            f"{len(pinched_routes)} pinched FPC route(s): {', '.join(pinched_routes[:4])}"
        )
    suffix = f" Current blockers: {'; '.join(details)}." if details else ""
    return (
        "Revise the mechanical stack/assembly sequence or enclosure/frame geometry until "
        "the swept insertion check reports no trapped parts and all FPC bend keepouts are "
        "unpinched; rerun python3 scripts/check_e1_phone_assemblability.py." + suffix
    )


def phone_boolean_interference_action() -> str:
    report = read_report(E1_PHONE_BOOLEAN_INTERFERENCE_PATH)
    clashes = report.get("unintentional_clashes")
    clash_count = (
        len(clashes) if isinstance(clashes, list) else count_value(report, "release_blocker_count")
    )
    samples: list[str] = []
    if isinstance(clashes, list):
        for row in clashes[:4]:
            if isinstance(row, dict):
                samples.append(f"{row.get('a')} vs {row.get('b')}")
    sample_text = f" Sample clashes: {', '.join(samples)}." if samples else ""
    return (
        "Close the full-CAD boolean validation by eliminating unintentional clashes in the "
        "concept/routed/supplier geometry, then rerun python3 scripts/check_e1_phone_boolean_interference.py. "
        f"Current unintentional clash count: {clash_count}." + sample_text
    )


def cpu_ap_completion_action() -> str:
    report = read_report(CPU_AP_COMPLETION_REPORT_PATH)
    missing = report.get("missing_required_transcripts")
    missing_count = len(missing) if isinstance(missing, list) else 0
    commands = report.get("next_capture_commands")
    command_count = len(commands) if isinstance(commands, list) else 0
    detail = (
        f" Current missing generated CPU/AP transcripts: {missing_count}; "
        f"capture command templates: {command_count}."
        if missing_count or command_count
        else ""
    )
    return (
        "Collect generated Eliza Rocket/RV64GC CPU/AP transcripts from the current "
        "Chipyard/AP run and rerun python3 scripts/check_cpu_ap_completion_gate.py; "
        "qemu-virt Linux boot evidence is reference-only and does not close this AP claim." + detail
    )


def blocker_action(result: GateResult) -> dict[str, object]:
    """Return an operator-facing next action for a blocked aggregate gate."""
    product_repo_groups = product_repo_artifact_group_summary()
    routed_summary = report_summary(E1_PHONE_ROUTED_OUTPUT_REPORT_PATH)
    factory_summary = report_summary(E1_PHONE_FACTORY_OUTPUT_REPORT_PATH)
    first_article_summary = report_summary(E1_PHONE_FIRST_ARTICLE_REPORT_PATH)
    supplier_summary = report_summary(E1_PHONE_SUPPLIER_RETURN_REPORT_PATH)
    approval_summary = report_summary(E1_PHONE_RELEASE_APPROVAL_REPORT_PATH)
    action_by_gate = {
        "cpu-ap-completion-gate": cpu_ap_completion_action(),
        "boot-security-chain-contract-check": boot_security_chain_action(),
        "pdk-access-gate": pdk_access_action(),
        "pd-signoff-check": pd_signoff_action(),
        "pd-release-evidence-check": pd_release_evidence_action(),
        "io-cell-contract-check": io_cell_contract_action(),
        "antenna-metadata-check": antenna_metadata_action(),
        "antenna-metadata-release-check": antenna_metadata_action(),
        "openlane-run-preflight-check": openlane_preflight_action(),
        "openlane-run-release-preflight-check": openlane_release_preflight_action(),
        "fpga-release-check": fpga_release_action(),
        "linux-firmware-boot-chain-contract-check": linux_firmware_boot_chain_action(),
        "android-release-readiness-contract-check": android_release_readiness_action(),
        "android-system-bridge-contract-check": android_system_bridge_action(),
        "e1-phone-board-package-check": (
            "Keep structural board package checks green while replacing fail-closed "
            "planning/candidate artifacts with release evidence from the underlying "
            "fabrication, enclosure, routed-output, supplier, and first-article gates."
        ),
        "e1-phone-fabrication-release-check": (
            "Close the fabrication/enclosure/e2e release gate by satisfying each "
            "blocked child gate and rerunning the fabrication release checker."
        ),
        "e1-phone-release-approval-signature-check": (
            f"Collect owner/reviewer/captured_at/revision-or-lot/SHA256-backed approval "
            f"rows for {count_value(approval_summary, 'release_blocked')} blocked rows; "
            "placeholder, template, and presence-only rows do not count."
        ),
        "e1-phone-supplier-return-content-check": (
            f"Collect supplier-returned quotes, drawings, STEP/B-rep models, samples, "
            f"pinouts, and acceptance evidence for {count_value(supplier_summary, 'blocked')} "
            "blocked supplier matrix rows."
        ),
        "e1-phone-routed-output-content-check": externalized_candidate_action(
            noun="routed output",
            summary=routed_summary,
            external_key="external_release_evidence_required_count",
            candidate_key="candidate_present_but_blocked_count",
            missing_key="true_missing_generated_output_count",
            validation_command="python3 scripts/check_e1_phone_routed_output_content.py",
        ),
        "e1-phone-factory-output-content-check": externalized_candidate_action(
            noun="factory output",
            summary=factory_summary,
            external_key="external_release_evidence_required_count",
            candidate_key="candidate_present_but_blocked_count",
            missing_key="true_missing_factory_output_count",
            validation_command="python3 scripts/check_e1_phone_factory_output_content.py",
        ),
        "e1-phone-first-article-content-check": (
            f"Execute first-article traveler/test logs on real units and replace "
            f"{count_value(first_article_summary, 'blocked_template_present_count')} template "
            f"and {count_value(first_article_summary, 'blocked_required_present_count')} "
            "presence-only rows with signed, hashed measurement evidence."
        ),
        "e1-phone-enclosure-mechanical-content-check": (
            "Collect routed-board STEP clearance, production enclosure handoff packets, "
            "CMM/FAI, process limits, validation results, and first-article fit evidence."
        ),
        "e1-phone-assemblability-check": phone_assemblability_action(),
        "e1-phone-boolean-interference-check": phone_boolean_interference_action(),
        "product-release-status-check": product_release_status_action(product_repo_groups),
        "phone-runtime-readiness-contract-check": (
            "Boot a target phone/emulator and capture live Android/system bridge, media, "
            "security lifecycle, radio/sensor/PMIC, and launcher runtime evidence."
        ),
        "os-rv64-release-check": os_rv64_release_action(),
    }
    validation = result.script
    if result.args:
        validation = " ".join((validation, *result.args))
    if result.name == "phone-runtime-readiness-contract-check":
        validation = "packages/chip/scripts/check_phone_runtime_readiness_contract.py"
    action: dict[str, object] = {
        "name": result.name,
        "dependency": result.blocker_dependency,
        "script": result.script,
        "validation_command": f"python3 {validation}".strip(),
        "evidence": result.evidence,
        "next_action": action_by_gate.get(
            result.name,
            "Inspect the checker report, replace placeholders with real evidence, and rerun the gate.",
        ),
    }
    if result.name == "phone-runtime-readiness-contract-check":
        runtime_action = runtime_next_capture_action()
        if runtime_action is not None:
            action["next_runtime_capture_action"] = runtime_action
    return action


def product_release_status_action(product_repo_groups: str = "") -> str:
    """Return product guidance that matches the rollup dependency state."""
    dependency = product_release_status_dependency()
    if dependency in {"actionable_external_dependency", "live_device_validation"}:
        return (
            "Resolve product release detail checks by closing external approvals, "
            "supplier/factory returns, physical validation, and live-device evidence; "
            "the current product rollup has no repo-artifact generation blockers."
        )
    action = (
        "Resolve product release detail checks by generating repo artifacts where "
        "possible and attaching external/live evidence where required."
    )
    if product_repo_groups:
        action += f" Current top repo-artifact groups: {product_repo_groups}."
    return action


def product_repo_artifact_group_summary(limit: int = 5) -> str:
    """Summarize product-level repo artifact groups for the aggregate action plan."""
    try:
        report = json.loads(PRODUCT_RELEASE_STATUS_PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return ""
    groups = report.get("repo_artifact_generation_groups")
    if not isinstance(groups, list):
        return ""
    rows: list[str] = []
    for group in groups:
        if not isinstance(group, dict):
            continue
        family = group.get("family")
        count = group.get("count")
        command = group.get("next_command")
        if not isinstance(family, str) or not isinstance(count, int):
            continue
        if isinstance(command, str) and command:
            rows.append(f"{family}={count} via {command}")
        else:
            rows.append(f"{family}={count}")
        if len(rows) >= limit:
            break
    return "; ".join(rows)


def product_next_release_action() -> dict[str, object] | None:
    """Return product rollup's structured next release action when available."""
    try:
        report = json.loads(PRODUCT_RELEASE_STATUS_PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None
    action = report.get("next_release_action")
    return action if isinstance(action, dict) else None


def runtime_next_capture_action() -> dict[str, object] | None:
    """Return runtime contract's structured next live-capture action when available."""
    try:
        report = json.loads(PHONE_RUNTIME_READINESS_REPORT_PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None
    action = report.get("next_runtime_capture_action")
    return action if isinstance(action, dict) else None


def blocker_code(name: str, fallback: str = "gate") -> str:
    cleaned = "".join(char.lower() if char.isalnum() else "_" for char in name)
    parts = [part for part in cleaned.split("_") if part]
    return "_".join(parts[:10]) or fallback


def structured_blockers(results: list[GateResult]) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for result in results:
        if result.status not in {"BLOCKED", "FAIL"}:
            continue
        code_prefix = "blocked" if result.status == "BLOCKED" else "failed"
        validation = result.script
        if result.args:
            validation = " ".join((validation, *result.args))
        rows.append(
            {
                "code": f"{code_prefix}_{blocker_code(result.name)}",
                "name": result.name,
                "status": result.status.lower(),
                "subsystem": result.subsystem,
                "tier": result.tier,
                "script": result.script,
                "validation_command": f"python3 {validation}".strip(),
                "dependency": result.blocker_dependency,
                "message": result.evidence,
                "next_action": blocker_action(result).get("next_action", ""),
            }
        )
    return rows


AGGREGATE_RELEASE_PHASES: tuple[dict[str, object], ...] = (
    {
        "phase": "chip_pd_signoff",
        "goal": "Close PD signoff, release evidence, OpenLane, antenna, and tapeout-scope gates.",
        "gates": {
            "pd-preflight-check",
            "pd-soc-input-contract-check",
            "pd-signoff-manifest-check",
            "pd-signoff-check",
            "pd-release-evidence-check",
            "pd-evidence-gates",
            "antenna-metadata-release-check",
            "openlane-run-release-preflight-check",
            "pdn-workload-signoff",
            "physical-closure-work-order-check",
            "manufacturing-tapeout-scope-check",
            "multi-pdk-closure-check",
            "pdk-portability-check",
            "pdk-access-gate",
            "die-area-budget-check",
        },
        "acceptance_commands": [
            "python3 scripts/check_pd_signoff.py",
            "python3 scripts/check_pd_release_evidence.py",
            "python3 scripts/check_openlane_run_preflight.py --release",
            "python3 scripts/aggregate_tapeout_readiness.py --scope chip --strict",
        ],
    },
    {
        "phase": "chip_package_board_release",
        "goal": "Close package, pinout, KiCad/manufacturing, board-package, and cross-probe release evidence.",
        "gates": {
            "pinout-check",
            "package-cross-probe-check",
            "package-cross-probe-release-check",
            "kicad-artifact-check",
            "kicad-artifacts-release-check",
            "manufacturing-artifacts-check",
            "manufacturing-artifacts-release-check",
            "e1-phone-manufacturing-artifacts-check",
            "board-package-evidence-check",
            "padframe-check",
            "io-cell-contract-check",
        },
        "acceptance_commands": [
            "python3 scripts/check_package_cross_probe.py --release",
            "python3 scripts/check_manufacturing_artifacts.py --release",
            "python3 scripts/check_kicad_artifacts.py --release",
            "python3 scripts/aggregate_tapeout_readiness.py --scope chip --strict",
        ],
    },
    {
        "phase": "chip_platform_bsp_runtime_release",
        "goal": "Close platform, BSP, Linux/Android handoff, FPGA, and real-world silicon evidence gates.",
        "gates": {
            "platform-contract-check",
            "chip-stats-consistency-check",
            "real-world-gates-check",
            "fpga-target-check",
            "fpga-release-check",
            "software-bsp-scaffold-check",
            "linux-platform-contract-check",
            "linux-boot-artifacts-check",
            "aosp-linux-handoff-contract-check",
            "android-release-readiness-contract-check",
            "android-simulated-peripheral-evidence-check",
            "android-system-bridge-contract-check",
            "android-sim-boot-check",
            "chipyard-generated-linux-contract-check",
            "e1-npu-linux-smoke-check",
            "minimum-linux-npu-target-check",
            "os-rv64-chip-boot-contract-check",
        },
        "acceptance_commands": [
            "python3 scripts/check_fpga_release.py --release",
            "python3 scripts/check_real_world_gates.py",
            "python3 scripts/aggregate_tapeout_readiness.py --scope chip --strict",
        ],
    },
    {
        "phase": "phone_fabrication_enclosure_release",
        "goal": "Close board package, fabrication, approvals, supplier, routed, factory, first-article, and enclosure gates.",
        "gates": {
            "e1-phone-board-package-check",
            "e1-phone-fabrication-release-check",
            "e1-phone-release-approval-signature-check",
            "e1-phone-supplier-return-content-check",
            "e1-phone-routed-output-content-check",
            "e1-phone-factory-output-content-check",
            "e1-phone-first-article-content-check",
            "e1-phone-enclosure-mechanical-content-check",
        },
        "acceptance_commands": [
            "python3 scripts/aggregate_tapeout_readiness.py --scope phone --strict",
            "python3 scripts/product_check.py --release",
        ],
    },
    {
        "phase": "phone_release_evidence_regeneration",
        "goal": "Keep generated phone release-readiness reports reproducible from committed sources.",
        "gates": {
            "e1-phone-release-evidence-regeneration-check",
        },
        "acceptance_commands": [
            "python3 scripts/check_e1_phone_release_evidence_regeneration.py",
            "python3 scripts/aggregate_tapeout_readiness.py --scope phone",
        ],
    },
    {
        "phase": "phone_end_to_end_runtime_release",
        "goal": "Collect live booted-target phone runtime evidence.",
        "gates": {
            "phone-runtime-readiness-contract-check",
        },
        "acceptance_commands": [
            "python3 scripts/check_phone_runtime_readiness_contract.py",
            "python3 scripts/aggregate_tapeout_readiness.py --scope phone --strict",
            "python3 scripts/product_check.py --release",
        ],
    },
    {
        "phase": "product_release_rollup",
        "goal": "Close chip, board, package, phone, and runtime release checks visible through product status.",
        "gates": {
            "product-release-status-check",
        },
        "acceptance_commands": [
            "python3 scripts/product_check.py --release",
            "python3 scripts/aggregate_tapeout_readiness.py --scope phone --strict",
        ],
    },
)


def blocker_phase_plan(results: list[GateResult]) -> list[dict[str, object]]:
    """Group blocked aggregate gates into release phases for operators."""
    blocked_by_name = {
        result.name: result
        for result in results
        if result.status == "BLOCKED" and result.blocker_dependency != "not_blocked"
    }
    rows: list[dict[str, object]] = []
    for phase in AGGREGATE_RELEASE_PHASES:
        gate_names = {
            str(name)
            for name in cast("Iterable[object]", phase.get("gates", set()))
            if isinstance(name, str)
        }
        matched = [blocked_by_name[name] for name in sorted(gate_names) if name in blocked_by_name]
        if not matched:
            continue
        next_actions = [blocker_action(result) for result in matched]
        if len(matched) != len(next_actions):
            raise RuntimeError(f"{phase['phase']}: gate/action count mismatch")
        row: dict[str, object] = {
            "phase": phase["phase"],
            "goal": phase["goal"],
            "release_credit": False,
            "blocked_gate_count": len(matched),
            "blocker_dependency_counts": {
                "repo_artifact_generation": sum(
                    1
                    for result in matched
                    if result.blocker_dependency == "repo_artifact_generation"
                ),
                "live_device_validation": sum(
                    1 for result in matched if result.blocker_dependency == "live_device_validation"
                ),
                "actionable_external_dependency": sum(
                    1
                    for result in matched
                    if result.blocker_dependency == "actionable_external_dependency"
                ),
            },
            "next_command_by_dependency": {
                dependency: sorted(
                    {
                        str(action["validation_command"])
                        for action in next_actions
                        if action["dependency"] == dependency
                    }
                )
                for dependency in (
                    "repo_artifact_generation",
                    "live_device_validation",
                    "actionable_external_dependency",
                )
                if any(action["dependency"] == dependency for action in next_actions)
            },
            "blocked_gates": [result.name for result in matched],
            "blocked_gate_details": [],
            "validation_commands": [str(action["validation_command"]) for action in next_actions],
            "acceptance_commands": phase["acceptance_commands"],
            "sample_evidence": [result.evidence for result in matched[:5]],
        }
        details: list[dict[str, object]] = []
        for result, action in zip(matched, next_actions, strict=True):
            detail: dict[str, object] = {
                "name": result.name,
                "blocker_dependency": result.blocker_dependency,
                "validation_command": action["validation_command"],
                "next_action": action["next_action"],
                "evidence": result.evidence,
            }
            if isinstance(action.get("next_runtime_capture_action"), dict):
                detail["next_runtime_capture_action"] = action["next_runtime_capture_action"]
                row["next_runtime_capture_action"] = action["next_runtime_capture_action"]
            details.append(detail)
        row["blocked_gate_details"] = details
        rows.append(row)
    return rows


def next_release_action(phase_plan: list[dict[str, object]]) -> dict[str, object] | None:
    """Expose the first blocked aggregate phase as a top-level operator action."""
    for phase in phase_plan:
        dependency_counts = phase.get("blocker_dependency_counts")
        if not isinstance(dependency_counts, dict):
            continue
        try:
            blocked_count = int(phase.get("blocked_gate_count") or 0)
        except (TypeError, ValueError):
            blocked_count = 0
        if blocked_count <= 0:
            continue
        action: dict[str, object] = {
            "phase": phase.get("phase"),
            "goal": phase.get("goal"),
            "release_credit": False,
            "blocked_gate_count": blocked_count,
            "blocker_dependency_counts": dependency_counts,
            "blocked_gates": phase.get("blocked_gates", []),
            "primary_commands": phase.get("validation_commands", []),
            "acceptance_commands": phase.get("acceptance_commands", []),
            "sample_evidence": phase.get("sample_evidence", []),
            "claim_boundary": "operator_release_action_only_not_release_evidence",
        }
        phase_name = str(phase.get("phase") or "")
        if phase_name == "product_release_rollup":
            product_action = product_next_release_action()
            if product_action is not None:
                action["product_next_release_action"] = product_action
        if phase_name == "phone_end_to_end_runtime_release":
            runtime_action = phase.get("next_runtime_capture_action")
            if not isinstance(runtime_action, dict):
                runtime_action = runtime_next_capture_action()
            if runtime_action is not None:
                action["next_runtime_capture_action"] = runtime_action
        return action
    return None


def run_gate(spec: GateSpec) -> GateResult:
    raw = Path(spec.script)
    if raw.is_absolute():
        script_path = raw
        # Absolute-path gates run from the script's own directory so that any
        # path-relative defaults inside the foreign script resolve correctly.
        # For ``module`` gates we run from the package root (script's parent's
        # parent) so ``python -m unittest <pkg.module>`` can import properly.
        cwd = script_path.parent.parent if spec.module else script_path.parent
    else:
        script_path = ROOT / spec.script
        cwd = script_path.parent.parent if spec.module else ROOT
    if not script_path.is_file():
        return GateResult(
            name=spec.name,
            status="FAIL",
            evidence=f"script missing: {spec.script}",
            subsystem=spec.subsystem,
            tier=spec.tier,
            script=spec.script,
            args=spec.args,
            module=spec.module,
        )
    if spec.module:
        cmd = [sys.executable, "-m", "unittest", spec.module, *spec.args]
    else:
        cmd = [sys.executable, str(script_path), *spec.args]
    proc = subprocess.Popen(
        cmd,
        cwd=cwd,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    try:
        stdout, _ = proc.communicate(timeout=GATE_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
            stdout, _ = proc.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
            stdout, _ = proc.communicate()
        combined_timeout = stdout or ""
        evidence = (
            f"STATUS: BLOCKED {spec.name} exceeded {GATE_TIMEOUT_SECONDS}s aggregate gate timeout"
        )
        if combined_timeout.strip():
            evidence = (
                evidence
                + "; partial output: "
                + _first_evidence_line(spec.name, combined_timeout, 124)
            )
        return GateResult(
            name=spec.name,
            status="BLOCKED",
            evidence=evidence,
            subsystem=spec.subsystem,
            tier=spec.tier,
            script=spec.script,
            args=spec.args,
            module=spec.module,
        )
    completed_returncode = proc.returncode if proc.returncode is not None else 1
    combined = stdout or ""
    status = _classify(completed_returncode, combined)
    evidence = _first_evidence_line(spec.name, combined, completed_returncode)
    return GateResult(
        name=spec.name,
        status=status,
        evidence=evidence,
        subsystem=spec.subsystem,
        tier=spec.tier,
        script=spec.script,
        args=spec.args,
        module=spec.module,
    )


def build_report(results: list[GateResult]) -> dict[str, object]:
    summary = {"pass": 0, "fail": 0, "blocked": 0}
    for result in results:
        summary[result.status.lower()] += 1
    status = "fail" if summary["fail"] > 0 else "blocked" if summary["blocked"] > 0 else "pass"
    categorized_results = [
        result
        if result.blocker_dependency != "not_blocked"
        else GateResult(
            name=result.name,
            status=result.status,
            evidence=result.evidence,
            subsystem=result.subsystem,
            tier=result.tier,
            script=result.script,
            args=result.args,
            module=result.module,
            blocker_dependency=classify_blocker_dependency(result),
        )
        for result in results
    ]
    blocker_dependency_counts: dict[BlockerDependency, int] = {
        "repo_artifact_generation": 0,
        "live_device_validation": 0,
        "actionable_external_dependency": 0,
    }
    blocker_groups: dict[BlockerDependency, list[dict[str, str]]] = {
        "repo_artifact_generation": [],
        "live_device_validation": [],
        "actionable_external_dependency": [],
    }
    blocker_action_plan: dict[BlockerDependency, list[dict[str, str]]] = {
        "repo_artifact_generation": [],
        "live_device_validation": [],
        "actionable_external_dependency": [],
    }
    for result in categorized_results:
        dependency = result.blocker_dependency
        if result.status != "BLOCKED" or dependency == "not_blocked":
            continue
        blocker_dependency_counts[dependency] += 1
        blocker_groups[dependency].append(
            {
                "name": result.name,
                "subsystem": result.subsystem,
                "tier": result.tier,
                "evidence": result.evidence,
                "script": result.script,
            }
        )
        blocker_action_plan[dependency].append(blocker_action(result))
    release_blocker = summary["fail"] > 0
    effective_release_blocker = release_blocker or summary["blocked"] > 0
    phase_plan = blocker_phase_plan(categorized_results)
    blockers = structured_blockers(categorized_results)
    return {
        "schema": SCHEMA,
        "generated_utc": datetime.now(UTC).isoformat(),
        "as_of": date.today().isoformat(),
        "status": status,
        "gates": [asdict(result) for result in categorized_results],
        "results": [asdict(result) for result in categorized_results],
        "blockers": blockers,
        "summary": summary,
        "blocker_dependency_counts": blocker_dependency_counts,
        "blocker_groups": blocker_groups,
        "blocker_action_plan": blocker_action_plan,
        "blocker_phase_plan": phase_plan,
        "next_release_action": next_release_action(phase_plan),
        "next_runtime_capture_action": runtime_next_capture_action(),
        "release_blocker": release_blocker,
        "effective_release_blocker": effective_release_blocker,
        "claim_boundary": CLAIM_BOUNDARY,
    }


def write_report(report: dict[str, object], report_path: Path | None = None) -> None:
    if report_path is None:
        report_path = REPORT_PATH
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(provenance_safe(report), indent=2, sort_keys=True) + "\n")


def print_summary(report: dict[str, object], strict: bool, report_path: Path | None = None) -> None:
    if report_path is None:
        report_path = REPORT_PATH
    gates = report["gates"]
    assert isinstance(gates, list)
    summary = report["summary"]
    assert isinstance(summary, dict)
    name_width = max((len(str(gate["name"])) for gate in gates), default=20)
    sub_width = max((len(str(gate["subsystem"])) for gate in gates), default=8)
    tier_width = max((len(str(gate["tier"])) for gate in gates), default=4)
    header = (
        f"{'STATUS':<8} {'SUBSYSTEM':<{sub_width}} {'TIER':<{tier_width}} "
        f"{'NAME':<{name_width}} EVIDENCE"
    )
    print(header)
    print("-" * len(header))
    for gate in gates:
        print(
            f"{gate['status']:<8} {gate['subsystem']:<{sub_width}} "
            f"{gate['tier']:<{tier_width}} {gate['name']:<{name_width}} "
            f"{gate['evidence']}"
        )
    print("-" * len(header))
    print(
        f"summary: PASS={summary['pass']} FAIL={summary['fail']} "
        f"BLOCKED={summary['blocked']}  release_blocker={report['release_blocker']}  "
        f"effective_release_blocker={report['effective_release_blocker']}  "
        f"strict={strict}"
    )
    try:
        printable_report_path = report_path.relative_to(ROOT)
    except ValueError:
        printable_report_path = report_path
    print(f"report: {printable_report_path}")
    print(f"claim_boundary: {report['claim_boundary']}")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Aggregate every fail-closed tapeout-readiness gate into "
            "build/reports/tapeout-readiness.json"
        )
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help=(
            "Treat BLOCKED as a release blocker as well. Used by `make tapeout-readiness-strict`."
        ),
    )
    parser.add_argument(
        "--json-only",
        action="store_true",
        help="Suppress the human summary table; only emit the JSON path.",
    )
    parser.add_argument(
        "--report",
        default=str(REPORT_PATH),
        help=f"Write aggregate report to this path (default: {REPORT_PATH.relative_to(ROOT)})",
    )
    parser.add_argument(
        "--scope",
        choices=("all", "chip", "phone"),
        default="all",
        help="Gate scope to aggregate. Default all keeps the combined chip + phone objective visible.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    report_path = Path(args.report)
    gates = select_gates(args.scope)
    results = [run_gate(spec) for spec in gates]
    report = build_report(results)
    report["scope"] = args.scope
    write_report(report, report_path)
    if args.json_only:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print_summary(report, strict=args.strict, report_path=report_path)
    if args.strict:
        if report["summary"]["fail"] > 0 or report["summary"]["blocked"] > 0:  # type: ignore[index]
            return 1
        return 0
    if report["release_blocker"]:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
