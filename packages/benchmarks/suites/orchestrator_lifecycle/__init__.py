"""Exposes lifecycle benchmark types without eagerly loading execution code.

The package-level runner export is lazy so importing the no-publication canary
cannot transitively load the scored runner or report writer.
"""

from typing import TYPE_CHECKING

from .types import (
    LifecycleConfig,
    LifecycleMetrics,
    Scenario,
    ScenarioResult,
    ScenarioTurn,
    TurnRecord,
)

if TYPE_CHECKING:
    from .runner import LifecycleRunner


def __getattr__(name: str) -> object:
    """Resolve the runner only for callers that request its legacy export."""

    if name == "LifecycleRunner":
        from .runner import LifecycleRunner

        return LifecycleRunner
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = [
    "LifecycleConfig",
    "LifecycleMetrics",
    "LifecycleRunner",
    "Scenario",
    "ScenarioResult",
    "ScenarioTurn",
    "TurnRecord",
]
