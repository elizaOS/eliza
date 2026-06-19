"""
Benchmark runner for fused-turboquant.

Compares:
1. Rotation methods: RHT (batched PyTorch) vs RHT (fused Triton) vs Dense QR
2. Full pipeline: encode/decode quality and throughput at different bit-widths
3. Memory: compressed vs uncompressed KV cache sizes
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

import torch

from quantization.fused_turboquant_vendored.core.hadamard import (
    DenseQRRotation,
    RHTRotation,
)
from quantization.fused_turboquant_vendored.core.quantizer import TurboQuantMSE
from quantization.fused_turboquant_vendored.kernels.triton_rht import is_triton_available

if is_triton_available():
    from quantization.fused_turboquant_vendored.kernels.triton_rht import triton_rht


@dataclass
class RotationBenchResult:
    method: str
    dim: int
    batch_size: int
    time_ms: float
    throughput_gops: float  # giga-operations per second
    memory_bytes: int


@dataclass
class QualityResult:
    bits: int
    dim: int
    num_vectors: int
    mse: float
    cosine_similarity: float
    inner_product_correlation: float
    compression_ratio: float


@dataclass
class BenchmarkSuite:
    rotation_results: list[RotationBenchResult] = field(default_factory=list)
    quality_results: list[QualityResult] = field(default_factory=list)


def _time_fn(fn, warmup: int = 5, repeats: int = 20) -> float:
    """Time a function with warmup, return median time in ms."""
    for _ in range(warmup):
        fn()
    torch.cuda.synchronize()

    times = []
    for _ in range(repeats):
        torch.cuda.synchronize()
        start = time.perf_counter()
        fn()
        torch.cuda.synchronize()
        elapsed = (time.perf_counter() - start) * 1000
        times.append(elapsed)

    times.sort()
    return times[len(times) // 2]


def benchmark_rotation(
    dim: int = 256,
    batch_size: int = 1024,
    device: str = "cuda",
) -> list[RotationBenchResult]:
    """Compare rotation methods: RHT (PyTorch), RHT (Triton), Dense QR."""
    results = []
    x = torch.randn(batch_size, dim, device=device, dtype=torch.float32)

    rht = RHTRotation(dim, device=device)
    dense = DenseQRRotation(dim, device=device)

    t_rht = _time_fn(lambda: rht(x))
    results.append(RotationBenchResult(
        method="RHT (PyTorch batched)",
        dim=dim, batch_size=batch_size,
        time_ms=t_rht,
        throughput_gops=batch_size * dim * (1 + dim.bit_length()) / t_rht / 1e6,
        memory_bytes=dim * 4,
    ))

    t_dense = _time_fn(lambda: dense(x))
    results.append(RotationBenchResult(
        method="Dense QR (matmul)",
        dim=dim, batch_size=batch_size,
        time_ms=t_dense,
        throughput_gops=batch_size * dim * dim / t_dense / 1e6,
        memory_bytes=dim * dim * 4,
    ))

    if is_triton_available():
        signs = rht.signs
        t_triton = _time_fn(lambda: triton_rht(x, signs))
        results.append(RotationBenchResult(
            method="RHT (Triton fused)",
            dim=dim, batch_size=batch_size,
            time_ms=t_triton,
            throughput_gops=batch_size * dim * (1 + dim.bit_length()) / t_triton / 1e6,
            memory_bytes=dim * 4,
        ))

    return results


def benchmark_quality(
    dim: int = 256,
    num_vectors: int = 1024,
    bits_list: list[int] | None = None,
    device: str = "cuda",
) -> list[QualityResult]:
    """Measure quantization quality at different bit-widths."""
    if bits_list is None:
        bits_list = [2, 3, 4]

    results = []
    x = torch.randn(num_vectors, dim, device=device, dtype=torch.float32)

    for bits in bits_list:
        tq = TurboQuantMSE(dim, bits=bits, device=device)
        compressed = tq.encode(x)
        x_hat = tq.decode(compressed)

        mse = torch.mean((x - x_hat) ** 2).item()

        x_norm = x / (torch.norm(x, dim=-1, keepdim=True) + 1e-8)
        xhat_norm = x_hat / (torch.norm(x_hat, dim=-1, keepdim=True) + 1e-8)
        cosine_sim = torch.mean(torch.sum(x_norm * xhat_norm, dim=-1)).item()

        ip_original = torch.sum(x[:num_vectors // 2] * x[num_vectors // 2:], dim=-1)
        ip_quantized = torch.sum(x_hat[:num_vectors // 2] * x_hat[num_vectors // 2:], dim=-1)
        ip_corr = torch.corrcoef(torch.stack([ip_original, ip_quantized]))[0, 1].item()

        results.append(QualityResult(
            bits=bits, dim=dim, num_vectors=num_vectors,
            mse=mse, cosine_similarity=cosine_sim,
            inner_product_correlation=ip_corr,
            compression_ratio=compressed.compression_ratio,
        ))

    return results


def run_full_benchmark(
    dim: int = 256,
    device: str = "cuda",
) -> BenchmarkSuite:
    """Run complete benchmark suite."""
    suite = BenchmarkSuite()

    for batch in [256, 1024, 4096, 16384]:
        suite.rotation_results.extend(
            benchmark_rotation(dim=dim, batch_size=batch, device=device)
        )

    suite.quality_results.extend(
        benchmark_quality(dim=dim, num_vectors=2048, device=device)
    )

    return suite


def print_results(suite: BenchmarkSuite) -> None:
    """Pretty-print benchmark results."""
    print("\n" + "=" * 80)
    print("ROTATION BENCHMARK")
    print("=" * 80)
    print(f"{'Method':<30} {'Batch':>8} {'Time (ms)':>12} {'Memory':>12}")
    print("-" * 80)
    for r in suite.rotation_results:
        mem = f"{r.memory_bytes:,} B" if r.memory_bytes < 1024 else f"{r.memory_bytes // 1024} KB"
        print(f"{r.method:<30} {r.batch_size:>8} {r.time_ms:>12.3f} {mem:>12}")

    print("\n" + "=" * 80)
    print("QUANTIZATION QUALITY")
    print("=" * 80)
    print(f"{'Bits':>5} {'MSE':>12} {'Cosine Sim':>12} {'IP Corr':>12} {'Compress':>10}")
    print("-" * 80)
    for r in suite.quality_results:
        print(
            f"{r.bits:>5} {r.mse:>12.6f} {r.cosine_similarity:>12.6f} "
            f"{r.inner_product_correlation:>12.6f} {r.compression_ratio:>9.1f}x"
        )
