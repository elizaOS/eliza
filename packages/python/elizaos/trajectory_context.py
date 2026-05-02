from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar

# Async-safe context for associating runtime/model calls with a trajectory step.
CURRENT_TRAJECTORY_STEP_ID: ContextVar[str | None] = ContextVar(
    "CURRENT_TRAJECTORY_STEP_ID", default=None
)


@contextmanager
def bind_trajectory_step(step_id: str | None):
    token = CURRENT_TRAJECTORY_STEP_ID.set(step_id)
    try:
        yield
    finally:
        CURRENT_TRAJECTORY_STEP_ID.reset(token)
