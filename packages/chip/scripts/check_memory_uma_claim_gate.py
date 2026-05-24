#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any, cast

import yaml

ROOT = Path(__file__).resolve().parents[1]
GATE = ROOT / "docs/evidence/memory/uma-dram-evidence-gate.yaml"
MEMORY = ROOT / "docs/arch/memory-subsystem.md"
INTERCONNECT = ROOT / "docs/arch/interconnect.md"
MEMORY_MAP = ROOT / "docs/arch/memory-map.md"
DRAM_RTL = ROOT / "rtl/memory/e1_axi_lite_dram.sv"
CONTRACT_RTL = ROOT / "rtl/interconnect/e1_linux_soc_contract.sv"
CONTRACT_TEST = ROOT / "verify/cocotb/test_cpu_mem_intc_contract.py"
GENERATED_MEMMAP = (
    ROOT
    / "build/chipyard/eliza_rocket/generated-src/chipyard.harness.TestHarness.ElizaRocketConfig.memmap.json"
)
GENERATED_DTS = (
    ROOT
    / "build/chipyard/eliza_rocket/generated-src/chipyard.harness.TestHarness.ElizaRocketConfig.dts"
)
GENERATED_VERILOG = ROOT / "build/chipyard/eliza_rocket/eliza_rocket_ap.v"
GENERATED_FIR = (
    ROOT
    / "build/chipyard/eliza_rocket/generated-src/chipyard.harness.TestHarness.ElizaRocketConfig.fir"
)
GENERATED_SIMULATOR = ROOT / "build/chipyard/eliza_rocket/simulator/simulator"
PERFORMANCE_TEMPLATE = (
    ROOT / "docs/evidence/memory/templates/bandwidth-latency-contended-access.template.json"
)
DRAM_CONTROLLER_REPORT = ROOT / "build/reports/dram_controller.json"

REQUIRED_BLOCKED = {
    "reset_rom_boot_memory_handoff",
    "real_dram_controller_phy",
    "cache_hierarchy_latency",
    "axi_tl_interconnect_contract",
    "cacheability_noncoherent_dma_policy",
    "uma_cache_coherency",
    "android_shared_buffer_uma",
    "iommu_smmu_dma_isolation",
    "memory_qos_bandwidth",
    "phone_2028_bandwidth_latency",
    "linux_interrupt_access_map",
}

REQUIRED_EVIDENCE_BY_CLAIM = {
    "reset_rom_boot_memory_handoff": {
        "docs/evidence/memory/reset_rom_boot_sram_handoff_report.json",
        "docs/evidence/memory/opensbi_dram_handoff_transcript.json",
    },
    "real_dram_controller_phy": {
        "docs/evidence/memory/real_dram_controller_phy_report.json",
        "docs/evidence/memory/dram_training_timing_report.json",
    },
    "cache_hierarchy_latency": {
        "docs/evidence/memory/cache_hierarchy_report.json",
        "docs/evidence/memory/cache_latency_counter_report.json",
    },
    "axi_tl_interconnect_contract": {
        "docs/evidence/memory/axi_tl_interconnect_contract_report.json",
        "docs/evidence/memory/fabric_bridge_ordering_report.json",
    },
    "cacheability_noncoherent_dma_policy": {
        "docs/evidence/memory/cacheability_attribute_map_report.json",
        "docs/evidence/memory/noncoherent_dma_sync_abi_report.json",
    },
    "uma_cache_coherency": {
        "docs/evidence/memory/uma_coherency_report.json",
        "docs/evidence/memory/shared_buffer_negative_sync_report.json",
    },
    "android_shared_buffer_uma": {
        "docs/evidence/memory/android_dma_buf_coherency_report.json",
        "docs/evidence/memory/android_shared_buffer_fence_report.json",
    },
    "iommu_smmu_dma_isolation": {
        "docs/evidence/memory/iommu_fault_injection_report.json",
        "docs/evidence/memory/dma_isolation_fault_visibility_report.json",
    },
    "memory_qos_bandwidth": {
        "docs/evidence/memory/memory_qos_report.json",
        "docs/evidence/memory/contended_bandwidth_latency_report.json",
    },
    "phone_2028_bandwidth_latency": {
        "docs/evidence/memory/phone_2028_memory_scorecard.json",
        "docs/evidence/memory/lpddr_bandwidth_latency_benchmark_report.json",
        "docs/evidence/memory/contended_android_memory_trace.json",
    },
    "linux_interrupt_access_map": {
        "docs/evidence/memory/linux_interrupt_access_map_report.json",
        "docs/evidence/memory/clint_plic_dma_exclusion_report.json",
    },
}

REQUIRED_ARTIFACT_SCHEMAS = {
    "docs/evidence/memory/reset_rom_boot_sram_handoff_report.json": "eliza.memory.reset_rom_boot_sram_handoff.v1",
    "docs/evidence/memory/opensbi_dram_handoff_transcript.json": "eliza.memory.opensbi_dram_handoff.v1",
    "docs/evidence/memory/real_dram_controller_phy_report.json": "eliza.memory.real_dram_controller_phy.v1",
    "docs/evidence/memory/dram_training_timing_report.json": "eliza.memory.dram_training_timing.v1",
    "docs/evidence/memory/cache_hierarchy_report.json": "eliza.memory.cache_hierarchy.v1",
    "docs/evidence/memory/cache_latency_counter_report.json": "eliza.memory.cache_latency_counter.v1",
    "docs/evidence/memory/axi_tl_interconnect_contract_report.json": "eliza.memory.axi_tl_interconnect_contract.v1",
    "docs/evidence/memory/fabric_bridge_ordering_report.json": "eliza.memory.fabric_bridge_ordering.v1",
    "docs/evidence/memory/cacheability_attribute_map_report.json": "eliza.memory.cacheability_attribute_map.v1",
    "docs/evidence/memory/noncoherent_dma_sync_abi_report.json": "eliza.memory.noncoherent_dma_sync_abi.v1",
    "docs/evidence/memory/uma_coherency_report.json": "eliza.memory.uma_coherency.v1",
    "docs/evidence/memory/shared_buffer_negative_sync_report.json": "eliza.memory.shared_buffer_negative_sync.v1",
    "docs/evidence/memory/android_dma_buf_coherency_report.json": "eliza.memory.android_dma_buf_coherency.v1",
    "docs/evidence/memory/android_shared_buffer_fence_report.json": "eliza.memory.android_shared_buffer_fence.v1",
    "docs/evidence/memory/iommu_fault_injection_report.json": "eliza.memory.iommu_fault_injection.v1",
    "docs/evidence/memory/dma_isolation_fault_visibility_report.json": "eliza.memory.dma_isolation_fault_visibility.v1",
    "docs/evidence/memory/memory_qos_report.json": "eliza.memory.qos.v1",
    "docs/evidence/memory/contended_bandwidth_latency_report.json": "eliza.memory.contended_bandwidth_latency.v1",
    "docs/evidence/memory/phone_2028_memory_scorecard.json": "eliza.memory.phone_2028_scorecard.v1",
    "docs/evidence/memory/lpddr_bandwidth_latency_benchmark_report.json": "eliza.memory.lpddr_bandwidth_latency_benchmark.v1",
    "docs/evidence/memory/contended_android_memory_trace.json": "eliza.memory.contended_android_trace.v1",
    "docs/evidence/memory/linux_interrupt_access_map_report.json": "eliza.memory.linux_interrupt_access_map.v1",
    "docs/evidence/memory/clint_plic_dma_exclusion_report.json": "eliza.memory.clint_plic_dma_exclusion.v1",
}

REQUIRED_TARGET_DELTAS = {
    "reset_rom_boot_sram_handoff": "reset_rom_boot_memory_handoff",
    "dram_controller_phy": "real_dram_controller_phy",
    "axi_tl_system_fabric": "axi_tl_interconnect_contract",
    "fabric_width_and_outstanding": "memory_qos_bandwidth",
    "cacheability_noncoherent_dma_policy": "cacheability_noncoherent_dma_policy",
    "uma_coherency": "uma_cache_coherency",
    "dma_isolation": "iommu_smmu_dma_isolation",
    "qos_bandwidth_latency": "memory_qos_bandwidth",
    "clint_plic_access_map": "linux_interrupt_access_map",
}

REQUIRED_ROADMAP_PHASES = {
    "phase0_sram_dma_containment": "current_scaffold",
    "phase1_capacity_and_counters": "blocked",
    "phase2_burst_fabric_model": "blocked",
    "phase3_cache_uma_policy": "blocked",
    "phase4_iommu_faults": "blocked",
    "phase5_lpddr_phone_target": "blocked",
}

REQUIRED_BANDWIDTH_LATENCY_FIELDS = {
    "schema",
    "evidence_class",
    "target",
    "target.target_id",
    "target.target_kind",
    "target.is_host",
    "target.is_simulator",
    "target.capture_utc",
    "process_corners",
    "process_corners.process_effects_contract",
    "process_corners.process_effects_contract.path",
    "process_corners.process_effects_contract.sha256",
    "process_corners.process_corner_count",
    "process_corners.worst_process_corner",
    "process_corners.pdk_signoff_claim",
    "memory_config",
    "memory_config.memory_type",
    "memory_config.capacity_gib",
    "runtime_state",
    "benchmark_commands",
    "raw_artifacts",
    "contention_workload",
    "parsed_metrics",
    "pass_fail_against_phone_2028_target_profile",
}

REQUIRED_BANDWIDTH_LATENCY_METRICS = {
    "peak_bandwidth_gbps",
    "sustained_bandwidth_gbps",
    "p95_random_read_latency_ns",
    "contended_cpu_latency_ns",
    "display_underflow_count",
    "dma_copy_bandwidth_gbps",
    "worst_process_corner_sustained_bandwidth_gbps",
    "worst_process_corner_p95_random_read_latency_ns",
}

REQUIRED_BANDWIDTH_LATENCY_ARTIFACTS = {
    "docs/evidence/memory/lpddr_bandwidth_latency_benchmark_report.json",
    "docs/evidence/memory/contended_bandwidth_latency_report.json",
    "docs/evidence/memory/contended_android_memory_trace.json",
    "docs/evidence/memory/phone_2028_memory_scorecard.json",
}

REQUIRED_PHASE_TRANSITIONS = [
    ("phase0_sram_dma_containment", "phase1_capacity_and_counters"),
    ("phase1_capacity_and_counters", "phase2_burst_fabric_model"),
    ("phase2_burst_fabric_model", "phase3_cache_uma_policy"),
    ("phase3_cache_uma_policy", "phase4_iommu_faults"),
    ("phase4_iommu_faults", "phase5_lpddr_phone_target"),
]

ROADMAP_PHASE_REQUIRED_TERMS = {
    "phase0_sram_dma_containment": ("4 KiB", "SRAM-backed", "DMA containment"),
    "phase1_capacity_and_counters": ("capacity", "per-master", "counters"),
    "phase2_burst_fabric_model": ("Burst", "outstanding", "ordering"),
    "phase3_cache_uma_policy": ("Coherent", "cache-maintenance", "shared-buffer"),
    "phase4_iommu_faults": ("IOMMU/SMMU", "per-device", "faults"),
    "phase5_lpddr_phone_target": ("LPDDR5X/LPDDR6", "QoS", "bandwidth/latency"),
}

TARGET_DELTA_REQUIRED_TERMS = {
    "reset_rom_boot_sram_handoff": ("identity ROM", "boot SRAM", "DRAM initialization", "OpenSBI"),
    "dram_controller_phy": ("AXI-Lite SRAM", "LPDDR", "training", "refresh"),
    "axi_tl_system_fabric": ("AXI-Lite", "AXI4", "TileLink", "ordering domains"),
    "fabric_width_and_outstanding": ("Single-beat AXI-Lite", "bursts", "outstanding", "per-master"),
    "cacheability_noncoherent_dma_policy": (
        "cacheability attributes",
        "non-coherent",
        "cache-maintenance ABI",
    ),
    "uma_coherency": ("No caches", "Coherent interconnect", "DMA ownership"),
    "dma_isolation": ("address response", "IOMMU/SMMU", "fault status"),
    "qos_bandwidth_latency": ("CPU-wins", "QoS", "bandwidth counters", "underflow"),
    "clint_plic_access_map": ("CLINT/ACLINT", "PLIC/IMSIC", "DMA exclusion", "device-tree"),
}

REQUIRED_DOC_TOKENS = {
    MEMORY: [
        "SRAM-backed",
        "reset ROM",
        "boot SRAM",
        "external DRAM controller and PHY",
        "Phone-class 2028 target",
        "LPDDR5X/LPDDR6",
        "bandwidth and latency",
        "cache hierarchy",
        "cacheability",
        "non-coherent",
        "real integration",
        "phone-class IOMMU/SMMU integration",
        "UMA coherency protocol",
        "IOMMU/SMMU translation",
        "memory QoS",
        "Linux and Android readiness blockers",
        "Page fault reporting",
        "CLINT/PLIC dependencies",
        "must not be used as release evidence",
        "Generated AP memory audit",
        "memory@80000000",
        "0x80000000",
        "256 MiB",
        "SimDRAM",
        "not boot evidence",
        "process effects contract",
        "process corner count",
        "worst process corner",
        "14A derated bandwidth/latency metrics",
        "make memory-uma-claim-gate",
        "make cocotb-contract",
    ],
    INTERCONNECT: [
        "not an IOMMU",
        "SRAM-backed DRAM model",
        "not a cache-coherent fabric",
        "not a QoS arbiter",
        "AXI4",
        "TileLink",
        "cacheability",
        "non-coherent",
        "Production fabric gates",
        "page fault reporting",
        "CLINT/PLIC access map",
        "remain blocked",
    ],
    MEMORY_MAP: [
        "SRAM-backed",
        "reset ROM",
        "boot SRAM",
        "4 KiB",
        "256 MiB",
        "not an IOMMU or coherency implementation",
        "Linux access-map dependencies",
        "CLINT/ACLINT",
        "PLIC/IMSIC",
        "page fault reporting",
    ],
}

FORBIDDEN_POSITIVE_CLAIMS = [
    r"\breal\s+DRAM\s+(?:controller|PHY)\s+(?:is\s+)?(?:implemented|validated|proven)\b",
    r"\bUMA\s+coherency\s+(?:is\s+)?(?:implemented|validated|proven)\b",
    r"\b(?:IOMMU|SMMU)\s+(?:is\s+)?(?:implemented|validated|proven|enabled)\b",
    r"\bmemory\s+QoS\s+(?:is\s+)?(?:implemented|validated|proven|enabled)\b",
    r"\bcoherent\s+DMA\s+(?:is\s+)?(?:implemented|validated|proven|enabled)\b",
    r"\bLPDDR(?:5X|6)[-\s]class\s+(?:is\s+)?(?:implemented|validated|proven|enabled)\b",
]


def read(path: Path) -> str:
    return path.read_text(errors="ignore")


def require(condition: bool, message: str, errors: list[str]) -> None:
    if not condition:
        errors.append(message)


def valid_relative_path(value: object) -> bool:
    if not isinstance(value, str) or not value:
        return False
    path = Path(value)
    return not path.is_absolute() and ".." not in path.parts


def load_json_report(path: Path, errors: list[str]) -> dict | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        errors.append(f"missing report: {path.relative_to(ROOT)}")
        return None
    except json.JSONDecodeError as exc:
        errors.append(f"{path.relative_to(ROOT)} is not valid JSON: {exc}")
        return None
    if not isinstance(data, dict):
        errors.append(f"{path.relative_to(ROOT)} must be a JSON object")
        return None
    return data


def duplicate_top_level_keys(path: Path) -> list[str]:
    seen: set[str] = set()
    duplicates: list[str] = []
    for line in path.read_text(errors="ignore").splitlines():
        if not line or line.startswith((" ", "#")):
            continue
        match = re.match(r"^([A-Za-z0-9_./-]+):", line)
        if not match:
            continue
        key = match.group(1)
        if key in seen and key not in duplicates:
            duplicates.append(key)
        seen.add(key)
    return duplicates


def check_gate(errors: list[str]) -> None:
    if not GATE.is_file():
        errors.append(f"missing {GATE.relative_to(ROOT)}")
        return

    duplicates = duplicate_top_level_keys(GATE)
    require(
        not duplicates,
        "memory/UMA gate has duplicate top-level keys: " + ", ".join(duplicates),
        errors,
    )

    data = yaml.safe_load(GATE.read_text())
    if not isinstance(data, dict):
        errors.append(f"{GATE.relative_to(ROOT)} must be a YAML mapping")
        return

    require(
        data.get("schema") == "eliza.memory_uma_evidence_gate.v1",
        "memory/UMA gate schema drifted",
        errors,
    )
    require(
        data.get("status") == "scaffold_only_real_claims_blocked",
        "memory/UMA gate must stay scaffold_only_real_claims_blocked",
        errors,
    )

    scaffold = data.get("current_scaffold_evidence")
    require(isinstance(scaffold, dict), "memory/UMA gate missing current_scaffold_evidence", errors)
    if isinstance(scaffold, dict):
        require(
            scaffold.get("claim_level") == "local_scaffold_only",
            "scaffold claim level must be local_scaffold_only",
            errors,
        )
        checks = scaffold.get("executable_checks")
        require(
            isinstance(checks, list) and bool(checks),
            "scaffold evidence must list executable checks",
            errors,
        )
        commands = {item.get("command") for item in checks or [] if isinstance(item, dict)}
        require(
            "make memory-uma-claim-gate" in commands,
            "gate must list make memory-uma-claim-gate",
            errors,
        )
        require(
            "make cocotb-contract" in commands,
            "gate must list cocotb contract simulation as executable evidence",
            errors,
        )

    deltas = data.get("target_2028_phone_uma_spec_deltas")
    require(
        isinstance(deltas, list) and len(deltas) >= len(REQUIRED_TARGET_DELTAS),
        "memory/UMA gate must list target_2028_phone_uma_spec_deltas",
        errors,
    )
    delta_by_id = {item.get("id"): item for item in deltas or [] if isinstance(item, dict)}
    missing_deltas = sorted(set(REQUIRED_TARGET_DELTAS) - set(delta_by_id))
    require(
        not missing_deltas,
        "memory/UMA gate missing target spec deltas: " + ", ".join(missing_deltas),
        errors,
    )
    for delta_id, gate_id in REQUIRED_TARGET_DELTAS.items():
        delta = delta_by_id.get(delta_id)
        if not isinstance(delta, dict):
            continue
        require(
            delta.get("evidence_gate") == gate_id,
            f"{delta_id} must map to evidence gate {gate_id}",
            errors,
        )
        current = delta.get("current")
        target = delta.get("target")
        require(
            isinstance(current, str) and bool(current),
            f"{delta_id} missing current spec delta",
            errors,
        )
        require(
            isinstance(target, str) and bool(target),
            f"{delta_id} missing target spec delta",
            errors,
        )
        combined_delta = f"{current}\n{target}"
        for term in TARGET_DELTA_REQUIRED_TERMS[delta_id]:
            require(term in combined_delta, f"{delta_id} spec delta missing term: {term}", errors)

    non_goals = "\n".join(data.get("non_goals") or [])
    for token in (
        "Phone-class DRAM controller integration",
        "Cache hierarchy",
        "UMA cache coherency",
        "IOMMU/SMMU translation",
        "Memory QoS",
    ):
        require(token in non_goals, f"memory/UMA gate non_goals missing token: {token}", errors)

    target = data.get("phone_2028_target_profile")
    require(isinstance(target, dict), "memory/UMA gate missing phone_2028_target_profile", errors)
    if isinstance(target, dict):
        require(
            target.get("target_class") == "performance_heavy_android_phone_ap",
            "phone_2028_target_profile target_class drifted",
            errors,
        )
        require(
            target.get("claim_level_required") == "L6_COMPLETE_PHONE",
            "phone 2028 memory claims must require L6_COMPLETE_PHONE",
            errors,
        )
        external = target.get("external_memory")
        require(
            isinstance(external, dict), "phone_2028_target_profile missing external_memory", errors
        )
        if isinstance(external, dict):
            acceptable = set(external.get("acceptable_types") or [])
            require(
                {"LPDDR5X", "LPDDR6"} <= acceptable, "phone target must list LPDDR5X/LPDDR6", errors
            )
            require(
                isinstance(external.get("capacity_gib_min"), int)
                and external["capacity_gib_min"] >= 12,
                "phone target capacity must be at least 12 GiB",
                errors,
            )
            require(
                isinstance(external.get("peak_bandwidth_gbps_min"), int)
                and external["peak_bandwidth_gbps_min"] >= 180,
                "phone target peak bandwidth must be at least 180 GB/s",
                errors,
            )
            require(
                isinstance(external.get("sustained_bandwidth_gbps_min"), int)
                and external["sustained_bandwidth_gbps_min"] >= 120,
                "phone target sustained bandwidth must be at least 120 GB/s",
                errors,
            )
            require(
                isinstance(external.get("p95_random_read_latency_ns_max"), int)
                and external["p95_random_read_latency_ns_max"] <= 120,
                "phone target p95 random-read latency must be at most 120 ns",
                errors,
            )
        cache = target.get("cache_and_sram")
        require(isinstance(cache, dict), "phone_2028_target_profile missing cache_and_sram", errors)
        if isinstance(cache, dict):
            require(
                isinstance(cache.get("shared_system_cache_mib_min"), int)
                and cache["shared_system_cache_mib_min"] >= 32,
                "phone target shared system cache must be at least 32 MiB",
                errors,
            )
            require(
                cache.get("cpu_cache_hierarchy_required") is True,
                "phone target must require CPU cache hierarchy",
                errors,
            )
            require(
                cache.get("coherent_last_level_cache_required") is True,
                "phone target must require coherent last-level cache",
                errors,
            )
        clients = set(target.get("clients", {}).get("required_contenders") or [])
        require(
            {"CPU", "DMA", "NPU", "display", "camera_or_isp", "GPU_or_2D"} <= clients,
            "phone target missing required memory contention clients",
            errors,
        )
        protection = target.get("protection")
        require(
            isinstance(protection, dict), "phone_2028_target_profile missing protection", errors
        )
        if isinstance(protection, dict):
            for key in (
                "iommu_or_smmu_required",
                "per_device_dma_domains_required",
                "kernel_visible_faults_required",
            ):
                require(
                    protection.get(key) is True, f"phone target protection missing {key}", errors
                )
        validation = target.get("validation")
        require(
            isinstance(validation, dict), "phone_2028_target_profile missing validation", errors
        )
        if isinstance(validation, dict):
            for key in (
                "requires_real_target_not_host",
                "requires_measured_bandwidth_latency",
                "requires_contended_workloads",
                "requires_thermal_state_and_clocks",
                "requires_android_shared_buffer_tests",
                "requires_clint_plic_access_map",
                "requires_page_fault_reporting_fields",
            ):
                require(
                    validation.get(key) is True, f"phone target validation missing {key}", errors
                )

    actual = data.get("linux_scaffold_current_capability")
    require(
        isinstance(actual, dict),
        "memory/UMA gate missing linux_scaffold_current_capability",
        errors,
    )
    if isinstance(actual, dict):
        for key in (
            "reset_rom",
            "boot_sram",
            "dram_init_or_training",
            "axi4_or_tilelink_fabric",
            "cacheability_attributes",
            "noncoherent_dma_cache_sync_abi",
        ):
            require(
                actual.get(key)
                in {"none", "contract_identity_rom_and_separate_minimal_rv64_scaffold_only"},
                f"linux_scaffold_current_capability must explicitly block {key}",
                errors,
            )
        require(
            actual.get("usable_rtl_capacity_bytes") == 4096,
            "actual RTL capacity must stay explicit at 4096 bytes until real memory exists",
            errors,
        )
        for key in (
            "cache_hierarchy",
            "coherency",
            "iommu_or_smmu",
            "coherent_dma",
            "page_fault_reporting",
            "memory_qos",
            "dram_phy",
        ):
            require(
                actual.get(key) == "none",
                f"linux_scaffold_current_capability must state {key}: none",
                errors,
            )
        require(
            actual.get("clint_plic_access_map") == "incomplete",
            "linux_scaffold_current_capability must state clint_plic_access_map: incomplete",
            errors,
        )

    local_rtl = data.get("separate_local_rtl_evidence")
    require(
        isinstance(local_rtl, dict), "memory/UMA gate missing separate_local_rtl_evidence", errors
    )
    if isinstance(local_rtl, dict):
        dram = local_rtl.get("dram_controller_boundary")
        require(
            isinstance(dram, dict),
            "separate_local_rtl_evidence missing dram_controller_boundary",
            errors,
        )
        if isinstance(dram, dict):
            require(
                dram.get("gate") == "make dram-controller-check",
                "DRAM local RTL evidence gate drifted",
                errors,
            )
            require(
                dram.get("report") == "build/reports/dram_controller.json",
                "DRAM local RTL evidence report path drifted",
                errors,
            )
            require(
                "not LPDDR PHY/training" in str(dram.get("claim_boundary")),
                "DRAM local RTL evidence must not claim LPDDR PHY/training",
                errors,
            )
            report = load_json_report(DRAM_CONTROLLER_REPORT, errors)
            if report is not None:
                require(
                    report.get("schema") == "eliza.gate_status.v1",
                    "dram_controller.json schema drifted",
                    errors,
                )
                require(
                    report.get("gate") == "dram-controller-check",
                    "dram_controller.json gate drifted",
                    errors,
                )
                require(report.get("status") == "PASS", "dram_controller.json must be PASS", errors)
                require(
                    report.get("subsystem") == "memory",
                    "dram_controller.json subsystem must be memory",
                    errors,
                )
                require(
                    report.get("phone_claim_allowed") is False,
                    "dram_controller.json must not allow phone claims",
                    errors,
                )
                require(
                    report.get("release_claim_allowed") is False,
                    "dram_controller.json must not allow release claims",
                    errors,
                )
                require(
                    "not phone" in str(report.get("claim_boundary", "")).lower()
                    and "lpddr" in str(report.get("claim_boundary", "")).lower(),
                    "dram_controller.json claim boundary must exclude phone/LPDDR evidence",
                    errors,
                )
                evidence_paths = report.get("evidence_paths")
                require(
                    isinstance(evidence_paths, list),
                    "dram_controller.json must list evidence_paths",
                    errors,
                )
                if isinstance(evidence_paths, list):
                    for rel_path in (
                        "rtl/memory/dram_ctrl/e1_dram_ctrl.sv",
                        "verify/cocotb/memory/test_dram_memory.py",
                    ):
                        require(
                            rel_path in evidence_paths,
                            f"dram_controller.json missing evidence path {rel_path}",
                            errors,
                        )
                    for rel_path in evidence_paths:
                        if isinstance(rel_path, str):
                            require(
                                (ROOT / rel_path).exists(),
                                f"dram_controller.json evidence path missing on disk: {rel_path}",
                                errors,
                            )
                detail = report.get("detail")
                cocotb_result = detail.get("cocotb_result") if isinstance(detail, dict) else None
                if isinstance(cocotb_result, str) and cocotb_result:
                    result_path = ROOT / cocotb_result
                    require(
                        result_path.is_file(),
                        f"dram controller cocotb result missing: {cocotb_result}",
                        errors,
                    )
                    if result_path.is_file():
                        root = ET.parse(result_path).getroot()
                        failures = int(root.attrib.get("failures", "0") or 0)
                        errors_count = int(root.attrib.get("errors", "0") or 0)
                        skipped = int(root.attrib.get("skipped", "0") or 0)
                        tests = {tc.attrib.get("name") for tc in root.iter("testcase")}
                        required_tests = report.get("required_tests")
                        if isinstance(required_tests, list):
                            missing = sorted(
                                str(test) for test in required_tests if test not in tests
                            )
                            require(
                                not missing,
                                "dram controller cocotb result missing tests: "
                                + ", ".join(missing),
                                errors,
                            )
                        require(
                            failures == 0 and errors_count == 0 and skipped == 0,
                            "dram controller cocotb result must have zero failures/errors/skips",
                            errors,
                        )
                else:
                    errors.append("dram_controller.json detail.cocotb_result missing")
        iommu = local_rtl.get("iommu_boundary")
        require(
            isinstance(iommu, dict), "separate_local_rtl_evidence missing iommu_boundary", errors
        )
        if isinstance(iommu, dict):
            require(
                iommu.get("gate") == "make iommu-evidence-check",
                "IOMMU local RTL evidence gate drifted",
                errors,
            )
            require(
                "not non-identity G-stage" in str(iommu.get("claim_boundary")),
                "IOMMU local RTL evidence must not claim non-identity G-stage/PDT/Linux",
                errors,
            )
        scaffold = cast("dict[str, Any]", actual)
        require(
            scaffold.get("measured_bandwidth_gbps") is None
            and scaffold.get("measured_latency_ns") is None,
            "current scaffold must not record phone bandwidth/latency measurements",
            errors,
        )
        require(
            scaffold.get("phone_class_status") == "blocked",
            "current phone-class memory status must remain blocked",
            errors,
        )

    phases = data.get("memory_roadmap_phases")
    require(isinstance(phases, list), "memory/UMA gate must list memory_roadmap_phases", errors)
    phase_by_id = {item.get("id"): item for item in phases or [] if isinstance(item, dict)}
    missing_phases = sorted(set(REQUIRED_ROADMAP_PHASES) - set(phase_by_id))
    require(
        not missing_phases,
        "memory roadmap missing phases: " + ", ".join(missing_phases),
        errors,
    )
    seen_phase_ids = [item.get("id") for item in phases or [] if isinstance(item, dict)]
    require(
        seen_phase_ids == list(REQUIRED_ROADMAP_PHASES),
        "memory roadmap phases must stay ordered from SRAM scaffold to LPDDR phone target",
        errors,
    )
    for phase_id, status in REQUIRED_ROADMAP_PHASES.items():
        phase = phase_by_id.get(phase_id)
        if not isinstance(phase, dict):
            continue
        require(phase.get("status") == status, f"{phase_id} must have status {status}", errors)
        capability = phase.get("capability")
        require(
            isinstance(capability, str) and bool(capability),
            f"{phase_id} missing capability",
            errors,
        )
        capability_text = capability if isinstance(capability, str) else ""
        gates = phase.get("measurable_gates")
        require(
            isinstance(gates, list) and len(gates) >= 2,
            f"{phase_id} must list at least two measurable_gates",
            errors,
        )
        gate_items = gates if isinstance(gates, list) else []
        exit_artifacts = phase.get("exit_artifacts")
        require(
            isinstance(exit_artifacts, list) and bool(exit_artifacts),
            f"{phase_id} must list exit_artifacts",
            errors,
        )
        exit_artifact_items = exit_artifacts if isinstance(exit_artifacts, list) else []
        combined_phase = (
            capability_text
            + "\n"
            + "\n".join(
                str(gate.get("pass_criteria", "")) for gate in gate_items if isinstance(gate, dict)
            )
        )
        for term in ROADMAP_PHASE_REQUIRED_TERMS[phase_id]:
            require(term in combined_phase, f"{phase_id} missing roadmap term: {term}", errors)
        for gate in gate_items:
            if not isinstance(gate, dict):
                errors.append(f"{phase_id} measurable gate must be a mapping")
                continue
            require(
                isinstance(gate.get("name"), str) and gate["name"],
                f"{phase_id} gate missing name",
                errors,
            )
            require(
                isinstance(gate.get("pass_criteria"), str) and gate["pass_criteria"],
                f"{phase_id} gate {gate.get('name', '<unnamed>')} missing pass_criteria",
                errors,
            )
            if phase_id == "phase0_sram_dma_containment":
                require(
                    isinstance(gate.get("command"), str) and gate["command"],
                    f"{phase_id} gate {gate.get('name', '<unnamed>')} must be command-runnable",
                    errors,
                )
            else:
                artifact = gate.get("artifact")
                require(
                    valid_relative_path(artifact),
                    f"{phase_id} gate {gate.get('name', '<unnamed>')} must list relative artifact",
                    errors,
                )
                if isinstance(artifact, str) and valid_relative_path(artifact):
                    require(
                        not (ROOT / artifact).exists(),
                        f"{phase_id} is blocked but roadmap artifact exists: {artifact}",
                        errors,
                    )
        for artifact in exit_artifact_items:
            require(
                valid_relative_path(artifact),
                f"{phase_id} exit artifact must be relative: {artifact}",
                errors,
            )

    transitions = data.get("phase_transition_rules")
    require(
        isinstance(transitions, list) and len(transitions) == len(REQUIRED_PHASE_TRANSITIONS),
        "memory/UMA gate must list one phase_transition_rules entry per transition",
        errors,
    )
    seen_transitions = [
        (item.get("from"), item.get("to")) for item in transitions or [] if isinstance(item, dict)
    ]
    require(
        seen_transitions == REQUIRED_PHASE_TRANSITIONS,
        "phase_transition_rules must stay ordered and contiguous from phase0 to phase5",
        errors,
    )
    for transition in transitions or []:
        if not isinstance(transition, dict):
            errors.append("phase transition must be a mapping")
            continue
        label = f"{transition.get('from', '<missing>')}->{transition.get('to', '<missing>')}"
        require(
            transition.get("status") == "blocked", f"{label} transition must remain blocked", errors
        )
        artifacts = transition.get("required_exit_artifacts")
        checks = transition.get("required_checks")
        require(
            isinstance(artifacts, list) and len(artifacts) >= 2,
            f"{label} transition must list required_exit_artifacts",
            errors,
        )
        require(
            isinstance(checks, list)
            and len(checks) >= 2
            and all(isinstance(check, str) and check for check in checks),
            f"{label} transition must list required_checks",
            errors,
        )
        for artifact in artifacts or []:
            require(
                valid_relative_path(artifact),
                f"{label} artifact must be relative: {artifact}",
                errors,
            )
            if valid_relative_path(artifact):
                require(
                    not (ROOT / artifact).exists(),
                    f"{label} transition is blocked but required artifact exists: {artifact}",
                    errors,
                )

    blocked = data.get("blocked_real_claims")
    require(isinstance(blocked, list), "memory/UMA gate must list blocked_real_claims", errors)
    blocked_by_id = {item.get("id"): item for item in blocked or [] if isinstance(item, dict)}
    missing = sorted(REQUIRED_BLOCKED - set(blocked_by_id))
    require(not missing, "memory/UMA gate missing blocked claim ids: " + ", ".join(missing), errors)
    for claim_id in sorted(REQUIRED_BLOCKED & set(blocked_by_id)):
        claim = blocked_by_id[claim_id]
        require(claim.get("status") == "blocked", f"{claim_id} must remain blocked", errors)
        require(
            isinstance(claim.get("reason"), str) and claim["reason"],
            f"{claim_id} missing reason",
            errors,
        )
        unblock = claim.get("unblock_requires")
        require(
            isinstance(unblock, list)
            and len(unblock) >= 2
            and all(isinstance(item, str) and item for item in unblock),
            f"{claim_id} must list unblock requirements",
            errors,
        )
        artifacts = claim.get("evidence_artifacts")
        require(
            isinstance(artifacts, list) and len(artifacts) >= 2,
            f"{claim_id} must list evidence_artifacts",
            errors,
        )
        artifact_set = set(artifacts or [])
        missing_artifacts = sorted(REQUIRED_EVIDENCE_BY_CLAIM[claim_id] - artifact_set)
        require(
            not missing_artifacts,
            f"{claim_id} missing required evidence_artifacts: " + ", ".join(missing_artifacts),
            errors,
        )
        for artifact in artifacts or []:
            require(
                valid_relative_path(artifact),
                f"{claim_id} evidence artifact must be a relative repo path: {artifact}",
                errors,
            )
            if valid_relative_path(artifact):
                require(
                    not (ROOT / artifact).exists(),
                    f"{claim_id} is still blocked but evidence artifact exists: {artifact}",
                    errors,
                )

    schemas = data.get("required_artifact_schemas")
    require(
        isinstance(schemas, dict), "memory/UMA gate must list required_artifact_schemas", errors
    )
    if isinstance(schemas, dict):
        for artifact, schema in REQUIRED_ARTIFACT_SCHEMAS.items():
            require(
                schemas.get(artifact) == schema,
                f"required_artifact_schemas missing {artifact}: {schema}",
                errors,
            )
        for artifact in schemas:
            require(
                valid_relative_path(artifact),
                f"required artifact schema key must be a relative repo path: {artifact}",
                errors,
            )
            if valid_relative_path(artifact):
                require(
                    not (ROOT / artifact).exists(),
                    f"artifact schema is for blocked evidence but file exists: {artifact}",
                    errors,
                )

    rules = "\n".join(data.get("claim_rules") or [])
    for token in (
        "must not",
        "Reset ROM",
        "boot SRAM",
        "AXI-Lite",
        "AXI4",
        "TileLink",
        "Non-coherent DMA",
        "cacheability",
        "real DRAM",
        "UMA coherency",
        "IOMMU/SMMU",
        "QoS",
        "executable RTL",
        "Host benchmark",
        "cache-maintenance ABI",
        "CLINT/PLIC access map dependencies",
        "page fault reporting",
    ):
        require(token in rules, f"claim rules missing boundary token: {token}", errors)

    next_commands = data.get("next_commands")
    require(isinstance(next_commands, dict), "memory/UMA gate must list next_commands", errors)
    if isinstance(next_commands, dict):
        for key, command in {
            "local_static_gate": "make memory-uma-claim-gate",
            "memory_evidence_template_check": "python3 scripts/check_memory_evidence_templates.py",
            "rtl_elaboration": "make rtl-check",
            "local_contract_sim": "make cocotb-contract",
            "benchmark_parser_dry_run": "make benchmarks-dry-run",
            "inspect_generated_ap_memory_map": "make chipyard-generated-linux-contract-check",
            "capture_payload_preflight": "make chipyard-linux-payload-check",
            "future_lpddr_evidence_placeholder": "make memory-uma-claim-gate",
        }.items():
            require(
                next_commands.get(key) == command,
                f"next_commands missing {key}: {command}",
                errors,
            )

    check_bandwidth_latency_evidence_contract(data, errors)
    check_performance_template(errors)
    check_generated_ap_memory_audit(data, errors)


def check_performance_template(errors: list[str]) -> None:
    if not PERFORMANCE_TEMPLATE.is_file():
        errors.append(f"missing {PERFORMANCE_TEMPLATE.relative_to(ROOT)}")
        return

    data = json.loads(PERFORMANCE_TEMPLATE.read_text())
    require(isinstance(data, dict), "memory performance template must be a JSON object", errors)
    if not isinstance(data, dict):
        return
    require(
        data.get("schema") == "eliza.memory.bandwidth_latency_contended_access.template.v1",
        "memory performance template schema drifted",
        errors,
    )
    require(
        data.get("template_status") == "template_only_not_evidence",
        "memory performance template must remain template_only_not_evidence",
        errors,
    )
    template_text = PERFORMANCE_TEMPLATE.read_text()
    for token in (
        "__REQUIRED_TARGET_ID__",
        "__REQUIRED_NUMBER__",
        "host_benchmark",
        "simulator_wall_clock",
        "axi_lite_sram_model_cycle_count",
        "generated_memmap_without_target_run",
        "__REQUIRED_14A_CORNER_ID__",
        "docs/spec-db/process-14a-effects.yaml",
        "process_corner_without_contract_hash",
    ):
        require(
            token in template_text, f"memory performance template missing token: {token}", errors
        )


def check_bandwidth_latency_evidence_contract(data: dict, errors: list[str]) -> None:
    contract = data.get("bandwidth_latency_evidence_contract")
    require(
        isinstance(contract, dict),
        "memory/UMA gate missing bandwidth_latency_evidence_contract",
        errors,
    )
    if not isinstance(contract, dict):
        return

    require(
        contract.get("status") == "blocked_until_real_target_measurements",
        "bandwidth/latency evidence contract must stay blocked until real target measurements",
        errors,
    )

    applies_to = set(contract.get("applies_to") or [])
    missing_artifacts = sorted(REQUIRED_BANDWIDTH_LATENCY_ARTIFACTS - applies_to)
    require(
        not missing_artifacts,
        "bandwidth/latency evidence contract missing artifacts: " + ", ".join(missing_artifacts),
        errors,
    )
    for artifact in applies_to:
        require(
            valid_relative_path(artifact),
            f"bandwidth/latency artifact path must be relative: {artifact}",
            errors,
        )
        if valid_relative_path(artifact):
            require(
                not (ROOT / artifact).exists(),
                f"bandwidth/latency evidence is blocked but artifact exists: {artifact}",
                errors,
            )

    fields = set(contract.get("minimum_report_fields") or [])
    missing_fields = sorted(REQUIRED_BANDWIDTH_LATENCY_FIELDS - fields)
    require(
        not missing_fields,
        "bandwidth/latency evidence contract missing report fields: " + ", ".join(missing_fields),
        errors,
    )

    metrics = set(contract.get("required_metrics") or [])
    missing_metrics = sorted(REQUIRED_BANDWIDTH_LATENCY_METRICS - metrics)
    require(
        not missing_metrics,
        "bandwidth/latency evidence contract missing metrics: " + ", ".join(missing_metrics),
        errors,
    )

    invalid = "\n".join(contract.get("invalid_evidence") or [])
    for token in (
        "Host benchmark",
        "Simulator wall-clock",
        "AXI-Lite SRAM model",
        "Generated memmap",
        "Process-corner derates",
    ):
        require(token in invalid, f"bandwidth/latency invalid_evidence missing {token}", errors)


def parse_int_value(value: object) -> int | None:
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value, 0)
        except ValueError:
            return None
    return None


def check_generated_ap_memory_audit(data: dict, errors: list[str]) -> None:
    audit = data.get("generated_ap_memory_audit")
    require(isinstance(audit, dict), "memory/UMA gate missing generated_ap_memory_audit", errors)
    if not isinstance(audit, dict):
        return

    require(
        audit.get("status") == "generated_source_only_not_boot_evidence",
        "generated AP memory audit must remain generated_source_only_not_boot_evidence",
        errors,
    )

    sources = audit.get("sources")
    require(isinstance(sources, dict), "generated AP memory audit missing sources", errors)
    expected_sources = {
        "memmap": GENERATED_MEMMAP,
        "dts": GENERATED_DTS,
        "verilog": GENERATED_VERILOG,
        "fir": GENERATED_FIR,
    }
    if isinstance(sources, dict):
        for key, path in expected_sources.items():
            rel = str(path.relative_to(ROOT))
            require(
                sources.get(key) == rel, f"generated AP source path for {key} must be {rel}", errors
            )

    ram = audit.get("linux_usable_ram")
    require(isinstance(ram, dict), "generated AP memory audit missing linux_usable_ram", errors)
    if isinstance(ram, dict):
        require(
            ram.get("node") == "memory@80000000", "Linux RAM node must be memory@80000000", errors
        )
        require(
            parse_int_value(ram.get("base")) == 0x80000000,
            "Linux RAM base must be 0x80000000",
            errors,
        )
        require(
            parse_int_value(ram.get("size_bytes")) == 0x10000000,
            "Linux RAM size must be 0x10000000",
            errors,
        )
        require(ram.get("size_mib") == 256, "Linux RAM size_mib must be 256", errors)
        require(ram.get("dts_status") == "enabled", "Linux RAM DTS status must be enabled", errors)
        require(
            "0x80000000" in str(ram.get("payload_policy", "")),
            "Linux RAM payload policy must name 0x80000000",
            errors,
        )

    scratch = audit.get("disabled_scratchpad")
    require(
        isinstance(scratch, dict), "generated AP memory audit missing disabled_scratchpad", errors
    )
    if isinstance(scratch, dict):
        require(
            scratch.get("node") == "memory@8000000",
            "scratchpad node must be memory@8000000",
            errors,
        )
        require(
            parse_int_value(scratch.get("base")) == 0x08000000,
            "scratchpad base must be 0x08000000",
            errors,
        )
        require(
            parse_int_value(scratch.get("size_bytes")) == 0x10000,
            "scratchpad size must be 0x10000",
            errors,
        )
        require(
            scratch.get("dts_status") == "disabled",
            "scratchpad DTS status must be disabled",
            errors,
        )

    model = audit.get("verilator_model")
    require(isinstance(model, dict), "generated AP memory audit missing verilator_model", errors)
    if isinstance(model, dict):
        require(
            model.get("module") == "SimDRAM", "Verilator memory model must name SimDRAM", errors
        )
        require(
            parse_int_value(model.get("mem_base")) == 0x80000000,
            "SimDRAM MEM_BASE must be 0x80000000",
            errors,
        )
        require(
            parse_int_value(model.get("mem_size_bytes")) == 0x10000000,
            "SimDRAM MEM_SIZE must be 0x10000000",
            errors,
        )
        require(
            model.get("simulator_executable") == "missing",
            "generated AP simulator executable must remain marked missing until built",
            errors,
        )

    blockers = "\n".join(audit.get("blockers") or [])
    for token in (
        "No generated Verilator simulator executable",
        "No OpenSBI image",
        "No Linux Image/initrd/DTB",
        "No serial transcript",
        "No real DRAM/LPDDR/UMA evidence",
    ):
        require(token in blockers, f"generated AP memory blockers missing token: {token}", errors)

    for path, label in (
        (GENERATED_MEMMAP, "generated memmap"),
        (GENERATED_DTS, "generated DTS"),
        (GENERATED_VERILOG, "generated Verilog"),
        (GENERATED_FIR, "generated FIRRTL"),
    ):
        require(path.is_file(), f"{label} source missing", errors)

    if GENERATED_MEMMAP.is_file():
        memmap = json.loads(GENERATED_MEMMAP.read_text())
        mapping = memmap.get("mapping") if isinstance(memmap, dict) else memmap
        entries = {
            name: entry
            for entry in mapping or []
            if isinstance(entry, dict)
            for name in entry.get("names", [])
        }
        dram = entries.get("memory@80000000")
        require(isinstance(dram, dict), "generated memmap missing memory@80000000", errors)
        if isinstance(dram, dict):
            require(dram.get("base") == [0x80000000], "generated memmap DRAM base drifted", errors)
            require(dram.get("size") == [0x10000000], "generated memmap DRAM size drifted", errors)
            require(dram.get("c") == [True], "generated memmap DRAM must remain cacheable", errors)
        small = entries.get("memory@8000000")
        require(isinstance(small, dict), "generated memmap missing memory@8000000", errors)
        if isinstance(small, dict):
            require(
                small.get("base") == [0x08000000],
                "generated memmap scratchpad base drifted",
                errors,
            )
            require(
                small.get("size") == [0x10000], "generated memmap scratchpad size drifted", errors
            )

    if GENERATED_DTS.is_file():
        dts = read(GENERATED_DTS)
        require("memory@80000000" in dts, "generated DTS missing memory@80000000", errors)
        require("reg = <0x80000000 0x10000000>;" in dts, "generated DTS DRAM reg drifted", errors)
        require("memory@8000000" in dts, "generated DTS missing memory@8000000", errors)
        require("reg = <0x8000000 0x10000>;" in dts, "generated DTS scratchpad reg drifted", errors)
        require(
            'status = "disabled";' in dts, "generated DTS must keep scratchpad disabled", errors
        )

    if GENERATED_VERILOG.is_file():
        verilog = read(GENERATED_VERILOG)
        require("SimDRAM" in verilog, "generated Verilog missing SimDRAM", errors)
        require(
            ".MEM_BASE(40'd2147483648)" in verilog, "generated Verilog SimDRAM base drifted", errors
        )
        require(".MEM_SIZE(268435456)" in verilog, "generated Verilog SimDRAM size drifted", errors)

    if GENERATED_FIR.is_file():
        fir = read(GENERATED_FIR)
        require("extmodule SimDRAM" in fir, "generated FIR missing SimDRAM", errors)
        require(
            "parameter MEM_BASE = 2147483648" in fir, "generated FIR SimDRAM base drifted", errors
        )
        require(
            "parameter MEM_SIZE = 268435456" in fir, "generated FIR SimDRAM size drifted", errors
        )

    require(
        not GENERATED_SIMULATOR.exists(),
        "generated AP simulator exists; update memory audit and require boot transcript evidence",
        errors,
    )


def check_docs(errors: list[str]) -> None:
    for path, tokens in REQUIRED_DOC_TOKENS.items():
        text = read(path)
        for token in tokens:
            require(token in text, f"{path.relative_to(ROOT)} missing token: {token}", errors)

    combined = "\n".join(read(path) for path in (MEMORY, INTERCONNECT, MEMORY_MAP, GATE))
    for pattern in FORBIDDEN_POSITIVE_CLAIMS:
        match = re.search(pattern, combined, flags=re.IGNORECASE)
        require(
            match is None,
            f"unsupported positive memory/UMA claim present: {match.group(0) if match else pattern}",
            errors,
        )


def check_rtl_and_tests(errors: list[str]) -> None:
    dram = read(DRAM_RTL)
    contract = read(CONTRACT_RTL)
    test = read(CONTRACT_TEST)

    require("module e1_axi_lite_dram" in dram, "DRAM scaffold module missing", errors)
    require(
        "logic [31:0] mem [0:DEPTH_WORDS-1]" in dram, "DRAM model must remain SRAM-backed", errors
    )
    require(
        "parameter int unsigned DEPTH_WORDS = 1024" in dram,
        "DRAM model depth changed without gate update",
        errors,
    )
    require("s_axil_bresp <= 2'b10" in dram, "DRAM write error path must return SLVERR", errors)
    require("s_axil_rresp <= 2'b10" in dram, "DRAM read error path must return SLVERR", errors)

    require(
        "grant_dma_wr = !cpu_wr_req && dma_wr_req" in contract,
        "DMA write arbitration contract changed",
        errors,
    )
    require(
        "grant_dma_rd = !cpu_rd_req && dma_rd_req" in contract,
        "DMA read arbitration contract changed",
        errors,
    )
    require(
        "dma_mem_awaddr - 32'h8000_0000" in contract,
        "DMA write path must remain translated into DRAM-local space",
        errors,
    )
    require(
        "dma_mem_araddr - 32'h8000_0000" in contract,
        "DMA read path must remain translated into DRAM-local space",
        errors,
    )

    require(
        "dma_non_dram_targets_fault_without_mmio_side_effects" in test,
        "cocotb contract must include DMA non-DRAM containment test",
        errors,
    )
    require(
        "monitor_cpu_valid_ready_stability" in test,
        "cocotb contract must include reusable CPU AXI-Lite valid/ready stability monitors",
        errors,
    )
    require(
        "monitor_cpu_response_liveness_and_balance" in test,
        "cocotb contract must include response liveness/balance monitors",
        errors,
    )
    require(
        "dram_aperture_outside_sram_model_returns_slverr" in test,
        "cocotb contract must include DRAM aperture capacity boundary test",
        errors,
    )
    require(
        "decode_error_register_captures_last_unmapped_access" in test,
        "cocotb contract must include decode-error observability test",
        errors,
    )
    require(
        "0x0C00_0008" in test and "0x1001_0038" in test,
        "DMA containment test must check MMIO side effects and error count",
        errors,
    )


def main() -> int:
    errors: list[str] = []
    check_gate(errors)
    check_docs(errors)
    check_rtl_and_tests(errors)

    if errors:
        print("Memory/UMA claim gate failed:")
        for error in errors:
            print(f"  - {error}")
        return 1

    data = yaml.safe_load(GATE.read_text())
    print("Memory/UMA claim gate passed.")
    print("  current_rtl_storage: 4096 bytes SRAM-backed AXI-Lite model")
    print("  software_aperture: 0x80000000..0x8fffffff 256 MiB decode aperture")
    print("  implemented_capacity_vs_aperture: 4 KiB implemented, 256 MiB address contract")
    print(
        "  phone_2028_target: "
        f"{data['phone_2028_target_profile']['external_memory']['acceptable_types']} "
        ">=12 GiB, >=120 GB/s sustained, <=120 ns p95 random-read latency"
    )
    print("  real_dram_lpddr_uma_iommu_qos_status: BLOCKED until real target evidence exists")
    return 0


if __name__ == "__main__":
    sys.exit(main())
