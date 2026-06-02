#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_power_thermal.json"
SCHEDULE_PATH = ROOT / "benchmarks/results/e1x-real-graph-schedule-execution-estimate.json"
MODEL_LOAD_PATH = ROOT / "benchmarks/results/e1x-real-graph-model-load.json"
WAFER_DOC_PATH = ROOT / "docs/arch/e1x-wafer-mesh.md"

WAFER_SIDE_MM = 215.0
WAFER_AREA_MM2 = WAFER_SIDE_MM * WAFER_SIDE_MM
LIQUID_COOLED_SYSTEM_POWER_ENVELOPE_W = 23_000.0
PLANNING_POWER_DENSITY_LIMIT_W_PER_MM2 = 0.5
AMBIENT_COOLANT_C = 25.0
PLANNING_THETA_JA_C_PER_W = 0.012
MAX_PLANNING_JUNCTION_C = 105.0

CORE_CLOCK_HZ = 900_000_000
INT8_LANES_PER_CORE = 16
LOCAL_SRAM_KIB_PER_CORE = 48
LOGICAL_CORES = 175_104
ENERGY_PJ_PER_INT8_OP = 0.22
FABRIC_PJ_PER_BYTE_HOP = 0.16
LOCAL_SRAM_PJ_PER_BYTE = 0.035
STATIC_POWER_W_PER_CORE = 0.018
LINK_BITS_PER_CYCLE_BIDIRECTIONAL = 64


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def pass_fail(condition: bool, detail: str, fail_detail: str | None = None) -> tuple[str, str]:
    return ("pass", detail) if condition else ("fail", fail_detail or detail)


def main() -> int:
    checks: list[dict[str, str]] = []
    missing = [
        str(path.relative_to(ROOT))
        for path in (SCHEDULE_PATH, MODEL_LOAD_PATH, WAFER_DOC_PATH)
        if not path.is_file()
    ]
    status, detail = pass_fail(
        not missing,
        "power/thermal input artifacts present",
        "missing artifacts: " + ", ".join(missing),
    )
    checks.append({"id": "e1x_power_thermal_inputs_present", "status": status, "detail": detail})
    schedule = load_json(SCHEDULE_PATH) if SCHEDULE_PATH.is_file() else {}
    model_load = load_json(MODEL_LOAD_PATH) if MODEL_LOAD_PATH.is_file() else {}

    schema_ok = (
        schedule.get("schema") == "eliza.e1x.schedule_execution_estimate.v1"
        and model_load.get("schema") == "eliza.e1x.real_graph_model_load.v1"
    )
    status, detail = pass_fail(schema_ok, "schedule and model-load schemas match")
    checks.append({"id": "e1x_power_thermal_schemas", "status": status, "detail": detail})

    logical_cores = int(schedule.get("logical_rows", 0)) * int(schedule.get("logical_cols", 0))
    clock_hz = int(schedule.get("core_clock_hz", 0))
    peak_int8_ops_per_s = logical_cores * INT8_LANES_PER_CORE * 2 * clock_hz
    peak_dynamic_power_w = peak_int8_ops_per_s * ENERGY_PJ_PER_INT8_OP / 1e12
    all_core_static_power_w = logical_cores * STATIC_POWER_W_PER_CORE
    peak_package_power_w = peak_dynamic_power_w + all_core_static_power_w
    peak_power_density_w_per_mm2 = peak_package_power_w / WAFER_AREA_MM2
    peak_planning_junction_c = AMBIENT_COOLANT_C + peak_package_power_w * PLANNING_THETA_JA_C_PER_W

    elapsed_s = float(schedule.get("total_schedule_cycles", 0)) / max(1, clock_hz)
    total_ops = int(schedule.get("total_int8_equivalent_op_count", 0))
    total_core_wave_count = int(schedule.get("total_core_wave_count", 0))
    total_k_wave_count = int(schedule.get("total_k_wave_count", 0))
    average_active_cores = total_core_wave_count / max(1, total_k_wave_count)
    compute_energy_j = total_ops * ENERGY_PJ_PER_INT8_OP / 1e12
    local_sram_energy_j = total_ops * LOCAL_SRAM_PJ_PER_BYTE / 1e12
    fabric_bytes = (
        int(schedule.get("total_fabric_cycles", 0)) * LINK_BITS_PER_CYCLE_BIDIRECTIONAL // 8
    )
    fabric_energy_j = (
        fabric_bytes
        * float(schedule.get("repair_hop_penalty", 0.0))
        * FABRIC_PJ_PER_BYTE_HOP
        / 1e12
    )
    active_static_energy_j = average_active_cores * STATIC_POWER_W_PER_CORE * elapsed_s
    schedule_energy_j = (
        compute_energy_j + local_sram_energy_j + fabric_energy_j + active_static_energy_j
    )
    schedule_average_power_w = schedule_energy_j / max(elapsed_s, 1e-12)
    schedule_power_density_w_per_mm2 = schedule_average_power_w / WAFER_AREA_MM2
    schedule_planning_junction_c = (
        AMBIENT_COOLANT_C + schedule_average_power_w * PLANNING_THETA_JA_C_PER_W
    )

    model_required_vs_sram = float(
        model_load.get("model_load", {}).get("total_required_mib", 0.0)
    ) / (logical_cores * LOCAL_SRAM_KIB_PER_CORE / 1024)

    gate_checks = [
        (
            "scaled_mesh_matches_8gb_contract",
            logical_cores == LOGICAL_CORES
            and clock_hz == CORE_CLOCK_HZ
            and 0.0 < model_required_vs_sram < 1.0,
            "schedule/model-load artifacts describe the scaled 8GB E1X mesh and resident model fit",
        ),
        (
            "peak_power_within_wafer_liquid_cooling_envelope",
            peak_package_power_w < LIQUID_COOLED_SYSTEM_POWER_ENVELOPE_W,
            (
                f"modeled dense peak package power {peak_package_power_w:.1f} W is below "
                f"{LIQUID_COOLED_SYSTEM_POWER_ENVELOPE_W:.0f} W wafer-system envelope"
            ),
        ),
        (
            "peak_power_density_within_planning_limit",
            peak_power_density_w_per_mm2 < PLANNING_POWER_DENSITY_LIMIT_W_PER_MM2,
            (
                f"modeled peak density {peak_power_density_w_per_mm2:.4f} W/mm2 is below "
                f"{PLANNING_POWER_DENSITY_LIMIT_W_PER_MM2:.2f} W/mm2 planning limit"
            ),
        ),
        (
            "planning_junction_within_modeled_limit",
            peak_planning_junction_c < MAX_PLANNING_JUNCTION_C
            and schedule_planning_junction_c < MAX_PLANNING_JUNCTION_C,
            (
                f"planning junction peak={peak_planning_junction_c:.2f} C "
                f"schedule={schedule_planning_junction_c:.2f} C under {MAX_PLANNING_JUNCTION_C:.1f} C"
            ),
        ),
        (
            "real_graph_schedule_energy_is_positive_and_bounded",
            0.0 < schedule_energy_j < 1.0 and 0.0 < schedule_average_power_w < peak_package_power_w,
            (
                f"real-graph schedule energy={schedule_energy_j:.6f} J "
                f"average_power={schedule_average_power_w:.3f} W"
            ),
        ),
    ]
    for check_id, condition, detail in gate_checks:
        status, resolved_detail = pass_fail(condition, detail)
        checks.append(
            {"id": f"e1x_power_thermal_{check_id}", "status": status, "detail": resolved_detail}
        )

    failures = [check for check in checks if check["status"] != "pass"]
    summary = {
        "check_count": len(checks),
        "failing_check_count": len(failures),
        "logical_cores": logical_cores,
        "local_sram_mib": logical_cores * LOCAL_SRAM_KIB_PER_CORE / 1024,
        "model_required_vs_sram": model_required_vs_sram,
        "wafer_area_mm2": WAFER_AREA_MM2,
        "peak_int8_tops": peak_int8_ops_per_s / 1e12,
        "peak_dynamic_power_w": peak_dynamic_power_w,
        "all_core_static_power_w": all_core_static_power_w,
        "peak_package_power_w": peak_package_power_w,
        "peak_power_density_w_per_mm2": peak_power_density_w_per_mm2,
        "peak_planning_junction_c": peak_planning_junction_c,
        "schedule_elapsed_ms": elapsed_s * 1000,
        "schedule_energy_j": schedule_energy_j,
        "schedule_average_power_w": schedule_average_power_w,
        "schedule_power_density_w_per_mm2": schedule_power_density_w_per_mm2,
        "schedule_planning_junction_c": schedule_planning_junction_c,
        "schedule_average_active_cores": average_active_cores,
        "cooling_envelope_w": LIQUID_COOLED_SYSTEM_POWER_ENVELOPE_W,
    }
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-power-thermal",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": utc_now(),
        "subsystem": "e1x",
        "claim_boundary": (
            "Planning-grade E1X power/thermal arithmetic from architecture constants and "
            "real-graph schedule artifacts. This is not package thermal signoff, PDN/SI/PI "
            "signoff, foundry power extraction, calibrated electrothermal simulation, or "
            "measured silicon power."
        ),
        "evidence_paths": [
            "benchmarks/results/e1x-real-graph-schedule-execution-estimate.json",
            "benchmarks/results/e1x-real-graph-model-load.json",
            "compiler/runtime/e1x_wafer_model.py",
            "docs/arch/e1x-wafer-mesh.md",
            "scripts/check_e1x_power_thermal.py",
        ],
        "checks": checks,
        "summary": summary,
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print("BLOCKED: E1X power/thermal failed: " + ", ".join(c["id"] for c in failures))
        return 1
    print(f"PASS: E1X power/thermal; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
