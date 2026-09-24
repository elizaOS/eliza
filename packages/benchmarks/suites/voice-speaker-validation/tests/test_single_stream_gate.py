from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

from single_stream_gate import (
    REQUIRED_SPEAKER_COUNTS,
    REQUIRED_VARIANTS,
    HypothesisTurn,
    build_reference_hypothesis,
    build_single_stream_scenarios,
    evaluate_single_stream_gate,
    scenario_to_manifest,
)


REQUIRED_METRICS = {
    "speaker_count_accuracy",
    "der",
    "jer",
    "wder",
    "overlap_der",
    "cpwer",
    "tcpwer",
    "speaker_attribution_errors",
    "disappeared_speaker_count",
    "over_split_count",
    "under_split_count",
    "speaker_turn_boundary_timing_error_ms",
}


def test_single_stream_matrix_covers_required_axes():
    scenarios = build_single_stream_scenarios()

    assert {scenario.speaker_count for scenario in scenarios} == set(REQUIRED_SPEAKER_COUNTS)
    assert {scenario.acoustic_variant for scenario in scenarios} == set(REQUIRED_VARIANTS)
    assert len(scenarios) == len(REQUIRED_SPEAKER_COUNTS) * len(REQUIRED_VARIANTS)
    assert len({scenario.scenario_id for scenario in scenarios}) == len(scenarios)

    for scenario in scenarios:
        assert scenario.source_platform_participant_id == "platform-room-tile-1"
        assert scenario.source_stream_id.startswith("room-mic-")
        assert "room_feed_suspected" in scenario.room_feed_evidence
        assert "multi_speaker_room" in scenario.room_feed_evidence
        assert len({turn.speaker_id for turn in scenario.reference_turns}) == scenario.speaker_count


def test_reference_hypotheses_pass_and_report_required_metrics():
    for scenario in build_single_stream_scenarios():
        report = evaluate_single_stream_gate(scenario, build_reference_hypothesis(scenario))

        assert report["pass"], report["failures"]
        assert report["detected_speaker_count"] == scenario.speaker_count
        assert report["platform_participant_ids"] == [scenario.source_platform_participant_id]
        assert set(report["metrics"]) == REQUIRED_METRICS
        assert report["metrics"]["der"] == 0
        assert report["metrics"]["jer"] == 0
        assert report["metrics"]["cpwer"] == 0
        assert report["metrics"]["tcpwer"] == 0
        assert report["metrics"]["speaker_attribution_errors"] == 0


def test_overlap_collapse_baseline_fails_gate():
    scenario = next(
        scenario
        for scenario in build_single_stream_scenarios()
        if scenario.speaker_count == 3 and scenario.acoustic_variant == "overlap"
    )
    collapsed = [
        replace(turn, diarized_speaker_id="platform-room-tile-1/collapsed-speaker")
        for turn in build_reference_hypothesis(scenario)
    ]

    report = evaluate_single_stream_gate(scenario, collapsed)

    assert not report["pass"]
    assert report["metrics"]["under_split_count"] == 2
    assert any(
        "overlapping speech collapsed into one speaker" in item
        for item in report["failures"]
    )


def test_secondary_speaker_disappearing_baseline_fails_gate():
    scenario = next(
        scenario
        for scenario in build_single_stream_scenarios()
        if scenario.speaker_count == 5 and scenario.acoustic_variant == "babble"
    )
    missing_last_speaker = [
        turn
        for turn in build_reference_hypothesis(scenario)
        if not turn.diarized_speaker_id.endswith("room_speaker_5")
    ]

    report = evaluate_single_stream_gate(scenario, missing_last_speaker)

    assert not report["pass"]
    assert "room_speaker_5" in report["disappeared_speakers"]
    assert report["metrics"]["disappeared_speaker_count"] == 1
    assert any("secondary speaker disappeared" in item for item in report["failures"])


def test_platform_participant_id_must_be_preserved_with_multiple_diarized_speakers():
    scenario = next(
        scenario
        for scenario in build_single_stream_scenarios()
        if scenario.speaker_count == 2 and scenario.acoustic_variant == "far_field"
    )
    hypothesis = build_reference_hypothesis(scenario)
    report = evaluate_single_stream_gate(scenario, hypothesis)

    assert report["pass"], report["failures"]
    assert report["platform_participant_ids"] == [scenario.source_platform_participant_id]
    assert len(report["diarized_speaker_ids"]) == 2

    wrong_platform = [
        HypothesisTurn(
            diarized_speaker_id=turn.diarized_speaker_id,
            platform_participant_id="platform-person-tile-2",
            start_ms=turn.start_ms,
            end_ms=turn.end_ms,
            text=turn.text,
        )
        for turn in hypothesis
    ]
    failed = evaluate_single_stream_gate(scenario, wrong_platform)

    assert not failed["pass"]
    assert any(
        "platform participant id was not preserved" in item
        for item in failed["failures"]
    )


def test_gate_writes_reviewable_manifest_and_report_artifact(artifacts_dir: Path):
    scenarios = build_single_stream_scenarios()
    reports = [
        evaluate_single_stream_gate(scenario, build_reference_hypothesis(scenario))
        for scenario in scenarios
    ]
    output = {
        "issue": 12493,
        "scenario_count": len(scenarios),
        "scenarios": [scenario_to_manifest(scenario) for scenario in scenarios],
        "reports": reports,
    }
    out_path = artifacts_dir / "single-stream-gate.json"
    out_path.write_text(json.dumps(output, indent=2), encoding="utf-8")

    loaded = json.loads(out_path.read_text(encoding="utf-8"))
    assert loaded["scenario_count"] == 24
    assert all(report["pass"] for report in loaded["reports"])
    assert out_path.exists()
