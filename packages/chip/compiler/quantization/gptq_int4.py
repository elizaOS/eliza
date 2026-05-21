"""GPTQ INT4 weight-only quantization (legacy fallback).

GPTQ uses second-order information (the Hessian of the layer reconstruction
loss) to choose per-column quantization values. AWQ usually wins on
perplexity at 3-4 bits, but GPTQ remains useful for small-batch and
non-LLM workloads.

Reference: Frantar et al, "GPTQ: Accurate Post-Training Quantization for
Generative Pre-trained Transformers", https://arxiv.org/abs/2210.17323

The output manifest is structurally identical to the AWQ manifest with a
different schema identifier so the elizanpu IREE backend can dispatch
either calibrator.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from ._base import MIN_SCALE, QuantizationManifest


@dataclass(frozen=True)
class GptqInt4Manifest(QuantizationManifest):
    schema: str
    group_size: int
    weight_scales: dict[str, list[float]]
    weight_zero_points: dict[str, list[int]]


class GptqInt4Calibrator:
    """GPTQ INT4 weight-only calibrator (per-group asymmetric)."""

    SCHEMA = "eliza.gptq_int4_manifest.v1"
    DEFAULT_GROUP_SIZE = 128

    def __init__(self, group_size: int = DEFAULT_GROUP_SIZE) -> None:
        if group_size <= 0 or group_size % 8 != 0:
            raise ValueError("group_size must be a positive multiple of 8")
        self.group_size = group_size
        self._weight_scales: dict[str, list[float]] = {}
        self._weight_zero_points: dict[str, list[int]] = {}

    def record_weight_group_scale(
        self,
        name: str,
        group_max_abs: Sequence[float],
        group_zero_points: Sequence[int],
    ) -> None:
        if len(group_max_abs) != len(group_zero_points):
            raise ValueError(f"GPTQ {name}: scales/zero-points length mismatch")
        if any(z < -8 or z > 7 for z in group_zero_points):
            raise ValueError(f"GPTQ {name}: zero point outside signed 4-bit range")
        self._weight_scales[name] = [
            (v / 7.0) if v > 0 else MIN_SCALE for v in group_max_abs
        ]
        self._weight_zero_points[name] = list(group_zero_points)

    def build_manifest(self) -> GptqInt4Manifest:
        return GptqInt4Manifest(
            schema=self.SCHEMA,
            group_size=self.group_size,
            weight_scales=self._weight_scales,
            weight_zero_points=self._weight_zero_points,
        )
