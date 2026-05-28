#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_benchmark.json"
REPORT_ID = "e1x-scaled-repair-model-gate"
BENCH_REPORT = ROOT / f"benchmarks/results/{REPORT_ID}/report.json"


def run_command(cmd: list[str]) -> tuple[bool, str]:
    proc = subprocess.run(cmd, cwd=ROOT, text=True, capture_output=True, check=False)
    if proc.returncode != 0:
        return False, (proc.stderr.strip() or proc.stdout.strip())[-1600:]
    return True, (proc.stdout.strip() or "command completed")[-1600:]


def inspect_benchmark_report() -> tuple[bool, str, dict[str, int | float | str]]:
    if not BENCH_REPORT.is_file():
        return False, f"missing benchmark report {BENCH_REPORT.relative_to(ROOT)}", {}
    report = json.loads(BENCH_REPORT.read_text(encoding="utf-8"))
    results = report.get("results")
    if not isinstance(results, list):
        return False, "benchmark report missing results list", {}
    by_name = {entry.get("name"): entry for entry in results if isinstance(entry, dict)}
    base = by_name.get("e1x_wafer_mesh_defect_sim")
    scaled = by_name.get("e1x_scaled_8gb_model_load_sim")
    if not isinstance(base, dict) or not isinstance(scaled, dict):
        return False, "missing base or scaled E1X benchmark result", {}
    base_metrics = base.get("metrics")
    scaled_metrics = scaled.get("metrics")
    if not isinstance(base_metrics, dict) or not isinstance(scaled_metrics, dict):
        return False, "E1X benchmark result missing metrics", {}
    scenarios = scaled_metrics.get("defect_testing", {}).get("scenarios", [])
    if not isinstance(scenarios, list) or len(scenarios) != 2:
        return False, "scaled E1X report missing normal/high defect scenarios", {}
    high = scenarios[1]
    if not isinstance(high, dict):
        return False, "scaled E1X high-failure scenario is malformed", {}
    if base_metrics.get("comparison", {}).get("e1", {}).get("basis") != "open_2028_sota_160tops":
        return False, "E1 comparison basis changed or is missing", {}
    if scaled_metrics.get("model_loaded_under_high_failure") != 1:
        return False, "scaled E1X high-failure model load did not pass", {}
    if scaled_metrics.get("high_failure_repaired_logical_mesh") != 1:
        return False, "scaled E1X high-failure repair did not pass", {}
    if scaled_metrics.get("model_run_successful") != 1:
        return False, "scaled E1X high-failure model execution did not pass", {}
    execution = scaled_metrics.get("model_execution", {}).get("high_failure_rate_repair_stress")
    if not isinstance(execution, dict) or execution.get("golden_trace_match") is not True:
        return False, "scaled E1X high-failure execution trace is missing or mismatched", {}
    handoff = scaled_metrics.get("repair_handoff")
    if not isinstance(handoff, dict):
        return False, "scaled E1X report missing repair handoff metadata", {}
    defect_map = handoff.get("high_failure_defect_map")
    repair_manifest = handoff.get("high_failure_repair_manifest")
    repair_rom = handoff.get("high_failure_repair_rom")
    if not isinstance(defect_map, dict) or not isinstance(repair_manifest, dict) or not isinstance(repair_rom, dict):
        return False, "scaled E1X repair handoff missing defect map, repair manifest, or repair ROM", {}
    defect_map_path = _required_repo_file(defect_map.get("path"))
    repair_manifest_path = _required_repo_file(repair_manifest.get("path"))
    repair_rom_path = _required_repo_file(repair_rom.get("path"))
    repair_rom_hex_path = _required_repo_file(repair_rom.get("hex_path"))
    if (
        defect_map_path is None
        or repair_manifest_path is None
        or repair_rom_path is None
        or repair_rom_hex_path is None
    ):
        return False, "scaled E1X repair handoff sidecar path is missing or invalid", {}
    defect_map_data = json.loads(defect_map_path.read_text(encoding="utf-8"))
    repair_manifest_data = json.loads(repair_manifest_path.read_text(encoding="utf-8"))
    repair_rom_data = json.loads(repair_rom_path.read_text(encoding="utf-8"))
    if defect_map_data.get("artifact_sha256") != defect_map.get("artifact_sha256"):
        return False, "defect-map sidecar sha does not match scaled report", {}
    if repair_manifest_data.get("artifact_sha256") != repair_manifest.get("artifact_sha256"):
        return False, "repair-manifest sidecar sha does not match scaled report", {}
    if repair_rom_data.get("artifact_sha256") != repair_rom.get("artifact_sha256"):
        return False, "repair-ROM sidecar sha does not match scaled report", {}
    if repair_manifest_data.get("source_defect_map_sha256") != defect_map_data.get("artifact_sha256"):
        return False, "repair manifest does not reference the defect-map artifact", {}
    if repair_rom_data.get("source_repair_manifest_sha256") != repair_manifest_data.get("artifact_sha256"):
        return False, "repair ROM does not reference the repair-manifest artifact", {}
    rom_hex_words = repair_rom_hex_path.read_text(encoding="utf-8").strip().splitlines()
    if rom_hex_words != repair_rom_data.get("words"):
        return False, "repair-ROM hex image does not match JSON ROM words", {}
    if not _file_sha256_is_stable(defect_map_path) or not _file_sha256_is_stable(repair_manifest_path) or not _file_sha256_is_stable(repair_rom_path):
        return False, "repair handoff sidecars are empty or unreadable", {}
    summary = {
        "claim_level": str(report.get("claim_level")),
        "base_logical_cores": int(base_metrics["architecture"]["logical_cores"]),
        "scaled_logical_cores": int(scaled_metrics["architecture"]["logical_cores"]),
        "scaled_local_sram_mib": float(scaled_metrics["local_sram_mib"]),
        "scaled_model_required_mib": float(scaled_metrics["model_total_required_mib"]),
        "high_failure_blocked_cores": int(high["blocked_core_count"]),
        "high_failure_blocked_links": int(high["blocked_link_count"]),
        "high_failure_route_checks": int(high["logical_neighbor_paths_checked"]),
        "scaled_dense_int8_peak_tops": float(scaled_metrics["architecture"]["dense_int8_peak_tops"]),
        "high_failure_prefill_ms": float(scaled_metrics["high_failure_prefill_ms"]),
        "high_failure_decode_tokens_per_second": float(
            scaled_metrics["high_failure_decode_tokens_per_second"]
        ),
        "high_failure_output_checksum": int(scaled_metrics["high_failure_output_checksum"]),
        "high_failure_defect_map_blocked_cores": int(defect_map_data["blocked_core_count"]),
        "high_failure_repair_manifest_remaps": int(repair_manifest_data["remapped_core_count"]),
        "high_failure_repair_manifest_sampled_routes": int(
            len(repair_manifest_data["sampled_routes"])
        ),
        "high_failure_repair_rom_words": int(repair_rom_data["total_word_count"]),
    }
    return True, "E1X base and scaled model-load benchmarks passed", summary


def _required_repo_file(value: object) -> Path | None:
    if not isinstance(value, str) or not value:
        return None
    path = Path(value)
    if path.is_absolute():
        return None
    resolved = ROOT / path
    return resolved if resolved.is_file() else None


def _file_sha256_is_stable(path: Path) -> bool:
    return bool(sha256(path.read_bytes()).hexdigest())


def main() -> int:
    run_ok, run_detail = run_command(
        [
            sys.executable,
            "benchmarks/run_benchmarks.py",
            "run",
            "--bench",
            "e1x_wafer_mesh_defect_sim",
            "--bench",
            "e1x_scaled_8gb_model_load_sim",
            "--report-id",
            REPORT_ID,
        ]
    )
    validate_ok, validate_detail = (
        run_command(
            [
                sys.executable,
                "benchmarks/run_benchmarks.py",
                "validate-report",
                str(BENCH_REPORT.relative_to(ROOT)),
            ]
        )
        if run_ok
        else (False, "not run")
    )
    inspect_ok, inspect_detail, metrics = inspect_benchmark_report() if validate_ok else (False, "not run", {})
    checks = [
        {"id": "e1x_benchmark_run", "status": "pass" if run_ok else "fail", "detail": run_detail},
        {
            "id": "e1x_benchmark_report_schema",
            "status": "pass" if validate_ok else "fail",
            "detail": validate_detail,
        },
        {
            "id": "e1x_scaled_repair_model_load_and_run_metrics",
            "status": "pass" if inspect_ok else "fail",
            "detail": inspect_detail,
        },
    ]
    failures = [check for check in checks if check["status"] != "pass"]
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-benchmark",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "subsystem": "e1x",
        "claim_boundary": "E1X L2 architecture-simulator benchmark only; not silicon, FPGA, board, PD, DFT, package, or full-wafer RTL benchmark evidence.",
        "evidence_paths": [
            "benchmarks/configs/benchmark_plan.json",
            f"benchmarks/results/{REPORT_ID}/report.json",
        ],
        "checks": checks,
        "summary": {**metrics, "check_count": len(checks), "failing_check_count": len(failures)},
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print("BLOCKED: E1X benchmark failed: " + ", ".join(c["id"] for c in failures))
        return 1
    print(f"PASS: E1X benchmark; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
