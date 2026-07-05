"""Result records the scheduler produces and metrics/report consume.

``TaskRun`` is the outcome of one LifeOps scenario driven by the shared agent
under a given concurrency N; ``LaneResult`` bundles every task run at one N
(the N=1 lane is the interference baseline). These are plain dataclasses — the
transport-facing JSON shape lives in ``report.py``, kept separate so the
runtime model and the on-disk contract can move independently.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from eliza_lifeops_bench.types import ScenarioResult

__all__ = ["TaskRun", "LaneResult"]


@dataclass
class TaskRun:
    """One scenario run inside a wave, plus the scheduler-observed timing.

    ``result`` is ``None`` only when the task never produced a
    ``ScenarioResult`` — a wall-clock timeout the scheduler tripped before
    ``run_one`` returned, or an unexpected exception. In both cases
    ``terminated_reason`` carries the classification ("timeout"/"error") so
    metrics never has to conflate a missing result with a zero score.
    """

    scenario_id: str
    seed: int
    wave_index: int
    terminated_reason: str
    task_wall_s: float
    result: ScenarioResult | None = None

    @property
    def score(self) -> float:
        """Per-task score in [0, 1]: ``total_score / max_score``.

        A task with no result scored nothing — it timed out or errored before
        the runner could evaluate it — so its contribution is 0.0. This is not
        a fabricated success default: ``completed`` (see ``metrics``) gates on
        ``terminated_reason``, so an incomplete task is never counted as a
        healthy zero-scoring completion.
        """
        if self.result is None:
            return 0.0
        max_score = self.result.max_score or 1.0
        return self.result.total_score / max_score

    @property
    def turns(self) -> int:
        """Number of agent turns the task took (0 if it never ran)."""
        return len(self.result.turns) if self.result is not None else 0


@dataclass
class LaneResult:
    """Every task run at one concurrency level N."""

    n: int
    waves: int
    tasks: list[TaskRun] = field(default_factory=list)
    wall_clock_s: float = 0.0
