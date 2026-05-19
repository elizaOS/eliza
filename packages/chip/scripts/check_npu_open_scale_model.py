#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from compiler.runtime.e1_npu_scale_model import (  # noqa: E402
    MIN_REAL_V1,
    OPEN_2028_FIRST,
    OPEN_2028_SOTA,
    OPEN_2028_STRETCH,
    estimate_attention_qk_s8,
    estimate_conv2d_s8,
    estimate_gemm_s8,
)


def require(condition: bool, message: str, errors: list[str]) -> None:
    if not condition:
        errors.append(message)


def main() -> int:
    errors: list[str] = []

    require(
        16 <= MIN_REAL_V1.int8_macs_per_cycle <= 64,
        f"minimum real v1 MAC/cycle out of range: {MIN_REAL_V1.int8_macs_per_cycle}",
        errors,
    )
    require(
        MIN_REAL_V1.scratchpad_kib >= 128, "minimum real v1 scratchpad must be >=128 KiB", errors
    )
    require(
        MIN_REAL_V1.dma_queue_depth >= 8, "minimum real v1 needs a real DMA command queue", errors
    )
    require(MIN_REAL_V1.supports_int4, "minimum real v1 must model INT4 support", errors)
    min_precision = {entry["precision"]: entry["state"] for entry in MIN_REAL_V1.precision_matrix()}
    require(
        min_precision.get("INT8") == "modeled", "scale model must report INT8 as modeled", errors
    )
    require(
        min_precision.get("FP8") == "blocked",
        "scale model must keep FP8 blocked without hardware/compiler evidence",
        errors,
    )
    first_precision = {
        entry["precision"]: entry["state"] for entry in OPEN_2028_FIRST.precision_matrix()
    }
    for projected in ("FP16", "BF16"):
        require(
            first_precision.get(projected) == "projected",
            f"2028 target may only project {projected}, not claim measured support",
            errors,
        )
    require(
        first_precision.get("FP8") == "blocked",
        "2028 first open target must keep FP8 blocked until evidence exists",
        errors,
    )

    require(
        10.0 <= OPEN_2028_FIRST.dense_int8_peak_tops <= 50.0,
        f"2028 first open target must land in 10-50 TOPS, got {OPEN_2028_FIRST.dense_int8_peak_tops:.2f}",
        errors,
    )
    require(
        50.0 <= OPEN_2028_STRETCH.dense_int8_peak_tops <= 100.0,
        f"2028 stretch open target must land in 50-100 TOPS, got {OPEN_2028_STRETCH.dense_int8_peak_tops:.2f}",
        errors,
    )
    sota_precision = {
        entry["precision"]: entry["state"] for entry in OPEN_2028_SOTA.precision_matrix()
    }
    require(
        OPEN_2028_SOTA.dense_int8_peak_tops >= 160.0,
        f"2028 SOTA target must reach >=160 dense INT8 TOPS, got {OPEN_2028_SOTA.dense_int8_peak_tops:.2f}",
        errors,
    )
    require(
        OPEN_2028_SOTA.sparse_int4_peak_tops >= 512.0,
        f"2028 SOTA target must reach >=512 sparse INT4 TOPS, got {OPEN_2028_SOTA.sparse_int4_peak_tops:.2f}",
        errors,
    )
    require(
        OPEN_2028_SOTA.scratchpad_kib >= 64 * 1024,
        "2028 SOTA target must model >=64 MiB aggregate local SRAM",
        errors,
    )
    require(
        OPEN_2028_SOTA.dma_queue_depth >= 4096,
        "2028 SOTA target must model a >=4096-deep descriptor queue",
        errors,
    )
    require(
        sota_precision.get("FP8") == "projected",
        "2028 SOTA target must project FP8 support while remaining modeled-only",
        errors,
    )
    require(
        OPEN_2028_FIRST.dma_queue_depth >= 1024,
        "2028 first open target must model a 1024-deep descriptor queue",
        errors,
    )
    require(
        OPEN_2028_STRETCH.scratchpad_kib >= OPEN_2028_FIRST.scratchpad_kib,
        "stretch target must not reduce local scratchpad",
        errors,
    )

    kernels = [
        estimate_gemm_s8(OPEN_2028_FIRST, 4096, 4096, 4096),
        estimate_conv2d_s8(OPEN_2028_FIRST, 1, 56, 56, 256, 256, 3, 3),
        estimate_attention_qk_s8(OPEN_2028_FIRST, 1, 16, 2048, 2048, 128),
    ]
    for estimate in kernels:
        require(estimate.macs > 0, f"{estimate.kernel} must issue MACs", errors)
        require(estimate.bytes_read > 0, f"{estimate.kernel} must read tensor bytes", errors)
        require(estimate.bytes_written > 0, f"{estimate.kernel} must write tensor bytes", errors)
        require(
            estimate.local_sram_bytes > estimate.bytes_read + estimate.bytes_written,
            f"{estimate.kernel} must model local SRAM operand traffic",
            errors,
        )
        require(
            estimate.energy_nj(OPEN_2028_FIRST) > 0,
            f"{estimate.kernel} must report positive modeled energy",
            errors,
        )
        require(
            estimate.tops_per_watt(OPEN_2028_FIRST) > 0,
            f"{estimate.kernel} must report positive modeled TOPS/W",
            errors,
        )
        require(estimate.cycles > 0, f"{estimate.kernel} must consume cycles", errors)
        require(
            estimate.observed_tops(OPEN_2028_FIRST.clock_hz) > 0,
            f"{estimate.kernel} must report observed TOPS",
            errors,
        )

    sota_gemm = estimate_gemm_s8(OPEN_2028_SOTA, 4096, 4096, 4096)
    require(
        sota_gemm.tops_per_watt(OPEN_2028_SOTA) >= 18.0,
        f"2028 SOTA target must model >=18 TOPS/W on large GEMM, got {sota_gemm.tops_per_watt(OPEN_2028_SOTA):.2f}",
        errors,
    )

    if errors:
        print("NPU open scale model check failed:")
        for error in errors:
            print(f"  - {error}")
        return 1

    print(
        "NPU open scale model passed: "
        f"min_v1={MIN_REAL_V1.int8_macs_per_cycle} MAC/cycle, "
        f"first={OPEN_2028_FIRST.dense_int8_peak_tops:.2f} TOPS, "
        f"stretch={OPEN_2028_STRETCH.dense_int8_peak_tops:.2f} TOPS, "
        f"sota={OPEN_2028_SOTA.dense_int8_peak_tops:.2f} TOPS"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
