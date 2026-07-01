#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x3d_benchmark.json"
REPORT_ID = "e1x3d-scaled-repair-model-gate"
BENCH_REPORT = ROOT / f"benchmarks/results/{REPORT_ID}/report.json"

FALSE_CLAIM_FLAGS = {
    "release_claim_allowed": False,
    "silicon_claim_allowed": False,
    "fpga_claim_allowed": False,
    "board_claim_allowed": False,
    "pd_signoff_claim_allowed": False,
    "three_d_signoff_claim_allowed": False,
    "full_wafer_rtl_claim_allowed": False,
    "production_readiness_claim_allowed": False,
}


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def repo_safe(text: str) -> str:
    return text.replace(str(ROOT), ".")


def run_command(cmd: list[str]) -> tuple[bool, str]:
    proc = subprocess.run(cmd, cwd=ROOT, text=True, capture_output=True, check=False)
    if proc.returncode != 0:
        return False, repo_safe((proc.stderr.strip() or proc.stdout.strip())[-1600:])
    return True, repo_safe((proc.stdout.strip() or "command completed")[-1600:])


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


def inspect_benchmark_report() -> tuple[bool, str, dict[str, int | float | str]]:
    if not BENCH_REPORT.is_file():
        return False, f"missing benchmark report {BENCH_REPORT.relative_to(ROOT)}", {}
    report = json.loads(BENCH_REPORT.read_text(encoding="utf-8"))
    results = report.get("results")
    if not isinstance(results, list):
        return False, "benchmark report missing results list", {}
    by_name = {entry.get("name"): entry for entry in results if isinstance(entry, dict)}
    base = by_name.get("e1x3d_wafer_stack_defect_sim")
    scaled = by_name.get("e1x3d_scaled_model_load_sim")
    if not isinstance(base, dict) or not isinstance(scaled, dict):
        return False, "missing base or scaled E1X3D benchmark result", {}
    base_metrics = base.get("metrics")
    scaled_metrics = scaled.get("metrics")
    if not isinstance(base_metrics, dict) or not isinstance(scaled_metrics, dict):
        return False, "E1X3D benchmark result missing metrics", {}

    if base_metrics.get("architecture", {}).get("logical_tiers", 0) < 2:
        return False, "base E1X3D is not 3D (logical_tiers < 2)", {}

    scenarios = scaled_metrics.get("defect_testing", {}).get("scenarios", [])
    if not isinstance(scenarios, list) or len(scenarios) != 3:
        return False, "scaled E1X3D report missing normal/high/dead-tier scenarios", {}
    if scaled_metrics.get("model_loaded_under_normal_defects") != 1:
        return False, "scaled E1X3D normal-defect model load did not pass", {}
    if scaled_metrics.get("model_loaded_under_high_failure") != 1:
        return False, "scaled E1X3D high-failure model load did not pass", {}
    if scaled_metrics.get("model_loaded_under_dead_tier") != 1:
        return False, "scaled E1X3D dead-tier-region model load did not pass", {}
    if scaled_metrics.get("high_failure_repaired_logical_mesh") != 1:
        return False, "scaled E1X3D high-failure repair did not pass", {}
    if scaled_metrics.get("dead_tier_repaired_logical_mesh") != 1:
        return False, "scaled E1X3D dead-tier repair did not pass", {}
    if int(scaled_metrics.get("dead_tier_z_paths_checked", 0)) <= 0:
        return False, "scaled E1X3D dead-tier scenario checked no Z routes", {}
    if scaled_metrics.get("model_run_successful") != 1:
        return False, "scaled E1X3D high-failure model execution did not pass", {}
    if scaled_metrics.get("thermal_status") != "PASS":
        return False, f"scaled E1X3D thermal gate is {scaled_metrics.get('thermal_status')}", {}
    if scaled_metrics.get("stack_yield_status") != "PASS":
        return (
            False,
            f"scaled E1X3D stack-yield gate is {scaled_metrics.get('stack_yield_status')}",
            {},
        )

    ratios = scaled_metrics.get("comparison", {}).get("ratios", {})
    if float(ratios.get("cores_vs_e1x_planar", 0)) < 2.0:
        return False, "scaled E1X3D does not exceed 2x planar E1X cores", {}
    if float(ratios.get("sram_vs_e1x_planar", 0)) < 2.0:
        return False, "scaled E1X3D does not exceed 2x planar E1X SRAM", {}

    handoff = scaled_metrics.get("repair_handoff")
    if not isinstance(handoff, dict):
        return False, "scaled E1X3D report missing repair handoff metadata", {}
    defect_map = handoff.get("high_failure_defect_map")
    repair_manifest = handoff.get("high_failure_repair_manifest")
    repair_rom = handoff.get("high_failure_repair_rom")
    model_shard_sample = handoff.get("high_failure_model_shard_sample")
    thermal = scaled_metrics.get("thermal")
    stack_yield = scaled_metrics.get("stack_yield")
    if not all(
        isinstance(item, dict)
        for item in (
            defect_map,
            repair_manifest,
            repair_rom,
            model_shard_sample,
            thermal,
            stack_yield,
        )
    ):
        return False, "scaled E1X3D handoff missing repair/thermal/yield sidecars", {}

    assert isinstance(defect_map, dict)
    assert isinstance(repair_manifest, dict)
    assert isinstance(repair_rom, dict)
    assert isinstance(model_shard_sample, dict)
    assert isinstance(thermal, dict)
    assert isinstance(stack_yield, dict)

    defect_map_path = _required_repo_file(defect_map.get("path"))
    repair_manifest_path = _required_repo_file(repair_manifest.get("path"))
    repair_rom_path = _required_repo_file(repair_rom.get("path"))
    repair_rom_hex_path = _required_repo_file(repair_rom.get("hex_path"))
    model_shard_sample_path = _required_repo_file(model_shard_sample.get("path"))
    thermal_path = _required_repo_file(thermal.get("path"))
    stack_yield_path = _required_repo_file(stack_yield.get("path"))
    if not all(
        path is not None
        for path in (
            defect_map_path,
            repair_manifest_path,
            repair_rom_path,
            repair_rom_hex_path,
            model_shard_sample_path,
            thermal_path,
            stack_yield_path,
        )
    ):
        return False, "scaled E1X3D handoff sidecar path is missing or invalid", {}

    assert defect_map_path is not None
    assert repair_manifest_path is not None
    assert repair_rom_path is not None
    assert repair_rom_hex_path is not None
    assert model_shard_sample_path is not None
    assert thermal_path is not None
    assert stack_yield_path is not None

    defect_map_data = json.loads(defect_map_path.read_text(encoding="utf-8"))
    repair_manifest_data = json.loads(repair_manifest_path.read_text(encoding="utf-8"))
    repair_rom_data = json.loads(repair_rom_path.read_text(encoding="utf-8"))
    model_shard_data = json.loads(model_shard_sample_path.read_text(encoding="utf-8"))
    thermal_data = json.loads(thermal_path.read_text(encoding="utf-8"))
    stack_yield_data = json.loads(stack_yield_path.read_text(encoding="utf-8"))

    if defect_map_data.get("artifact_sha256") != defect_map.get("artifact_sha256"):
        return False, "defect-map sidecar sha does not match scaled report", {}
    if repair_manifest_data.get("artifact_sha256") != repair_manifest.get("artifact_sha256"):
        return False, "repair-manifest sidecar sha does not match scaled report", {}
    if repair_rom_data.get("artifact_sha256") != repair_rom.get("artifact_sha256"):
        return False, "repair-ROM sidecar sha does not match scaled report", {}
    if model_shard_data.get("artifact_sha256") != model_shard_sample.get("artifact_sha256"):
        return False, "model-shard sidecar sha does not match scaled report", {}
    if repair_manifest_data.get("source_defect_map_sha256") != defect_map_data.get(
        "artifact_sha256"
    ):
        return False, "repair manifest does not reference the defect-map artifact", {}
    if repair_rom_data.get("source_repair_manifest_sha256") != repair_manifest_data.get(
        "artifact_sha256"
    ):
        return False, "repair ROM does not reference the repair-manifest artifact", {}
    rom_hex_words = repair_rom_hex_path.read_text(encoding="utf-8").strip().splitlines()
    if rom_hex_words != repair_rom_data.get("words"):
        return False, "repair-ROM hex image does not match JSON ROM words", {}
    if thermal_data.get("status") != "PASS" or thermal_data.get("status") != scaled_metrics.get(
        "thermal_status"
    ):
        return False, "thermal sidecar status mismatch or not PASS", {}
    if stack_yield_data.get("status") != "PASS" or not stack_yield_data.get("repair_feasible"):
        return False, "stack-yield sidecar not PASS or repair not feasible", {}
    for path in (
        defect_map_path,
        repair_manifest_path,
        repair_rom_path,
        model_shard_sample_path,
        thermal_path,
        stack_yield_path,
    ):
        if not _file_sha256_is_stable(path):
            return False, f"handoff sidecar {path.name} is empty or unreadable", {}

    high = scenarios[1]
    dead_tier = scenarios[2]
    summary: dict[str, int | float | str] = {
        "base_logical_cores": int(base_metrics["architecture"]["logical_cores"]),
        "base_logical_tiers": int(base_metrics["architecture"]["logical_tiers"]),
        "scaled_logical_cores": int(scaled_metrics["architecture"]["logical_cores"]),
        "scaled_logical_tiers": int(scaled_metrics["architecture"]["logical_tiers"]),
        "scaled_local_sram_gib": float(scaled_metrics["architecture"]["local_sram_gib"]),
        "cores_vs_e1x_planar": float(ratios.get("cores_vs_e1x_planar", 0)),
        "sram_vs_e1x_planar": float(ratios.get("sram_vs_e1x_planar", 0)),
        "packing_density_vs_planar": float(ratios.get("packing_density_vs_planar", 0)),
        "high_failure_blocked_cores": int(high["blocked_core_count"]),
        "high_failure_blocked_links": int(high["blocked_link_count"]),
        "high_failure_route_checks": int(high["logical_neighbor_paths_checked"]),
        "high_failure_repair_rom_words": int(repair_rom_data["total_word_count"]),
        "dead_tier_z_paths_checked": int(dead_tier["z_neighbor_paths_checked"]),
        "thermal_peak_junction_c": float(scaled_metrics["thermal_peak_junction_c"]),
        "stack_bond_yield": float(scaled_metrics["stack_bond_yield"]),
    }
    return True, "E1X3D base and scaled stacked-mesh benchmarks passed", summary


def main() -> int:
    run_ok, run_detail = run_command(
        [
            sys.executable,
            "benchmarks/run_benchmarks.py",
            "run",
            "--bench",
            "e1x3d_wafer_stack_defect_sim",
            "--bench",
            "e1x3d_scaled_model_load_sim",
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
    inspect_ok, inspect_detail, metrics = (
        inspect_benchmark_report() if validate_ok else (False, "not run", {})
    )
    checks = [
        {"id": "e1x3d_benchmark_run", "status": "pass" if run_ok else "fail", "detail": run_detail},
        {
            "id": "e1x3d_benchmark_report_schema",
            "status": "pass" if validate_ok else "fail",
            "detail": validate_detail,
        },
        {
            "id": "e1x3d_scaled_repair_thermal_yield_metrics",
            "status": "pass" if inspect_ok else "fail",
            "detail": inspect_detail,
        },
    ]
    failures = [check for check in checks if check["status"] != "pass"]
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x3d-benchmark",
        "status": "PASS" if not failures else "BLOCKED",
        **FALSE_CLAIM_FLAGS,
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": utc_now(),
        "subsystem": "e1x3d",
        "claim_boundary": (
            "E1X3D L2 architecture-simulator benchmark only: 3D-stacked wafer mesh, "
            "dead-core/link/Z-link/dead-tier-region repair routing, modeled stacked-logic "
            "thermal ceiling and multiplicative stack-yield gates. Not silicon, FPGA, board, "
            "PD, 3D DRC/LVS, electrothermal signoff, sequential-integration PDK, or full-wafer "
            "RTL evidence."
        ),
        "evidence_paths": [
            "benchmarks/configs/benchmark_plan.json",
            f"benchmarks/results/{REPORT_ID}/report.json",
            "benchmarks/results/e1x3d-scaled-16gb-model-load.json",
            "research/threed_ic_2026/03_implementation/e1x3d_design_decisions.md",
        ],
        "checks": checks,
        "summary": {**metrics, "check_count": len(checks), "failing_check_count": len(failures)},
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print("BLOCKED: E1X3D benchmark failed: " + ", ".join(c["id"] for c in failures))
        return 1
    print(f"PASS: E1X3D benchmark; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
