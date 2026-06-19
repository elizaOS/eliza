"""STREAM-like trace generator for the DRAMSim3 trace-based CPU.

DRAMSim3's ``TraceBasedCPU`` consumes whitespace-separated records of
the form ``<hex_addr> <READ|WRITE> <cycle>``. This module emits four
canonical STREAM kernels (Copy, Scale, Add, Triad) plus a pointer-chase
microbenchmark and a sequential microbench used as the sanity workload.

Every transaction is emitted at ``injection_period`` cycle spacing so
DRAMSim3 sees back-to-back issue pressure across all four memory
channels. Address ranges are chosen to span the modeled DRAM aperture
so the controller exercises bank-group rotation and row-buffer turnover
rather than sitting in one open page.

Outputs are tagged ``simulator_only`` upstream by the runner; no number
produced from these traces can satisfy the phone-class bandwidth gate
in ``docs/evidence/memory/uma-dram-evidence-gate.yaml``.
"""

from __future__ import annotations

import random
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

# DRAMSim3 LPDDR4 burst length 16 * 16-bit lane = 32 B per access.
# We round to 64 B to match typical cache line granularity.
ACCESS_GRANULARITY_BYTES = 64

# Number of STREAM array elements per kernel iteration. Sized so the
# DRAMSim3 controller stays saturated across the default 500k-cycle
# replay window even when the trace replays through a serialized queue:
# at 1 cycle per transaction and ~3 transactions per element, 200k
# elements covers ~600k cycles of issue pressure and the simulator
# truncates at the cycle budget. Bandwidth is reported over the active
# replay window.
STREAM_ELEMENTS_PER_KERNEL = 200_000

# Tight injection period; DRAMSim3 will queue-up and serialize when the
# controller cannot keep up, which is the behaviour we want to measure.
DEFAULT_INJECTION_PERIOD_CYCLES = 1


@dataclass(frozen=True)
class TraceSpec:
    """Definition of a single DRAMSim3 trace workload."""

    name: str
    description: str
    aperture_bytes: int
    injection_period_cycles: int = DEFAULT_INJECTION_PERIOD_CYCLES


def _aligned(addr: int) -> int:
    """Snap an address to the access granularity."""
    return addr & ~(ACCESS_GRANULARITY_BYTES - 1)


def _emit_stream_kernel(
    spec: TraceSpec,
    base_a: int,
    base_b: int,
    base_c: int,
    kernel: str,
    start_cycle: int,
) -> Iterator[tuple[int, str, int]]:
    """Emit one pass of the named STREAM kernel.

    STREAM definitions follow McCalpin (1995):

    - Copy:  c = a
    - Scale: b = scalar * c
    - Add:   c = a + b
    - Triad: a = b + scalar * c

    For DRAMSim3 we model the memory transactions only; the scalar
    multiply / add happens in the CPU and does not touch DRAM.
    """

    cycle = start_cycle
    period = spec.injection_period_cycles
    n = STREAM_ELEMENTS_PER_KERNEL
    stride = ACCESS_GRANULARITY_BYTES

    for i in range(n):
        offset = i * stride
        a = _aligned(base_a + offset)
        b = _aligned(base_b + offset)
        c = _aligned(base_c + offset)
        if kernel == "copy":
            yield a, "READ", cycle
            cycle += period
            yield c, "WRITE", cycle
            cycle += period
        elif kernel == "scale":
            yield c, "READ", cycle
            cycle += period
            yield b, "WRITE", cycle
            cycle += period
        elif kernel == "add":
            yield a, "READ", cycle
            cycle += period
            yield b, "READ", cycle
            cycle += period
            yield c, "WRITE", cycle
            cycle += period
        elif kernel == "triad":
            yield b, "READ", cycle
            cycle += period
            yield c, "READ", cycle
            cycle += period
            yield a, "WRITE", cycle
            cycle += period
        else:
            raise ValueError(f"unknown STREAM kernel: {kernel!r}")


def _stream_arrays(spec: TraceSpec) -> tuple[int, int, int]:
    """Return the (a, b, c) base addresses for the three STREAM arrays.

    Arrays are spaced by ``aperture_bytes / 4`` so they land in
    different bank groups under DRAMSim3's row-buffer-friendly address
    mapping.
    """
    third = spec.aperture_bytes // 4
    return (third, 2 * third, 3 * third)


def emit_stream_copy(spec: TraceSpec) -> Iterator[tuple[int, str, int]]:
    a, b, c = _stream_arrays(spec)
    yield from _emit_stream_kernel(spec, a, b, c, "copy", start_cycle=0)


def emit_stream_scale(spec: TraceSpec) -> Iterator[tuple[int, str, int]]:
    a, b, c = _stream_arrays(spec)
    yield from _emit_stream_kernel(spec, a, b, c, "scale", start_cycle=0)


def emit_stream_add(spec: TraceSpec) -> Iterator[tuple[int, str, int]]:
    a, b, c = _stream_arrays(spec)
    yield from _emit_stream_kernel(spec, a, b, c, "add", start_cycle=0)


def emit_stream_triad(spec: TraceSpec) -> Iterator[tuple[int, str, int]]:
    a, b, c = _stream_arrays(spec)
    yield from _emit_stream_kernel(spec, a, b, c, "triad", start_cycle=0)


def emit_microbench(spec: TraceSpec) -> Iterator[tuple[int, str, int]]:
    """Sequential read sweep across the aperture; analogue of the
    ``microbench_test.trc`` smoke trace shipped historically with
    DRAMSim2. Used as the sanity workload."""
    cycle = 0
    period = spec.injection_period_cycles
    addr = 0
    while addr + ACCESS_GRANULARITY_BYTES <= spec.aperture_bytes:
        yield _aligned(addr), "READ", cycle
        addr += ACCESS_GRANULARITY_BYTES
        cycle += period
        if cycle > 200_000:
            break


def emit_pointer_chase(spec: TraceSpec) -> Iterator[tuple[int, str, int]]:
    """Pseudo-random pointer chase across the aperture. The chase walks
    a Linear-Congruential pseudo-random sequence with a fixed seed so
    runs are reproducible. Used to surface worst-case row-miss latency.
    """
    rng = random.Random(0xC0FFEE)
    cycle = 0
    period = max(spec.injection_period_cycles, 8)
    aperture = spec.aperture_bytes
    # 60k random reads at period 8 cover ~480k cycles -- enough to
    # exercise the full 500k-cycle default replay window without
    # truncation.
    for _ in range(60_000):
        addr = _aligned(rng.randrange(0, aperture))
        yield addr, "READ", cycle
        cycle += period


WORKLOADS = {
    "stream_copy": emit_stream_copy,
    "stream_scale": emit_stream_scale,
    "stream_add": emit_stream_add,
    "stream_triad": emit_stream_triad,
    "microbench": emit_microbench,
    "pointer_chase": emit_pointer_chase,
}


def write_trace(workload: str, aperture_bytes: int, out_path: Path) -> int:
    """Write a DRAMSim3 trace for ``workload`` to ``out_path``.

    Returns the number of transactions emitted.
    """
    if workload not in WORKLOADS:
        raise ValueError(f"unknown workload {workload!r}; supported: {sorted(WORKLOADS)}")
    spec = TraceSpec(
        name=workload,
        description=f"DRAMSim3 trace for {workload}",
        aperture_bytes=aperture_bytes,
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with out_path.open("w", encoding="ascii") as fh:
        for addr, op, cycle in WORKLOADS[workload](spec):
            fh.write(f"0x{addr:x} {op} {cycle}\n")
            count += 1
    return count


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workload", choices=sorted(WORKLOADS))
    parser.add_argument("output", type=Path)
    parser.add_argument(
        "--aperture-bytes",
        type=lambda x: int(x, 0),
        default=16 * 1024 * 1024 * 1024,
    )
    args = parser.parse_args()
    n = write_trace(args.workload, args.aperture_bytes, args.output)
    print(f"wrote {n} transactions to {args.output}")
