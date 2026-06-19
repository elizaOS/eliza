#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_full_payload_repaired_run.json"

FULL_PAYLOAD = ROOT / "build/reports/e1x_full_payload_manifest.json"
FULL_PAYLOAD_REPAIR = ROOT / "build/reports/e1x_full_payload_repair_mapping.json"
FULL_PAYLOAD_REPAIR_ROM = ROOT / "build/reports/e1x_full_payload_repair_rom.json"
WINDOW_TRACE = ROOT / "build/reports/e1x_window_execution_trace_linkage.json"
BENCHMARK = ROOT / "build/reports/e1x_benchmark.json"
NORMAL_TRACE = ROOT / "benchmarks/results/e1x-real-graph-model-load.normal_execution_trace.json"
HIGH_TRACE = ROOT / "benchmarks/results/e1x-real-graph-model-load.high_failure_execution_trace.json"

MASK64 = (1 << 64) - 1
FNV64_OFFSET = 0xCBF29CE484222325
FNV64_PRIME = 0x100000001B3


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def pass_fail(condition: bool, detail: str, fail_detail: str | None = None) -> tuple[str, str]:
    return ("pass", detail) if condition else ("fail", fail_detail or detail)


def mix64(checksum: int, value: int) -> int:
    return ((checksum ^ (value & MASK64)) * FNV64_PRIME) & MASK64


def main() -> int:
    checks: list[dict[str, str]] = []
    paths = (
        FULL_PAYLOAD,
        FULL_PAYLOAD_REPAIR,
        FULL_PAYLOAD_REPAIR_ROM,
        WINDOW_TRACE,
        BENCHMARK,
        NORMAL_TRACE,
        HIGH_TRACE,
    )
    missing = [str(path.relative_to(ROOT)) for path in paths if not path.is_file()]
    status, detail = pass_fail(
        not missing,
        "full-payload repaired-run inputs present",
        "missing inputs: " + ", ".join(missing),
    )
    checks.append(
        {"id": "e1x_full_payload_repaired_run_inputs_present", "status": status, "detail": detail}
    )

    full_payload = load_json(FULL_PAYLOAD) if FULL_PAYLOAD.is_file() else {}
    full_repair = load_json(FULL_PAYLOAD_REPAIR) if FULL_PAYLOAD_REPAIR.is_file() else {}
    full_rom = load_json(FULL_PAYLOAD_REPAIR_ROM) if FULL_PAYLOAD_REPAIR_ROM.is_file() else {}
    window_trace = load_json(WINDOW_TRACE) if WINDOW_TRACE.is_file() else {}
    benchmark = load_json(BENCHMARK) if BENCHMARK.is_file() else {}
    normal_trace = load_json(NORMAL_TRACE) if NORMAL_TRACE.is_file() else {}
    high_trace = load_json(HIGH_TRACE) if HIGH_TRACE.is_file() else {}

    deps_ok = (
        full_payload.get("status") == "PASS"
        and int(full_payload.get("summary", {}).get("committed_loader_word_count", 0))
        == 1_627_034_880
        and full_repair.get("status") == "PASS"
        and int(full_repair.get("summary", {}).get("payload_shard_record_count", 0)) == 151_367
        and full_rom.get("status") == "PASS"
        and int(full_rom.get("summary", {}).get("high_failure_payload_remap_word_count", 0))
        == 3_012
        and window_trace.get("status") == "PASS"
        and benchmark.get("status") == "PASS"
        and normal_trace.get("schema") == "eliza.e1x.real_graph_execution_trace.v1"
        and high_trace.get("schema") == "eliza.e1x.real_graph_execution_trace.v1"
    )
    status, detail = pass_fail(
        deps_ok,
        "full payload, repair mapping, repair ROM, benchmark, and execution traces are PASS",
        "dependency report missing, stale, or failing",
    )
    checks.append(
        {
            "id": "e1x_full_payload_repaired_run_dependencies_pass",
            "status": status,
            "detail": detail,
        }
    )

    payload_summary = full_payload.get("summary", {})
    repair_summary = full_repair.get("summary", {})
    rom_summary = full_rom.get("summary", {})
    trace_summary = window_trace.get("summary", {})
    bench_summary = benchmark.get("summary", {})

    payload_link_ok = (
        int(payload_summary.get("payload_manifest_checksum", 0))
        == int(repair_summary.get("payload_manifest_checksum", -1))
        and int(payload_summary.get("committed_loader_word_count", 0))
        == int(repair_summary.get("payload_loader_word_count", -1))
        == int(rom_summary.get("payload_loader_word_count", -1))
        == 1_627_034_880
        and int(payload_summary.get("committed_shard_record_count", 0))
        == int(repair_summary.get("payload_shard_record_count", -1))
        == int(rom_summary.get("payload_shard_record_count", -1))
        == 151_367
    )
    status, detail = pass_fail(
        payload_link_ok,
        "full payload manifest, repair mapping, and repair ROM agree on shard/loader-word coverage",
        "full payload repaired-run payload linkage mismatch",
    )
    checks.append(
        {"id": "e1x_full_payload_repaired_run_payload_links", "status": status, "detail": detail}
    )

    repair_link_ok = (
        int(repair_summary.get("normal_payload_remapped_records", 0))
        == int(rom_summary.get("normal_payload_remap_word_count", -1))
        == 279
        and int(repair_summary.get("high_failure_payload_remapped_records", 0))
        == int(rom_summary.get("high_failure_payload_remap_word_count", -1))
        == 3_012
        and str(rom_summary.get("normal_repair_rom_sha256", ""))
        == str(trace_summary.get("normal_repair_rom_sha256", ""))
        == "7911d1a3f892202baa2f39f6277d7efda42ac1d7a35e37c9bc3b597f8473cd97"
        and str(rom_summary.get("high_failure_repair_rom_sha256", ""))
        == str(trace_summary.get("high_failure_repair_rom_sha256", ""))
        == "9f2710a5266260fe9885f22954d14f3e6787840d5c6b0bf36781a051e42e29da"
    )
    status, detail = pass_fail(
        repair_link_ok,
        "normal/high payload remap counts and ROM hashes match repaired trace linkage",
        "full payload repaired-run repair/ROM linkage mismatch",
    )
    checks.append(
        {"id": "e1x_full_payload_repaired_run_repair_links", "status": status, "detail": detail}
    )

    normal_cycles = int(normal_trace.get("total_cycles", 0))
    high_cycles = int(high_trace.get("total_cycles", 0))
    cycle_ratio = high_cycles / normal_cycles if normal_cycles else 0.0
    normal_decode_tps = float(normal_trace.get("decode_tokens_per_second", 0.0))
    high_decode_tps = float(high_trace.get("decode_tokens_per_second", 0.0))
    tps_ratio = high_decode_tps / normal_decode_tps if normal_decode_tps else 0.0
    run_ok = (
        normal_trace.get("execution_successful") is True
        and high_trace.get("execution_successful") is True
        and normal_trace.get("golden_trace_match") is True
        and high_trace.get("golden_trace_match") is True
        and normal_cycles == int(trace_summary.get("normal_total_cycles", -1)) == 47_501_642_583
        and high_cycles == int(trace_summary.get("high_failure_total_cycles", -1)) == 63_132_355_414
        and int(normal_trace.get("output_checksum", 0))
        == int(trace_summary.get("normal_output_checksum", -1))
        == 8_263_636_289_739_888_019
        and int(high_trace.get("output_checksum", 0))
        == int(trace_summary.get("high_failure_output_checksum", -1))
        == 3_419_781_716_949_080_192
        and cycle_ratio > 1.3
        and 0.7 < tps_ratio < 0.8
        and int(normal_trace.get("route_checks", 0)) == 4_096
        and int(high_trace.get("route_checks", 0)) == 8_192
    )
    status, detail = pass_fail(
        run_ok,
        "normal/high repaired execution traces run successfully with stable slowdown and output checksums",
        "full payload repaired-run execution trace mismatch",
    )
    checks.append(
        {"id": "e1x_full_payload_repaired_run_trace_behavior", "status": status, "detail": detail}
    )

    benchmark_link_ok = (
        bench_summary.get("real_graph_normal_execution_trace_sha256")
        == normal_trace.get("artifact_sha256")
        and bench_summary.get("real_graph_high_failure_execution_trace_sha256")
        == high_trace.get("artifact_sha256")
        and int(bench_summary.get("real_graph_normal_execution_trace_cycles", 0)) == normal_cycles
        and int(bench_summary.get("real_graph_high_failure_execution_trace_cycles", 0))
        == high_cycles
        and int(bench_summary.get("real_graph_high_failure_repair_rom_words", 0)) == 3_582
        and int(bench_summary.get("real_graph_high_failure_route_checks", 0)) == 8_192
    )
    status, detail = pass_fail(
        benchmark_link_ok,
        "benchmark summary links repaired-run traces, repair ROMs, and route-check counts",
        "full payload repaired-run benchmark linkage mismatch",
    )
    checks.append(
        {"id": "e1x_full_payload_repaired_run_benchmark_links", "status": status, "detail": detail}
    )

    combined_checksum = FNV64_OFFSET
    for value in (
        int(payload_summary.get("payload_manifest_checksum", 0)),
        int(repair_summary.get("combined_payload_repair_checksum", 0)),
        int(rom_summary.get("combined_payload_repair_rom_checksum", 0)),
        normal_cycles,
        high_cycles,
        int(normal_trace.get("output_checksum", 0)),
        int(high_trace.get("output_checksum", 0)),
        int(trace_summary.get("high_failure_window_route_checksum", 0)),
    ):
        combined_checksum = mix64(combined_checksum, value)

    failures = [check for check in checks if check["status"] != "pass"]
    summary = {
        "check_count": len(checks),
        "failing_check_count": len(failures),
        "payload_shard_record_count": int(payload_summary.get("committed_shard_record_count", 0)),
        "payload_loader_word_count": int(payload_summary.get("committed_loader_word_count", 0)),
        "payload_manifest_checksum": int(payload_summary.get("payload_manifest_checksum", 0)),
        "normal_payload_remap_words": int(rom_summary.get("normal_payload_remap_word_count", 0)),
        "high_failure_payload_remap_words": int(
            rom_summary.get("high_failure_payload_remap_word_count", 0)
        ),
        "normal_repair_rom_sha256": str(rom_summary.get("normal_repair_rom_sha256", "")),
        "high_failure_repair_rom_sha256": str(
            rom_summary.get("high_failure_repair_rom_sha256", "")
        ),
        "normal_trace_sha256": str(normal_trace.get("artifact_sha256", "")),
        "high_failure_trace_sha256": str(high_trace.get("artifact_sha256", "")),
        "normal_total_cycles": normal_cycles,
        "high_failure_total_cycles": high_cycles,
        "high_vs_normal_cycle_ratio": cycle_ratio,
        "normal_decode_tokens_per_second": normal_decode_tps,
        "high_failure_decode_tokens_per_second": high_decode_tps,
        "high_vs_normal_decode_tps_ratio": tps_ratio,
        "normal_output_checksum": int(normal_trace.get("output_checksum", 0)),
        "high_failure_output_checksum": int(high_trace.get("output_checksum", 0)),
        "normal_route_checks": int(normal_trace.get("route_checks", 0)),
        "high_failure_route_checks": int(high_trace.get("route_checks", 0)),
        "high_failure_window_route_checksum": int(
            trace_summary.get("high_failure_window_route_checksum", 0)
        ),
        "combined_repaired_run_checksum": combined_checksum,
        "residual_blocker": "full_output_real_weight_checksum_missing",
    }
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-full-payload-repaired-run",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": utc_now(),
        "subsystem": "e1x",
        "claim_boundary": (
            "Links the full resident payload manifest, normal/high repair mapping, "
            "boot-programmable repair ROMs, and normal/high real-graph execution traces. "
            "This proves modeled repaired-run consistency for the resident payload under "
            "normal and high-failure defect maps; it is still not full 6.5GB payload "
            "execution and not a full-output real-weight checksum."
        ),
        "evidence_paths": [
            "build/reports/e1x_full_payload_manifest.json",
            "build/reports/e1x_full_payload_repair_mapping.json",
            "build/reports/e1x_full_payload_repair_rom.json",
            "build/reports/e1x_window_execution_trace_linkage.json",
            "build/reports/e1x_benchmark.json",
            "benchmarks/results/e1x-real-graph-model-load.normal_execution_trace.json",
            "benchmarks/results/e1x-real-graph-model-load.high_failure_execution_trace.json",
            "scripts/check_e1x_full_payload_repaired_run.py",
        ],
        "checks": checks,
        "summary": summary,
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print(
            "BLOCKED: E1X full-payload repaired run failed: " + ", ".join(c["id"] for c in failures)
        )
        return 1
    print(f"PASS: E1X full-payload repaired run; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
