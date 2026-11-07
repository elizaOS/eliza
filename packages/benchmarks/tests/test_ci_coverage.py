"""Public workload classification is complete and uses valid lanes."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT.parent))

from benchmarks.orchestrator.ci_coverage import (  # noqa: E402
    CI_LANE_BY_BENCHMARK,
    CI_LANES,
    ci_lane_for,
    classified_benchmark_ids,
    public_benchmark_ids,
    registry_benchmark_ids,
)


def _workspace_root() -> Path:
    return Path(__file__).resolve().parents[1]


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


def test_meeting_voice_registry_contract_for_issue_12502() -> None:
    registry_ids = registry_benchmark_ids(_workspace_root())

    assert {
        "meeting_voice",
        "meeting_voice_real",
        "meeting_voice_stress",
        "meeting_voice_av",
        "meeting_transcription_proof",
        "voicebench",
        "voicebench_quality",
        "voiceagentbench",
        "mmau",
    } <= registry_ids
    assert ci_lane_for("meeting_voice") == "smoke"
    assert ci_lane_for("meeting_voice_real") == "manual"
    assert ci_lane_for("meeting_voice_stress") == "manual"
    assert ci_lane_for("meeting_voice_av") == "manual"
