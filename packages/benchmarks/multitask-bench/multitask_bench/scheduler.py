"""Wave scheduler: drives one agent through N interleaved LifeOps tasks.

The unit under test is "one long-lived agent handling N tasks at once", so a
lane holds a single ``LifeOpsBenchRunner`` whose ``agent_factory`` mints a
fresh ``agent_fn`` per scenario. For the eliza harness that factory hands every
task its own session on one shared ``AgentRuntime`` (genuine shared-runtime
interference); for hermes/openclaw it hands every task the same client instance
driving a per-turn subprocess/in-process call (process-isolated, interference =
shared rate/cost budget only). The asymmetry is disclosed by the caller as
``isolation`` — never erased here.

Tasks arrive batch-presented at t=0 in waves of exactly N: the sample is sliced
``sample[k*N:(k+1)*N]`` and each wave runs concurrently via ``asyncio.gather``.
Streamed/sliding-window arrival was rejected upstream (nondeterministic /
throughput-shaped); a wave is the deterministic unit the interference delta is
computed over. The N=1 lane is 10 sequential single-task waves — the baseline
the N=5/N=10 deltas subtract against.

Per-task wall-clock timeout is enforced with ``asyncio.wait_for`` so one wedged
task cannot stall a wave forever; a tripped timeout is recorded as a
``TaskRun`` with ``terminated_reason="timeout"`` rather than propagated, so the
lane still yields a full result set for fairness/starvation accounting.
"""

from __future__ import annotations

import asyncio
import time

from eliza_lifeops_bench.runner import AgentFactory, LifeOpsBenchRunner, WorldFactory
from eliza_lifeops_bench.types import Scenario

from .sample import sample_seed
from .types import LaneResult, TaskRun

__all__ = ["partition_waves", "run_lane"]


def partition_waves(scenarios: list[Scenario], n: int) -> list[list[Scenario]]:
    """Slice ``scenarios`` into consecutive waves of exactly ``n``.

    The final wave is short only when ``len(scenarios)`` is not a multiple of
    ``n``. Deterministic: the same sample and N always produce the same waves,
    which is what lets the interference delta line up (scenario, seed) pairs
    across lanes.
    """
    if n < 1:
        raise ValueError(f"wave size must be >= 1, got {n}")
    return [scenarios[k : k + n] for k in range(0, len(scenarios), n)]


async def _run_task(
    runner: LifeOpsBenchRunner,
    scenario: Scenario,
    seed: int,
    wave_index: int,
    timeout_s: float,
) -> TaskRun:
    """Run one scenario under a wall-clock timeout, classifying the outcome.

    ``run_one`` already translates in-flight failures into a typed
    ``ScenarioResult`` (terminated_reason "error"/"cost_exceeded"); the only
    thing it does not bound is total wall time, so we wrap it in
    ``wait_for``. A timeout or an escaped exception becomes a resultless
    ``TaskRun`` whose ``terminated_reason`` records why, keeping "did not
    complete" distinct from "completed with score 0".
    """
    started = time.monotonic()
    try:
        result = await asyncio.wait_for(
            runner.run_one(scenario, seed), timeout=timeout_s
        )
        wall_s = time.monotonic() - started
        return TaskRun(
            scenario_id=scenario.id,
            seed=seed,
            wave_index=wave_index,
            terminated_reason=result.terminated_reason,
            task_wall_s=wall_s,
            result=result,
        )
    except asyncio.TimeoutError:
        wall_s = time.monotonic() - started
        return TaskRun(
            scenario_id=scenario.id,
            seed=seed,
            wave_index=wave_index,
            terminated_reason="timeout",
            task_wall_s=wall_s,
            result=None,
        )


async def run_lane(
    *,
    n: int,
    scenarios: list[Scenario],
    agent_factory: AgentFactory,
    world_factory: WorldFactory,
    timeout_s: float,
    max_cost_usd: float = 50.0,
) -> LaneResult:
    """Run the full sample at concurrency ``n`` and return its lane result.

    One runner per lane owns the shared cost ledger; ``agent_factory`` gives
    each task a fresh ``agent_fn`` (a fresh session on the shared runtime for
    eliza). Waves run in order; within a wave every task runs concurrently so
    the shared agent is genuinely handling N at once.
    """
    runner = LifeOpsBenchRunner(
        agent_factory=agent_factory,
        world_factory=world_factory,
        scenarios=scenarios,
        max_cost_usd=max_cost_usd,
        # Waves own their own concurrency; the runner-level semaphore only
        # matters for its own run_all path, which we do not use.
        concurrency=max(n, 1),
        abort_on_budget_exceeded=False,
    )

    waves = partition_waves(scenarios, n)
    tasks: list[TaskRun] = []
    lane_started = time.monotonic()
    for wave_index, wave in enumerate(waves):
        wave_runs = await asyncio.gather(
            *(
                _run_task(runner, scenario, sample_seed(scenario), wave_index, timeout_s)
                for scenario in wave
            )
        )
        tasks.extend(wave_runs)
    wall_clock_s = time.monotonic() - lane_started

    return LaneResult(n=n, waves=len(waves), tasks=tasks, wall_clock_s=wall_clock_s)
