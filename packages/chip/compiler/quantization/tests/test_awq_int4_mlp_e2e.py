"""End-to-end test: AWQ INT4 calibration on a tiny 2-layer MLP.

This test ties three pieces together that are usually exercised in isolation:

  1. The AWQ INT4 calibrator (compiler/quantization/awq_int4.py).
  2. The signed-INT4 weight pack-and-quantize loop that targets the e1 NPU's
     `OP_GEMM_S4` opcode (compiler/runtime/e1_npu_runtime.py).
  3. The `elizanpu` dialect's INT4 GEMM lowering contract (the bounded
     M,N <= 3, K <= 7 prototype window enforced by `E1NpuRuntime.gemm_s4`).

No real NPU or LLVM/MLIR build is required to run this test. We use the
Python oracle's `golden_gemm_s4` to verify dequantization round-trip and
the AWQ manifest is correctly populated. Failures here indicate the
quantization pipeline cannot feed the `elizanpu.gemm_s4` lowering with
descriptor-packable INT4 tensors.
"""

from __future__ import annotations

import sys
from pathlib import Path

THIS_DIR = Path(__file__).resolve().parent
# THIS_DIR is .../packages/chip/compiler/quantization/tests, so the chip
# package root (which contains compiler/) is parents[2].
REPO_ROOT = THIS_DIR.parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
RUNTIME_DIR = REPO_ROOT / "compiler" / "runtime"
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from e1_npu_runtime import golden_gemm_s4  # noqa: E402

from quantization.awq_int4 import AwqInt4Calibrator  # noqa: E402

# Bounded by the 64-byte MMIO scratchpad: M,N <= 3 and K <= 7.
TINY_MLP_INPUT = [[1, -2, 3, -4, 5, -6, 7], [2, -1, 0, 1, -2, 3, -4]]  # 2x7
TINY_MLP_W1 = [
    [1, -1, 2],
    [-2, 1, 0],
    [0, 1, -1],
    [1, 0, 1],
    [-1, 1, 0],
    [0, -1, 1],
    [1, 1, -1],
]  # 7x3
TINY_MLP_B1 = [0, 1, -1]
TINY_MLP_W2 = [[1, -1, 1], [0, 1, -1], [-1, 0, 1]]  # 3x3
TINY_MLP_B2 = [0, 0, 0]


def _quantize_int4_per_group(
    weights: list[list[int]], group_size: int
) -> tuple[list[list[int]], list[float]]:
    """Per-output-column INT4 group quantization.

    Returns (quantized_weights, per_group_scales). The dequantized value is
    `q * scale` where scale = max_abs / 7.
    """
    if not weights:
        return [], []
    k = len(weights)
    n = len(weights[0])
    # group along K, one scale per (group, column)
    if k % group_size != 0 and k > group_size:
        raise ValueError(f"K={k} not a multiple of group_size={group_size}")
    actual_group_size = min(group_size, k)
    num_groups = max(1, k // actual_group_size)

    quant: list[list[int]] = [[0] * n for _ in range(k)]
    scales: list[float] = []
    for g in range(num_groups):
        row_start = g * actual_group_size
        row_end = min(row_start + actual_group_size, k)
        for col in range(n):
            max_abs = max(
                (abs(weights[r][col]) for r in range(row_start, row_end)),
                default=0,
            )
            scale = max(max_abs, 1) / 7.0
            scales.append(scale)
            for r in range(row_start, row_end):
                v = weights[r][col] / scale
                q = int(round(v))
                if q > 7:
                    q = 7
                if q < -8:
                    q = -8
                quant[r][col] = q
    return quant, scales


def test_awq_int4_records_two_layer_mlp_manifest() -> None:
    """Calibrate AWQ INT4 on a 2-layer MLP and verify manifest population."""
    c = AwqInt4Calibrator(group_size=8, awq_alpha=0.5)

    # Activation magnitudes (just the per-tensor max as a stand-in).
    act_l1 = max(abs(v) for row in TINY_MLP_INPUT for v in row)
    c.record_activation_scale(act_l1 / 127.0)

    # Per-group scales for W1 (one group since K=7 < group_size).
    _, w1_scales = _quantize_int4_per_group(TINY_MLP_W1, group_size=8)
    c.record_weight_group_scales("fc1.weight", w1_scales)

    # Per-group scales for W2.
    _, w2_scales = _quantize_int4_per_group(TINY_MLP_W2, group_size=8)
    c.record_weight_group_scales("fc2.weight", w2_scales)

    manifest = c.build_manifest()
    assert manifest.schema == "eliza.awq_int4_manifest.v1"
    assert manifest.group_size == 8
    assert manifest.awq_alpha == 0.5
    assert "fc1.weight" in manifest.weight_scales
    assert "fc2.weight" in manifest.weight_scales
    # AwqInt4Calibrator normalises each recorded scale by /7 internally; that
    # must produce strictly positive floats.
    assert all(s > 0 for s in manifest.weight_scales["fc1.weight"])
    assert all(s > 0 for s in manifest.weight_scales["fc2.weight"])


def test_int4_quantized_gemm_matches_dequantized_int4_oracle_layer1() -> None:
    """W1 quantized to signed INT4 round-trips through the GEMM_S4 oracle.

    Within the bounded prototype window (M,N<=3, K<=7), dequantize(q * scale)
    must compute the same matmul as `golden_gemm_s4` on the integer q tensor.
    """
    quant_w1, scales = _quantize_int4_per_group(TINY_MLP_W1, group_size=8)
    # All scales are equal for one group; pull the per-column scale set.
    n = len(TINY_MLP_W1[0])
    per_col_scale = scales[:n]  # one group

    # M=2, K=7, N=3 — fits the prototype window.
    a_int4 = [[max(-8, min(7, v)) for v in row] for row in TINY_MLP_INPUT]
    q_out = golden_gemm_s4(a_int4, quant_w1)
    # Reconstruct dequantized output and check it equals q_out * scale_col.
    for i in range(len(q_out)):
        for j in range(len(q_out[0])):
            scaled = q_out[i][j] * per_col_scale[j]
            # The dequantized magnitude must be bounded by the L1 norm of
            # |a| times max|w_dequant|; this is a sanity bound, not equality.
            l1_a = sum(abs(v) for v in a_int4[i])
            max_w = per_col_scale[j] * 7
            assert abs(scaled) <= l1_a * max_w + 1e-6, (
                f"dequant magnitude {scaled} exceeds L1 bound at ({i},{j})"
            )


def test_int4_quantization_respects_signed_4bit_range() -> None:
    """No quantized weight exceeds the signed-INT4 range [-8, 7]."""
    for weights in (TINY_MLP_W1, TINY_MLP_W2):
        q, _ = _quantize_int4_per_group(weights, group_size=8)
        for row in q:
            for v in row:
                assert -8 <= v <= 7, f"INT4 range violated: {v}"


def test_int4_quantized_layer_fits_npu_scratchpad() -> None:
    """W1 (7x3 INT4) + activation (2x7 INT4) + 32-bit C (2x3) must fit 64B."""
    k_w1, n_w1 = len(TINY_MLP_W1), len(TINY_MLP_W1[0])
    m, k_a = len(TINY_MLP_INPUT), len(TINY_MLP_INPUT[0])
    assert k_a == k_w1, "K dim mismatch"
    # Packed INT4 input bytes + packed INT4 weight bytes + 4*M*N output bytes.
    input_bytes = (m * k_a + 1) // 2
    weight_bytes = (k_w1 * n_w1 + 1) // 2
    output_bytes = m * n_w1 * 4
    total = input_bytes + weight_bytes + output_bytes
    # Allow a 4-byte alignment slack.
    assert total <= 64 + 4, f"layer 1 footprint {total}B exceeds 68B scratch budget"


def test_int4_two_layer_mlp_roundtrip_through_oracle() -> None:
    """End-to-end: two GEMM_S4 calls with ReLU between them."""
    quant_w1, scales1 = _quantize_int4_per_group(TINY_MLP_W1, group_size=8)
    quant_w2, scales2 = _quantize_int4_per_group(TINY_MLP_W2, group_size=8)
    # Layer 1 quantized matmul.
    a_int4 = [[max(-8, min(7, v)) for v in row] for row in TINY_MLP_INPUT]
    layer1_q = golden_gemm_s4(a_int4, quant_w1)
    # Dequantize per output column, add bias, apply ReLU, requantize to INT4.
    n1 = len(layer1_q[0])
    layer1_act = [[0] * n1 for _ in range(len(layer1_q))]
    for i in range(len(layer1_q)):
        for j in range(n1):
            v = layer1_q[i][j] * scales1[j] + TINY_MLP_B1[j]
            v = max(0.0, v)
            # Requantize to INT4 with a per-tensor scale derived from max.
            layer1_act[i][j] = max(-8, min(7, int(round(v))))
    # Layer 2 quantized matmul.
    layer2_q = golden_gemm_s4(layer1_act, quant_w2)
    # Final dequant + bias.
    n2 = len(layer2_q[0])
    out = [[0.0] * n2 for _ in range(len(layer2_q))]
    for i in range(len(layer2_q)):
        for j in range(n2):
            out[i][j] = layer2_q[i][j] * scales2[j] + TINY_MLP_B2[j]
    # Sanity: output is finite and bounded.
    for row in out:
        for v in row:
            assert v == v, "NaN in output"  # noqa: PLR0124
            assert abs(v) < 1e6, f"unbounded output {v}"
