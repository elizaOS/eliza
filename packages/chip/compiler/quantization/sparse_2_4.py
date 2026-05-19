"""2:4 structured sparse INT4 wiring.

The e1 RTL exposes `SDOT4_S4_2_4` — a packed INT4 dot product with a 4-bit
mask indicating which 2 of every 4 lanes carry non-zero values. Wiring this
into the elizanpu compiler requires:

1. Detect 2:4-friendly weight matrices during quantization.
2. Apply per-2:4-block magnitude pruning so each 4-lane group keeps the top 2
   weights by absolute value.
3. Emit the mask byte alongside the packed INT4 weight.

Manifest schema records the per-tensor 2:4 mask + per-group scale.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass


@dataclass(frozen=True)
class Sparse24Manifest:
    schema: str
    group_size: int
    masks: dict[str, list[int]]
    weight_scales: dict[str, list[float]]

    def to_json(self) -> str:
        return json.dumps(
            {
                "schema": self.schema,
                "group_size": self.group_size,
                "masks": self.masks,
                "weight_scales": self.weight_scales,
            },
            indent=2,
            sort_keys=True,
        )


def select_2_4_mask(group: Sequence[float]) -> int:
    """Return the 4-bit mask selecting the top-2 magnitudes from a 4-lane group.

    Mask bit i = 1 iff lane i is retained.
    """
    if len(group) != 4:
        raise ValueError("2:4 pruning operates on 4-lane groups")
    indexed = sorted(range(4), key=lambda i: abs(group[i]), reverse=True)
    keep = set(indexed[:2])
    return sum(1 << i for i in keep)


class Sparse24Calibrator:
    """Build a 2:4 structured-sparse INT4 calibration manifest."""

    SCHEMA = "eliza.sparse_2_4_int4_manifest.v1"

    def __init__(self, group_size: int = 4) -> None:
        if group_size != 4:
            raise ValueError("2:4 structured sparsity requires group_size=4")
        self.group_size = group_size
        self._masks: dict[str, list[int]] = {}
        self._weight_scales: dict[str, list[float]] = {}

    def record_weight_groups(
        self,
        name: str,
        groups: Sequence[Sequence[float]],
    ) -> None:
        if not groups:
            raise ValueError(f"sparse_2_4 {name}: empty group list")
        masks: list[int] = []
        scales: list[float] = []
        for group in groups:
            mask = select_2_4_mask(group)
            kept_abs = max((abs(v) for v in group), default=0.0)
            masks.append(mask)
            scales.append((kept_abs / 7.0) if kept_abs > 0 else 0.0)
        self._masks[name] = masks
        self._weight_scales[name] = scales

    def build_manifest(self) -> Sparse24Manifest:
        return Sparse24Manifest(
            schema=self.SCHEMA,
            group_size=self.group_size,
            masks=self._masks,
            weight_scales=self._weight_scales,
        )
