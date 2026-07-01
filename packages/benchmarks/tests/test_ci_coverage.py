"""Every public benchmark must declare a CI lane (#9475, #10193).

This is the de-larp guard: the suite advertised "40+ benchmarks" while nearly
every one had zero scheduled real-model runs. This test makes the CI-coverage
classification in ``orchestrator/ci_coverage.py`` stay 1:1 with registered
benchmarks plus public orchestrator adapters, so a new benchmark cannot be added
or exposed without an explicit CI lane (``scheduled`` / ``smoke``) or an explicit
``manual``-only marker — no benchmark silently gets zero CI coverage.

It also pins the classified-benchmark count to the live registry + adapter set
(#10193 trust): the prose in the sources previously undercounted what is really
44 registered / 53 public benchmarks, and this test makes any future hardcoded
"N-out-of-old-total" count in the classification module fail loudly.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT.parent))

from benchmarks.orchestrator.ci_coverage import (  # noqa: E402
    CI_LANE_BY_BENCHMARK,
    CI_LANES,
    SCHEDULED_ORCHESTRATOR_SUBSET,
    ci_lane_for,
    classified_benchmark_ids,
    public_benchmark_ids,
    registry_benchmark_ids,
)


def _workspace_root() -> Path:
    return Path(__file__).resolve().parents[2]


def test_every_public_benchmark_has_a_ci_lane_or_manual_marker() -> None:
    public_ids = public_benchmark_ids(_workspace_root())
    classified = classified_benchmark_ids()

    missing = public_ids - classified
    assert missing == frozenset(), (
        "public benchmarks with NO CI lane (add to CI_LANE_BY_BENCHMARK in "
        f"orchestrator/ci_coverage.py): {sorted(missing)}"
    )

    stale = classified - public_ids
    assert stale == frozenset(), (
        "CI_LANE_BY_BENCHMARK lists benchmarks that are no longer public "
        f"(remove them): {sorted(stale)}"
    )


def test_every_ci_lane_value_is_valid() -> None:
    for benchmark_id, lane in CI_LANE_BY_BENCHMARK.items():
        assert lane in CI_LANES, f"{benchmark_id}: invalid CI lane {lane!r}"


def test_scheduled_orchestrator_subset_is_scheduled_and_registered() -> None:
    registry_ids = registry_benchmark_ids(_workspace_root())
    for benchmark_id in SCHEDULED_ORCHESTRATOR_SUBSET:
        assert benchmark_id in registry_ids, (
            f"{benchmark_id} is in the scheduled orchestrator workflow subset "
            "but is not a registered benchmark"
        )
        assert ci_lane_for(benchmark_id) == "scheduled"


def test_at_least_one_benchmark_per_lane() -> None:
    # The whole point is honest coverage: every lane is actually used, so the
    # taxonomy reflects reality rather than being aspirational.
    lanes_in_use = set(CI_LANE_BY_BENCHMARK.values())
    assert lanes_in_use == set(CI_LANES)


def test_classified_count_equals_public_benchmark_count() -> None:
    # #10193: the classified set is the count of record for "how many public
    # benchmarks exist". Assert it equals the live registry|adapter set so a
    # stale hardcoded count (the old "42/43") can never silently drift back in.
    public_ids = public_benchmark_ids(_workspace_root())
    classified = classified_benchmark_ids()
    # Guard against a stale hardcoded undercount silently drifting back in.
    assert len(classified) == len(public_ids), (
        f"classified benchmarks ({len(classified)}) != public benchmarks "
        f"({len(public_ids)}); classification and registry/adapters are out of sync"
    )


def test_registry_count_matches_classified_registry_subset() -> None:
    # #10193: pin the registered-benchmark count. The registry is the canonical
    # source of truth; every registered id must also carry a CI lane, and the
    # count reported by the registry must equal the number of registered ids
    # that are classified. This is what makes "44 registered" a fact the tests
    # own, not prose someone forgets to update.
    registry_ids = registry_benchmark_ids(_workspace_root())
    classified = classified_benchmark_ids()
    assert registry_ids <= classified, (
        "registered benchmarks with NO CI lane: "
        f"{sorted(registry_ids - classified)}"
    )
    classified_registry = registry_ids & classified
    assert len(classified_registry) == len(registry_ids)


def test_no_source_hardcodes_a_stale_benchmark_count() -> None:
    # #10193: an undercount ("N-out-of-old-total") lived in module prose. Guard
    # against any stale "N/43" or "N/42" or "4[23] registered" count creeping
    # back into the classification sources. The honest counts (44 registered,
    # 53 public) are derived from the registry/adapters, never hardcoded as a
    # fraction of a stale total. Scans the real sources only — not this test.
    sources = [
        ROOT / "orchestrator" / "ci_coverage.py",
        ROOT / "README.md",
    ]
    stale = re.compile(r"\b\d+\s*/\s*4[23]\b|\b4[23]\s+registered\b")
    offenders: list[str] = []
    for source in sources:
        if not source.is_file():
            continue
        for lineno, line in enumerate(source.read_text(encoding="utf-8").splitlines(), 1):
            if stale.search(line):
                offenders.append(f"{source.name}:{lineno}: {line.strip()}")
    assert not offenders, "stale hardcoded benchmark count(s) found:\n" + "\n".join(offenders)
