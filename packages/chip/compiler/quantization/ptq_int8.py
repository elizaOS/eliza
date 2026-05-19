"""PTQ INT8: per-channel weights + per-tensor activations.

Standard production INT8 quantization. The weight scale is per-output-channel
to preserve dynamic range across rows; the activation scale is per-tensor to
keep the `OP_A` / `OP_B` lane width at 8 bits. Asymmetric variants are NOT
emitted: the e1 RTL `DOT4_S8` / `GEMM_S8` opcodes are symmetric.

The calibrator consumes a small batch of representative tensors (typically a
few hundred examples through the model) and computes:

  weight_scale[c]   = max(|W[c, :]|) / 127
  activation_scale  = quantile_99(|A|) / 127

The output is a JSON manifest (schema `eliza.ptq_int8_manifest.v1`) consumed
by the elizanpu backend at `iree-compile --iree-input-quantization-manifest=...`.
"""

from __future__ import annotations

import json
import math
from collections.abc import Sequence
from dataclasses import dataclass


@dataclass(frozen=True)
class TensorStats:
    """Per-tensor summary collected during calibration."""

    name: str
    max_abs: float
    quantile_99: float
    count: int


@dataclass(frozen=True)
class PtqInt8Manifest:
    schema: str
    weights: dict[str, list[float]]
    activations: dict[str, float]

    def to_json(self) -> str:
        return json.dumps(
            {
                "schema": self.schema,
                "weights": self.weights,
                "activations": self.activations,
            },
            indent=2,
            sort_keys=True,
        )


class PtqInt8Calibrator:
    """Collect per-channel weight scales and per-tensor activation scales."""

    SCHEMA = "eliza.ptq_int8_manifest.v1"

    def __init__(self) -> None:
        self._weight_scales: dict[str, list[float]] = {}
        self._activation_max: dict[str, list[float]] = {}

    def record_weight(self, name: str, channel_max_abs: Sequence[float]) -> None:
        """Record the per-channel max-abs of a weight tensor."""
        if not channel_max_abs:
            raise ValueError(f"weight {name} has zero channels")
        self._weight_scales[name] = [
            (v / 127.0) if v > 0 else math.ldexp(1.0, -24) for v in channel_max_abs
        ]

    def record_activation(self, name: str, values_abs: Sequence[float]) -> None:
        """Record an activation batch's absolute values."""
        if not values_abs:
            return
        self._activation_max.setdefault(name, []).extend(values_abs)

    def _quantile_99(self, values: Sequence[float]) -> float:
        if not values:
            return 0.0
        sorted_values = sorted(values)
        index = max(0, min(len(sorted_values) - 1, int(0.99 * len(sorted_values))))
        return sorted_values[index]

    def build_manifest(self) -> PtqInt8Manifest:
        activations = {
            name: max(self._quantile_99(values) / 127.0, math.ldexp(1.0, -24))
            for name, values in self._activation_max.items()
        }
        return PtqInt8Manifest(
            schema=self.SCHEMA,
            weights=self._weight_scales,
            activations=activations,
        )
