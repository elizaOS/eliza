"""Unit tests for the quantization calibrators.

The calibrators are deterministic algebraic transforms over per-tensor
statistics. We exercise them with tiny reference inputs and assert each
manifest carries the expected schema string plus correct numeric values.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

THIS_DIR = Path(__file__).resolve().parent
PARENT = THIS_DIR.parents[1]
if str(PARENT.parent) not in sys.path:
    sys.path.insert(0, str(PARENT.parent))

from quantization.awq_int4 import AwqInt4Calibrator  # noqa: E402
from quantization.fp8_e4m3_calibration import (  # noqa: E402
    E4M3_MAX,
    Fp8E4m3Calibrator,
)
from quantization.gptq_int4 import GptqInt4Calibrator  # noqa: E402
from quantization.int2_bitnet import Int2BitnetCalibrator  # noqa: E402
from quantization.ptq_int8 import PtqInt8Calibrator  # noqa: E402
from quantization.sparse_2_4 import Sparse24Calibrator, select_2_4_mask  # noqa: E402


def test_ptq_int8_per_channel_weight_scale() -> None:
    c = PtqInt8Calibrator()
    c.record_weight("fc.weight", [12.7, 25.4, 127.0])
    c.record_activation("fc.input", [10.0] * 100 + [200.0])
    manifest = c.build_manifest()
    assert manifest.schema == "eliza.ptq_int8_manifest.v1"
    # weight scales: [12.7/127, 25.4/127, 127/127] = [0.1, 0.2, 1.0]
    assert manifest.weights["fc.weight"] == [12.7 / 127, 25.4 / 127, 1.0]
    # activation: quantile_99(sorted=[10..10, 200]) -> index 99 -> 10.0
    assert manifest.activations["fc.input"] == 10.0 / 127


def test_awq_int4_group_size_must_be_multiple_of_8() -> None:
    import pytest

    with pytest.raises(ValueError, match="group_size"):
        AwqInt4Calibrator(group_size=7)


def test_awq_int4_records_alpha_default() -> None:
    c = AwqInt4Calibrator()
    c.record_activation_scale(0.5)
    c.record_weight_group_scales("attn.qkv", [7.0, 14.0])
    manifest = c.build_manifest()
    assert manifest.schema == "eliza.awq_int4_manifest.v1"
    assert manifest.group_size == 128
    assert manifest.awq_alpha == 0.5
    assert manifest.weight_scales["attn.qkv"] == [1.0, 2.0]


def test_gptq_int4_rejects_out_of_range_zero_point() -> None:
    import pytest

    c = GptqInt4Calibrator()
    with pytest.raises(ValueError, match="signed 4-bit"):
        c.record_weight_group_scale("fc", [1.0], [8])


def test_fp8_e4m3_saturation_constant() -> None:
    c = Fp8E4m3Calibrator()
    c.record_weight("mlp.fc1.weight", 448.0)
    c.record_activation("mlp.fc1.input", [0.0] * 10)
    manifest = c.build_manifest()
    assert manifest.schema == "eliza.fp8_e4m3_manifest.v1"
    assert manifest.saturation_max == E4M3_MAX
    assert manifest.weight_scales["mlp.fc1.weight"] == 1.0


def test_sparse_2_4_selects_top_2_magnitudes() -> None:
    assert select_2_4_mask([0.1, 0.2, 0.3, 0.4]) == 0b1100
    assert select_2_4_mask([4.0, 0.1, 3.0, 0.2]) == 0b0101


def test_sparse_2_4_manifest_round_trip() -> None:
    c = Sparse24Calibrator()
    c.record_weight_groups(
        "attn.q",
        [
            [0.1, 0.2, 0.3, 0.4],
            [-1.0, 0.0, 0.5, -0.5],
        ],
    )
    manifest = c.build_manifest()
    assert manifest.schema == "eliza.sparse_2_4_int4_manifest.v1"
    assert manifest.group_size == 4
    # First group: keep lanes 2,3 -> mask 0b1100 = 12
    # Second group: keep lanes 0,2 -> mask 0b0101 = 5
    assert manifest.masks["attn.q"] == [0b1100, 0b0101]
    serialized = json.loads(manifest.to_json())
    assert serialized["masks"]["attn.q"] == [0b1100, 0b0101]


def test_int2_bitnet_threshold_is_half_mean_abs() -> None:
    c = Int2BitnetCalibrator()
    c.record_weight_mean_abs("fc.weight", 0.4)
    c.record_activation_scale(0.05)
    manifest = c.build_manifest()
    assert manifest.schema == "eliza.int2_bitnet_manifest.v1"
    assert manifest.weight_thresholds["fc.weight"] == 0.2
    assert manifest.activation_scale == 0.05
