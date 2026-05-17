"""Suite-definition gate tests.

The three named suites (``smoke`` / ``core`` / ``full``) are explicit subsets
of the hand-authored scenario corpus. These tests assert:

- ``smoke`` is exactly 5 scenarios — the budget that lets the multi-tier CI
  job finish in under 5 minutes wall-clock.
- ``core`` is no more than 35 scenarios — the budget that lets the nightly
  job finish under its 45-minute job timeout.
- Every suite ID resolves against ``SCENARIOS_BY_ID`` (caught at import time,
  but re-asserted here for clarity).
- ``smoke`` spans at least 4 distinct domains so we exercise multiple
  surfaces on every PR.
- ``smoke`` is all STATIC so it runs without live-judge keys.
"""

from __future__ import annotations

import pytest

from eliza_lifeops_bench.scenarios import ALL_SCENARIOS, SCENARIOS_BY_ID
from eliza_lifeops_bench.suites import (
    CORE_SCENARIO_IDS,
    CORE_SCENARIOS,
    FULL_SCENARIOS,
    SMOKE_SCENARIO_IDS,
    SMOKE_SCENARIOS,
    SUITES,
    resolve_suite,
)
from eliza_lifeops_bench.types import ScenarioMode


def test_smoke_is_exactly_five_scenarios() -> None:
    assert len(SMOKE_SCENARIOS) == 5, (
        f"smoke suite must be exactly 5 scenarios (got {len(SMOKE_SCENARIOS)}) "
        "— the 5-minute wall-clock budget depends on this cap."
    )
    assert len(SMOKE_SCENARIO_IDS) == 5


def test_core_is_at_most_thirty_five_scenarios() -> None:
    assert 1 <= len(CORE_SCENARIOS) <= 35, (
        f"core suite must be 1..35 scenarios (got {len(CORE_SCENARIOS)})"
    )
    assert len(CORE_SCENARIO_IDS) == len(CORE_SCENARIOS)


def test_full_matches_all_scenarios() -> None:
    assert len(FULL_SCENARIOS) == len(ALL_SCENARIOS)


def test_all_suite_ids_exist_in_corpus() -> None:
    for sid in [*SMOKE_SCENARIO_IDS, *CORE_SCENARIO_IDS]:
        assert sid in SCENARIOS_BY_ID, f"unknown scenario id in suite: {sid}"


def test_smoke_spans_at_least_four_domains() -> None:
    domains = {s.domain for s in SMOKE_SCENARIOS}
    assert len(domains) >= 4, (
        f"smoke suite must span ≥4 domains (got {[d.value for d in domains]})"
    )


def test_smoke_is_all_static() -> None:
    """Smoke must run without CEREBRAS+ANTHROPIC keys, so no LIVE scenarios."""
    non_static = [s for s in SMOKE_SCENARIOS if s.mode is not ScenarioMode.STATIC]
    assert not non_static, (
        "smoke suite must be all STATIC: "
        + ", ".join(s.id for s in non_static)
    )


def test_resolve_suite_returns_named_list() -> None:
    assert resolve_suite("smoke") is SUITES["smoke"]
    assert resolve_suite("CORE") is SUITES["core"]
    assert resolve_suite(" full ") is SUITES["full"]


def test_resolve_suite_rejects_unknown() -> None:
    with pytest.raises(KeyError):
        resolve_suite("does-not-exist")
