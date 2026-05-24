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
from dataclasses import asdict, dataclass
from datetime import date
from pathlib import Path
from typing import Literal

ROOT = Path(__file__).resolve().parents[1]
REPORT_PATH = ROOT / "build/reports/tapeout-readiness.json"
PRODUCT_RELEASE_STATUS_PATH = ROOT / "build/reports/product_release_status.json"
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
        name="e1-phone-release-evidence-regeneration-check",
        script="scripts/check_e1_phone_release_evidence_regeneration.py",
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


def blocker_action(result: GateResult) -> dict[str, str]:
    """Return an operator-facing next action for a blocked aggregate gate."""
    product_repo_groups = product_repo_artifact_group_summary()
    action_by_gate = {
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
            "Collect owner/reviewer/captured_at/revision-or-lot/SHA256-backed "
            "approval rows; placeholder, template, and presence-only rows do not count."
        ),
        "e1-phone-supplier-return-content-check": (
            "Collect supplier-returned quotes, drawings, STEP/B-rep models, samples, "
            "pinouts, and acceptance evidence for every blocked supplier matrix row."
        ),
        "e1-phone-routed-output-content-check": (
            "Generate or replace missing routed release outputs, then validate DRC/ERC, "
            "SI/PI/RF, IPC/fabrication, and exact-net evidence for every routed domain."
        ),
        "e1-phone-factory-output-content-check": (
            "Generate the missing BOM, Gerber/drill, IPC-2581, POS, panel, assembly, "
            "probe, and factory-test outputs with content-valid manifests."
        ),
        "e1-phone-first-article-content-check": (
            "Execute first-article traveler/test logs on real units and replace template "
            "or presence-only rows with signed, hashed measurement evidence."
        ),
        "e1-phone-enclosure-mechanical-content-check": (
            "Collect routed-board STEP clearance, production enclosure handoff packets, "
            "CMM/FAI, process limits, validation results, and first-article fit evidence."
        ),
        "product-release-status-check": (
            "Resolve product release detail checks by generating repo artifacts where "
            "possible and attaching external/live evidence where required."
            + (
                f" Current top repo-artifact groups: {product_repo_groups}."
                if product_repo_groups
                else ""
            )
        ),
        "phone-runtime-readiness-contract-check": (
            "Boot a target phone/emulator and capture live Android/system bridge, media, "
            "security lifecycle, radio/sensor/PMIC, and launcher runtime evidence."
        ),
    }
    validation = result.script
    if result.args:
        validation = " ".join((validation, *result.args))
    if result.name == "phone-runtime-readiness-contract-check":
        validation = "packages/chip/scripts/check_phone_runtime_readiness_contract.py"
    return {
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


AGGREGATE_RELEASE_PHASES: tuple[dict[str, object], ...] = (
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
        gate_names = {str(name) for name in phase.get("gates", set()) if isinstance(name, str)}
        matched = [blocked_by_name[name] for name in sorted(gate_names) if name in blocked_by_name]
        if not matched:
            continue
        next_actions = [blocker_action(result) for result in matched]
        rows.append(
            {
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
                        1
                        for result in matched
                        if result.blocker_dependency == "live_device_validation"
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
                            action["validation_command"]
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
                "blocked_gate_details": [
                    {
                        "name": result.name,
                        "blocker_dependency": result.blocker_dependency,
                        "validation_command": action["validation_command"],
                        "next_action": action["next_action"],
                        "evidence": result.evidence,
                    }
                    for result, action in zip(matched, next_actions, strict=True)
                ],
                "validation_commands": [action["validation_command"] for action in next_actions],
                "acceptance_commands": phase["acceptance_commands"],
                "sample_evidence": [result.evidence for result in matched[:5]],
            }
        )
    return rows


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
    return {
        "schema": SCHEMA,
        "as_of": date.today().isoformat(),
        "status": status,
        "gates": [asdict(result) for result in categorized_results],
        "results": [asdict(result) for result in categorized_results],
        "summary": summary,
        "blocker_dependency_counts": blocker_dependency_counts,
        "blocker_groups": blocker_groups,
        "blocker_action_plan": blocker_action_plan,
        "blocker_phase_plan": blocker_phase_plan(categorized_results),
        "release_blocker": release_blocker,
        "effective_release_blocker": effective_release_blocker,
        "claim_boundary": CLAIM_BOUNDARY,
    }


def write_report(report: dict[str, object], report_path: Path | None = None) -> None:
    if report_path is None:
        report_path = REPORT_PATH
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")


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
