#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from compiler.runtime.e1_npu_scale_model import (  # noqa: E402
    MIN_REAL_V1,
    OPEN_2028_FIRST,
    OPEN_2028_SOTA,
    OPEN_2028_STRETCH,
    NpuScaleConfig,
    estimate_attention_qk_s8,
    estimate_conv2d_s8,
    estimate_gemm_s8,
)

CONFIGS = {
    MIN_REAL_V1.name: MIN_REAL_V1,
    OPEN_2028_FIRST.name: OPEN_2028_FIRST,
    OPEN_2028_STRETCH.name: OPEN_2028_STRETCH,
    OPEN_2028_SOTA.name: OPEN_2028_SOTA,
}
MODEL = ROOT / "benchmarks/models/mobile_smoke.tflite"
PROCESS_EFFECTS = ROOT / "docs/spec-db/process-14a-effects.yaml"
DESCRIPTOR_BYTES = 16


@dataclass(frozen=True)
class ProcessCorner:
    name: str
    voltage_v: float
    temperature_c: int
    frequency_derate: float
    interconnect_rc_derate: float
    dynamic_power_scale: float
    leakage_power_scale: float
    thermal_margin_derate: float
    claim_boundary: str


PROCESS_CORNERS = (
    ProcessCorner(
        name="14a_tt_0p70v_25c_frontside_pdn",
        voltage_v=0.70,
        temperature_c=25,
        frequency_derate=1.00,
        interconnect_rc_derate=1.00,
        dynamic_power_scale=1.00,
        leakage_power_scale=1.00,
        thermal_margin_derate=1.00,
        claim_boundary="planning_corner_not_pdk_signoff",
    ),
    ProcessCorner(
        name="14a_ss_0p63v_105c_frontside_pdn",
        voltage_v=0.63,
        temperature_c=105,
        frequency_derate=0.72,
        interconnect_rc_derate=1.30,
        dynamic_power_scale=0.81,
        leakage_power_scale=1.85,
        thermal_margin_derate=0.70,
        claim_boundary="pessimistic_mobile_hot_corner_not_pdk_signoff",
    ),
    ProcessCorner(
        name="14a_ff_0p77v_0c_frontside_pdn",
        voltage_v=0.77,
        temperature_c=0,
        frequency_derate=1.14,
        interconnect_rc_derate=0.88,
        dynamic_power_scale=1.21,
        leakage_power_scale=0.62,
        thermal_margin_derate=1.08,
        claim_boundary="fast_cold_corner_not_pdk_signoff",
    ),
    ProcessCorner(
        name="14a_bspdn_follow_on_hot_ir_em_stress",
        voltage_v=0.68,
        temperature_c=115,
        frequency_derate=0.82,
        interconnect_rc_derate=1.12,
        dynamic_power_scale=0.94,
        leakage_power_scale=2.25,
        thermal_margin_derate=0.62,
        claim_boundary="backside_pdn_follow_on_variant_not_selected_not_pdk_signoff",
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


def build_workload(config: NpuScaleConfig):
    return [
        estimate_gemm_s8(config, 4096, 4096, 4096),
        estimate_gemm_s8(config, 1024, 1024, 4096),
        estimate_conv2d_s8(config, 1, 56, 56, 256, 256, 3, 3),
        estimate_attention_qk_s8(config, 1, 16, 2048, 2048, 128),
    ]


def ceil_div(numerator: int, denominator: int) -> int:
    if denominator <= 0:
        raise ValueError("denominator must be positive")
    return (numerator + denominator - 1) // denominator


def descriptor_counter_entry(config: NpuScaleConfig, estimate) -> dict:
    transfer_bytes = estimate.bytes_read + estimate.bytes_written
    scratchpad_bytes = max(1, config.scratchpad_kib * 1024)
    descriptors_required = ceil_div(transfer_bytes, scratchpad_bytes)
    return {
        "schema": "eliza.npu_scale_descriptor_counter_model.v1",
        "claim_boundary": "modeled_queue_pressure_only_not_rtl_dma_or_silicon_counter_evidence",
        "descriptor_bytes": DESCRIPTOR_BYTES,
        "descriptor_queue_depth": config.dma_queue_depth,
        "descriptor_payload_bytes": scratchpad_bytes,
        "descriptors_required": descriptors_required,
        "descriptor_queue_passes": ceil_div(descriptors_required, config.dma_queue_depth),
        "descriptor_ring_bytes": descriptors_required * DESCRIPTOR_BYTES,
        "dma_read_beats": ceil_div(estimate.bytes_read, config.dma_bytes_per_cycle),
        "dma_write_beats": ceil_div(estimate.bytes_written, config.dma_bytes_per_cycle),
        "dma_total_beats": ceil_div(transfer_bytes, config.dma_bytes_per_cycle),
        "dma_bytes_per_cycle": config.dma_bytes_per_cycle,
        "modeled_read_bytes": estimate.bytes_read,
        "modeled_written_bytes": estimate.bytes_written,
    }


def metric_entry(config: NpuScaleConfig, estimate) -> dict:
    memory_wait_cycles = max(0, estimate.memory_cycles - estimate.compute_cycles)
    stall_cycles = max(0, estimate.cycles - estimate.compute_cycles)
    utilization = 100.0 * estimate.compute_cycles / estimate.cycles
    elapsed_s = estimate.cycles / config.clock_hz
    return {
        "kernel": estimate.kernel,
        "target_cycles": estimate.cycles,
        "npu_cycles": estimate.cycles,
        "macs": estimate.macs,
        "bytes_read": estimate.bytes_read,
        "bytes_written": estimate.bytes_written,
        "external_bytes_read": estimate.external_bytes_read,
        "external_bytes_written": estimate.external_bytes_written,
        "local_sram_bytes": estimate.local_sram_bytes,
        "compute_cycles": estimate.compute_cycles,
        "memory_cycles": estimate.memory_cycles,
        "memory_wait_cycles": memory_wait_cycles,
        "stall_cycles": stall_cycles,
        "utilization_percent": utilization,
        "modeled_frequency_hz": config.clock_hz,
        "throughput_ops_s": (estimate.macs * 2) / elapsed_s,
        "observed_tops": estimate.observed_tops(config.clock_hz),
        "energy_nj": estimate.energy_nj(config),
        "average_power_w": estimate.average_power_w(config),
        "tops_per_watt": estimate.tops_per_watt(config),
        "arithmetic_intensity_macs_per_external_byte": (
            estimate.arithmetic_intensity_macs_per_external_byte()
        ),
        "descriptor_counters": descriptor_counter_entry(config, estimate),
    }


def process_corner_entry(config: NpuScaleConfig, corner: ProcessCorner, estimates) -> dict:
    effective_clock_hz = int(config.clock_hz * corner.frequency_derate)
    effective_dma_bytes_per_cycle = max(
        1, int(config.dma_bytes_per_cycle / corner.interconnect_rc_derate)
    )
    kernel_entries = []
    for estimate in estimates:
        compute_cycles = estimate.compute_cycles
        memory_cycles = (
            estimate.bytes_read + estimate.bytes_written + effective_dma_bytes_per_cycle - 1
        ) // effective_dma_bytes_per_cycle
        cycles = max(compute_cycles, memory_cycles)
        elapsed_s = cycles / effective_clock_hz
        dynamic_pj = (
            estimate.macs * config.energy_pj_per_int8_mac * corner.dynamic_power_scale
            + estimate.local_sram_bytes * config.local_sram_pj_per_byte * corner.dynamic_power_scale
            + (estimate.external_bytes_read + estimate.external_bytes_written)
            * config.external_memory_pj_per_byte
            * corner.interconnect_rc_derate
        )
        static_nj = config.static_power_w * corner.leakage_power_scale * elapsed_s * 1e9
        energy_nj = dynamic_pj / 1000.0 + static_nj
        average_power_w = energy_nj / 1e9 / elapsed_s
        observed_tops = estimate.macs * 2 / elapsed_s / 1e12
        kernel_entries.append(
            {
                "kernel": estimate.kernel,
                "npu_cycles": cycles,
                "compute_cycles": compute_cycles,
                "memory_cycles": memory_cycles,
                "memory_wait_cycles": max(0, memory_cycles - compute_cycles),
                "modeled_frequency_hz": effective_clock_hz,
                "observed_tops": observed_tops,
                "utilization_percent": 100.0 * compute_cycles / cycles,
                "energy_nj": energy_nj,
                "average_power_w": average_power_w,
                "tops_per_watt": observed_tops / average_power_w,
            }
        )
    min_observed_tops = min(kernel["observed_tops"] for kernel in kernel_entries)
    return {
        "name": corner.name,
        "voltage_v": corner.voltage_v,
        "temperature_c": corner.temperature_c,
        "frequency_derate": corner.frequency_derate,
        "interconnect_rc_derate": corner.interconnect_rc_derate,
        "dynamic_power_scale": corner.dynamic_power_scale,
        "leakage_power_scale": corner.leakage_power_scale,
        "thermal_margin_derate": corner.thermal_margin_derate,
        "effective_clock_hz": effective_clock_hz,
        "effective_dma_bytes_per_cycle": effective_dma_bytes_per_cycle,
        "dense_int8_peak_tops": config.int8_macs_per_cycle * 2 * effective_clock_hz / 1e12,
        "min_observed_tops": min_observed_tops,
        "max_observed_tops": max(kernel["observed_tops"] for kernel in kernel_entries),
        "min_utilization_percent": min(kernel["utilization_percent"] for kernel in kernel_entries),
        "min_tops_per_watt": min(kernel["tops_per_watt"] for kernel in kernel_entries),
        "max_average_power_w": max(kernel["average_power_w"] for kernel in kernel_entries),
        "kernels": kernel_entries,
        "claim_boundary": corner.claim_boundary,
        "release_use": "prohibited_until_pdk_extracted_timing_power_thermal_signoff",
    }


def run_timeloop_energy(config_name: str) -> dict | None:
    """Invoke ``run_npu_timeloop.py`` and merge its energy column.

    Returns ``None`` when the Timeloop tools are missing (blocked) so the
    caller can record the gap explicitly. Never fabricates energy numbers.
    """
    script = Path(__file__).resolve().parent / "run_npu_timeloop.py"
    if not script.is_file():
        return None
    try:
        completed = subprocess.run(
            [sys.executable, str(script), "--config", config_name],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
            timeout=900,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if completed.returncode != 0 and not completed.stdout:
        return None
    try:
        return json.loads(completed.stdout)
    except json.JSONDecodeError:
        return None


def main() -> int:
    parser = argparse.ArgumentParser(description="Run deterministic NPU architecture scale model")
    parser.add_argument("--config", choices=sorted(CONFIGS), default=OPEN_2028_FIRST.name)
    parser.add_argument("--out", type=Path)
    parser.add_argument(
        "--with-timeloop-energy",
        action="store_true",
        help=(
            "Invoke benchmarks/sim/run_npu_timeloop.py to attach modeled "
            "joules-per-inference. Fails closed if the tools are missing."
        ),
    )
    args = parser.parse_args()

    config = CONFIGS[args.config]
    estimates = build_workload(config)
    kernels = [metric_entry(config, estimate) for estimate in estimates]
    process_corners = [
        process_corner_entry(config, corner, estimates) for corner in PROCESS_CORNERS
    ]
    worst_corner = min(process_corners, key=lambda corner: corner["min_observed_tops"])
    descriptor_counters = [kernel["descriptor_counters"] for kernel in kernels]
    report = {
        "schema": "eliza.npu_scale_sim.v1",
        "status": "pass",
        "claim_boundary": (
            "Deterministic architecture scale model only; not measured RTL, "
            "Android NNAPI, silicon performance, or phone-class throughput evidence."
        ),
        "config": {
            "name": config.name,
            "tiles": config.tiles,
            "int8_macs_per_tile_per_cycle": config.int8_macs_per_tile_per_cycle,
            "int8_macs_per_cycle": config.int8_macs_per_cycle,
            "clock_hz": config.clock_hz,
            "scratchpad_kib": config.scratchpad_kib,
            "dma_queue_depth": config.dma_queue_depth,
            "dma_bytes_per_cycle": config.dma_bytes_per_cycle,
            "dense_int8_peak_tops": config.dense_int8_peak_tops,
            "sparse_int4_peak_tops": config.sparse_int4_peak_tops,
            "supports_int4": config.supports_int4,
            "supports_bf16": config.supports_bf16,
            "supports_fp16": config.supports_fp16,
            "supports_fp8": config.supports_fp8,
            "energy_pj_per_int8_mac": config.energy_pj_per_int8_mac,
            "local_sram_pj_per_byte": config.local_sram_pj_per_byte,
            "external_memory_pj_per_byte": config.external_memory_pj_per_byte,
            "static_power_w": config.static_power_w,
            "precision_matrix": config.precision_matrix(),
            "descriptor_queue": {
                "depth": config.dma_queue_depth,
                "submission_api": "modeled_only",
                "runtime_mmio_support": "reserved_blocked_without_dma_engine_evidence",
            },
        },
        "artifacts": {
            "model": file_hash(MODEL),
            "benchmark_model_hash_capture": "sha256",
            "process_effects_contract": file_hash(PROCESS_EFFECTS),
        },
        "kernels": kernels,
        "process_corners": process_corners,
        "summary": {
            "kernel_count": len(kernels),
            "process_corner_count": len(process_corners),
            "total_macs": sum(kernel["macs"] for kernel in kernels),
            "total_bytes_read": sum(kernel["bytes_read"] for kernel in kernels),
            "total_bytes_written": sum(kernel["bytes_written"] for kernel in kernels),
            "total_descriptors_required": sum(
                counter["descriptors_required"] for counter in descriptor_counters
            ),
            "max_descriptor_queue_passes": max(
                counter["descriptor_queue_passes"] for counter in descriptor_counters
            ),
            "total_dma_read_beats": sum(
                counter["dma_read_beats"] for counter in descriptor_counters
            ),
            "total_dma_write_beats": sum(
                counter["dma_write_beats"] for counter in descriptor_counters
            ),
            "total_dma_beats": sum(counter["dma_total_beats"] for counter in descriptor_counters),
            "min_observed_tops": min(kernel["observed_tops"] for kernel in kernels),
            "max_observed_tops": max(kernel["observed_tops"] for kernel in kernels),
            "min_utilization_percent": min(kernel["utilization_percent"] for kernel in kernels),
            "min_tops_per_watt": min(kernel["tops_per_watt"] for kernel in kernels),
            "max_average_power_w": max(kernel["average_power_w"] for kernel in kernels),
            "worst_process_corner": worst_corner["name"],
            "worst_process_corner_min_observed_tops": worst_corner["min_observed_tops"],
            "process_corner_claim_boundary": "modeled_derates_only_not_14a_pdk_or_signoff_evidence",
        },
    }
    if args.with_timeloop_energy:
        energy_report = run_timeloop_energy(config.name)
        if energy_report is None:
            report["timeloop_energy"] = {
                "status": "blocked",
                "reason": (
                    "benchmarks/sim/run_npu_timeloop.py did not produce a "
                    "parseable JSON report (typically because timeloop / "
                    "accelergy binaries are missing)."
                ),
            }
        else:
            report["timeloop_energy"] = energy_report
            energy = None
            if isinstance(energy_report, dict):
                summary_block = energy_report.get("summary")
                if isinstance(summary_block, dict):
                    energy = summary_block.get("energy_joules_per_inference")
            if energy is not None and isinstance(report["summary"], dict):
                report["summary"]["energy_joules_per_inference"] = energy

    text = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.out:
        output = args.out if args.out.is_absolute() else ROOT / args.out
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(text, encoding="utf-8")
    print(text, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
