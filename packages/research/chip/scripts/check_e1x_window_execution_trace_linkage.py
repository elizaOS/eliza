#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_window_execution_trace_linkage.json"

BENCHMARK = ROOT / "build/reports/e1x_benchmark.json"
WINDOW_REPAIR_ROM = ROOT / "build/reports/e1x_window_repair_rom_linkage.json"
WINDOW_ROUTE = ROOT / "build/reports/e1x_window_route_validation.json"
NORMAL_TRACE = ROOT / "benchmarks/results/e1x-real-graph-model-load.normal_execution_trace.json"
HIGH_TRACE = ROOT / "benchmarks/results/e1x-real-graph-model-load.high_failure_execution_trace.json"

NORMAL_TRACE_SHA256 = "5fe31007632635c42efea77ca1f2ac2911d2584815ac74f5d2f7a6facf902af7"
HIGH_TRACE_SHA256 = "0df46c3be0753a814b1f99a72f82f3c19cd4e67b1cbffede00f9c757106d7eb3"
NORMAL_ROM_SHA256 = "7911d1a3f892202baa2f39f6277d7efda42ac1d7a35e37c9bc3b597f8473cd97"
HIGH_ROM_SHA256 = "9f2710a5266260fe9885f22954d14f3e6787840d5c6b0bf36781a051e42e29da"


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def pass_fail(condition: bool, detail: str, fail_detail: str | None = None) -> tuple[str, str]:
    return ("pass", detail) if condition else ("fail", fail_detail or detail)


def main() -> int:
    checks: list[dict[str, str]] = []
    paths = (BENCHMARK, WINDOW_REPAIR_ROM, WINDOW_ROUTE, NORMAL_TRACE, HIGH_TRACE)
    missing = [str(path.relative_to(ROOT)) for path in paths if not path.is_file()]
    status, detail = pass_fail(
        not missing,
        "window execution-trace linkage inputs present",
        "missing inputs: " + ", ".join(missing),
    )
    checks.append(
        {
            "id": "e1x_window_execution_trace_linkage_inputs_present",
            "status": status,
            "detail": detail,
        }
    )

    benchmark = load_json(BENCHMARK) if BENCHMARK.is_file() else {}
    window_repair_rom = load_json(WINDOW_REPAIR_ROM) if WINDOW_REPAIR_ROM.is_file() else {}
    window_route = load_json(WINDOW_ROUTE) if WINDOW_ROUTE.is_file() else {}
    normal_trace = load_json(NORMAL_TRACE) if NORMAL_TRACE.is_file() else {}
    high_trace = load_json(HIGH_TRACE) if HIGH_TRACE.is_file() else {}

    deps_ok = (
        benchmark.get("status") == "PASS"
        and window_repair_rom.get("status") == "PASS"
        and int(window_repair_rom.get("summary", {}).get("high_failure_window_remap_word_count", 0))
        >= 3_012
        and window_route.get("status") == "PASS"
        and int(window_route.get("summary", {}).get("window_neighbor_edge_count", 0)) >= 301_949
        and normal_trace.get("schema") == "eliza.e1x.real_graph_execution_trace.v1"
        and high_trace.get("schema") == "eliza.e1x.real_graph_execution_trace.v1"
    )
    status, detail = pass_fail(
        deps_ok,
        "benchmark, window repair-ROM linkage, route validation, and normal/high traces are linked and PASS",
        "trace-linkage dependency report missing, stale, or failing",
    )
    checks.append(
        {
            "id": "e1x_window_execution_trace_linkage_dependencies_pass",
            "status": status,
            "detail": detail,
        }
    )

    bench_summary = benchmark.get("summary", {})
    rom_summary = window_repair_rom.get("summary", {})
    route_summary = window_route.get("summary", {})

    artifact_ok = (
        normal_trace.get("artifact_sha256") == NORMAL_TRACE_SHA256
        and high_trace.get("artifact_sha256") == HIGH_TRACE_SHA256
        and bench_summary.get("real_graph_normal_repair_rom_sha256") == NORMAL_ROM_SHA256
        and bench_summary.get("real_graph_high_failure_repair_rom_sha256") == HIGH_ROM_SHA256
        and rom_summary.get("normal_repair_rom_sha256") == NORMAL_ROM_SHA256
        and rom_summary.get("high_failure_repair_rom_sha256") == HIGH_ROM_SHA256
    )
    status, detail = pass_fail(
        artifact_ok,
        "normal/high execution traces and repair ROM hashes match benchmark and window linkage artifacts",
        "trace or repair-ROM artifact hash mismatch",
    )
    checks.append(
        {
            "id": "e1x_window_execution_trace_linkage_artifact_hashes",
            "status": status,
            "detail": detail,
        }
    )

    normal_cycles = int(normal_trace.get("total_cycles", 0))
    high_cycles = int(high_trace.get("total_cycles", 0))
    trace_ratio = high_cycles / normal_cycles if normal_cycles else 0.0
    normal_penalty = float(normal_trace.get("repair_hop_penalty", 0.0))
    high_penalty = float(high_trace.get("repair_hop_penalty", 0.0))
    penalty_ratio = high_penalty / normal_penalty if normal_penalty else 0.0
    route_extra_ratio = float(route_summary.get("high_vs_normal_window_extra_hop_ratio", 0.0))
    scenario_ok = (
        normal_trace.get("execution_successful") is True
        and high_trace.get("execution_successful") is True
        and normal_trace.get("golden_trace_match") is True
        and high_trace.get("golden_trace_match") is True
        and normal_cycles == 47_501_642_583
        and high_cycles == 63_132_355_414
        and int(normal_trace.get("route_checks", 0)) == 4_096
        and int(high_trace.get("route_checks", 0)) == 8_192
        and trace_ratio > 1.0
        and penalty_ratio > 8.0
        and route_extra_ratio > 10.0
    )
    status, detail = pass_fail(
        scenario_ok,
        "high-failure execution trace is slower and carries higher repair penalty than normal trace",
        "normal/high execution trace scenario linkage mismatch",
    )
    checks.append(
        {
            "id": "e1x_window_execution_trace_linkage_scenario_behavior",
            "status": status,
            "detail": detail,
        }
    )

    checksum_ok = (
        int(normal_trace.get("output_checksum", 0)) == 8_263_636_289_739_888_019
        and int(high_trace.get("output_checksum", 0)) == 3_419_781_716_949_080_192
        and int(normal_trace.get("output_checksum", 0)) != int(high_trace.get("output_checksum", 0))
        and int(rom_summary.get("window_route_high_failure_checksum", 0))
        == int(route_summary.get("high_failure_window_route_checksum", -1))
        and int(route_summary.get("high_failure_window_route_checksum", 0))
        == 8_141_847_437_961_269_241
    )
    status, detail = pass_fail(
        checksum_ok,
        "trace output checksums and high-failure window route checksum are stable and linked",
        "execution trace or window route checksum mismatch",
    )
    checks.append(
        {"id": "e1x_window_execution_trace_linkage_checksums", "status": status, "detail": detail}
    )

    failures = [check for check in checks if check["status"] != "pass"]
    summary = {
        "check_count": len(checks),
        "failing_check_count": len(failures),
        "normal_trace_sha256": str(normal_trace.get("artifact_sha256", "")),
        "high_failure_trace_sha256": str(high_trace.get("artifact_sha256", "")),
        "normal_total_cycles": normal_cycles,
        "high_failure_total_cycles": high_cycles,
        "high_vs_normal_trace_cycle_ratio": trace_ratio,
        "normal_repair_hop_penalty": normal_penalty,
        "high_failure_repair_hop_penalty": high_penalty,
        "high_vs_normal_repair_hop_penalty_ratio": penalty_ratio,
        "window_high_vs_normal_extra_hop_ratio": route_extra_ratio,
        "normal_output_checksum": int(normal_trace.get("output_checksum", 0)),
        "high_failure_output_checksum": int(high_trace.get("output_checksum", 0)),
        "normal_route_checks": int(normal_trace.get("route_checks", 0)),
        "high_failure_route_checks": int(high_trace.get("route_checks", 0)),
        "normal_repair_rom_sha256": str(rom_summary.get("normal_repair_rom_sha256", "")),
        "high_failure_repair_rom_sha256": str(
            rom_summary.get("high_failure_repair_rom_sha256", "")
        ),
        "high_failure_window_remap_word_count": int(
            rom_summary.get("high_failure_window_remap_word_count", 0)
        ),
        "high_failure_window_route_checksum": int(
            route_summary.get("high_failure_window_route_checksum", 0)
        ),
        "residual_blocker": "full_output_vectorized_tensor_fabric_executor_missing",
    }
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-window-execution-trace-linkage",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": utc_now(),
        "subsystem": "e1x",
        "claim_boundary": (
            "Links normal/high real-graph execution traces to the repair ROM and "
            "window-route evidence for the executed vector window. This validates "
            "scenario trace consistency and repair-induced slowdown linkage; it is "
            "not full-output tensor execution or silicon evidence."
        ),
        "evidence_paths": [
            "build/reports/e1x_benchmark.json",
            "build/reports/e1x_window_repair_rom_linkage.json",
            "build/reports/e1x_window_route_validation.json",
            "benchmarks/results/e1x-real-graph-model-load.normal_execution_trace.json",
            "benchmarks/results/e1x-real-graph-model-load.high_failure_execution_trace.json",
            "scripts/check_e1x_window_execution_trace_linkage.py",
        ],
        "checks": checks,
        "summary": summary,
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print(
            "BLOCKED: E1X window execution-trace linkage failed: "
            + ", ".join(c["id"] for c in failures)
        )
        return 1
    print(f"PASS: E1X window execution-trace linkage; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
