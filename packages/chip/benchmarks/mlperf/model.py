"""Reference INT8 MLP workload for the E1 NPU MLPerf Inference harness.

Workload contract (documented as MODELED, not an MLPerf-class model)
--------------------------------------------------------------------
The MLPerf Inference Mobile suite specifies models such as MobileNetEdge
and MOSAIC. None of those reference checkpoints are vendored in this
tree, and the E1 NPU MMIO datapath caps a single GEMM tile at M,N <= 3,
K <= 7 (64-byte scratchpad, see ``E1NpuRuntime.gemm_s8``). We therefore
use the tiny two-layer INT8 MLP that the runtime/IREE e2e tests already
exercise (``test_e1_npu_tiny_mlp_e2e.py``) so the harness drives the
*real* NPU runtime/sim datapath end to end, byte-exact against the
GEMM_S8 golden oracle.

This is a representative small classifier used as a MODELED workload.
The harness explicitly does not claim MLPerf Mobile accuracy or latency
from a 2-layer MLP; the claim boundary is recorded in the report.

Topology
--------
- Input: 3 INT8 features.
- Layer 0: 3x3 INT8 GEMM (W0), bias add, INT8-saturating ReLU.
- Layer 1: 3x3 INT8 GEMM (W1).
- Output: argmax over 3 logits -> class label in {0, 1, 2}.

Both GEMMs run on the NPU (``E1NpuRuntime.gemm_s8``); the bias-add and
INT8 saturation/ReLU run host-side exactly as the partitioner accounts
for them (host_broadcasts_bias / host_saturates_int8), not as a CPU
fallback partition.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

RUNTIME_DIR = Path(__file__).resolve().parents[2] / "compiler" / "runtime"
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

# Fixed, deterministic INT8 weights. Single 3x3 tile per layer keeps the
# whole inference inside the 64-byte NPU scratchpad.
W0: tuple[tuple[int, ...], ...] = (
    (2, -3, 1),
    (1, 2, -1),
    (-2, 0, 3),
)
W1: tuple[tuple[int, ...], ...] = (
    (1, 0, -1),
    (-1, 1, 1),
    (2, -1, 0),
)
BIAS0: tuple[int, ...] = (1, -2, 3)

NUM_CLASSES = 3
NUM_FEATURES = 3


@dataclass(frozen=True)
class LabeledSample:
    features: tuple[int, ...]
    label: int


def saturate_s8(value: int) -> int:
    return max(-128, min(127, value))


def reference_predict(features: tuple[int, ...]) -> int:
    """Pure-Python reference forward pass (the accuracy ground truth).

    Mirrors the NPU datapath exactly: GEMM_S8 -> bias -> int8-saturated
    ReLU -> GEMM_S8 -> argmax. Used to label the dataset and to score
    the NPU path's accuracy.
    """
    z0 = [sum(features[k] * W0[k][j] for k in range(NUM_FEATURES)) for j in range(NUM_CLASSES)]
    biased = [saturate_s8(z0[j] + BIAS0[j]) for j in range(NUM_CLASSES)]
    activated = [max(0, value) for value in biased]
    z1 = [sum(activated[k] * W1[k][j] for k in range(NUM_CLASSES)) for j in range(NUM_CLASSES)]
    return _argmax(z1)


def _argmax(values: list[int]) -> int:
    best_index = 0
    best_value = values[0]
    for index in range(1, len(values)):
        if values[index] > best_value:
            best_value = values[index]
            best_index = index
    return best_index


def build_dataset(count: int) -> list[LabeledSample]:
    """Deterministic INT8 feature dataset with reference labels.

    Features span a small signed grid so the two output classes are both
    represented; labels come from the reference forward pass so accuracy
    is measured against the model's own ground truth (the standard
    MLPerf accuracy contract: SUT output vs reference output on the same
    inputs).
    """
    if count <= 0:
        raise ValueError("dataset count must be positive")
    samples: list[LabeledSample] = []
    for i in range(count):
        # Deterministic spread across the signed INT8 grid.
        a = ((i * 7) % 13) - 6
        b = ((i * 5) % 11) - 5
        c = ((i * 3) % 9) - 4
        features = (a, b, c)
        samples.append(LabeledSample(features=features, label=reference_predict(features)))
    return samples


def macs_per_inference() -> int:
    """Total INT8 MACs for one forward pass.

    Each layer is a 1xK by KxN GEMM (a single feature row): layer 0 is
    1 x NUM_FEATURES by NUM_FEATURES x NUM_CLASSES, layer 1 is
    1 x NUM_CLASSES by NUM_CLASSES x NUM_CLASSES. This matches the NPU
    hardware MAC counter (one row M=1 per inference), not a batched
    M=NUM_FEATURES tile.
    """
    layer0 = NUM_FEATURES * NUM_CLASSES
    layer1 = NUM_CLASSES * NUM_CLASSES
    return layer0 + layer1
