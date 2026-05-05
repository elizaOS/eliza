"""Local SFT training utilities (optimizers, validation harnesses).

Quantization lives next to this in `scripts/quantization/`; benchmarks live in
`scripts/benchmark/`. This package owns only the optimizer side of the
training pipeline (APOLLO, APOLLO-Mini, AdamW baseline).
"""

from .optimizer import (
    build_adamw_optimizer,
    build_apollo_mini_optimizer,
    build_apollo_optimizer,
    optimizer_state_bytes,
)

__all__ = [
    "build_adamw_optimizer",
    "build_apollo_mini_optimizer",
    "build_apollo_optimizer",
    "optimizer_state_bytes",
]
