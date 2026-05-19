from __future__ import annotations

from dataclasses import dataclass
from math import ceil

INT8_BYTES = 1
INT4_VALUES_PER_BYTE = 2
ACCUM_BYTES = 4


@dataclass(frozen=True)
class NpuScaleConfig:
    name: str
    tiles: int
    int8_macs_per_tile_per_cycle: int
    clock_hz: int
    scratchpad_kib: int
    dma_queue_depth: int
    dma_bytes_per_cycle: int
    supports_int4: bool = True
    supports_bf16: bool = False
    supports_fp16: bool = False
    supports_fp8: bool = False
    structured_sparsity_factor: int = 1

    @property
    def int8_macs_per_cycle(self) -> int:
        return self.tiles * self.int8_macs_per_tile_per_cycle

    @property
    def dense_int8_peak_tops(self) -> float:
        return self.int8_macs_per_cycle * 2 * self.clock_hz / 1e12

    @property
    def sparse_int4_peak_tops(self) -> float:
        if not self.supports_int4:
            return 0.0
        packed_factor = INT4_VALUES_PER_BYTE
        return self.dense_int8_peak_tops * packed_factor * self.structured_sparsity_factor

    def precision_matrix(self) -> list[dict[str, str]]:
        return [
            {
                "precision": "INT8",
                "state": "modeled",
                "claim": "dense throughput model only",
            },
            {
                "precision": "INT4",
                "state": "projected" if self.supports_int4 else "blocked",
                "claim": "sparse/packed projection only; requires measured RTL/compiler evidence",
            },
            {
                "precision": "FP16",
                "state": "projected" if self.supports_fp16 else "blocked",
                "claim": "support flag only; no measured runtime path in this repository",
            },
            {
                "precision": "BF16",
                "state": "projected" if self.supports_bf16 else "blocked",
                "claim": "support flag only; no measured runtime path in this repository",
            },
            {
                "precision": "FP8",
                "state": "projected" if self.supports_fp8 else "blocked",
                "claim": "blocked until opcode/datapath/compiler and benchmark evidence exist",
            },
        ]


@dataclass(frozen=True)
class KernelEstimate:
    kernel: str
    macs: int
    bytes_read: int
    bytes_written: int
    compute_cycles: int
    memory_cycles: int

    @property
    def cycles(self) -> int:
        return max(self.compute_cycles, self.memory_cycles)

    def observed_tops(self, clock_hz: int) -> float:
        return self.macs * 2 / (self.cycles / clock_hz) / 1e12


MIN_REAL_V1 = NpuScaleConfig(
    name="min_real_v1_16mac_128kib",
    tiles=1,
    int8_macs_per_tile_per_cycle=16,
    clock_hz=500_000_000,
    scratchpad_kib=128,
    dma_queue_depth=8,
    dma_bytes_per_cycle=16,
)

OPEN_2028_FIRST = NpuScaleConfig(
    name="open_2028_first_50tops",
    tiles=16,
    int8_macs_per_tile_per_cycle=1024,
    clock_hz=1_500_000_000,
    scratchpad_kib=256 * 16,
    dma_queue_depth=1024,
    dma_bytes_per_cycle=512,
    supports_bf16=True,
    supports_fp16=True,
)

OPEN_2028_STRETCH = NpuScaleConfig(
    name="open_2028_stretch_100tops",
    tiles=16,
    int8_macs_per_tile_per_cycle=2048,
    clock_hz=1_500_000_000,
    scratchpad_kib=512 * 16,
    dma_queue_depth=2048,
    dma_bytes_per_cycle=1024,
    supports_bf16=True,
    supports_fp16=True,
    structured_sparsity_factor=2,
)


def _require_positive(**values: int) -> None:
    for name, value in values.items():
        if value <= 0:
            raise ValueError(f"{name} must be positive")


def _memory_cycles(total_bytes: int, bytes_per_cycle: int) -> int:
    return ceil(total_bytes / bytes_per_cycle)


def estimate_gemm_s8(config: NpuScaleConfig, m: int, n: int, k: int) -> KernelEstimate:
    _require_positive(m=m, n=n, k=k)
    macs = m * n * k
    bytes_read = (m * k + k * n) * INT8_BYTES
    bytes_written = m * n * ACCUM_BYTES
    return KernelEstimate(
        kernel="gemm_s8",
        macs=macs,
        bytes_read=bytes_read,
        bytes_written=bytes_written,
        compute_cycles=ceil(macs / config.int8_macs_per_cycle),
        memory_cycles=_memory_cycles(bytes_read + bytes_written, config.dma_bytes_per_cycle),
    )


def estimate_conv2d_s8(
    config: NpuScaleConfig,
    batch: int,
    out_h: int,
    out_w: int,
    out_channels: int,
    in_channels: int,
    kernel_h: int,
    kernel_w: int,
) -> KernelEstimate:
    _require_positive(
        batch=batch,
        out_h=out_h,
        out_w=out_w,
        out_channels=out_channels,
        in_channels=in_channels,
        kernel_h=kernel_h,
        kernel_w=kernel_w,
    )
    positions = batch * out_h * out_w
    reduction = in_channels * kernel_h * kernel_w
    macs = positions * out_channels * reduction
    input_bytes = positions * reduction * INT8_BYTES
    weight_bytes = out_channels * reduction * INT8_BYTES
    output_bytes = positions * out_channels * ACCUM_BYTES
    return KernelEstimate(
        kernel="conv2d_s8",
        macs=macs,
        bytes_read=input_bytes + weight_bytes,
        bytes_written=output_bytes,
        compute_cycles=ceil(macs / config.int8_macs_per_cycle),
        memory_cycles=_memory_cycles(
            input_bytes + weight_bytes + output_bytes, config.dma_bytes_per_cycle
        ),
    )


def estimate_attention_qk_s8(
    config: NpuScaleConfig,
    batch: int,
    heads: int,
    query_tokens: int,
    key_tokens: int,
    head_dim: int,
) -> KernelEstimate:
    _require_positive(
        batch=batch,
        heads=heads,
        query_tokens=query_tokens,
        key_tokens=key_tokens,
        head_dim=head_dim,
    )
    macs = batch * heads * query_tokens * key_tokens * head_dim
    q_bytes = batch * heads * query_tokens * head_dim * INT8_BYTES
    k_bytes = batch * heads * key_tokens * head_dim * INT8_BYTES
    score_bytes = batch * heads * query_tokens * key_tokens * ACCUM_BYTES
    return KernelEstimate(
        kernel="attention_qk_s8",
        macs=macs,
        bytes_read=q_bytes + k_bytes,
        bytes_written=score_bytes,
        compute_cycles=ceil(macs / config.int8_macs_per_cycle),
        memory_cycles=_memory_cycles(q_bytes + k_bytes + score_bytes, config.dma_bytes_per_cycle),
    )
