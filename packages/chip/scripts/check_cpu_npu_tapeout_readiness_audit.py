#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import shutil
from pathlib import Path
from typing import Any

from chip_utils import load_json_object, load_yaml_object, require_number

ROOT = Path(__file__).resolve().parents[1]
SCORECARD = ROOT / "docs/architecture-optimization/cpu-npu-2028-readiness-scorecard.yaml"
MANUAL_REVIEW = ROOT / "docs/architecture-optimization/cpu-npu-2028-manual-review.yaml"
COMPETITIVE = ROOT / "benchmarks/results/cpu-npu-2028-competitive-envelope.json"
PROCESS_EVAL = ROOT / "benchmarks/results/cpu-npu-2028-14a-process-eval.json"
MODELED_EVAL = ROOT / "benchmarks/results/cpu-npu-2028-modeled-eval.json"
NPU_CONTEXT_QUEUE_SIM = ROOT / "benchmarks/results/npu-context-queue-sim.json"
MEMORY_IOMMU_QOS_SIM = ROOT / "benchmarks/results/memory-iommu-qos-sim.json"
DRY_RUN_REPORT = ROOT / "benchmarks/results/dry-run/report.json"
LOCAL_HOST_BENCHMARK_REPORT = ROOT / "benchmarks/results/local-host-benchmark-evidence.json"
CHIPYARD_IMPORT_PREFLIGHT_REPORTS = (
    ROOT / "build/chipyard/eliza_rocket/bootstrap-preflight.json",
    ROOT / "benchmarks/results/chipyard/bootstrap-preflight.json",
)
OUT = ROOT / "benchmarks/results/cpu-npu-2028-tapeout-readiness-audit.json"

REQUIRED_MODELED_REPORTS = {
    "modeled_benchmark_eval": (
        ROOT / "benchmarks/results/cpu-npu-2028-modeled-eval.json",
        "modeled_eval_release_blocked",
    ),
    "npu_context_queue_sim": (
        ROOT / "benchmarks/results/npu-context-queue-sim.json",
        "pass",
    ),
    "memory_iommu_qos_sim": (
        ROOT / "benchmarks/results/memory-iommu-qos-sim.json",
        "pass",
    ),
    "burst_sustained_policy": (
        ROOT / "benchmarks/results/cpu-npu-2028-burst-sustained-policy.json",
        "modeled_policy_release_blocked",
    ),
    "burst_thermal_transient": (
        ROOT / "benchmarks/results/cpu-npu-2028-burst-thermal-transient.json",
        "modeled_transient_release_blocked",
    ),
    "aosp_governor_trace": (
        ROOT / "benchmarks/results/cpu-npu-2028-aosp-governor-trace.json",
        "modeled_aosp_trace_release_blocked",
    ),
    "process_14a_eval": (
        ROOT / "benchmarks/results/cpu-npu-2028-14a-process-eval.json",
        "modeled_process_eval_release_blocked",
    ),
    "competitive_envelope": (
        ROOT / "benchmarks/results/cpu-npu-2028-competitive-envelope.json",
        "modeled_competitive_envelope_release_blocked",
    ),
}
REQUIRED_TOOL_CHECKS = {
    "riscv_elf_compiler": ("riscv64-unknown-elf-gcc", "RISCV_CC"),
    "renode": ("renode", None),
    "verilator": ("verilator", None),
    "yosys": ("yosys", None),
    "benchmark_model": ("benchmark_model", None),
    "fio": ("fio", None),
}
REPO_TOOL_DIRS = (
    "tools/bin",
    ".venv/bin",
    "external/oss-cad-suite/bin",
)
HOST_SMOKE_TOOL_DIR = "benchmarks/tools"
HOST_SMOKE_MARKER = b"eliza-host-smoke"
HOST_SMOKE_READ_BYTES = 256 * 1024
FALSE_CLAIM_FLAGS = {
    "release_claim_allowed": False,
    "tapeout_claim_allowed": False,
    "aosp_claim_allowed": False,
    "measured_benchmark_claim_allowed": False,
    "pdk_signoff_claim_allowed": False,
    "silicon_claim_allowed": False,
    "production_readiness_claim_allowed": False,
}


def rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def check_row(row_id: str, status: str, evidence: str) -> dict[str, str]:
    return {"id": row_id, "status": status, "evidence": evidence}


def tool_search_path(*, include_host_smoke: bool = False) -> str:
    repo_dirs = [str(ROOT / item) for item in REPO_TOOL_DIRS if (ROOT / item).is_dir()]
    env_dirs = [
        entry
        for entry in os.environ.get("PATH", "").split(os.pathsep)
        if entry and Path(entry).resolve() != (ROOT / HOST_SMOKE_TOOL_DIR).resolve()
    ]
    smoke_dirs = (
        [str(ROOT / HOST_SMOKE_TOOL_DIR)]
        if include_host_smoke and (ROOT / HOST_SMOKE_TOOL_DIR).is_dir()
        else []
    )
    return os.pathsep.join(repo_dirs + env_dirs + smoke_dirs)


def is_host_smoke_tool(path: str | None) -> bool:
    if not path:
        return False
    resolved = Path(path).resolve()
    smoke_dir = (ROOT / HOST_SMOKE_TOOL_DIR).resolve()
    try:
        resolved.relative_to(smoke_dir)
        return True
    except ValueError:
        pass
    try:
        with resolved.open("rb") as f:
            return HOST_SMOKE_MARKER in f.read(HOST_SMOKE_READ_BYTES)
    except OSError:
        return False


def resolve_required_tool(binary: str) -> tuple[bool, str, str]:
    path = shutil.which(binary, path=tool_search_path())
    if path:
        return True, path, "available"
    smoke_path = shutil.which(binary, path=tool_search_path(include_host_smoke=True))
    if smoke_path and is_host_smoke_tool(smoke_path):
        return False, smoke_path, "repo_local_host_smoke_tool_not_release_evidence"
    return False, "", "missing_executable"


def modeled_report_rows() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for report_id, (path, expected_status) in REQUIRED_MODELED_REPORTS.items():
        status = "fail"
        actual_status = "missing"
        schema = "missing"
        if path.is_file():
            data = load_json_object(path)
            actual_status = str(data.get("status", "missing"))
            schema = str(data.get("schema", "missing"))
            if actual_status == expected_status:
                status = "pass"
        rows.append(
            {
                "id": report_id,
                "status": status,
                "artifact": rel(path),
                "schema": schema,
                "expected_status": expected_status,
                "actual_status": actual_status,
                "release_use": "model_only_not_release_evidence",
            }
        )
    return rows


def proof_domain_rows(scorecard: dict[str, Any]) -> list[dict[str, Any]]:
    domains = scorecard.get("proof_domains")
    if not isinstance(domains, list):
        raise ValueError("scorecard proof_domains must be a list")
    rows: list[dict[str, Any]] = []
    for domain in domains:
        if not isinstance(domain, dict):
            raise ValueError("scorecard proof domain entries must be mappings")
        evidence = domain.get("evidence_artifacts")
        if not isinstance(evidence, list):
            raise ValueError(f"{domain.get('id')}: evidence_artifacts must be a list")
        missing = [
            item for item in evidence if isinstance(item, str) and not (ROOT / item).exists()
        ]
        placeholder_only = [
            item
            for item in evidence
            if isinstance(item, str)
            and (item.endswith(".template.json") or "template" in Path(item).name)
        ]
        current_state = str(domain.get("current_state", ""))
        rows.append(
            {
                "id": str(domain.get("id")),
                "status": "blocked"
                if current_state.startswith("blocked_until_") or missing or placeholder_only
                else "pass",
                "current_state": current_state,
                "gate_command": str(domain.get("gate_command")),
                "evidence_artifacts": evidence,
                "missing_artifacts": missing,
                "placeholder_only_artifacts": placeholder_only,
            }
        )
    return rows


def tool_rows() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for tool_id, (binary, env_override) in REQUIRED_TOOL_CHECKS.items():
        env_hint = f" or set {env_override}" if env_override else ""
        found, path, reason = resolve_required_tool(binary)
        rows.append(
            {
                "id": tool_id,
                "status": "pass" if found else "blocked",
                "binary": binary,
                "path": path,
                "resolution_state": reason,
                "search_path_policy": (
                    "repo tools/bin, .venv/bin, and external/oss-cad-suite/bin count; "
                    "benchmarks/tools host smoke shims do not count as release tools."
                ),
                "unblock": f"Install a release-capable {binary}{env_hint}.",
            }
        )
    return rows


def benchmark_release_rows() -> list[dict[str, Any]]:
    if not DRY_RUN_REPORT.is_file():
        return [
            {
                "id": "dry_run_report",
                "status": "blocked",
                "reason": "missing_dry_run_report",
                "artifact": rel(DRY_RUN_REPORT),
                "unblock": "Run make benchmarks-dry-run.",
            }
        ]
    data = load_json_object(DRY_RUN_REPORT)
    if data.get("schema") != "eliza.benchmark_run.v1":
        raise ValueError("benchmark dry-run report schema mismatch")
    if data.get("dry_run") is not True:
        raise ValueError("benchmark release readiness requires dry_run=true report")
    results = data.get("results")
    if not isinstance(results, list):
        raise ValueError("benchmark dry-run results must be a list")

    rows: list[dict[str, Any]] = []
    for result in results:
        if not isinstance(result, dict):
            raise ValueError("benchmark dry-run result entries must be mappings")
        name = str(result.get("name", "<unnamed>"))
        status = str(result.get("status", "missing"))
        blocked_requirements = result.get("blocked_requirements", [])
        blocked_assets = result.get("blocked_assets", [])
        dependencies = result.get("dependencies", [])
        if not isinstance(blocked_requirements, list):
            raise ValueError(f"{name}: blocked_requirements must be a list")
        if blocked_assets is None:
            blocked_assets = []
        if not isinstance(blocked_assets, list):
            raise ValueError(f"{name}: blocked_assets must be a list")
        if not isinstance(dependencies, list):
            raise ValueError(f"{name}: dependencies must be a list")
        rejected_host_smoke = [
            item.get("name")
            for item in dependencies
            if isinstance(item, dict) and item.get("blocked_reason") == "repo_local_host_smoke_tool"
        ]
        blocked_names = [
            str(item.get("name"))
            for item in blocked_requirements + blocked_assets
            if isinstance(item, dict) and item.get("name")
        ]
        is_blocked = status in {"planned_missing_deps", "blocked", "missing_dependencies"}
        rows.append(
            {
                "id": name,
                "status": "blocked" if is_blocked else "pass",
                "benchmark_status": status,
                "blocked_requirements": blocked_requirements,
                "blocked_assets": blocked_assets,
                "blocked_requirement_names": sorted(set(blocked_names)),
                "rejected_host_smoke_tools": sorted(
                    str(item) for item in rejected_host_smoke if item
                ),
            }
        )
    return rows


def local_host_benchmark_summary() -> dict[str, Any]:
    if not LOCAL_HOST_BENCHMARK_REPORT.is_file():
        return {
            "status": "missing",
            "passed_count": 0,
            "partial_timeout_count": 0,
            "release_claim_allowed": False,
        }
    data = load_json_object(LOCAL_HOST_BENCHMARK_REPORT)
    summary = data.get("summary")
    if not isinstance(summary, dict):
        raise ValueError("local host benchmark report missing summary")
    if data.get("status") != "local_host_evidence_not_release":
        raise ValueError("local host benchmark report must remain non-release evidence")
    boundary = str(data.get("claim_boundary", ""))
    if "not target silicon" not in boundary or "must not be used for release" not in boundary:
        raise ValueError("local host benchmark report claim boundary is too weak")
    return {
        "status": str(data.get("status")),
        "passed_count": int(summary.get("passed_count", 0)),
        "partial_timeout_count": int(summary.get("partial_timeout_count", 0)),
        "release_claim_allowed": False,
    }


def chipyard_import_preflight_summary() -> dict[str, Any]:
    for path in CHIPYARD_IMPORT_PREFLIGHT_REPORTS:
        if not path.is_file():
            continue
        data = load_json_object(path)
        if data.get("schema") != "eliza.cpu_ap_bootstrap_preflight.v1":
            raise ValueError(f"{rel(path)} schema mismatch")
        status = str(data.get("status", "missing"))
        selected = data.get("selected_path")
        chipyard = data.get("chipyard")
        if not isinstance(selected, dict) or not isinstance(chipyard, dict):
            raise ValueError(f"{rel(path)} missing Chipyard selected path metadata")
        return {
            "status": status,
            "artifact": rel(path),
            "checkout": str(data.get("checkout", "")),
            "config_name": str(selected.get("config_name", "")),
            "chipyard_tag": str(chipyard.get("tag", "")),
            "chipyard_commit": str(chipyard.get("commit", "")),
            "blocker_count": len(data.get("blockers") or []),
            "error_count": len(data.get("errors") or []),
        }
    return {
        "status": "missing",
        "artifact": "",
        "checkout": "",
        "config_name": "",
        "chipyard_tag": "",
        "chipyard_commit": "",
        "blocker_count": 0,
        "error_count": 0,
    }


def build_report() -> dict[str, Any]:
    scorecard = load_yaml_object(SCORECARD)
    manual_review = load_yaml_object(MANUAL_REVIEW)
    competitive = load_json_object(COMPETITIVE)
    process_eval = load_json_object(PROCESS_EVAL)
    modeled_eval = load_json_object(MODELED_EVAL)
    npu_context_queue = load_json_object(NPU_CONTEXT_QUEUE_SIM)
    memory_iommu_qos = load_json_object(MEMORY_IOMMU_QOS_SIM)

    modeled_rows = modeled_report_rows()
    proof_rows = proof_domain_rows(scorecard)
    tools = tool_rows()
    benchmark_rows = benchmark_release_rows()
    local_host_summary = local_host_benchmark_summary()
    chipyard_preflight = chipyard_import_preflight_summary()

    competitive_metrics = competitive.get("envelope_metrics")
    process_metrics = process_eval.get("baseline_metrics")
    modeled_metrics = modeled_eval.get("modeled_metrics")
    if not isinstance(competitive_metrics, dict):
        raise ValueError("competitive envelope missing envelope_metrics")
    if not isinstance(process_metrics, dict) or not isinstance(modeled_metrics, dict):
        raise ValueError("process/modeled eval missing metrics")
    queue_config = npu_context_queue.get("config")
    queue_summary = npu_context_queue.get("summary")
    if not isinstance(queue_config, dict) or not isinstance(queue_summary, dict):
        raise ValueError("NPU context queue simulator missing config/summary")
    memory_qos_config = memory_iommu_qos.get("config")
    memory_qos_summary = memory_iommu_qos.get("summary")
    if not isinstance(memory_qos_config, dict) or not isinstance(memory_qos_summary, dict):
        raise ValueError("memory IOMMU/QoS simulator missing config/summary")

    modeled_local_complete = all(row["status"] == "pass" for row in modeled_rows)
    blocked_domains = [row["id"] for row in proof_rows if row["status"] == "blocked"]
    blocked_tools = [row["id"] for row in tools if row["status"] == "blocked"]
    blocked_benchmarks = [row["id"] for row in benchmark_rows if row["status"] == "blocked"]
    blocked_benchmark_requirements = sorted(
        {
            name
            for row in benchmark_rows
            for name in row.get("blocked_requirement_names", [])
            if isinstance(name, str)
        }
    )
    release_blocker_count = len(blocked_domains) + len(blocked_tools) + len(blocked_benchmarks)
    checks = [
        check_row(
            "modeled_cpu_npu_stack_complete",
            "pass" if modeled_local_complete else "fail",
            "All local CPU/NPU modeled reports exist with their expected release-blocked statuses.",
        ),
        check_row(
            "competitive_envelope_metrics_pass",
            "pass"
            if require_number(
                competitive_metrics.get("npu_process_derated_dense_tops"),
                "process derated dense TOPS",
            )
            >= 160.0
            and require_number(
                competitive_metrics.get("sustained_package_power_w"), "sustained power"
            )
            <= 5.0
            and require_number(competitive_metrics.get("burst_hotspot_die_c"), "burst hotspot")
            < 95.0
            else "fail",
            "Competitive planning envelope keeps CPU/NPU power, thermal, and process-derated NPU headroom inside target bounds.",
        ),
        check_row(
            "release_evidence_incomplete_blocked",
            "blocked" if release_blocker_count > 0 else "pass",
            "Real AOSP, benchmark, power/thermal, PDK/signoff, memory, CPU/AP, NNAPI, and tool evidence is still incomplete.",
        ),
        check_row(
            "final_tapeout_claim_blocked",
            "blocked",
            "Tapeout readiness cannot be claimed until every proof domain and tool/evidence dependency is unblocked with real evidence.",
        ),
    ]
    failed = [row["id"] for row in checks if row["status"] == "fail"]
    blocked = [row["id"] for row in checks if row["status"] == "blocked"]
    return {
        "schema": "eliza.cpu_npu_2028_tapeout_readiness_audit.v1",
        "status": "fail" if failed else "tapeout_release_blocked" if blocked else "pass",
        "claim_boundary": (
            "Tapeout readiness audit for local CPU/NPU modeled evidence only; this is not "
            "AOSP, measured benchmark, PDK, physical signoff, silicon, or tapeout approval."
        ),
        **FALSE_CLAIM_FLAGS,
        "false_claim_flags": FALSE_CLAIM_FLAGS,
        "source_artifacts": {
            "readiness_scorecard": rel(SCORECARD),
            "manual_review": rel(MANUAL_REVIEW),
            "competitive_envelope": rel(COMPETITIVE),
            "process_eval": rel(PROCESS_EVAL),
            "modeled_eval": rel(MODELED_EVAL),
            "benchmark_dry_run_report": rel(DRY_RUN_REPORT),
            "local_host_benchmark_report": rel(LOCAL_HOST_BENCHMARK_REPORT),
            "chipyard_import_preflight_report": chipyard_preflight["artifact"],
        },
        "modeled_reports": modeled_rows,
        "proof_domains": proof_rows,
        "toolchain_readiness": tools,
        "benchmark_release_readiness": benchmark_rows,
        "summary": {
            "modeled_report_count": len(modeled_rows),
            "modeled_local_complete": modeled_local_complete,
            "blocked_proof_domain_count": len(blocked_domains),
            "blocked_tool_count": len(blocked_tools),
            "blocked_benchmark_count": len(blocked_benchmarks),
            "blocked_proof_domains": blocked_domains,
            "blocked_tools": blocked_tools,
            "blocked_benchmarks": blocked_benchmarks,
            "blocked_benchmark_requirements": blocked_benchmark_requirements,
            "local_host_benchmark_status": local_host_summary["status"],
            "local_host_benchmark_passed_count": local_host_summary["passed_count"],
            "local_host_benchmark_partial_timeout_count": local_host_summary[
                "partial_timeout_count"
            ],
            "local_host_benchmark_release_claim_allowed": local_host_summary[
                "release_claim_allowed"
            ],
            "chipyard_import_preflight_status": chipyard_preflight["status"],
            "chipyard_import_preflight_artifact": chipyard_preflight["artifact"],
            "chipyard_import_preflight_blocker_count": chipyard_preflight["blocker_count"],
            "chipyard_import_preflight_error_count": chipyard_preflight["error_count"],
            "competitive_npu_process_derated_dense_tops": require_number(
                competitive_metrics.get("npu_process_derated_dense_tops"),
                "process derated dense TOPS",
            ),
            "competitive_sustained_package_power_w": require_number(
                competitive_metrics.get("sustained_package_power_w"), "sustained power"
            ),
            "competitive_burst_hotspot_die_c": require_number(
                competitive_metrics.get("burst_hotspot_die_c"), "burst hotspot"
            ),
            "modeled_npu_sota_dma_queue_depth": require_number(
                modeled_metrics.get("npu_sota_dma_queue_depth"), "SOTA NPU queue depth"
            ),
            "modeled_npu_sota_total_descriptors_required": require_number(
                modeled_metrics.get("npu_sota_total_descriptors_required"),
                "SOTA NPU descriptors",
            ),
            "modeled_npu_sota_max_descriptor_queue_passes": require_number(
                modeled_metrics.get("npu_sota_max_descriptor_queue_passes"),
                "SOTA NPU queue passes",
            ),
            "modeled_npu_sota_total_dma_beats": require_number(
                modeled_metrics.get("npu_sota_total_dma_beats"), "SOTA NPU DMA beats"
            ),
            "modeled_npu_context_queue_contexts": require_number(
                queue_config.get("concurrent_contexts"), "NPU context count"
            ),
            "modeled_npu_context_queue_depth": require_number(
                queue_config.get("descriptor_queue_depth"), "NPU context queue depth"
            ),
            "modeled_npu_context_queue_jain_fairness": require_number(
                queue_summary.get("jain_fairness_index"), "NPU context queue fairness"
            ),
            "modeled_npu_context_queue_max_service_gap_cycles": require_number(
                queue_summary.get("max_service_gap_cycles"), "NPU context queue service gap"
            ),
            "modeled_npu_context_queue_total_dma_beats": require_number(
                queue_summary.get("total_dma_beats_served"), "NPU context queue DMA beats"
            ),
            "modeled_memory_iommu_qos_streams": require_number(
                memory_qos_config.get("stream_count"), "memory IOMMU/QoS stream count"
            ),
            "modeled_memory_iommu_fault_probes": require_number(
                memory_qos_summary.get("fault_probe_count"), "memory IOMMU fault probes"
            ),
            "modeled_memory_iommu_deny_by_default_faults": require_number(
                memory_qos_summary.get("deny_by_default_fault_count"),
                "memory IOMMU deny-by-default faults",
            ),
            "modeled_memory_qos_display_underflows": require_number(
                memory_qos_summary.get("display_underflow_count"),
                "memory QoS display underflows",
            ),
            "modeled_memory_qos_isochronous_max_gap_cycles": require_number(
                memory_qos_summary.get("isochronous_max_service_gap_cycles"),
                "memory QoS isochronous gap",
            ),
            "manual_review_status": str(manual_review.get("status")),
            "scorecard_status": str(scorecard.get("status")),
        },
        "checks": checks,
        "release_claim_forbidden_until": [
            "All proof_domains have pass status with real artifacts, not templates.",
            "All required host/simulator/benchmark tools are installed or explicitly configured.",
            "AOSP virtual-device logs prove CPU/NPU scheduler, thermal, and NNAPI behavior.",
            "Measured power, thermal, clock, memory, benchmark, and workload traces are archived.",
            "Selected 14A PDK, extracted timing/RC/IR/EM/thermal/reliability, DFT, and physical signoff reports pass.",
        ],
    }


def validate_report(data: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if data.get("schema") != "eliza.cpu_npu_2028_tapeout_readiness_audit.v1":
        errors.append("schema mismatch")
    if data.get("status") != "tapeout_release_blocked":
        errors.append("tapeout audit must remain tapeout_release_blocked")
    if "not AOSP" not in str(data.get("claim_boundary", "")):
        errors.append("claim boundary must block AOSP/tapeout claims")
    for key, value in FALSE_CLAIM_FLAGS.items():
        if data.get(key) is not value:
            errors.append(f"{key} must be exactly false")
    if data.get("false_claim_flags") != FALSE_CLAIM_FLAGS:
        errors.append("false_claim_flags must match tapeout readiness denied claim fields")
    summary = data.get("summary")
    if not isinstance(summary, dict):
        errors.append("summary must be a mapping")
        return errors
    if summary.get("modeled_local_complete") is not True:
        errors.append("modeled local CPU/NPU stack must be complete")
    if require_number(summary.get("blocked_proof_domain_count"), "blocked proof domain count") <= 0:
        errors.append("audit must keep release blocked until proof domains are real")
    if require_number(summary.get("blocked_benchmark_count"), "blocked benchmark count") <= 0:
        errors.append("audit must enumerate blocked benchmark release rows")
    if require_number(summary.get("modeled_npu_sota_dma_queue_depth"), "NPU queue depth") < 1024:
        errors.append("audit must preserve modeled NPU queue depth")
    if (
        require_number(
            summary.get("modeled_npu_sota_max_descriptor_queue_passes"), "NPU queue passes"
        )
        != 1.0
    ):
        errors.append("audit must preserve one-pass SOTA descriptor queue budget")
    if require_number(summary.get("modeled_npu_sota_total_dma_beats"), "NPU DMA beats") <= 0:
        errors.append("audit must preserve modeled NPU DMA beats")
    if require_number(summary.get("modeled_npu_context_queue_contexts"), "context count") < 8:
        errors.append("audit must preserve modeled 8-context NPU queue evidence")
    if require_number(summary.get("modeled_npu_context_queue_depth"), "context queue depth") < 1024:
        errors.append("audit must preserve modeled NPU context queue depth")
    if require_number(summary.get("modeled_npu_context_queue_jain_fairness"), "fairness") < 0.99:
        errors.append("audit must preserve modeled NPU context queue fairness")
    if require_number(summary.get("modeled_npu_context_queue_max_service_gap_cycles"), "gap") > 32:
        errors.append("audit must preserve modeled NPU no-starvation service gap")
    if require_number(summary.get("modeled_memory_iommu_qos_streams"), "memory streams") < 9:
        errors.append("audit must preserve modeled memory IOMMU stream coverage")
    if require_number(summary.get("modeled_memory_iommu_fault_probes"), "IOMMU faults") < 4:
        errors.append("audit must preserve modeled memory IOMMU fault coverage")
    if (
        require_number(
            summary.get("modeled_memory_iommu_deny_by_default_faults"),
            "deny-by-default faults",
        )
        < 1
    ):
        errors.append("audit must preserve modeled deny-by-default IOMMU fault coverage")
    if require_number(summary.get("modeled_memory_qos_display_underflows"), "underflows") != 0:
        errors.append("audit must preserve no-underflow modeled display QoS")
    if (
        require_number(
            summary.get("modeled_memory_qos_isochronous_max_gap_cycles"),
            "isochronous gap",
        )
        > 32
    ):
        errors.append("audit must preserve modeled isochronous QoS service gap")
    requirements = summary.get("blocked_benchmark_requirements")
    if (
        not isinstance(requirements, list)
        or "benchmarks/capabilities/e1_npu_nnapi.proof.json" not in requirements
    ):
        errors.append("audit must list e1 NPU NNAPI proof as a blocked benchmark requirement")
    benchmark_rows = data.get("benchmark_release_readiness")
    if not isinstance(benchmark_rows, list):
        errors.append("benchmark_release_readiness must be a list")
    elif not any(
        isinstance(row, dict)
        and row.get("id") == "tflite_e1_npu"
        and row.get("status") == "blocked"
        for row in benchmark_rows
    ):
        errors.append("tflite_e1_npu must remain blocked until NNAPI proof exists")
    checks = data.get("checks")
    if not isinstance(checks, list):
        errors.append("checks must be a list")
        return errors
    by_id = {row.get("id"): row for row in checks if isinstance(row, dict)}
    for row_id in ("modeled_cpu_npu_stack_complete", "competitive_envelope_metrics_pass"):
        if by_id.get(row_id, {}).get("status") != "pass":
            errors.append(f"{row_id} must pass")
    for row_id in ("release_evidence_incomplete_blocked", "final_tapeout_claim_blocked"):
        if by_id.get(row_id, {}).get("status") != "blocked":
            errors.append(f"{row_id} must remain blocked")
    return errors


def main() -> int:
    try:
        data = build_report()
        errors = validate_report(data)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        data = None
        errors = [str(exc)]
    if errors:
        print("CPU+NPU tapeout readiness audit failed:")
        for error in errors:
            print(f"  - {error}")
        return 1
    assert data is not None
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(
        f"CPU+NPU tapeout readiness audit passed: {OUT.relative_to(ROOT)} remains release-blocked."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
