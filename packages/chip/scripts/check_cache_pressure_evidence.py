#!/usr/bin/env python3
"""Fail-closed gate for cache pressure/contention evidence.

This gate does not claim phone-class cache or memory throughput. It checks for
the evidence a future cocotb pressure harness must emit and, when that report is
missing, writes a blocked report that captures the current known structural
gaps: single outstanding miss pressure, blocked cycles, max in-flight misses,
display/QoS service-window violations, and p95 miss latency.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_REPORT = ROOT / "docs/evidence/cache/cache_pressure_report.json"

SCHEMA = "eliza.cache_pressure_evidence.v1"
MEASURED_EVIDENCE_CLASS = "rtl_cocotb_pressure_measurement"
REQUIRED_METRICS = {
    "attempted_misses",
    "completed_misses",
    "blocked_cycles",
    "max_in_flight_misses",
    "display_service_window_violations",
    "p95_miss_latency_cycles",
}
REQUIRED_COVERAGE_LEVELS = {"l1d", "l2", "l3", "slc"}
REQUIRED_CONTENTION_AGENTS = {"cpu_miss_stream", "display_qos"}
PHONE_CLAIM_LEVELS = {"L5_PROTOTYPE_SILICON", "L6_COMPLETE_PHONE"}
CACHE_PRESSURE_MAX_AGE = timedelta(days=30)
REQUIRED_HARNESS = ROOT / "verify/cocotb/cache/test_cache_pressure.py"
EXPECTED_JUNIT_RESULTS = {
    "e1_l1d_cache": (
        ROOT / "verify/cocotb/cache/results/e1_l1d_cache_test_cache_pressure.xml",
        "test_l1d_pressure_records_mshr_depth",
    ),
    "e1_l2_tb": (
        ROOT / "verify/cocotb/cache/results/e1_l2_tb_test_cache_pressure.xml",
        "test_l2_pressure_miss_path_records_coverage",
    ),
    "e1_l3_tb": (
        ROOT / "verify/cocotb/cache/results/e1_l3_tb_test_cache_pressure.xml",
        "test_l3_pressure_miss_path_records_coverage",
    ),
    "e1_slc_tb": (
        ROOT / "verify/cocotb/cache/results/e1_slc_tb_test_cache_pressure.xml",
        "test_slc_pressure_and_display_qos_records_coverage",
    ),
}
LMBENCH_BLOCKED = ROOT / "docs/evidence/memory/lmbench_blocked.json"
LMBENCH_SUMMARY = ROOT / "docs/evidence/memory/lmbench_summary.json"
L5_L6_MEMORY_REPORTS = {
    "lpddr_bandwidth_latency_benchmark_report": ROOT
    / "docs/evidence/memory/lpddr_bandwidth_latency_benchmark_report.json",
    "contended_bandwidth_latency_report": ROOT
    / "docs/evidence/memory/contended_bandwidth_latency_report.json",
    "contended_android_memory_trace": ROOT
    / "docs/evidence/memory/contended_android_memory_trace.json",
    "phone_2028_memory_scorecard": ROOT / "docs/evidence/memory/phone_2028_memory_scorecard.json",
}
REQUIRED_RTL_TOKENS = {
    "l1d_single_miss_issue_gate": (
        ROOT / "rtl/cache/l1d/e1_l1d_cache.sv",
        r"!acq_pending_q",
        (
            "L1D has a 4-entry MSHR scaffold, but new miss allocation / "
            "outbound acquire issue is still gated by one acquisition-pending bit."
        ),
    ),
    "l2_idle_accept_only": (
        ROOT / "rtl/cache/l2/e1_l2_cache.sv",
        r"state_q\s*==\s*S_IDLE",
        "L2 request acceptance is tied to idle state.",
    ),
    "l3_idle_accept_only": (
        ROOT / "rtl/cache/l3/e1_l3_cache.sv",
        r"state_q\s*==\s*T_IDLE",
        "L3 request acceptance is tied to idle state.",
    ),
    "slc_idle_accept_only": (
        ROOT / "rtl/cache/slc/e1_slc.sv",
        r"state_q\s*==\s*U_IDLE",
        "SLC request acceptance is tied to idle state.",
    ),
}


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def load_json(path: Path) -> tuple[dict[str, Any] | None, str | None]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None, "missing"
    except json.JSONDecodeError as exc:
        return None, f"invalid_json:{exc}"
    if not isinstance(data, dict):
        return None, "not_object"
    return data, None


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_utc_timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        return None
    return parsed.astimezone(timezone.utc)


def resolve_artifact_path(value: Any) -> Path | None:
    if not isinstance(value, str) or not value:
        return None
    path = Path(value)
    if path.is_absolute() or ".." in path.parts:
        return None
    return ROOT / path


def generated_by_findings(data: dict[str, Any], report_path: Path) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    if data.get("generated_by") != rel(REQUIRED_HARNESS):
        findings.append(
            {
                "name": "generated_by",
                "path": rel(report_path),
                "status": "invalid",
                "reason": f"generated_by must be {rel(REQUIRED_HARNESS)}",
            }
        )
    declared_sha = data.get("generated_by_sha256")
    if not REQUIRED_HARNESS.is_file():
        findings.append(
            {
                "name": "generated_by_sha256",
                "path": rel(REQUIRED_HARNESS),
                "status": "missing",
                "reason": "required cocotb pressure harness is missing",
            }
        )
    elif not isinstance(declared_sha, str) or re.fullmatch(r"[0-9a-f]{64}", declared_sha) is None:
        findings.append(
            {
                "name": "generated_by_sha256",
                "path": rel(report_path),
                "status": "invalid",
                "reason": "generated_by_sha256 must hash-bind the cocotb harness",
            }
        )
    elif sha256_file(REQUIRED_HARNESS) != declared_sha:
        findings.append(
            {
                "name": "generated_by_sha256",
                "path": rel(REQUIRED_HARNESS),
                "status": "invalid",
                "reason": "generated_by_sha256 does not match the cocotb harness",
            }
        )
    return findings


def junit_result_artifact_findings(data: dict[str, Any], report_path: Path) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    artifacts = data.get("result_artifacts")
    if not isinstance(artifacts, dict):
        return [
            {
                "name": "result_artifacts",
                "path": rel(report_path),
                "status": "invalid",
                "reason": "measured pressure reports must hash-bind cocotb JUnit XML result_artifacts",
            }
        ]

    for top, (default_path, active_testcase) in EXPECTED_JUNIT_RESULTS.items():
        scope = f"result_artifacts.{top}"
        artifact = artifacts.get(top)
        if not isinstance(artifact, dict):
            findings.append(
                {
                    "name": scope,
                    "path": rel(report_path),
                    "status": "missing",
                    "reason": "missing required cocotb JUnit XML artifact binding",
                }
            )
            continue
        path = resolve_artifact_path(artifact.get("path"))
        expected_rel = rel(default_path)
        if path is None:
            findings.append(
                {
                    "name": f"{scope}.path",
                    "path": rel(report_path),
                    "status": "invalid",
                    "reason": "path must be a relative chip-tree path",
                }
            )
            continue
        if rel(path) != expected_rel:
            findings.append(
                {
                    "name": f"{scope}.path",
                    "path": rel(path),
                    "status": "invalid",
                    "reason": f"path must be {expected_rel}",
                }
            )
        if not path.is_file():
            findings.append(
                {
                    "name": f"{scope}.path",
                    "path": rel(path),
                    "status": "missing",
                    "reason": "cocotb JUnit XML artifact is missing",
                }
            )
            continue
        declared_sha = artifact.get("sha256")
        if not isinstance(declared_sha, str) or re.fullmatch(r"[0-9a-f]{64}", declared_sha) is None:
            findings.append(
                {
                    "name": f"{scope}.sha256",
                    "path": rel(path),
                    "status": "invalid",
                    "reason": "sha256 must be lowercase SHA-256 hex",
                }
            )
        elif sha256_file(path) != declared_sha:
            findings.append(
                {
                    "name": f"{scope}.sha256",
                    "path": rel(path),
                    "status": "invalid",
                    "reason": "sha256 does not match cocotb JUnit XML artifact",
                }
            )
        try:
            root = ET.parse(path).getroot()
        except ET.ParseError as exc:
            findings.append(
                {
                    "name": f"{scope}.xml",
                    "path": rel(path),
                    "status": "invalid",
                    "reason": f"JUnit XML is not parseable: {exc}",
                }
            )
            continue
        bad_nodes = []
        for testcase in root.iter("testcase"):
            name = testcase.attrib.get("name", "<unnamed>")
            for tag in ("failure", "error", "skipped"):
                if testcase.find(tag) is not None:
                    bad_nodes.append(f"{name}:{tag}")
        if bad_nodes:
            findings.append(
                {
                    "name": f"{scope}.xml",
                    "path": rel(path),
                    "status": "invalid",
                    "reason": "JUnit XML contains non-passing testcase nodes: " + ", ".join(bad_nodes),
                }
            )
        active = None
        for testcase in root.iter("testcase"):
            if testcase.attrib.get("name") == active_testcase:
                active = testcase
                break
        if active is None:
            findings.append(
                {
                    "name": f"{scope}.active_testcase",
                    "path": rel(path),
                    "status": "missing",
                    "reason": f"JUnit XML missing expected active testcase {active_testcase}",
                }
            )
        else:
            sim_time = active.attrib.get("sim_time_ns")
            try:
                sim_time_value = float(sim_time) if sim_time is not None else 0.0
            except ValueError:
                sim_time_value = 0.0
            if sim_time_value <= 0.001:
                findings.append(
                    {
                        "name": f"{scope}.active_testcase",
                        "path": rel(path),
                        "status": "invalid",
                        "reason": f"active testcase {active_testcase} has no measured simulation time",
                    }
                )
    return findings


def rtl_structural_findings() -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    for name, (path, pattern, reason) in REQUIRED_RTL_TOKENS.items():
        base = {"name": name, "path": rel(path)}
        try:
            text = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            findings.append({**base, "status": "missing", "reason": "required RTL missing"})
            continue
        if re.search(pattern, text):
            findings.append(
                {
                    **base,
                    "status": "gap_observed",
                    "reason": reason,
                }
            )
        else:
            findings.append(
                {
                    **base,
                    "status": "needs_review",
                    "reason": "expected structural pressure token not found; inspect RTL and update gate",
                }
            )
    return findings


def memory_evidence_findings() -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    if LMBENCH_BLOCKED.is_file():
        data, error = load_json(LMBENCH_BLOCKED)
        reason = "lmbench memory runner emitted a blocked marker."
        if error is None and data is not None:
            reason = str(data.get("reason") or reason)
        findings.append(
            {
                "name": "lmbench_memory_runner",
                "path": rel(LMBENCH_BLOCKED),
                "status": "blocked",
                "reason": reason,
            }
        )
    elif LMBENCH_SUMMARY.is_file():
        findings.append(
            {
                "name": "lmbench_memory_runner",
                "path": rel(LMBENCH_SUMMARY),
                "status": "pass",
                "reason": (
                    "lmbench memory summary is present; L5/L6 release suitability "
                    "is checked by the real-target memory report gates."
                ),
            }
        )
    else:
        findings.append(
            {
                "name": "lmbench_memory_runner",
                "path": rel(LMBENCH_BLOCKED),
                "status": "missing",
                "reason": (
                    "No lmbench memory summary or blocked marker is present; run "
                    "`make lmbench-bw` to refresh the target-memory evidence path."
                ),
            }
        )

    missing_reports = [
        {"name": name, "path": rel(path)}
        for name, path in sorted(L5_L6_MEMORY_REPORTS.items())
        if not path.is_file()
    ]
    findings.append(
        {
            "name": "l5_l6_memory_real_target_reports",
            "path": "docs/evidence/memory",
            "status": "missing" if missing_reports else "pass",
            "reason": (
                "Phone-class memory evidence requires real-target L5/L6 bandwidth, "
                "latency, contention, Android shared-buffer, and scorecard artifacts."
                if missing_reports
                else "Required L5/L6 memory report paths exist; schema validation is delegated to memory-evidence-template-check."
            ),
            "missing_reports": missing_reports,
        }
    )
    return findings


def missing_report(report_path: Path) -> dict[str, Any]:
    harness_status = "present" if REQUIRED_HARNESS.is_file() else "missing"
    findings = [
        {
            "name": "cache_pressure_cocotb_harness",
            "path": rel(REQUIRED_HARNESS),
            "status": harness_status,
            "reason": (
                "Required cocotb pressure harness must drive L1D/L2/L3/SLC "
                "miss pressure and SLC display/QoS contention."
            ),
        },
        {
            "name": "cache_pressure_metrics",
            "path": rel(report_path),
            "status": "missing",
            "reason": "No measured cache pressure report has been generated.",
            "required_metrics": sorted(REQUIRED_METRICS),
        },
    ]
    findings.extend(rtl_structural_findings())
    findings.extend(memory_evidence_findings())
    return {
        "schema": SCHEMA,
        "status": "blocked",
        "claim_allowed": False,
        "rtl_pressure_claim_allowed": False,
        "phone_claim_allowed": False,
        "release_claim_allowed": False,
        "evidence_class": "missing_cocotb_cache_pressure_harness",
        "claim_boundary": (
            "Cache throughput/QoS claims require a measured pressure report from "
            "a harness that drives outstanding CPU misses plus display/QoS "
            "contention through the current cache RTL."
        ),
        "required_harness": rel(REQUIRED_HARNESS),
        "required_metrics": sorted(REQUIRED_METRICS),
        "metrics": {
            "attempted_misses": None,
            "completed_misses": None,
            "blocked_cycles": None,
            "max_in_flight_misses": None,
            "display_service_window_violations": None,
            "p95_miss_latency_cycles": None,
        },
        "findings": findings,
        "blockers": [
            "L1D/L2/L3/SLC pressure cocotb harness has not produced a measured report for this gate invocation.",
            "No measured max in-flight miss depth or blocked-cycle count.",
            "No display/QoS service-window measurement under CPU miss pressure.",
            "No p95 miss latency measurement through the hierarchy.",
            "No real DRAM/LPDDR controller, PHY, refresh, training, or bandwidth model.",
            "No L5/L6 real-target memory bandwidth, latency, contention, Android trace, or scorecard artifacts.",
        ],
    }


def validate_measured_report(data: dict[str, Any], report_path: Path) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    if data.get("schema") != SCHEMA:
        findings.append(
            {
                "name": "schema",
                "path": rel(report_path),
                "status": "invalid",
                "reason": f"schema must be {SCHEMA}",
            }
        )
    if data.get("source") != "cocotb-cache-pressure":
        findings.append(
            {
                "name": "source",
                "path": rel(report_path),
                "status": "invalid",
                "reason": "source must be cocotb-cache-pressure",
            }
        )
    if data.get("status") != "pass":
        findings.append(
            {
                "name": "status",
                "path": rel(report_path),
                "status": "invalid",
                "reason": "measured cache-pressure reports must be producer-status pass; stale blocked reports stay blocked",
                "record_status": data.get("status"),
            }
        )
    captured = parse_utc_timestamp(data.get("captured_utc"))
    if captured is None:
        findings.append(
            {
                "name": "captured_utc",
                "path": rel(report_path),
                "status": "invalid",
                "reason": "captured_utc must be an ISO-8601 timestamp with timezone",
            }
        )
    else:
        now = datetime.now(timezone.utc)
        if captured > now + timedelta(minutes=5):
            findings.append(
                {
                    "name": "captured_utc",
                    "path": rel(report_path),
                    "status": "invalid",
                    "reason": "captured_utc must not be in the future",
                }
            )
        elif now - captured > CACHE_PRESSURE_MAX_AGE:
            findings.append(
                {
                    "name": "captured_utc",
                    "path": rel(report_path),
                    "status": "invalid",
                    "reason": f"captured_utc is older than {CACHE_PRESSURE_MAX_AGE.days} days; refresh pressure evidence",
                }
            )
    claim_boundary = data.get("claim_boundary")
    if not (
        isinstance(claim_boundary, str)
        and "not" in claim_boundary.lower()
        and "phone" in claim_boundary.lower()
        and "release" in claim_boundary.lower()
    ):
        findings.append(
            {
                "name": "claim_boundary",
                "path": rel(report_path),
                "status": "invalid",
                "reason": "claim_boundary must explicitly block phone/release promotion",
            }
        )
    if data.get("claim_level") in PHONE_CLAIM_LEVELS:
        findings.append(
            {
                "name": "claim_level",
                "path": rel(report_path),
                "status": "invalid",
                "reason": (
                    "cocotb cache-pressure evidence cannot carry L5/L6 "
                    "prototype-silicon or complete-phone claim levels"
                ),
                "claim_level": data.get("claim_level"),
            }
        )
    for claim_field in ("claim_allowed", "phone_claim_allowed", "release_claim_allowed"):
        if data.get(claim_field) is not False:
            findings.append(
                {
                    "name": claim_field,
                    "path": rel(report_path),
                    "status": "invalid",
                    "reason": (
                        "cache-pressure cocotb evidence must explicitly set generic, "
                        "phone, and release claim flags to false; only "
                        "rtl_pressure_claim_allowed may be true after validation"
                    ),
                }
            )
    if data.get("evidence_class") != MEASURED_EVIDENCE_CLASS:
        findings.append(
            {
                "name": "evidence_class",
                "path": rel(report_path),
                "status": "invalid",
                "reason": (
                    "measured cache-pressure reports must use "
                    f"{MEASURED_EVIDENCE_CLASS}"
                ),
            }
        )
    findings.extend(generated_by_findings(data, report_path))
    findings.extend(junit_result_artifact_findings(data, report_path))
    top_levels = data.get("cocotb_top_levels")
    if not isinstance(top_levels, list) or not all(isinstance(item, str) for item in top_levels):
        findings.append(
            {
                "name": "cocotb_top_levels",
                "path": rel(report_path),
                "status": "invalid",
                "reason": "cocotb_top_levels must list the top modules used to generate the report",
            }
        )
    else:
        required_tops = {"e1_l1d_cache", "e1_l2_tb", "e1_l3_tb", "e1_slc_tb"}
        missing_tops = sorted(required_tops - set(top_levels))
        if missing_tops:
            findings.append(
                {
                    "name": "cocotb_top_levels",
                    "path": rel(report_path),
                    "status": "missing",
                    "reason": "measured report does not record every required cocotb top level",
                    "missing": missing_tops,
                }
            )
    coverage = data.get("coverage")
    if not isinstance(coverage, list) or not all(isinstance(item, str) for item in coverage):
        findings.append(
            {
                "name": "coverage",
                "path": rel(report_path),
                "status": "invalid",
                "reason": "coverage must list exercised cache levels",
                "required": sorted(REQUIRED_COVERAGE_LEVELS),
            }
        )
    else:
        missing_coverage = sorted(REQUIRED_COVERAGE_LEVELS - set(coverage))
        if missing_coverage:
            findings.append(
                {
                    "name": "coverage",
                    "path": rel(report_path),
                    "status": "missing",
                    "reason": "pressure evidence does not cover the full cache hierarchy",
                    "missing": missing_coverage,
                }
            )
    agents = data.get("contention_agents")
    if not isinstance(agents, list) or not all(isinstance(item, str) for item in agents):
        findings.append(
            {
                "name": "contention_agents",
                "path": rel(report_path),
                "status": "invalid",
                "reason": "contention_agents must list exercised traffic classes",
                "required": sorted(REQUIRED_CONTENTION_AGENTS),
            }
        )
    else:
        missing_agents = sorted(REQUIRED_CONTENTION_AGENTS - set(agents))
        if missing_agents:
            findings.append(
                {
                    "name": "contention_agents",
                    "path": rel(report_path),
                    "status": "missing",
                    "reason": "pressure evidence does not include required contention traffic",
                    "missing": missing_agents,
                }
            )
    metrics = data.get("metrics")
    if not isinstance(metrics, dict):
        findings.append(
            {
                "name": "metrics",
                "path": rel(report_path),
                "status": "invalid",
                "reason": "metrics must be an object",
            }
        )
        return findings
    for metric in sorted(REQUIRED_METRICS):
        value = metrics.get(metric)
        if not isinstance(value, int | float) or isinstance(value, bool):
            findings.append(
                {
                    "name": metric,
                    "path": rel(report_path),
                    "status": "invalid",
                    "reason": "metric must be numeric",
                }
            )
    attempted_misses = metrics.get("attempted_misses")
    completed_misses = metrics.get("completed_misses")
    blocked_cycles = metrics.get("blocked_cycles")
    p95_miss_latency_cycles = metrics.get("p95_miss_latency_cycles")
    display_violations = metrics.get("display_service_window_violations")
    if isinstance(attempted_misses, int | float) and attempted_misses <= 0:
    if (
        isinstance(metrics.get("attempted_misses"), int | float)
        and metrics["attempted_misses"] <= 0
    ):
        findings.append(
            {
                "name": "attempted_misses",
                "path": rel(report_path),
                "status": "invalid",
                "reason": "pressure harness must attempt at least one miss",
            }
        )
    if isinstance(completed_misses, int | float) and completed_misses <= 0:
        findings.append(
            {
                "name": "completed_misses",
                "path": rel(report_path),
                "status": "invalid",
                "reason": "pressure harness must complete at least one miss",
            }
        )
    if (
        isinstance(attempted_misses, int | float)
        and isinstance(completed_misses, int | float)
        and completed_misses > attempted_misses
    ):
        findings.append(
            {
                "name": "completed_misses",
                "path": rel(report_path),
                "status": "invalid",
                "reason": "completed misses cannot exceed attempted misses",
            }
        )
    if isinstance(blocked_cycles, int | float) and blocked_cycles < 0:
        findings.append(
            {
                "name": "blocked_cycles",
                "path": rel(report_path),
                "status": "invalid",
                "reason": "blocked cycle count cannot be negative",
            }
        )
    if isinstance(p95_miss_latency_cycles, int | float) and p95_miss_latency_cycles <= 0:
        findings.append(
            {
                "name": "p95_miss_latency_cycles",
                "path": rel(report_path),
                "status": "invalid",
                "reason": "p95 miss latency must be positive",
            }
        )
    if isinstance(metrics.get("max_in_flight_misses"), int | float) and metrics[
        "max_in_flight_misses"
    ] < 2:
    if (
        isinstance(metrics.get("max_in_flight_misses"), int | float)
        and metrics["max_in_flight_misses"] < 2
    ):
        findings.append(
            {
                "name": "max_in_flight_misses",
                "path": rel(report_path),
                "status": "gap_observed",
                "reason": "current hierarchy did not sustain multiple in-flight misses",
            }
        )
    if isinstance(display_violations, int | float) and display_violations < 0:
        findings.append(
            {
                "name": "display_service_window_violations",
                "path": rel(report_path),
                "status": "invalid",
                "reason": "display/QoS service window violations cannot be negative",
            }
        )
    if isinstance(display_violations, int | float) and display_violations > 0:
    if (
        isinstance(metrics.get("display_service_window_violations"), int | float)
        and metrics["display_service_window_violations"] > 0
    ):
        findings.append(
            {
                "name": "display_service_window_violations",
                "path": rel(report_path),
                "status": "gap_observed",
                "reason": "display/QoS service window was violated under contention",
            }
        )
    return findings


def measured_report(report_path: Path, data: dict[str, Any]) -> dict[str, Any]:
    pressure_findings = validate_measured_report(data, report_path)
    memory_findings = memory_evidence_findings()
    findings = pressure_findings + memory_findings
    blocking = [
        item for item in pressure_findings if item["status"] in {"invalid", "missing"}
    ]
    gaps = [item for item in pressure_findings if item["status"] == "gap_observed"]
    status = "pass" if not blocking and not gaps else "blocked"
    return {
        **data,
        "status": status,
        "rtl_pressure_claim_allowed": status == "pass",
        "phone_claim_allowed": False,
        "release_claim_allowed": False,
        "claim_allowed": False,
        "findings": findings,
        "blocked_count": len(blocking) + len(gaps),
        "memory_blocked_count": len(
            [
                item
                for item in memory_findings
                if item["status"] in {"invalid", "missing", "gap_observed"}
            ]
        ),
    }


def build_report(report_path: Path) -> dict[str, Any]:
    data, error = load_json(report_path)
    if error == "missing":
        return missing_report(report_path)
    if error is not None:
        return {
            "schema": SCHEMA,
            "status": "blocked",
            "claim_allowed": False,
            "rtl_pressure_claim_allowed": False,
            "phone_claim_allowed": False,
            "release_claim_allowed": False,
            "evidence_class": "invalid_cache_pressure_report",
            "findings": [
                {
                    "name": "cache_pressure_report",
                    "path": rel(report_path),
                    "status": "invalid",
                    "reason": error,
                }
            ],
            "blockers": ["cache_pressure_report.json is not valid JSON evidence."],
        }
    assert data is not None
    if data.get("evidence_class") == "missing_cocotb_cache_pressure_harness":
        return missing_report(report_path)
    return measured_report(report_path, data)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Return 2 while cache pressure evidence is blocked or gap-observed.",
    )
    args = parser.parse_args()

    report_path = args.report if args.report.is_absolute() else ROOT / args.report
    report = build_report(report_path)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    if report.get("status") == "pass":
        print("STATUS: PASS cache.pressure_evidence - measured pressure evidence present")
        return 0

    print("STATUS: BLOCKED cache.pressure_evidence - cache pressure/QoS evidence incomplete")
    for finding in report.get("findings", []):
        status = finding.get("status")
        if status != "pass":
            print(f"  - {finding.get('name')}: {status} ({finding.get('reason')})")
    print(f"  wrote {rel(report_path)}")
    return 2 if args.strict else 0


if __name__ == "__main__":
    raise SystemExit(main())
