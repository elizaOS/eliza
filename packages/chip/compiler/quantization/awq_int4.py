"""AWQ INT4 weight-only quantization.

AWQ (Activation-aware Weight Quantization) scales each weight column by the
inverse of the per-channel activation magnitude, then quantizes to INT4
weight-only. The compute path uses `elizanpu.dot8_s4` (and 2:4 sparse for
the 50% sparse path) with the activation kept at int8 / fp8.

Reference: Lin et al, "AWQ: Activation-aware Weight Quantization for
On-Device LLMs", https://arxiv.org/abs/2306.00978

The output manifest contains the per-group scale factor and the per-tensor
activation scale used to reconstruct the dequantized output.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from ._base import MIN_SCALE, QuantizationManifest


@dataclass(frozen=True)
class AwqInt4Manifest(QuantizationManifest):
    schema: str
    group_size: int
    activation_scale: float
    weight_scales: dict[str, list[float]]
    awq_alpha: float


class AwqInt4Calibrator:
    """Activation-aware INT4 weight-only calibrator.

    For each weight matrix `W` and the per-channel activation magnitude
    `s_act`, compute the AWQ scaling factor `s = s_act^alpha`, then quantize
    `W * diag(s)^-1` to INT4 in groups of `group_size`. The dequantized
    output is `(s * W_quant_int4) * (s_act / 127)`.
    """

    SCHEMA = "eliza.awq_int4_manifest.v1"
    DEFAULT_GROUP_SIZE = 128
    DEFAULT_ALPHA = 0.5

    def __init__(
        self, group_size: int = DEFAULT_GROUP_SIZE, awq_alpha: float = DEFAULT_ALPHA
    ) -> None:
        if group_size <= 0 or group_size % 8 != 0:
            raise ValueError("group_size must be a positive multiple of 8")
        self.group_size = group_size
        self.awq_alpha = awq_alpha
        self._weight_scales: dict[str, list[float]] = {}
        self._activation_scale: float = MIN_SCALE

    def record_activation_scale(self, scale: float) -> None:
        self._activation_scale = max(scale, MIN_SCALE)

    def record_weight_group_scales(self, name: str, group_scales: Sequence[float]) -> None:
        if not group_scales:
            raise ValueError(f"weight {name} has zero groups")
        self._weight_scales[name] = [
            (v / 7.0) if v > 0 else MIN_SCALE for v in group_scales
        ]

    def build_manifest(self) -> AwqInt4Manifest:
        return AwqInt4Manifest(
            schema=self.SCHEMA,
            group_size=self.group_size,
            activation_scale=self._activation_scale,
            weight_scales=self._weight_scales,
            awq_alpha=self.awq_alpha,
        )
