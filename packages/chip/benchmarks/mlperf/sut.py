"""E1 NPU system-under-test (SUT) for the MLPerf Inference harness.

Runs the tiny INT8 MLP (``benchmarks/mlperf/model.py``) through the real
E1 NPU behavioral simulator (``E1NpuMmioSim`` / ``E1NpuRuntime``). Each
inference issues two GEMM_S8 NPU commands over the MMIO datapath plus a
host-side bias-add + INT8-saturating ReLU between layers, exactly as the
ExecuTorch partitioner accounts for that activation composite.

The SUT also accumulates NPU performance counters (cycles, MACs) read
back from the simulator so the harness can derive a modeled
energy-per-inference from the architecture scale model.
"""

from __future__ import annotations

import sys
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path

RUNTIME_DIR = Path(__file__).resolve().parents[2] / "compiler" / "runtime"
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from test_e1_npu_runtime_sim import E1NpuMmioSim  # noqa: E402

from benchmarks.mlperf.loadgen import QueryResponse, QuerySample  # noqa: E402
from benchmarks.mlperf.model import (  # noqa: E402
    BIAS0,
    NUM_CLASSES,
    W0,
    W1,
    LabeledSample,
    saturate_s8,
)


@dataclass
class SutCounters:
    inferences: int = 0
    npu_commands: int = 0
    npu_cycles: int = 0
    npu_macs: int = 0


@dataclass
class E1NpuSut:
    """SUT backed by the E1 NPU behavioral simulator.

    A fresh ``E1NpuMmioSim`` is created per GEMM command because the
    64-byte scratchpad holds a single tile; this matches the descriptor
    stream the lowering emits (one descriptor per GEMM tile).
    """

    dataset: list[LabeledSample]
    counters: SutCounters = field(default_factory=SutCounters)

    def name(self) -> str:
        return "e1_npu_mmio_sim"

    def _gemm(self, a: list[list[int]], b: tuple[tuple[int, ...], ...]) -> list[list[int]]:
        sim = E1NpuMmioSim()
        result = sim.runtime.gemm_s8(a, [list(row) for row in b])
        perf = sim.runtime.perf()
        self.counters.npu_commands += 1
        self.counters.npu_cycles += perf["cycles"]
        self.counters.npu_macs += perf["macs"]
        return result

    def _infer(self, sample: LabeledSample) -> int:
        features = [list(sample.features)]
        z0 = self._gemm(features, W0)[0]
        biased = [saturate_s8(z0[j] + BIAS0[j]) for j in range(NUM_CLASSES)]
        activated = [max(0, value) for value in biased]
        z1 = self._gemm([activated], W1)[0]
        self.counters.inferences += 1
        return _argmax(z1)

    def issue_query(self, samples: Sequence[QuerySample]) -> list[QueryResponse]:
        responses: list[QueryResponse] = []
        for sample in samples:
            labeled = self.dataset[sample.index]
            prediction = self._infer(labeled)
            responses.append(QueryResponse(index=sample.index, prediction=prediction))
        return responses


def _argmax(values: list[int]) -> int:
    best_index = 0
    best_value = values[0]
    for index in range(1, len(values)):
        if values[index] > best_value:
            best_value = values[index]
            best_index = index
    return best_index
