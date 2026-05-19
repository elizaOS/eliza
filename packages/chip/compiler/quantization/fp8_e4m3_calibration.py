"""FP8 E4M3 calibration.

E4M3 is the format used by Hopper/Blackwell, MI300, Snapdragon 8 Elite Gen 5
for weights + activations. The format outperforms E5M2 across most
configurations and covers ~92% of LLM workloads at minimal quality loss.

FP8 E4M3 max representable value: 448.0
FP8 E4M3 min positive subnormal:  2**-9 = 1/512
FP8 E4M3 has +/- inf and a single NaN; saturation is the only legal overflow.

Calibration collects per-tensor max-abs and computes a scale = max_abs / 448.
For LLM activations we use the 99.9th percentile to avoid outliers shifting
the scale and crushing the lower magnitudes.

Status: scalar opcode `DOT4_FP8_E4M3` exists in the RTL contract today;
tensor execution path is BLOCKED until full FP8 datapath lands. This module
emits the calibration manifest so we can stage the lowering work.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass

E4M3_MAX = 448.0
E4M3_MIN_POS_SUBNORMAL = 1.0 / 512.0


@dataclass(frozen=True)
class Fp8E4m3Manifest:
    schema: str
    weight_scales: dict[str, float]
    activation_scales: dict[str, float]
    saturation_max: float

    def to_json(self) -> str:
        return json.dumps(
            {
                "schema": self.schema,
                "weight_scales": self.weight_scales,
                "activation_scales": self.activation_scales,
                "saturation_max": self.saturation_max,
            },
            indent=2,
            sort_keys=True,
        )


class Fp8E4m3Calibrator:
    """Collect per-tensor FP8 E4M3 scales for weights and activations."""

    SCHEMA = "eliza.fp8_e4m3_manifest.v1"
    ACTIVATION_PERCENTILE = 0.999

    def __init__(self) -> None:
        self._weight_max: dict[str, float] = {}
        self._activation_values: dict[str, list[float]] = {}

    def record_weight(self, name: str, max_abs: float) -> None:
        if max_abs < 0:
            raise ValueError("weight max-abs must be non-negative")
        self._weight_max[name] = max_abs

    def record_activation(self, name: str, values_abs: Sequence[float]) -> None:
        if not values_abs:
            return
        self._activation_values.setdefault(name, []).extend(values_abs)

    def _percentile(self, values: Sequence[float], percentile: float) -> float:
        if not values:
            return 0.0
        sorted_values = sorted(values)
        idx = max(0, min(len(sorted_values) - 1, int(percentile * len(sorted_values))))
        return sorted_values[idx]

    def build_manifest(self) -> Fp8E4m3Manifest:
        weight_scales = {
            name: max(value / E4M3_MAX, E4M3_MIN_POS_SUBNORMAL)
            for name, value in self._weight_max.items()
        }
        activation_scales = {
            name: max(
                self._percentile(values, self.ACTIVATION_PERCENTILE) / E4M3_MAX,
                E4M3_MIN_POS_SUBNORMAL,
            )
            for name, values in self._activation_values.items()
        }
        return Fp8E4m3Manifest(
            schema=self.SCHEMA,
            weight_scales=weight_scales,
            activation_scales=activation_scales,
            saturation_max=E4M3_MAX,
        )
