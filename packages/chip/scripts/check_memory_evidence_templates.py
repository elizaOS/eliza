#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, TypedDict, TypeGuard

import yaml

ROOT = Path(__file__).resolve().parents[1]
PROCESS_EFFECTS_CONTRACT_PATH = "docs/spec-db/process-14a-effects.yaml"
TEMPLATE = ROOT / "docs/evidence/memory/templates/bandwidth-latency-contended-access.template.json"
UMA_GATE = ROOT / "docs/evidence/memory/uma-dram-evidence-gate.yaml"
DRAM_SIM_EVIDENCE = ROOT / "docs/evidence/memory/dram_sim_evidence.yaml"

REAL_REPORT_CANDIDATES = (
    ROOT / "docs/evidence/memory/lpddr_bandwidth_latency_benchmark_report.json",
    ROOT / "docs/evidence/memory/contended_bandwidth_latency_report.json",
    ROOT / "docs/evidence/memory/contended_android_memory_trace.json",
    ROOT / "docs/evidence/memory/phone_2028_memory_scorecard.json",
)

PLACEHOLDER_RE = re.compile(r"__[A-Z0-9_]+__")
REQUIRED_METRICS = {
    "peak_bandwidth_gbps",
    "sustained_bandwidth_gbps",
    "p95_random_read_latency_ns",
    "contended_cpu_latency_ns",
    "display_underflow_count",
    "dma_copy_bandwidth_gbps",
    "worst_process_corner_sustained_bandwidth_gbps",
    "worst_process_corner_p95_random_read_latency_ns",
}
REQUIRED_REJECTION_KEYS = {
    "host_benchmark",
    "simulator_wall_clock",
    "axi_lite_sram_model_cycle_count",
    "generated_memmap_without_target_run",
    "process_corner_without_contract_hash",
}
REQUIRED_PASS_FAIL_KEYS = {
    "capacity_gib_min_12",
    "peak_bandwidth_gbps_min_180",
    "sustained_bandwidth_gbps_min_120",
    "p95_random_read_latency_ns_max_120",
    "contended_trace_present",
    "overall",
}
REQUIRED_CONTENDED_CLIENTS = {"CPU", "DMA", "NPU", "display", "camera/ISP", "GPU/2D"}
VALID_PASS_FAIL_VALUES = {"pass", "fail", "downgraded"}
REQUIRED_BLOCKED_MEMORY_CLAIMS = {
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


class DramsimSku(TypedDict):
    standard: str
    capacity_gib: int
    peak_gbps: float


DRAMSIM_SKUS: dict[str, DramsimSku] = {
    "lpddr5x_10667": {
        "standard": "LPDDR5X-10667",
        "capacity_gib": 16,
        "peak_gbps": 85.336,
    },
    "lpddr6_14400": {
        "standard": "LPDDR6-14400",
        "capacity_gib": 24,
        "peak_gbps": 172.8,
    },
}
DRAMSIM_WORKLOADS = {
    "microbench",
    "stream_copy",
    "stream_scale",
    "stream_add",
    "stream_triad",
    "pointer_chase",
}
DRAMSIM_CLAIM_BOUNDARY_TOKENS = ("simulator", "not", "phone")


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def load_yaml(path: Path) -> Any:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def flatten_strings(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        strings: list[str] = []
        for item in value.values():
            strings.extend(flatten_strings(item))
        return strings
    if isinstance(value, list):
        strings = []
        for item in value:
            strings.extend(flatten_strings(item))
        return strings
    return []


def at(data: dict[str, Any], path: tuple[str, ...]) -> Any:
    current: Any = data
    for key in path:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def dotted_at(data: dict[str, Any], path: str) -> Any:
    return at(data, tuple(path.split(".")))


def load_uma_gate_contract() -> tuple[dict[str, str], list[str]]:
    data = load_yaml(UMA_GATE)
    if not isinstance(data, dict):
        return {}, []
    schemas = data.get("required_artifact_schemas")
    schema_map = (
        {
            key: value
            for key, value in schemas.items()
            if isinstance(key, str) and isinstance(value, str)
        }
        if isinstance(schemas, dict)
        else {}
    )
    contract = data.get("bandwidth_latency_evidence_contract")
    fields = contract.get("minimum_report_fields") if isinstance(contract, dict) else None
    minimum_fields = (
        [field for field in fields if isinstance(field, str)] if isinstance(fields, list) else []
    )
    return schema_map, minimum_fields


def require(condition: bool, message: str, errors: list[str]) -> None:
    if not condition:
        errors.append(message)


def is_number(value: Any) -> TypeGuard[float]:
    return isinstance(value, int | float) and not isinstance(value, bool)


def is_utc_timestamp(value: Any) -> bool:
    if not isinstance(value, str) or not value:
        return False
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return parsed.tzinfo is not None and parsed.utcoffset() is not None


def validate_uma_gate(errors: list[str]) -> None:
    if not UMA_GATE.is_file():
        errors.append(f"missing gate {UMA_GATE.relative_to(ROOT)}")
        return
    data = load_yaml(UMA_GATE)
    require(isinstance(data, dict), "UMA DRAM evidence gate must be a YAML mapping", errors)
    if not isinstance(data, dict):
        return

    require(
        data.get("schema") == "eliza.memory_uma_evidence_gate.v1",
        "UMA DRAM evidence gate schema drifted",
        errors,
    )
    require(
        data.get("status") == "scaffold_only_real_claims_blocked",
        "UMA DRAM evidence gate must remain scaffold_only_real_claims_blocked",
        errors,
    )

    target = data.get("phone_2028_target_profile")
    require(
        isinstance(target, dict),
        "UMA DRAM gate missing phone_2028_target_profile",
        errors,
    )
    if isinstance(target, dict):
        external = target.get("external_memory")
        require(isinstance(external, dict), "UMA DRAM gate missing external_memory", errors)
        if isinstance(external, dict):
            for key in (
                "capacity_gib_min",
                "peak_bandwidth_gbps_min",
                "sustained_bandwidth_gbps_min",
                "p95_random_read_latency_ns_max",
            ):
                require(
                    is_number(external.get(key)),
                    f"external_memory.{key} must be numeric",
                    errors,
                )

    schema_map = data.get("required_artifact_schemas")
    require(
        isinstance(schema_map, dict),
        "UMA DRAM gate required_artifact_schemas must be a mapping",
        errors,
    )
    if not isinstance(schema_map, dict):
        schema_map = {}

    blocked = data.get("blocked_real_claims")
    require(
        isinstance(blocked, list),
        "UMA DRAM gate blocked_real_claims must be a list",
        errors,
    )
    if not isinstance(blocked, list):
        blocked = []
    blocked_ids = {item.get("id") for item in blocked if isinstance(item, dict)}
    missing = sorted(REQUIRED_BLOCKED_MEMORY_CLAIMS - blocked_ids)
    require(
        not missing,
        "UMA DRAM gate missing blocked claim ids: " + ", ".join(missing),
        errors,
    )

    declared_artifacts: set[str] = set()
    for item in blocked:
        if not isinstance(item, dict):
            errors.append("UMA DRAM blocked_real_claims entries must be mappings")
            continue
        claim_id = item.get("id")
        require(
            item.get("status") == "blocked",
            f"memory claim {claim_id} must remain blocked",
            errors,
        )
        artifacts = item.get("evidence_artifacts")
        require(
            isinstance(artifacts, list) and bool(artifacts),
            f"memory claim {claim_id} must list evidence_artifacts",
            errors,
        )
        if not isinstance(artifacts, list):
            continue
        for artifact in artifacts:
            if not isinstance(artifact, str):
                errors.append(f"memory claim {claim_id} has non-string evidence artifact")
                continue
            declared_artifacts.add(artifact)
            expected_schema = schema_map.get(artifact)
            require(
                bool(isinstance(expected_schema, str) and expected_schema),
                f"memory claim {claim_id} artifact lacks required_artifact_schemas entry: {artifact}",
                errors,
            )
            if (ROOT / artifact).exists():
                errors.append(f"memory claim {claim_id} is blocked but artifact exists: {artifact}")

    extra_schema_artifacts = sorted(set(schema_map) - declared_artifacts)
    require(
        not extra_schema_artifacts,
        "UMA DRAM gate required_artifact_schemas has undeclared artifacts: "
        + ", ".join(extra_schema_artifacts),
        errors,
    )

    local_evidence = data.get("separate_local_rtl_evidence")
    require(
        isinstance(local_evidence, dict),
        "UMA DRAM gate missing separate_local_rtl_evidence boundaries",
        errors,
    )
    if isinstance(local_evidence, dict):
        for boundary_id, boundary in local_evidence.items():
            require(
                isinstance(boundary, dict),
                f"separate_local_rtl_evidence.{boundary_id} must be a mapping",
                errors,
            )
            if not isinstance(boundary, dict):
                continue
            claim_boundary = boundary.get("claim_boundary")
            require(
                isinstance(claim_boundary, str)
                and "not" in claim_boundary.lower()
                and "phone" in claim_boundary.lower(),
                f"separate_local_rtl_evidence.{boundary_id}.claim_boundary must block phone promotion",
                errors,
            )

    claim_rules = " ".join(flatten_strings(data.get("claim_rules")))
    for token in ("real DRAM", "Host benchmark", "cannot satisfy"):
        require(
            token.lower() in claim_rules.lower(),
            f"UMA DRAM claim_rules missing {token!r}",
            errors,
        )


def validate_dramsim_aggregate(errors: list[str], path: Path = DRAM_SIM_EVIDENCE) -> None:
    if not path.is_file():
        rel = path.relative_to(ROOT) if path.is_relative_to(ROOT) else path
        errors.append(f"missing DRAMSim aggregate {rel}")
        return
    data = load_yaml(path)
    rel = path.relative_to(ROOT) if path.is_relative_to(ROOT) else path
    require(
        isinstance(data, dict),
        f"{rel}: DRAMSim aggregate must be a YAML mapping",
        errors,
    )
    if not isinstance(data, dict):
        return
    require(
        data.get("schema") == "eliza.memory.dram_sim_evidence.v1",
        f"{rel}: schema drifted",
        errors,
    )
    require(
        data.get("status") == "dramsim3_behavioral_simulation",
        f"{rel}: status must remain dramsim3_behavioral_simulation",
        errors,
    )
    require(
        data.get("evidence_class") == "dramsim3_behavioral_simulation",
        f"{rel}: evidence_class must be dramsim3_behavioral_simulation",
        errors,
    )
    require(
        is_utc_timestamp(data.get("captured_utc")),
        f"{rel}: captured_utc must be an ISO-8601 timestamp with timezone",
        errors,
    )

    context = " ".join(flatten_strings(data.get("context")))
    limitations = data.get("simulator_limitations")
    require(
        isinstance(limitations, list) and len(limitations) >= 4,
        f"{rel}: simulator_limitations incomplete",
        errors,
    )
    combined_boundary = " ".join(flatten_strings([context, limitations, data.get("claim_rules")]))
    for token in DRAMSIM_CLAIM_BOUNDARY_TOKENS:
        require(
            token in combined_boundary.lower(),
            f"{rel}: claim boundary missing {token!r}",
            errors,
        )
    boundary_lower = combined_boundary.lower()
    require(
        "real target" in boundary_lower or "real-target" in boundary_lower,
        f"{rel}: claim boundary must mention real target",
        errors,
    )

    skus = data.get("skus")
    require(isinstance(skus, list), f"{rel}: skus must be a list", errors)
    if not isinstance(skus, list):
        return
    report_artifacts = data.get("report_artifacts")
    require(
        isinstance(report_artifacts, dict),
        f"{rel}: report_artifacts must hash-bind every listed DRAMSim report",
        errors,
    )
    if not isinstance(report_artifacts, dict):
        report_artifacts = {}
    report_artifact_hashes = {
        path: digest
        for path, digest in report_artifacts.items()
        if isinstance(path, str) and isinstance(digest, str)
    }
    all_report_paths: set[str] = set()
    seen_skus: set[str] = set()
    for sku in skus:
        require(isinstance(sku, dict), f"{rel}: sku entries must be mappings", errors)
        if not isinstance(sku, dict):
            continue
        sku_id = sku.get("id")
        require(
            isinstance(sku_id, str) and sku_id in DRAMSIM_SKUS,
            f"{rel}: unknown DRAMSim SKU {sku_id}",
            errors,
        )
        if not isinstance(sku_id, str) or sku_id not in DRAMSIM_SKUS:
            continue
        seen_skus.add(sku_id)
        expected = DRAMSIM_SKUS[sku_id]
        require(
            sku.get("standard") == expected["standard"],
            f"{rel}: {sku_id} standard drifted",
            errors,
        )
        require(
            sku.get("capacity_gib") == expected["capacity_gib"],
            f"{rel}: {sku_id} capacity_gib drifted",
            errors,
        )
        peak = sku.get("jedec_peak_bandwidth_gbps")
        require(
            is_number(peak) and abs(float(peak) - expected["peak_gbps"]) < 0.01,
            f"{rel}: {sku_id} peak bandwidth drifted",
            errors,
        )
        sustained = sku.get("sustained_bandwidth_gbps")
        latency = sku.get("p95_read_latency_ns")
        require(
            isinstance(sustained, dict),
            f"{rel}: {sku_id} missing sustained_bandwidth_gbps",
            errors,
        )
        require(
            isinstance(latency, dict),
            f"{rel}: {sku_id} missing p95_read_latency_ns",
            errors,
        )
        if isinstance(sustained, dict):
            missing = sorted(DRAMSIM_WORKLOADS - set(sustained))
            require(
                not missing,
                f"{rel}: {sku_id} missing sustained workloads: " + ", ".join(missing),
                errors,
            )
            for workload, value in sustained.items():
                require(
                    workload in DRAMSIM_WORKLOADS,
                    f"{rel}: {sku_id} unknown sustained workload {workload}",
                    errors,
                )
                require(
                    is_number(value) and value > 0,
                    f"{rel}: {sku_id}.{workload} sustained bandwidth must be positive",
                    errors,
                )
                if is_number(value) and is_number(peak):
                    require(
                        float(value) < float(peak),
                        f"{rel}: {sku_id}.{workload} sustained bandwidth exceeds JEDEC peak",
                        errors,
                    )
        if isinstance(latency, dict):
            missing = sorted(DRAMSIM_WORKLOADS - set(latency))
            require(
                not missing,
                f"{rel}: {sku_id} missing latency workloads: " + ", ".join(missing),
                errors,
            )
            for workload, value in latency.items():
                require(
                    workload in DRAMSIM_WORKLOADS,
                    f"{rel}: {sku_id} unknown latency workload {workload}",
                    errors,
                )
                require(
                    is_number(value) and value > 0,
                    f"{rel}: {sku_id}.{workload} p95 latency must be positive",
                    errors,
                )

        report_paths = sku.get("report_paths")
        require(
            isinstance(report_paths, list),
            f"{rel}: {sku_id} report_paths must be a list",
            errors,
        )
        if isinstance(report_paths, list):
            expected_paths = {
                f"build/reports/memory/dramsim3_{sku_id}_{workload}.json"
                for workload in DRAMSIM_WORKLOADS
            }
            actual_paths = {item for item in report_paths if isinstance(item, str)}
            all_report_paths.update(actual_paths)
            missing_paths = sorted(expected_paths - actual_paths)
            require(
                not missing_paths,
                f"{rel}: {sku_id} missing report_paths: " + ", ".join(missing_paths),
                errors,
            )
            for report_path in sorted(actual_paths):
                digest = report_artifact_hashes.get(report_path)
                require(
                    isinstance(digest, str) and re.fullmatch(r"[0-9a-f]{64}", digest) is not None,
                    f"{rel}: {report_path} missing report_artifacts sha256 binding",
                    errors,
                )
                report_file = ROOT / report_path
                if (
                    report_file.is_file()
                    and isinstance(digest, str)
                    and re.fullmatch(r"[0-9a-f]{64}", digest) is not None
                ):
                    require(
                        sha256_file(report_file) == digest,
                        f"{rel}: report_artifacts sha256 is stale for {report_path}",
                        errors,
                    )
                workload = Path(report_path).stem.removeprefix(f"dramsim3_{sku_id}_")
                validate_dramsim_report(
                    report_path,
                    sku_id,
                    workload,
                    sustained.get(workload) if isinstance(sustained, dict) else None,
                    latency.get(workload) if isinstance(latency, dict) else None,
                    errors,
                )

    missing_skus = sorted(set(DRAMSIM_SKUS) - seen_skus)
    require(
        not missing_skus,
        f"{rel}: missing DRAMSim SKUs: " + ", ".join(missing_skus),
        errors,
    )
    extra_report_artifacts = sorted(set(report_artifact_hashes) - all_report_paths)
    missing_report_artifacts = sorted(all_report_paths - set(report_artifact_hashes))
    require(
        not missing_report_artifacts,
        f"{rel}: report_artifacts missing listed reports: " + ", ".join(missing_report_artifacts),
        errors,
    )
    require(
        not extra_report_artifacts,
        f"{rel}: report_artifacts contains unlisted reports: " + ", ".join(extra_report_artifacts),
        errors,
    )

    sanity = at(data, ("jedec_sanity_check", "results"))
    require(
        isinstance(sanity, list),
        f"{rel}: jedec_sanity_check.results must be a list",
        errors,
    )
    if isinstance(sanity, list):
        sanity_by_sku = {item.get("sku"): item for item in sanity if isinstance(item, dict)}
        for sku_id in DRAMSIM_SKUS:
            row = sanity_by_sku.get(sku_id)
            require(
                isinstance(row, dict),
                f"{rel}: missing JEDEC sanity row for {sku_id}",
                errors,
            )
            if not isinstance(row, dict):
                continue
            require(
                row.get("passes_sanity") is True,
                f"{rel}: {sku_id} JEDEC sanity must pass",
                errors,
            )
            require(
                is_number(row.get("sustained_over_peak_ratio"))
                and row["sustained_over_peak_ratio"] < 1.0,
                f"{rel}: {sku_id} sustained/peak ratio must be below 1",
                errors,
            )


def validate_dramsim_report(
    report_path: str,
    sku_id: str,
    workload: str,
    expected_bandwidth_gbps: Any,
    expected_p95_latency_ns: Any,
    errors: list[str],
) -> None:
    path = ROOT / report_path
    if not path.is_file():
        errors.append(f"{report_path}: listed DRAMSim report is missing")
        return
    data = load_json(path)
    require(isinstance(data, dict), f"{report_path}: report must be a JSON object", errors)
    if not isinstance(data, dict):
        return
    require(
        data.get("schema") == "eliza.memory.dram_sim_sweep.v1",
        f"{report_path}: schema drifted",
        errors,
    )
    require(
        data.get("status") == "simulator_only",
        f"{report_path}: status must be simulator_only",
        errors,
    )
    require(
        data.get("evidence_class") == "dramsim3_behavioral_simulation",
        f"{report_path}: evidence_class drifted",
        errors,
    )
    require(
        is_utc_timestamp(data.get("captured_utc")),
        f"{report_path}: captured_utc must be timezone-aware",
        errors,
    )
    require(
        data.get("phone_claim_allowed") is False,
        f"{report_path}: phone_claim_allowed must be false",
        errors,
    )
    require(
        data.get("release_claim_allowed") is False,
        f"{report_path}: release_claim_allowed must be false",
        errors,
    )
    boundary = str(data.get("claim_boundary", "")).lower()
    require(
        "not physical" in boundary and "phone" in boundary,
        f"{report_path}: claim_boundary must block phone promotion",
        errors,
    )
    require(
        str(data.get("standard", "")).startswith(DRAMSIM_SKUS[sku_id]["standard"].split("-")[0]),
        f"{report_path}: standard does not match {sku_id}",
        errors,
    )
    require(data.get("workload") == workload, f"{report_path}: workload must be {workload}", errors)
    if is_number(expected_bandwidth_gbps):
        actual_bandwidth = data.get("simulated_total_bandwidth_gbps")
        require(
            is_number(actual_bandwidth)
            and abs(float(actual_bandwidth) - float(expected_bandwidth_gbps)) <= 0.01,
            f"{report_path}: simulated_total_bandwidth_gbps must match aggregate sustained bandwidth",
            errors,
        )
    if is_number(expected_p95_latency_ns):
        actual_latency = data.get("simulated_p95_latency_ns")
        require(
            is_number(actual_latency)
            and abs(float(actual_latency) - float(expected_p95_latency_ns)) <= 0.01,
            f"{report_path}: simulated_p95_latency_ns must match aggregate p95 latency",
            errors,
        )
    peak = data.get("peak_bandwidth_gbps")
    total = data.get("simulated_total_bandwidth_gbps")
    require(
        is_number(total) and is_number(peak) and float(total) < float(peak),
        f"{report_path}: simulated bandwidth must remain below JEDEC peak",
        errors,
    )

    raw_artifacts = data.get("raw_artifacts")
    require(
        isinstance(raw_artifacts, list) and bool(raw_artifacts),
        f"{report_path}: raw_artifacts must hash-bind raw DRAMSim logs/stats",
        errors,
    )
    raw_paths: set[str] = set()
    if isinstance(raw_artifacts, list):
        for index, artifact in enumerate(raw_artifacts):
            if not isinstance(artifact, dict):
                errors.append(f"{report_path}: raw_artifacts[{index}] must be an object")
                continue
            path_value = artifact.get("path")
            digest = artifact.get("sha256")
            path_ok = bool(
                isinstance(path_value, str)
                and path_value
                and not Path(path_value).is_absolute()
                and ".." not in Path(path_value).parts
            )
            require(path_ok, f"{report_path}: raw_artifacts[{index}].path must be relative", errors)
            require(
                isinstance(digest, str) and re.fullmatch(r"[0-9a-f]{64}", digest) is not None,
                f"{report_path}: raw_artifacts[{index}].sha256 must be lowercase hex",
                errors,
            )
            if path_ok:
                assert isinstance(path_value, str)
                raw_paths.add(path_value)
                raw_path = ROOT / path_value
                require(
                    raw_path.is_file(), f"{report_path}: raw artifact missing: {path_value}", errors
                )
                if (
                    raw_path.is_file()
                    and isinstance(digest, str)
                    and re.fullmatch(r"[0-9a-f]{64}", digest)
                ):
                    require(
                        sha256_file(raw_path) == digest,
                        f"{report_path}: raw_artifacts[{index}].sha256 does not match {path_value}",
                        errors,
                    )
    for field in ("raw_log_path", "raw_stats_path"):
        value = data.get(field)
        require(
            isinstance(value, str) and value in raw_paths,
            f"{report_path}: {field} must be listed in raw_artifacts with matching hash",
            errors,
        )


def validate_template(errors: list[str]) -> None:
    if not TEMPLATE.is_file():
        errors.append(f"missing template {TEMPLATE.relative_to(ROOT)}")
        return

    data = load_json(TEMPLATE)
    require(isinstance(data, dict), "memory evidence template must be a JSON object", errors)
    if not isinstance(data, dict):
        return

    require(
        data.get("schema") == "eliza.memory.bandwidth_latency_contended_access.template.v1",
        "memory evidence template schema drifted",
        errors,
    )
    require(
        data.get("template_status") == "template_only_not_evidence",
        "memory evidence template must remain template_only_not_evidence",
        errors,
    )
    report = data.get("report")
    require(
        isinstance(report, dict),
        "memory evidence template missing report object",
        errors,
    )
    if not isinstance(report, dict):
        return

    placeholders = [text for text in flatten_strings(report) if PLACEHOLDER_RE.search(text)]
    require(
        len(placeholders) >= 16,
        "memory evidence template must keep explicit placeholders in every required field",
        errors,
    )
    require(
        at(report, ("target", "is_host")) is False
        and at(report, ("target", "is_simulator")) is False,
        "memory evidence template must default host/simulator evidence to false",
        errors,
    )
    metrics = at(report, ("parsed_metrics",))
    require(
        isinstance(metrics, dict),
        "memory evidence template missing parsed_metrics",
        errors,
    )
    if isinstance(metrics, dict):
        missing = sorted(REQUIRED_METRICS - set(metrics))
        require(
            not missing,
            "memory evidence template missing metrics: " + ", ".join(missing),
            errors,
        )

    pass_fail = at(report, ("pass_fail_against_phone_2028_target_profile",))
    require(
        isinstance(pass_fail, dict),
        "memory evidence template missing pass_fail_against_phone_2028_target_profile",
        errors,
    )
    if isinstance(pass_fail, dict):
        missing = sorted(REQUIRED_PASS_FAIL_KEYS - set(pass_fail))
        require(
            not missing,
            "memory evidence template missing pass/fail keys: " + ", ".join(missing),
            errors,
        )

    process = at(report, ("process_corners",))
    require(
        isinstance(process, dict),
        "memory evidence template missing process_corners",
        errors,
    )
    if isinstance(process, dict):
        contract = process.get("process_effects_contract")
        require(
            isinstance(contract, dict),
            "memory evidence template missing process_effects_contract",
            errors,
        )
        if isinstance(contract, dict):
            require(
                contract.get("path") == "docs/spec-db/process-14a-effects.yaml",
                "memory evidence template must bind to docs/spec-db/process-14a-effects.yaml",
                errors,
            )
            require(
                contract.get("sha256") == "__REQUIRED_SHA256__",
                "memory evidence template must require process effects contract sha256",
                errors,
            )
        require(
            process.get("worst_process_corner") == "__REQUIRED_14A_CORNER_ID__",
            "memory evidence template must require worst 14A process corner id",
            errors,
        )
        require(
            process.get("pdk_signoff_claim") == "none",
            "memory evidence template must make no PDK signoff claim",
            errors,
        )

    rejections = at(report, ("negative_evidence_rejection",))
    require(
        isinstance(rejections, dict),
        "memory evidence template missing negative_evidence_rejection",
        errors,
    )
    if isinstance(rejections, dict):
        missing = sorted(REQUIRED_REJECTION_KEYS - set(rejections))
        require(
            not missing,
            "memory evidence template missing rejection keys: " + ", ".join(missing),
            errors,
        )
        for key in REQUIRED_REJECTION_KEYS & set(rejections):
            require(
                rejections[key] == "reject",
                f"template rejection {key} must be reject",
                errors,
            )


def validate_real_report(path: Path, errors: list[str]) -> None:
    data = load_json(path)
    rel = path.relative_to(ROOT) if path.is_relative_to(ROOT) else path
    require(isinstance(data, dict), f"{rel}: report must be a JSON object", errors)
    if not isinstance(data, dict):
        return
    rel_key = str(rel)
    schema_map, minimum_fields = load_uma_gate_contract()
    expected_schema = schema_map.get(rel_key)
    if expected_schema is not None:
        require(
            data.get("schema") == expected_schema,
            f"{rel}: schema must be {expected_schema}",
            errors,
        )
    for field in minimum_fields:
        value = dotted_at(data, field)
        require(
            value is not None,
            f"{rel}: missing minimum report field {field}",
            errors,
        )

    placeholder_hits = [
        text for text in flatten_strings(data) if PLACEHOLDER_RE.search(text) or text.strip() == ""
    ]
    require(
        not placeholder_hits,
        f"{rel}: report contains placeholders or blank strings; first={placeholder_hits[:1]}",
        errors,
    )
    require(
        data.get("evidence_class") == "real_target_measurement",
        f"{rel}: evidence_class must be real_target_measurement",
        errors,
    )
    claim_boundary = data.get("claim_boundary")
    require(
        isinstance(claim_boundary, str)
        and "not" in claim_boundary.lower()
        and "phone" in claim_boundary.lower()
        and "release" in claim_boundary.lower(),
        f"{rel}: claim_boundary must explicitly block phone/release promotion",
        errors,
    )
    for claim_field in ("claim_allowed", "phone_claim_allowed", "release_claim_allowed"):
        require(
            data.get(claim_field) is False,
            f"{rel}: {claim_field} must be exactly false",
            errors,
        )
    require(
        at(data, ("target", "is_host")) is False,
        f"{rel}: host results are invalid",
        errors,
    )
    require(
        at(data, ("target", "is_simulator")) is False,
        f"{rel}: simulator wall-clock results are invalid",
        errors,
    )

    process = at(data, ("process_corners",))
    require(isinstance(process, dict), f"{rel}: process_corners must be an object", errors)
    if isinstance(process, dict):
        contract = process.get("process_effects_contract")
        require(
            isinstance(contract, dict),
            f"{rel}: process_effects_contract must be an object",
            errors,
        )
        if isinstance(contract, dict):
            require(
                contract.get("path") == PROCESS_EFFECTS_CONTRACT_PATH,
                f"{rel}: process_effects_contract path must bind to 14A effects contract",
                errors,
            )
            require(
                isinstance(contract.get("sha256"), str)
                and re.fullmatch(r"[0-9a-f]{64}", contract["sha256"]) is not None,
                f"{rel}: process_effects_contract sha256 must be lowercase hex",
                errors,
            )
            contract_path = ROOT / PROCESS_EFFECTS_CONTRACT_PATH
            if (
                contract.get("path") == PROCESS_EFFECTS_CONTRACT_PATH
                and isinstance(contract.get("sha256"), str)
                and re.fullmatch(r"[0-9a-f]{64}", contract["sha256"]) is not None
            ):
                require(
                    contract_path.is_file() and sha256_file(contract_path) == contract["sha256"],
                    f"{rel}: process_effects_contract sha256 must match {PROCESS_EFFECTS_CONTRACT_PATH}",
                    errors,
                )
        require(
            isinstance(process.get("process_corner_count"), int)
            and not isinstance(process.get("process_corner_count"), bool)
            and process["process_corner_count"] > 0,
            f"{rel}: process_corner_count must be a positive integer",
            errors,
        )
        require(
            isinstance(process.get("worst_process_corner"), str)
            and process["worst_process_corner"].startswith("14a_"),
            f"{rel}: worst_process_corner must name a 14A corner",
            errors,
        )
        require(
            process.get("pdk_signoff_claim") == "none",
            f"{rel}: pdk_signoff_claim must remain none",
            errors,
        )

    memory_type = at(data, ("memory_config", "memory_type"))
    require(
        isinstance(memory_type, str)
        and memory_type not in {"AXI-Lite SRAM model", "SimDRAM", "host DRAM", "unknown"},
        f"{rel}: memory_type must name a real target memory type or explicit downgrade",
        errors,
    )
    capacity = at(data, ("memory_config", "capacity_gib"))
    require(
        is_number(capacity) and capacity > 0,
        f"{rel}: capacity_gib must be numeric",
        errors,
    )

    metrics = at(data, ("parsed_metrics",))
    require(isinstance(metrics, dict), f"{rel}: parsed_metrics must be an object", errors)
    if isinstance(metrics, dict):
        missing = sorted(REQUIRED_METRICS - set(metrics))
        require(not missing, f"{rel}: missing metrics: " + ", ".join(missing), errors)
        for metric in REQUIRED_METRICS & set(metrics):
            require(
                is_number(metrics[metric]),
                f"{rel}: metric {metric} must be numeric",
                errors,
            )

    pass_fail = data.get("pass_fail_against_phone_2028_target_profile")
    require(
        isinstance(pass_fail, dict),
        f"{rel}: pass_fail_against_phone_2028_target_profile must be an object",
        errors,
    )
    if isinstance(pass_fail, dict):
        missing = sorted(REQUIRED_PASS_FAIL_KEYS - set(pass_fail))
        require(
            not missing,
            f"{rel}: missing pass/fail target keys: " + ", ".join(missing),
            errors,
        )
        for key in REQUIRED_PASS_FAIL_KEYS & set(pass_fail):
            value = pass_fail.get(key)
            require(
                isinstance(value, str) and value in VALID_PASS_FAIL_VALUES,
                f"{rel}: pass/fail target key {key} must be one of "
                + ", ".join(sorted(VALID_PASS_FAIL_VALUES)),
                errors,
            )
        if pass_fail.get("overall") == "pass":
            not_passed = sorted(
                key for key in REQUIRED_PASS_FAIL_KEYS - {"overall"} if pass_fail.get(key) != "pass"
            )
            require(
                not not_passed,
                f"{rel}: overall pass requires all target pass/fail keys to pass: "
                + ", ".join(not_passed),
                errors,
            )
        if pass_fail.get("capacity_gib_min_12") == "pass":
            require(
                is_number(capacity) and float(capacity) >= 12.0,
                f"{rel}: capacity_gib_min_12 pass requires capacity_gib >= 12",
                errors,
            )
        if isinstance(metrics, dict):
            peak = metrics.get("peak_bandwidth_gbps")
            sustained = metrics.get("sustained_bandwidth_gbps")
            latency = metrics.get("p95_random_read_latency_ns")
            if pass_fail.get("peak_bandwidth_gbps_min_180") == "pass":
                require(
                    is_number(peak) and float(peak) >= 180.0,
                    f"{rel}: peak_bandwidth_gbps_min_180 pass requires peak_bandwidth_gbps >= 180",
                    errors,
                )
            if pass_fail.get("sustained_bandwidth_gbps_min_120") == "pass":
                require(
                    is_number(sustained) and float(sustained) >= 120.0,
                    f"{rel}: sustained_bandwidth_gbps_min_120 pass requires sustained_bandwidth_gbps >= 120",
                    errors,
                )
            if pass_fail.get("p95_random_read_latency_ns_max_120") == "pass":
                require(
                    is_number(latency) and float(latency) <= 120.0,
                    f"{rel}: p95_random_read_latency_ns_max_120 pass requires p95_random_read_latency_ns <= 120",
                    errors,
                )
        contention = data.get("contention_workload")
        if pass_fail.get("contended_trace_present") == "pass":
            require(
                isinstance(contention, dict),
                f"{rel}: contended_trace_present pass requires contention_workload object",
                errors,
            )
            if isinstance(contention, dict):
                clients = contention.get("clients")
                require(
                    isinstance(clients, list)
                    and bool(clients)
                    and all(isinstance(client, str) and client for client in clients),
                    f"{rel}: contention_workload.clients must list clients",
                    errors,
                )
                if isinstance(clients, list):
                    client_set = {client for client in clients if isinstance(client, str)}
                    missing_clients = sorted(REQUIRED_CONTENDED_CLIENTS - client_set)
                    require(
                        not missing_clients,
                        f"{rel}: contention_workload.clients missing required clients: "
                        + ", ".join(missing_clients),
                        errors,
                    )
                duration = contention.get("duration_seconds")
                require(
                    is_number(duration) and float(duration) > 0,
                    f"{rel}: contention_workload.duration_seconds must be positive",
                    errors,
                )
                raw_trace = contention.get("raw_trace_path")
                require(
                    bool(
                        isinstance(raw_trace, str)
                        and raw_trace
                        and not Path(raw_trace).is_absolute()
                        and ".." not in Path(raw_trace).parts
                    ),
                    f"{rel}: contention_workload.raw_trace_path must be a relative repo path",
                    errors,
                )

    commands = data.get("benchmark_commands")
    require(
        isinstance(commands, list)
        and bool(commands)
        and all(isinstance(command, str) and command.strip() for command in commands),
        f"{rel}: benchmark_commands must list exact non-empty commands",
        errors,
    )
    raw_artifacts = data.get("raw_artifacts")
    require(
        isinstance(raw_artifacts, list) and bool(raw_artifacts),
        f"{rel}: raw_artifacts must list raw logs/traces",
        errors,
    )
    raw_artifact_paths: set[str] = set()
    if isinstance(raw_artifacts, list):
        for artifact in raw_artifacts:
            require(
                isinstance(artifact, dict),
                f"{rel}: raw_artifacts entries must be objects",
                errors,
            )
            if isinstance(artifact, dict):
                path_value = artifact.get("path")
                path_ok = bool(
                    isinstance(path_value, str)
                    and path_value
                    and not Path(path_value).is_absolute()
                    and ".." not in Path(path_value).parts
                )
                require(path_ok, f"{rel}: raw artifact path must be a relative repo path", errors)
                require(
                    isinstance(artifact.get("sha256"), str)
                    and re.fullmatch(r"[0-9a-f]{64}", artifact["sha256"]) is not None,
                    f"{rel}: raw artifact sha256 must be lowercase hex",
                    errors,
                )
                if path_ok:
                    assert isinstance(path_value, str)
                    raw_artifact_paths.add(path_value)
                    artifact_path = ROOT / path_value
                    require(
                        artifact_path.is_file(),
                        f"{rel}: raw artifact is missing: {path_value}",
                        errors,
                    )
                    if (
                        artifact_path.is_file()
                        and isinstance(artifact.get("sha256"), str)
                        and re.fullmatch(r"[0-9a-f]{64}", artifact["sha256"]) is not None
                    ):
                        require(
                            sha256_file(artifact_path) == artifact["sha256"],
                            f"{rel}: raw artifact sha256 does not match {path_value}",
                            errors,
                        )
    contention = data.get("contention_workload")
    if (
        isinstance(pass_fail, dict)
        and pass_fail.get("contended_trace_present") == "pass"
        and isinstance(contention, dict)
        and isinstance(contention.get("raw_trace_path"), str)
        and contention["raw_trace_path"]
        and not Path(contention["raw_trace_path"]).is_absolute()
        and ".." not in Path(contention["raw_trace_path"]).parts
    ):
        require(
            contention["raw_trace_path"] in raw_artifact_paths,
            f"{rel}: contention_workload.raw_trace_path must be listed in raw_artifacts",
            errors,
        )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--report",
        action="append",
        default=[],
        help="validate an additional real memory performance report",
    )
    parser.add_argument(
        "--strict-real-reports",
        action="store_true",
        help="require all default real memory L5/L6 report artifacts to exist",
    )
    args = parser.parse_args()

    errors: list[str] = []
    validate_template(errors)
    validate_uma_gate(errors)
    validate_dramsim_aggregate(errors)

    reports = [ROOT / report for report in args.report]
    if args.strict_real_reports:
        missing_reports = [path for path in REAL_REPORT_CANDIDATES if not path.is_file()]
        for report in missing_reports:
            errors.append(f"strict real memory report missing: {report.relative_to(ROOT)}")
        reports.extend(path for path in REAL_REPORT_CANDIDATES if path.is_file())
    else:
        reports.extend(path for path in REAL_REPORT_CANDIDATES if path.is_file())
    for report in reports:
        if report.is_file():
            validate_real_report(report, errors)
        else:
            errors.append(f"report does not exist: {report}")

    if errors:
        print("Memory evidence template check failed:")
        for error in errors:
            print(f"  - {error}")
        return 1

    print(
        "Memory evidence template check passed: template is non-evidence and real-report placeholder rejection is armed."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
