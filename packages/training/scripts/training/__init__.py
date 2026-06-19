"""Local SFT training utilities (optimizers, validation harnesses).

Quantization lives next to this in `scripts/quantization/`; benchmarks live in
`scripts/benchmark/`. This package owns only the optimizer side of the
training pipeline (APOLLO and APOLLO-Mini).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .optimizer import (
        build_apollo_mini_optimizer,
        build_apollo_optimizer,
        optimizer_state_bytes,
    )

__all__ = [
    "build_apollo_mini_optimizer",
    "build_apollo_optimizer",
    "optimizer_state_bytes",
]


def __getattr__(name: str) -> Any:
    if name in __all__:
        from . import optimizer

        return getattr(optimizer, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
