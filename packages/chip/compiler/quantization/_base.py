"""Shared primitives for the e1 quantization calibrators.

Every calibrator emits a frozen-dataclass manifest serialized with the same
deterministic JSON shape, and the integer-precision calibrators clamp scales to
the same minimum positive value to avoid divide-by-zero during dequantization.
Those two facts are captured here so the per-format modules carry only the math
that is genuinely format-specific.
"""

from __future__ import annotations

import json
import math
from dataclasses import asdict

MIN_SCALE: float = math.ldexp(1.0, -24)
"""Smallest positive scale emitted by the integer calibrators.

A zero scale would make dequantization (`q * scale`) collapse a whole channel
to zero and divide-by-zero on the inverse path, so empty or all-zero channels
clamp to this floor. FP8 (which has a real subnormal floor) and 2:4 sparse
(where a pruned group legitimately has zero scale) use their own floors.
"""


class QuantizationManifest:
    """Mixin providing deterministic JSON serialization for manifest dataclasses.

    The concrete manifest must be a frozen dataclass. Serialization is stable
    across runs (`sort_keys=True`) and human-reviewable (`indent=2`) so manifests
    diff cleanly in the evidence tree.
    """

    def to_json(self) -> str:
        return json.dumps(asdict(self), indent=2, sort_keys=True)  # type: ignore[call-overload]
