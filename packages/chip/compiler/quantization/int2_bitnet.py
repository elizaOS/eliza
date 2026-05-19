"""INT2 BitNet calibration.

BitNet-class INT2 quantization is the experimental ultra-low-precision path.
The e1 RTL has scalar `DOT16_S2`; tensor execution is BLOCKED until the
RTL adds a sixteen-lane INT2 datapath. This module supports the
calibration pipeline so the compiler can land the lowering as soon as the
RTL path exists.

INT2 levels are {-1, 0, +1} (ternary) plus a +/- saturation marker for a
full signed 2-bit codeword. We follow the BitNet b1.58 convention: weights
trinarize, activations stay int8 with a per-tensor scale.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass


@dataclass(frozen=True)
class Int2BitnetManifest:
    schema: str
    weight_thresholds: dict[str, float]
    activation_scale: float

    def to_json(self) -> str:
        return json.dumps(
            {
                "schema": self.schema,
                "weight_thresholds": self.weight_thresholds,
                "activation_scale": self.activation_scale,
            },
            indent=2,
            sort_keys=True,
        )


class Int2BitnetCalibrator:
    """Compute per-tensor trinarization thresholds for BitNet-class INT2."""

    SCHEMA = "eliza.int2_bitnet_manifest.v1"

    def __init__(self) -> None:
        self._weight_thresholds: dict[str, float] = {}
        self._activation_scale: float = math.ldexp(1.0, -24)

    def record_weight_mean_abs(self, name: str, mean_abs: float) -> None:
        # BitNet b1.58 uses mean-abs / 2 as the trinarization threshold;
        # values within +/- threshold trinarize to 0, beyond to +/- 1.
        if mean_abs < 0:
            raise ValueError("weight mean-abs must be non-negative")
        self._weight_thresholds[name] = mean_abs / 2.0

    def record_activation_scale(self, scale: float) -> None:
        self._activation_scale = max(scale, math.ldexp(1.0, -24))

    def build_manifest(self) -> Int2BitnetManifest:
        return Int2BitnetManifest(
            schema=self.SCHEMA,
            weight_thresholds=self._weight_thresholds,
            activation_scale=self._activation_scale,
        )
