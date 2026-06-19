#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PROCESS_EFFECTS = ROOT / "docs/spec-db/process-14a-effects.yaml"
DEFAULT_OUT = ROOT / "benchmarks/results/soc-thermal-sweep.json"

FALSE_CLAIM_FLAGS = {
    "release_claim_allowed": False,
    "phone_score_claim_allowed": False,
    "rtl_claim_allowed": False,
    "pdk_signoff_claim_allowed": False,
    "silicon_claim_allowed": False,
    "sustained_power_thermal_claim_allowed": False,
    "aosp_runtime_claim_allowed": False,
    "production_readiness_claim_allowed": False,
}


@dataclass(frozen=True)
class ProcessCorner:
    name: str
    voltage_v: float
    temperature_c: int
    cpu_frequency_derate: float
    cpu_ipc_derate: float
    npu_frequency_derate: float
    npu_memory_derate: float
    dynamic_power_scale: float
    leakage_power_scale: float
    thermal_resistance_scale: float
    claim_boundary: str


@dataclass(frozen=True)
class Scenario:
    name: str
    cpu_active_fraction: float
    npu_active_fraction: float
    memory_bandwidth_gbps: float
    display_camera_gbps: float
    duration_s: int
    intent: str


PROCESS_CORNERS = (
    ProcessCorner(
        name="14a_tt_0p70v_25c_frontside_pdn",
        voltage_v=0.70,
        temperature_c=25,
        cpu_frequency_derate=1.00,
        cpu_ipc_derate=1.00,
        npu_frequency_derate=1.00,
        npu_memory_derate=1.00,
        dynamic_power_scale=1.00,
        leakage_power_scale=1.00,
        thermal_resistance_scale=1.00,
        claim_boundary="planning_corner_not_pdk_signoff",
    ),
    ProcessCorner(
        name="14a_ss_0p63v_105c_frontside_pdn",
        voltage_v=0.63,
        temperature_c=105,
        cpu_frequency_derate=0.72,
        cpu_ipc_derate=0.90,
        npu_frequency_derate=0.72,
        npu_memory_derate=0.77,
        dynamic_power_scale=0.81,
        leakage_power_scale=1.85,
        thermal_resistance_scale=1.25,
        claim_boundary="pessimistic_mobile_hot_corner_not_pdk_signoff",
    ),
    ProcessCorner(
        name="14a_ff_0p77v_0c_frontside_pdn",
        voltage_v=0.77,
        temperature_c=0,
        cpu_frequency_derate=1.14,
        cpu_ipc_derate=1.03,
        npu_frequency_derate=1.14,
        npu_memory_derate=1.08,
        dynamic_power_scale=1.21,
        leakage_power_scale=0.62,
        thermal_resistance_scale=0.92,
        claim_boundary="fast_cold_corner_not_pdk_signoff",
    ),
    ProcessCorner(
        name="14a_bspdn_follow_on_hot_ir_em_stress",
        voltage_v=0.68,
        temperature_c=115,
        cpu_frequency_derate=0.82,
        cpu_ipc_derate=0.94,
        npu_frequency_derate=0.82,
        npu_memory_derate=0.89,
        dynamic_power_scale=0.94,
        leakage_power_scale=2.25,
        thermal_resistance_scale=1.35,
        claim_boundary="backside_pdn_follow_on_variant_not_selected_not_pdk_signoff",
    ),
)

SCENARIOS = (
    Scenario(
        name="android_foreground_ai_assistant",
        cpu_active_fraction=0.58,
        npu_active_fraction=0.62,
        memory_bandwidth_gbps=82.0,
        display_camera_gbps=18.0,
        duration_s=1800,
        intent="mixed CPU scheduler, NPU inference, display, and camera contention",
    ),
    Scenario(
        name="sustained_npu_camera_display",
        cpu_active_fraction=0.35,
        npu_active_fraction=0.88,
        memory_bandwidth_gbps=118.0,
        display_camera_gbps=34.0,
        duration_s=1800,
        intent="sustained NPU path with camera/display memory pressure",
    ),
    Scenario(
        name="cpu_peak_background_npu",
        cpu_active_fraction=0.92,
        npu_active_fraction=0.28,
        memory_bandwidth_gbps=74.0,
        display_camera_gbps=12.0,
        duration_s=900,
        intent="CPU-heavy foreground work with concurrent low-duty NPU",
    ),
)


def file_hash(path: Path) -> dict[str, str | int]:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return {
        "path": str(path.relative_to(ROOT)),
        "sha256": digest.hexdigest(),
        "bytes": path.stat().st_size,
    }


def scenario_entry(
    scenario: Scenario,
    corner: ProcessCorner,
    *,
    cpu_base_ipc: float,
    cpu_base_frequency_hz: int,
    cpu_base_power_w: float,
    npu_base_tops: float,
    npu_base_power_w: float,
    memory_sustained_gbps: float,
    ambient_c: float,
) -> dict[str, float | int | str | bool]:
    cpu_frequency_hz = int(cpu_base_frequency_hz * corner.cpu_frequency_derate)
    cpu_ipc = cpu_base_ipc * corner.cpu_ipc_derate
    npu_tops = npu_base_tops * corner.npu_frequency_derate * corner.npu_memory_derate
    cpu_power_w = (
        cpu_base_power_w * scenario.cpu_active_fraction * corner.dynamic_power_scale
        + cpu_base_power_w * 0.16 * corner.leakage_power_scale
    )
    npu_power_w = (
        npu_base_power_w * scenario.npu_active_fraction * corner.dynamic_power_scale
        + npu_base_power_w * 0.20 * corner.leakage_power_scale
    )
    memory_power_w = 0.012 * scenario.memory_bandwidth_gbps * corner.dynamic_power_scale
    uncore_power_w = 0.45 + 0.006 * scenario.display_camera_gbps * corner.dynamic_power_scale
    total_power_w = cpu_power_w + npu_power_w + memory_power_w + uncore_power_w
    die_temp_c = ambient_c + total_power_w * 8.8 * corner.thermal_resistance_scale
    bandwidth_limit_gbps = memory_sustained_gbps * corner.npu_memory_derate
    bandwidth_margin_gbps = bandwidth_limit_gbps - (
        scenario.memory_bandwidth_gbps + scenario.display_camera_gbps
    )
    throttle_required = die_temp_c > 95.0 or bandwidth_margin_gbps < 0
    return {
        "name": scenario.name,
        "intent": scenario.intent,
        "duration_s": scenario.duration_s,
        "cpu_frequency_hz": cpu_frequency_hz,
        "cpu_ipc": cpu_ipc,
        "npu_int8_tops": npu_tops,
        "memory_bandwidth_demand_gbps": scenario.memory_bandwidth_gbps,
        "display_camera_bandwidth_gbps": scenario.display_camera_gbps,
        "memory_bandwidth_limit_gbps": bandwidth_limit_gbps,
        "memory_bandwidth_margin_gbps": bandwidth_margin_gbps,
        "cpu_power_w": cpu_power_w,
        "npu_power_w": npu_power_w,
        "memory_power_w": memory_power_w,
        "uncore_power_w": uncore_power_w,
        "total_power_w": total_power_w,
        "die_temp_c": die_temp_c,
        "npu_tops_per_w": npu_tops / max(npu_power_w, 1e-9),
        "composite_perf_per_w": (cpu_ipc * scenario.cpu_active_fraction + npu_tops / 10.0)
        / total_power_w,
        "throttle_required": throttle_required,
        "release_use": "prohibited_until_pdk_extracted_timing_power_thermal_signoff",
    }


def corner_entry(corner: ProcessCorner, args: argparse.Namespace) -> dict:
    scenarios = [
        scenario_entry(
            scenario,
            corner,
            cpu_base_ipc=args.cpu_base_ipc,
            cpu_base_frequency_hz=args.cpu_base_frequency_hz,
            cpu_base_power_w=args.cpu_base_power_w,
            npu_base_tops=args.npu_base_tops,
            npu_base_power_w=args.npu_base_power_w,
            memory_sustained_gbps=args.memory_sustained_gbps,
            ambient_c=args.ambient_c,
        )
        for scenario in SCENARIOS
    ]
    worst_thermal = max(scenarios, key=lambda item: float(item["die_temp_c"]))
    worst_efficiency = min(scenarios, key=lambda item: float(item["composite_perf_per_w"]))
    return {
        "name": corner.name,
        "voltage_v": corner.voltage_v,
        "temperature_c": corner.temperature_c,
        "cpu_frequency_derate": corner.cpu_frequency_derate,
        "cpu_ipc_derate": corner.cpu_ipc_derate,
        "npu_frequency_derate": corner.npu_frequency_derate,
        "npu_memory_derate": corner.npu_memory_derate,
        "dynamic_power_scale": corner.dynamic_power_scale,
        "leakage_power_scale": corner.leakage_power_scale,
        "thermal_resistance_scale": corner.thermal_resistance_scale,
        "claim_boundary": corner.claim_boundary,
        "release_use": "prohibited_until_pdk_extracted_timing_power_thermal_signoff",
        "scenarios": scenarios,
        "summary": {
            "max_total_power_w": max(float(item["total_power_w"]) for item in scenarios),
            "max_die_temp_c": float(worst_thermal["die_temp_c"]),
            "worst_thermal_scenario": str(worst_thermal["name"]),
            "min_composite_perf_per_w": float(worst_efficiency["composite_perf_per_w"]),
            "worst_efficiency_scenario": str(worst_efficiency["name"]),
            "throttle_required": any(bool(item["throttle_required"]) for item in scenarios),
        },
    }


def build_report(args: argparse.Namespace) -> dict:
    if not PROCESS_EFFECTS.is_file():
        raise SystemExit(f"missing {PROCESS_EFFECTS.relative_to(ROOT)}")
    corners = [corner_entry(corner, args) for corner in PROCESS_CORNERS]
    all_scenarios = [
        scenario
        for corner in corners
        for scenario in corner["scenarios"]
        if isinstance(corner.get("scenarios"), list)
    ]
    worst_thermal = max(all_scenarios, key=lambda item: float(item["die_temp_c"]))
    worst_efficiency = min(all_scenarios, key=lambda item: float(item["composite_perf_per_w"]))
    max_power = max(all_scenarios, key=lambda item: float(item["total_power_w"]))
    return {
        "schema": "eliza.soc_cpu_npu_thermal_sweep.v1",
        "status": "pass",
        **FALSE_CLAIM_FLAGS,
        "evidence_class": "deterministic_combined_cpu_npu_arch_model",
        "claim_boundary": "modeled_only_not_rtl_pdk_silicon_sustained_or_phone_score_evidence",
        "benchmark_success_allowed": True,
        "release_use": "prohibited_until_pdk_extracted_timing_power_thermal_signoff",
        "config": {
            "cpu_cores": 2,
            "cpu_base_ipc": args.cpu_base_ipc,
            "cpu_base_frequency_hz": args.cpu_base_frequency_hz,
            "cpu_base_power_w": args.cpu_base_power_w,
            "npu_base_tops": args.npu_base_tops,
            "npu_base_power_w": args.npu_base_power_w,
            "memory_sustained_gbps": args.memory_sustained_gbps,
            "ambient_c": args.ambient_c,
            "model_boundary": "combined architecture planning model; no PDK, RTL, silicon, or AOSP proof",
        },
        "artifacts": {
            "process_effects_contract": file_hash(PROCESS_EFFECTS),
            "cpu_ap_model": "benchmarks/generate_simulator_arch_metrics.py --mode model-14a-cpu-ap",
            "npu_model": "benchmarks/sim/run_npu_scale_sim.py --config open_2028_first_50tops",
        },
        "process_corners": corners,
        "summary": {
            "process_corner_count": len(corners),
            "scenario_count": len(SCENARIOS),
            "max_total_power_w": float(max_power["total_power_w"]),
            "max_die_temp_c": float(worst_thermal["die_temp_c"]),
            "worst_thermal_corner": next(
                corner["name"] for corner in corners if worst_thermal in corner["scenarios"]
            ),
            "worst_thermal_scenario": str(worst_thermal["name"]),
            "min_composite_perf_per_w": float(worst_efficiency["composite_perf_per_w"]),
            "worst_efficiency_corner": next(
                corner["name"] for corner in corners if worst_efficiency in corner["scenarios"]
            ),
            "worst_efficiency_scenario": str(worst_efficiency["name"]),
            "any_modeled_throttle_required": any(
                bool(item["throttle_required"]) for item in all_scenarios
            ),
            "claim_boundary": "modeled_derates_only_not_sustained_power_thermal_evidence",
        },
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run combined CPU+NPU 14A thermal sweep model")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--cpu-base-ipc", type=float, default=1.80)
    parser.add_argument("--cpu-base-frequency-hz", type=int, default=3_200_000_000)
    parser.add_argument("--cpu-base-power-w", type=float, default=3.2)
    parser.add_argument("--npu-base-tops", type=float, default=36.6)
    parser.add_argument("--npu-base-power-w", type=float, default=3.6)
    parser.add_argument("--memory-sustained-gbps", type=float, default=120.0)
    parser.add_argument("--ambient-c", type=float, default=25.0)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = build_report(args)
    text = json.dumps(report, indent=2, sort_keys=True) + "\n"
    out = args.out if args.out.is_absolute() else ROOT / args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text, encoding="utf-8")
    print(text, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
