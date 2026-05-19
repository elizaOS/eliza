#!/usr/bin/env python3
"""Generate simulator architecture metrics artifacts.

The default mode preserves the historical QEMU liveness-only artifact and is
not benchmark evidence. The 14A CPU/AP mode emits a deterministic architecture
model with cycle, IPC, power, thermal, and process-corner fields for local
benchmark plumbing. It is still modeled evidence, not PDK or silicon signoff.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_QEMU_LOG = ROOT / "build/reports/qemu_smoke.log"
DEFAULT_OUT = ROOT / "benchmarks/results/simulator-arch-metrics.json"
PROCESS_EFFECTS = ROOT / "docs/spec-db/process-14a-effects.yaml"
BANNER = "eliza e1 qemu"


@dataclass(frozen=True)
class CpuProcessCorner:
    name: str
    voltage_v: float
    temperature_c: int
    frequency_derate: float
    ipc_derate: float
    dynamic_power_scale: float
    leakage_power_scale: float
    thermal_resistance_scale: float
    claim_boundary: str


PROCESS_CORNERS = (
    CpuProcessCorner(
        name="14a_tt_0p70v_25c_frontside_pdn",
        voltage_v=0.70,
        temperature_c=25,
        frequency_derate=1.00,
        ipc_derate=1.00,
        dynamic_power_scale=1.00,
        leakage_power_scale=1.00,
        thermal_resistance_scale=1.00,
        claim_boundary="planning_corner_not_pdk_signoff",
    ),
    CpuProcessCorner(
        name="14a_ss_0p63v_105c_frontside_pdn",
        voltage_v=0.63,
        temperature_c=105,
        frequency_derate=0.72,
        ipc_derate=0.90,
        dynamic_power_scale=0.81,
        leakage_power_scale=1.85,
        thermal_resistance_scale=1.25,
        claim_boundary="pessimistic_mobile_hot_corner_not_pdk_signoff",
    ),
    CpuProcessCorner(
        name="14a_ff_0p77v_0c_frontside_pdn",
        voltage_v=0.77,
        temperature_c=0,
        frequency_derate=1.14,
        ipc_derate=1.03,
        dynamic_power_scale=1.21,
        leakage_power_scale=0.62,
        thermal_resistance_scale=0.92,
        claim_boundary="fast_cold_corner_not_pdk_signoff",
    ),
    CpuProcessCorner(
        name="14a_bspdn_follow_on_hot_ir_em_stress",
        voltage_v=0.68,
        temperature_c=115,
        frequency_derate=0.82,
        ipc_derate=0.94,
        dynamic_power_scale=0.94,
        leakage_power_scale=2.25,
        thermal_resistance_scale=1.35,
        claim_boundary="backside_pdn_follow_on_variant_not_selected_not_pdk_signoff",
    ),
)


WORKLOADS = (
    {
        "name": "rv64gc_coremark_like_integer",
        "instructions": 240_000_000,
        "base_ipc": 2.25,
        "mpki": 1.8,
        "activity": 0.58,
    },
    {
        "name": "linux_kernel_compile_mix",
        "instructions": 420_000_000,
        "base_ipc": 1.72,
        "mpki": 5.6,
        "activity": 0.66,
    },
    {
        "name": "android_ui_runtime_mix",
        "instructions": 180_000_000,
        "base_ipc": 1.38,
        "mpki": 7.2,
        "activity": 0.42,
    },
    {
        "name": "tflite_cpu_fallback_smoke",
        "instructions": 310_000_000,
        "base_ipc": 1.95,
        "mpki": 3.1,
        "activity": 0.71,
    },
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--mode",
        choices=("qemu-liveness", "model-14a-cpu-ap"),
        default="qemu-liveness",
    )
    parser.add_argument("--qemu-log", type=Path, default=DEFAULT_QEMU_LOG)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--cores", type=int, default=2)
    parser.add_argument("--base-frequency-hz", type=int, default=3_200_000_000)
    parser.add_argument("--base-power-w", type=float, default=3.2)
    parser.add_argument("--ipc-scale", type=float, default=1.0)
    parser.add_argument("--mpki-scale", type=float, default=1.0)
    parser.add_argument(
        "--profile",
        choices=("efficient_2core", "sota_2core"),
        default="efficient_2core",
    )
    parser.add_argument("--ambient-c", type=float, default=25.0)
    return parser.parse_args()


def resolve(path: Path) -> Path:
    return path if path.is_absolute() else ROOT / path


def display_path(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def file_hash(path: Path) -> dict[str, str | int]:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return {
        "path": display_path(path),
        "sha256": digest.hexdigest(),
        "bytes": path.stat().st_size,
    }


def modeled_workload_entries(
    *,
    cores: int,
    frequency_hz: int,
    power_w: float,
    ipc_scale: float,
    mpki_scale: float,
    corner: CpuProcessCorner,
) -> list[dict[str, float | int | str]]:
    effective_frequency_hz = int(frequency_hz * corner.frequency_derate)
    entries: list[dict[str, float | int | str]] = []
    for workload in WORKLOADS:
        instructions_value = workload["instructions"]
        base_ipc_value = workload["base_ipc"]
        mpki_value = workload["mpki"]
        activity_value = workload["activity"]
        if not isinstance(instructions_value, int):
            raise TypeError("workload instructions must be int")
        if not isinstance(base_ipc_value, int | float):
            raise TypeError("workload base_ipc must be numeric")
        if not isinstance(mpki_value, int | float):
            raise TypeError("workload mpki must be numeric")
        if not isinstance(activity_value, int | float):
            raise TypeError("workload activity must be numeric")
        ipc = float(base_ipc_value) * ipc_scale * corner.ipc_derate
        target_cycles = int(instructions_value / (ipc * cores))
        elapsed_s = target_cycles / effective_frequency_hz
        dynamic_power_w = power_w * float(activity_value) * corner.dynamic_power_scale
        leakage_power_w = power_w * 0.18 * corner.leakage_power_scale
        estimated_power_w = dynamic_power_w + leakage_power_w
        entries.append(
            {
                "name": str(workload["name"]),
                "instructions": instructions_value,
                "target_cycles": target_cycles,
                "simulated_frequency_hz": effective_frequency_hz,
                "ipc": ipc,
                "mpki": float(mpki_value) * mpki_scale / corner.ipc_derate,
                "elapsed_seconds_modeled": elapsed_s,
                "estimated_package_power_w": estimated_power_w,
                "energy_j": estimated_power_w * elapsed_s,
            }
        )
    return entries


def modeled_14a_cpu_ap(args: argparse.Namespace) -> dict:
    if args.cores <= 0:
        raise SystemExit("--cores must be positive")
    if args.base_frequency_hz <= 0:
        raise SystemExit("--base-frequency-hz must be positive")
    if args.base_power_w <= 0:
        raise SystemExit("--base-power-w must be positive")
    if args.ipc_scale <= 0:
        raise SystemExit("--ipc-scale must be positive")
    if args.mpki_scale <= 0:
        raise SystemExit("--mpki-scale must be positive")
    if not PROCESS_EFFECTS.is_file():
        raise SystemExit(f"missing process effects contract: {PROCESS_EFFECTS.relative_to(ROOT)}")

    corners = []
    all_workloads = []
    for corner in PROCESS_CORNERS:
        workloads = modeled_workload_entries(
            cores=args.cores,
            frequency_hz=args.base_frequency_hz,
            power_w=args.base_power_w,
            ipc_scale=args.ipc_scale,
            mpki_scale=args.mpki_scale,
            corner=corner,
        )
        total_instructions = sum(int(workload["instructions"]) for workload in workloads)
        total_cycles = sum(int(workload["target_cycles"]) for workload in workloads)
        total_energy_j = sum(float(workload["energy_j"]) for workload in workloads)
        max_power_w = max(float(workload["estimated_package_power_w"]) for workload in workloads)
        estimated_die_temp_c = args.ambient_c + max_power_w * 9.5 * corner.thermal_resistance_scale
        effective_frequency_hz = int(args.base_frequency_hz * corner.frequency_derate)
        aggregate_ipc = total_instructions / (total_cycles * args.cores)
        entry = {
            "name": corner.name,
            "voltage_v": corner.voltage_v,
            "temperature_c": corner.temperature_c,
            "frequency_derate": corner.frequency_derate,
            "ipc_derate": corner.ipc_derate,
            "dynamic_power_scale": corner.dynamic_power_scale,
            "leakage_power_scale": corner.leakage_power_scale,
            "thermal_resistance_scale": corner.thermal_resistance_scale,
            "simulated_frequency_hz": effective_frequency_hz,
            "target_cycles": total_cycles,
            "instructions": total_instructions,
            "ipc": aggregate_ipc,
            "estimated_package_power_w": max_power_w,
            "estimated_die_temp_c": estimated_die_temp_c,
            "instructions_per_joule": total_instructions / total_energy_j,
            "workloads": workloads,
            "claim_boundary": corner.claim_boundary,
            "release_use": "prohibited_until_pdk_extracted_timing_power_thermal_signoff",
        }
        corners.append(entry)
        if corner.name == "14a_tt_0p70v_25c_frontside_pdn":
            all_workloads = workloads

    nominal = next(
        corner for corner in corners if corner["name"] == "14a_tt_0p70v_25c_frontside_pdn"
    )
    worst = min(corners, key=lambda corner: float(corner["ipc"]))
    max_power = max(corners, key=lambda corner: float(corner["estimated_package_power_w"]))
    max_temp = max(corners, key=lambda corner: float(corner["estimated_die_temp_c"]))
    return {
        "schema": "eliza.simulator_arch_metrics.v1",
        "evidence_class": "deterministic_14a_cpu_ap_arch_model",
        "claim_boundary": "modeled_architecture_metrics_only_not_pdk_rtl_silicon_or_phone_score_evidence",
        "calibration_status": "architecture_model_calibrated_by_static_assumptions",
        "benchmark_success_allowed": True,
        "config": {
            "cores": args.cores,
            "profile": args.profile,
            "isa": "rv64gc_planned_linux_ap_profile",
            "base_frequency_hz": args.base_frequency_hz,
            "base_power_w": args.base_power_w,
            "ipc_scale": args.ipc_scale,
            "mpki_scale": args.mpki_scale,
            "ambient_c": args.ambient_c,
            "model_boundary": "two-core scalable AP model; not RTL performance signoff",
        },
        "process_effects_contract": file_hash(PROCESS_EFFECTS),
        "target_cycles": int(nominal["target_cycles"]),
        "simulated_frequency_hz": int(nominal["simulated_frequency_hz"]),
        "ipc": float(nominal["ipc"]),
        "mpki": sum(float(workload["mpki"]) for workload in all_workloads) / len(all_workloads),
        "estimated_package_power_w": float(nominal["estimated_package_power_w"]),
        "estimated_die_temp_c": float(nominal["estimated_die_temp_c"]),
        "instructions_per_joule": float(nominal["instructions_per_joule"]),
        "process_corner_count": len(corners),
        "worst_process_corner": str(worst["name"]),
        "worst_process_corner_ipc": float(worst["ipc"]),
        "worst_process_corner_frequency_hz": int(worst["simulated_frequency_hz"]),
        "worst_process_corner_power_w": float(max_power["estimated_package_power_w"]),
        "worst_process_corner_die_temp_c": float(max_temp["estimated_die_temp_c"]),
        "workloads": all_workloads,
        "process_corners": corners,
    }


def qemu_liveness(args: argparse.Namespace) -> dict:
    qemu_log = resolve(args.qemu_log)
    if not qemu_log.is_file():
        raise SystemExit(f"missing qemu smoke log: {qemu_log.relative_to(ROOT)}")

    text = qemu_log.read_text(errors="ignore")
    if BANNER not in text:
        raise SystemExit(f"qemu smoke log does not contain required banner: {BANNER}")

    return {
        "schema": "eliza.simulator_arch_metrics.v1",
        "evidence_class": "qemu_virt_liveness_only",
        "claim_boundary": "not_performance_evidence",
        "calibration_status": "uncalibrated",
        "benchmark_success_allowed": False,
        "source_log": display_path(qemu_log),
        "observed_banner": BANNER,
        "target_cycles": 0,
        "simulated_frequency_hz": 0,
        "ipc": 0,
        "notes": [
            "QEMU smoke confirms firmware liveness only.",
            "Cycle, frequency, and IPC remain zero until gem5, RTL, FPGA, or silicon metrics exist.",
            "Do not compare this artifact with phone-class benchmark results.",
        ],
    }


def main() -> int:
    args = parse_args()
    out = resolve(args.out)
    data = qemu_liveness(args) if args.mode == "qemu-liveness" else modeled_14a_cpu_ap(args)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"wrote {display_path(out)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
