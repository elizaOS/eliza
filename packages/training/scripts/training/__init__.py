"""Training model metadata and lazily loaded optimizer factories."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .model_registry import REGISTRY, ModelEntry, Tier, get
    from .optimizer import (
        build_apollo_mini_optimizer,
        build_apollo_optimizer,
        optimizer_state_bytes,
    )

__all__ = [
    "REGISTRY", "ModelEntry", "Tier", "get",
    "build_apollo_mini_optimizer",
    "build_apollo_optimizer",
    "optimizer_state_bytes",
]


def __getattr__(name: str) -> Any:
    if name in {"REGISTRY", "ModelEntry", "Tier", "get"}:
        from . import model_registry

        return getattr(model_registry, name)
    if name in __all__:
        from . import optimizer

        return getattr(optimizer, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
