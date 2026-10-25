"""Shared hermetic lane runs so the state-hash replay cost is paid once.

Driving the frozen sample through the real LifeOpsBench runner replays
ground-truth against the ~5000-entity medium snapshot per task, which is the
dominant cost. The perfect/wrong lanes are deterministic, so we run each set of
lanes once at session scope and let every test assert against the cached
results rather than re-running.
"""

from __future__ import annotations

import asyncio

import pytest

from multitask_bench.harness import build_agent_factory, build_world_factory
from multitask_bench.sample import MULTITASK_SAMPLE
from multitask_bench.scheduler import run_lane
from multitask_bench.types import LaneResult


async def _run_lanes(harness: str, ns: tuple[int, ...]) -> list[LaneResult]:
    factory = build_agent_factory(harness)
    world = build_world_factory()
    lanes: list[LaneResult] = []
    for n in ns:
        lanes.append(
            await run_lane(
                n=n,
                scenarios=MULTITASK_SAMPLE,
                agent_factory=factory,
                world_factory=world,
                timeout_s=60.0,
            )
        )
    return lanes


@pytest.fixture(scope="session")
def perfect_lanes() -> list[LaneResult]:
    """N=1/5/10 lanes driven by the PerfectAgent oracle (deterministic)."""
    return asyncio.run(_run_lanes("perfect", (1, 5, 10)))


@pytest.fixture(scope="session")
def wrong_lanes() -> list[LaneResult]:
    """N=1/5 lanes driven by the WrongAgent oracle (deterministic)."""
    return asyncio.run(_run_lanes("wrong", (1, 5)))
