from __future__ import annotations

import json

from voice_profile_lifecycle import (
    SCHEMA_VERSION,
    build_lifecycle_report,
    write_lifecycle_report,
)


def test_lifecycle_report_covers_issue_acceptance_matrix():
    report = build_lifecycle_report()

    assert report["schemaVersion"] == SCHEMA_VERSION
    assert report["fixtureMode"] == "deterministic-synthetic-embeddings"

    coverage = report["coverage"]
    for key in [
        "ownerEnrollment",
        "recurringAttendeeEnrollment",
        "unknownSpeakerRemainsUnknown",
        "userConfirmedNaming",
        "userCorrection",
        "selfIntroductionNaming",
        "platformCalendarNameProvenance",
        "merge",
        "split",
        "delete",
        "revoke",
        "export",
        "bind",
        "unbind",
        "similarVoices",
        "backgroundNoise",
        "music",
        "overlap",
        "replaySpoof",
    ]:
        assert coverage[key] is True

    assert coverage["shortUtteranceBins"] == ["0.5s", "1s", "3s", "10s"]
    assert set(coverage["metrics"]) == {
        "EER",
        "FAR",
        "FRR",
        "top1",
        "top3",
        "DET/ROC",
        "confusionMatrix",
    }


def test_lifecycle_metrics_include_threshold_sweep_and_safety_gates():
    report = build_lifecycle_report()
    metrics = report["metrics"]

    assert metrics["thresholds"]["meetingLabel"] < metrics["thresholds"]["sensitiveAction"]
    assert 0 <= metrics["eer"] <= 1
    assert 0 <= metrics["far"] <= 1
    assert 0 <= metrics["frr"] <= 1
    assert metrics["top1ProfileAccuracy"] == 1.0
    assert metrics["top3ProfileAccuracy"] == 1.0
    assert metrics["sameSpeakerCosine"]["count"] > 0
    assert metrics["differentSpeakerCosine"]["count"] > 0
    assert len(metrics["detRocPoints"]) >= 5
    assert metrics["confusionMatrix"]["unknown"]["unknown"] == 1
    assert metrics["impostorAcceptRate"]["meetingLabel"] > 0
    assert metrics["impostorAcceptRate"]["sensitiveAction"] == 0

    gates = report["gates"]
    assert gates["unknownSpeakerRemainsUnknown"] is True
    assert gates["sensitiveRejectsReplaySpoof"] is True
    assert gates["sensitiveImpostorAcceptRateBelowMeetingLabel"] is True


def test_lifecycle_operations_and_snapshots_are_deterministic():
    first = build_lifecycle_report()
    second = build_lifecycle_report()

    assert json.dumps(first, sort_keys=True) == json.dumps(second, sort_keys=True)

    operation_names = [operation["operation"] for operation in first["operations"]]
    assert operation_names == [
        "unknown_speaker_check",
        "self_introduction_naming",
        "platform_calendar_name",
        "rename",
        "rename",
        "duplicate_profile_created",
        "merge",
        "split",
        "bind",
        "unbind",
        "export",
        "revoke",
        "delete",
    ]
    assert first["storeSnapshots"][0]["profileCount"] == 0
    assert first["storeSnapshots"][-1]["activeProfileCount"] >= 4
    assert all(
        profile["rawEmbeddingIncluded"] is False
        for operation in first["operations"]
        if operation["operation"] == "export"
        for profile in [operation["profile"]]
    )


def test_write_lifecycle_report_artifact(tmp_path):
    output = tmp_path / "voice-profile-lifecycle.json"
    report = write_lifecycle_report(output)

    assert output.exists()
    written = json.loads(output.read_text(encoding="utf-8"))
    assert written == report
    assert written["benchmark"] == "voice-profile-lifecycle"
