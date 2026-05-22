"""LoadGen-style query scheduler for the E1 NPU MLPerf Inference harness.

This is a faithful re-implementation of the subset of MLCommons LoadGen
semantics needed to drive SingleStream and Offline scenarios against a
deterministic system-under-test (SUT). It is *not* the MLCommons C++
loadgen binary.

Fidelity boundary (documented, not hidden)
------------------------------------------
Implemented to match the MLPerf Inference rules:

- SingleStream: queries are issued one at a time; the SUT processes a
  single sample per query and the next query is not issued until the
  previous one completes. The reported metric is the 90th-percentile
  query latency (MLPerf SingleStream "result is the 90%-ile latency").
- Offline: all samples are available at once; the SUT is handed the
  entire query set in a single issue call and may process them in any
  order. The reported metric is throughput (samples per second) over
  the wall time of the batch.
- Latency is recorded per query at nanosecond resolution, percentiles
  are computed by the nearest-rank method on the sorted latency vector.

Deliberately *not* implemented (would change results, so we do not
claim them):

- Server and MultiStream scenarios (Poisson arrival / fixed query rate).
- The full LoadGen min-duration / min-query-count convergence and the
  early-stopping statistical confidence test. We expose a fixed
  ``query_count`` instead and record it, rather than fabricating the
  variable-length run LoadGen would schedule.
- Accuracy vs performance mode crossover: this harness always records
  both accuracy (against the reference) and latency in a single pass,
  whereas LoadGen runs them as separate modes.

These are recorded in the report ``fidelity`` block so any reader knows
exactly which LoadGen behaviors are modeled and which are stubbed.
"""

from __future__ import annotations

import time
from collections.abc import Sequence
from dataclasses import dataclass, field
from enum import Enum
from typing import Protocol


class Scenario(str, Enum):
    SINGLE_STREAM = "SingleStream"
    OFFLINE = "Offline"


@dataclass(frozen=True)
class QuerySample:
    """One LoadGen query sample: an index into the loaded dataset."""

    index: int


@dataclass(frozen=True)
class QueryResponse:
    """SUT response for a single sample."""

    index: int
    prediction: int


class SystemUnderTest(Protocol):
    """Minimal MLPerf SUT contract.

    ``issue_query`` receives a batch of samples and must return one
    response per sample. SingleStream calls it with a single-element
    batch; Offline calls it once with the full sample set.
    """

    def issue_query(self, samples: Sequence[QuerySample]) -> list[QueryResponse]: ...

    def name(self) -> str: ...


@dataclass(frozen=True)
class LoadGenConfig:
    scenario: Scenario
    query_count: int
    percentiles: tuple[float, ...] = (50.0, 90.0, 99.0)

    def __post_init__(self) -> None:
        if self.query_count <= 0:
            raise ValueError("query_count must be positive")
        for pct in self.percentiles:
            if not 0.0 < pct < 100.0:
                raise ValueError("percentiles must be in (0, 100)")


@dataclass
class LoadGenResult:
    scenario: Scenario
    query_count: int
    responses: list[QueryResponse]
    latencies_ns: list[int]
    wall_time_ns: int
    latency_percentiles_ns: dict[str, int] = field(default_factory=dict)
    throughput_samples_per_second: float | None = None


def _percentile_nearest_rank(sorted_values: Sequence[int], percentile: float) -> int:
    """Nearest-rank percentile, the convention LoadGen reports against."""
    if not sorted_values:
        raise ValueError("cannot compute percentile of empty sample set")
    rank = max(1, ceil_pct(percentile, len(sorted_values)))
    return sorted_values[rank - 1]


def ceil_pct(percentile: float, count: int) -> int:
    # ceil(percentile/100 * N) without importing math for one call.
    scaled = percentile / 100.0 * count
    integral = int(scaled)
    return integral if scaled == integral else integral + 1


def _percentile_key(percentile: float) -> str:
    if percentile == int(percentile):
        return f"p{int(percentile)}"
    return f"p{percentile}".replace(".", "_")


def run_loadgen(sut: SystemUnderTest, config: LoadGenConfig) -> LoadGenResult:
    """Schedule queries against the SUT per the configured scenario."""
    samples = [QuerySample(index=i) for i in range(config.query_count)]

    if config.scenario is Scenario.SINGLE_STREAM:
        responses: list[QueryResponse] = []
        latencies_ns: list[int] = []
        wall_start = time.perf_counter_ns()
        for sample in samples:
            issue_start = time.perf_counter_ns()
            batch_response = sut.issue_query([sample])
            issue_end = time.perf_counter_ns()
            if len(batch_response) != 1:
                raise ValueError(
                    "SingleStream SUT must return exactly one response per query"
                )
            responses.append(batch_response[0])
            latencies_ns.append(issue_end - issue_start)
        wall_time_ns = time.perf_counter_ns() - wall_start
        sorted_latencies = sorted(latencies_ns)
        percentiles = {
            _percentile_key(pct): _percentile_nearest_rank(sorted_latencies, pct)
            for pct in config.percentiles
        }
        return LoadGenResult(
            scenario=config.scenario,
            query_count=config.query_count,
            responses=responses,
            latencies_ns=latencies_ns,
            wall_time_ns=wall_time_ns,
            latency_percentiles_ns=percentiles,
        )

    if config.scenario is Scenario.OFFLINE:
        wall_start = time.perf_counter_ns()
        batch_response = sut.issue_query(samples)
        wall_time_ns = time.perf_counter_ns() - wall_start
        if len(batch_response) != config.query_count:
            raise ValueError(
                "Offline SUT must return one response per submitted sample"
            )
        # Offline reports throughput, not per-query latency, but we still
        # capture the batch wall time so the throughput is auditable.
        throughput = config.query_count / (wall_time_ns / 1e9) if wall_time_ns else 0.0
        return LoadGenResult(
            scenario=config.scenario,
            query_count=config.query_count,
            responses=batch_response,
            latencies_ns=[],
            wall_time_ns=wall_time_ns,
            throughput_samples_per_second=throughput,
        )

    raise ValueError(f"unsupported scenario {config.scenario}")
