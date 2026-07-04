from __future__ import annotations

import json
from pathlib import Path

import pytest

from elizaos_meeting_transcription_proof.cli import build_report


FIXTURE_MANIFEST = Path(__file__).resolve().parents[1] / "fixtures" / "mock-meeting-manifest.json"


def _fixture_scenarios() -> list[object]:
    return json.loads(FIXTURE_MANIFEST.read_text(encoding="utf-8"))["scenarios"]


def _fixture_dataset_sources() -> list[object]:
    return json.loads(FIXTURE_MANIFEST.read_text(encoding="utf-8"))["dataset_sources"]


def _fixture_capture_paths() -> list[object]:
    return json.loads(FIXTURE_MANIFEST.read_text(encoding="utf-8"))["capture_paths"]


def _fixture_speaker_operations() -> list[object]:
    return json.loads(FIXTURE_MANIFEST.read_text(encoding="utf-8"))["speaker_operations"]


def _base_manifest(provider_mode: str = "real_zoom_meet") -> dict[str, object]:
    return {
        "provider_mode": provider_mode,
        "surfaces": ["zoom", "google_meet", "on_device", "cloud_agent", "hybrid_local_cloud"],
        "capture_modes": ["bot", "bot_free"],
        "transcript_schema": {
            "required_fields": [
                "meeting_id",
                "source",
                "consent",
                "segments",
                "speakers",
                "artifacts",
                "retention_policy",
            ]
        },
        "adapters": [
            {"id": "zoom", "capture_modes": ["bot", "bot_free"]},
            {"id": "google_meet", "capture_modes": ["bot", "bot_free"]},
        ],
        "stressors": ["music", "noise", "babble", "overlap", "far_field"],
        "scenarios": _fixture_scenarios(),
        "dataset_sources": _fixture_dataset_sources(),
        "capture_paths": _fixture_capture_paths(),
        "speaker_operations": _fixture_speaker_operations(),
        "metrics": {
            "transcript_quality": 0.91,
            "diarization_quality": 0.82,
            "speaker_identity_quality": 0.77,
            "consent_retention_quality": 1.0,
            "wer": 0.09,
            "cer": 0.04,
            "speaker_attributed_wer": 0.13,
            "der": 0.18,
            "jer": 0.22,
            "overlap_aware_wer": 0.2,
            "active_speaker_accuracy": 0.84,
            "voice_profile_false_accept_rate": 0.03,
            "voice_profile_false_reject_rate": 0.08,
            "end_of_turn_latency_ms": 280,
            "barge_in_latency_ms": 190,
            "p95_end_to_end_latency_ms": 1300,
            "notes_factuality": 0.93,
            "action_item_extraction": 0.89,
        },
    }


def _write_manifest(tmp_path: Path, manifest: dict[str, object]) -> Path:
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps(manifest), encoding="utf-8")
    return path


def test_mocked_plumbing_fixture_is_not_publishable() -> None:
    report = build_report(lane="mocked_plumbing", manifest_path=FIXTURE_MANIFEST)

    assert report["lane"] == "mocked_plumbing"
    assert report["publishable"] is False
    assert report["score"] == pytest.approx(1.0)
    assert report["evidence_files"] == {}
    assert len(report["scenarios"]) == len(_fixture_scenarios())
    assert len(report["dataset_sources"]) == len(_fixture_dataset_sources())
    assert len(report["capture_paths"]) == len(_fixture_capture_paths())
    assert len(report["speaker_operations"]) == len(_fixture_speaker_operations())


def test_real_lane_requires_non_mock_provider(tmp_path: Path) -> None:
    manifest = _write_manifest(tmp_path, _base_manifest(provider_mode="mock"))

    with pytest.raises(ValueError, match="non-mock provider_mode"):
        build_report(lane="real_product", manifest_path=manifest)


def test_real_lane_requires_every_evidence_file(tmp_path: Path) -> None:
    manifest_data = _base_manifest()
    manifest_data["evidence"] = {"audio": "audio.wav"}
    (tmp_path / "audio.wav").write_text("fake audio marker", encoding="utf-8")
    manifest = _write_manifest(tmp_path, manifest_data)

    with pytest.raises(ValueError, match="missing evidence types"):
        build_report(lane="real_product", manifest_path=manifest)


def test_real_lane_requires_detailed_voice_metrics(tmp_path: Path) -> None:
    manifest_data = _base_manifest()
    metrics = manifest_data["metrics"]
    assert isinstance(metrics, dict)
    metrics.pop("speaker_attributed_wer")
    manifest = _write_manifest(tmp_path, manifest_data)

    with pytest.raises(ValueError, match="missing detailed metrics"):
        build_report(lane="real_product", manifest_path=manifest)


def test_detailed_ratio_metrics_must_be_in_range(tmp_path: Path) -> None:
    manifest_data = _base_manifest()
    metrics = manifest_data["metrics"]
    assert isinstance(metrics, dict)
    metrics["der"] = 1.5
    manifest = _write_manifest(tmp_path, manifest_data)

    with pytest.raises(ValueError, match=r"metrics\.der must be in \[0, 1\]"):
        build_report(lane="real_product", manifest_path=manifest)


def test_latency_metrics_must_be_non_negative(tmp_path: Path) -> None:
    manifest_data = _base_manifest()
    metrics = manifest_data["metrics"]
    assert isinstance(metrics, dict)
    metrics["barge_in_latency_ms"] = -1
    manifest = _write_manifest(tmp_path, manifest_data)

    with pytest.raises(ValueError, match="metrics.barge_in_latency_ms must be non-negative"):
        build_report(lane="real_product", manifest_path=manifest)


def test_real_lane_requires_complete_scenario_coverage(tmp_path: Path) -> None:
    manifest_data = _base_manifest()
    manifest_data["scenarios"] = [
        scenario
        for scenario in _fixture_scenarios()
        if isinstance(scenario, dict) and scenario.get("id") != "shared_room_microphone"
    ]
    manifest = _write_manifest(tmp_path, manifest_data)

    with pytest.raises(ValueError, match="missing scenarios"):
        build_report(lane="real_product", manifest_path=manifest)


def test_scenarios_may_only_reference_required_evidence_types(tmp_path: Path) -> None:
    manifest_data = _base_manifest()
    scenarios = _fixture_scenarios()
    assert isinstance(scenarios[0], dict)
    scenarios[0] = {**scenarios[0], "evidence": ["audio", "imaginary_artifact"]}
    manifest_data["scenarios"] = scenarios
    manifest = _write_manifest(tmp_path, manifest_data)

    with pytest.raises(ValueError, match="unknown evidence"):
        build_report(lane="real_product", manifest_path=manifest)


def test_scenarios_must_reference_every_required_evidence_type(tmp_path: Path) -> None:
    manifest_data = _base_manifest()
    stripped = []
    for scenario in _fixture_scenarios():
        assert isinstance(scenario, dict)
        evidence = [item for item in scenario["evidence"] if item != "model_trajectories"]
        stripped.append({**scenario, "evidence": evidence or ["audio"]})
    manifest_data["scenarios"] = stripped
    manifest = _write_manifest(tmp_path, manifest_data)

    with pytest.raises(ValueError, match="do not reference evidence"):
        build_report(lane="real_product", manifest_path=manifest)


def test_real_lane_requires_external_dataset_condition_coverage(tmp_path: Path) -> None:
    manifest_data = _base_manifest()
    manifest_data["dataset_sources"] = [
        dataset
        for dataset in _fixture_dataset_sources()
        if isinstance(dataset, dict) and dataset.get("id") != "misp_meeting"
    ]
    manifest = _write_manifest(tmp_path, manifest_data)

    with pytest.raises(ValueError, match="dataset_sources missing conditions"):
        build_report(lane="real_product", manifest_path=manifest)


def test_dataset_sources_may_only_reference_required_evidence_types(tmp_path: Path) -> None:
    manifest_data = _base_manifest()
    datasets = _fixture_dataset_sources()
    assert isinstance(datasets[0], dict)
    datasets[0] = {**datasets[0], "evidence": ["audio", "imaginary_artifact"]}
    manifest_data["dataset_sources"] = datasets
    manifest = _write_manifest(tmp_path, manifest_data)

    with pytest.raises(ValueError, match="references unknown evidence"):
        build_report(lane="real_product", manifest_path=manifest)


def test_dataset_sources_require_version_and_checksum(tmp_path: Path) -> None:
    manifest_data = _base_manifest()
    datasets = _fixture_dataset_sources()
    assert isinstance(datasets[0], dict)
    datasets[0] = {key: value for key, value in datasets[0].items() if key != "checksum"}
    manifest_data["dataset_sources"] = datasets
    manifest = _write_manifest(tmp_path, manifest_data)

    with pytest.raises(ValueError, match="missing fields"):
        build_report(lane="real_product", manifest_path=manifest)


def test_dataset_source_version_and_checksum_must_be_non_empty(tmp_path: Path) -> None:
    manifest_data = _base_manifest()
    datasets = _fixture_dataset_sources()
    assert isinstance(datasets[0], dict)
    datasets[0] = {**datasets[0], "version": " "}
    manifest_data["dataset_sources"] = datasets
    manifest = _write_manifest(tmp_path, manifest_data)

    with pytest.raises(ValueError, match=r"dataset_sources\[0\]\.version must be a non-empty string"):
        build_report(lane="real_product", manifest_path=manifest)


def test_dataset_sources_require_benchmarkable_metadata(tmp_path: Path) -> None:
    manifest_data = _base_manifest()
    datasets = _fixture_dataset_sources()
    assert isinstance(datasets[0], dict)
    datasets[0] = {key: value for key, value in datasets[0].items() if key != "sample_count"}
    manifest_data["dataset_sources"] = datasets
    manifest = _write_manifest(tmp_path, manifest_data)

    with pytest.raises(ValueError, match="missing fields"):
        build_report(lane="real_product", manifest_path=manifest)


def test_dataset_source_sample_count_must_be_positive(tmp_path: Path) -> None:
    manifest_data = _base_manifest()
    datasets = _fixture_dataset_sources()
    assert isinstance(datasets[0], dict)
    datasets[0] = {**datasets[0], "sample_count": 0}
    manifest_data["dataset_sources"] = datasets
    manifest = _write_manifest(tmp_path, manifest_data)

    with pytest.raises(ValueError, match=r"dataset_sources\[0\]\.sample_count must be a positive integer"):
        build_report(lane="real_product", manifest_path=manifest)


def test_dataset_sources_may_only_reference_known_target_metrics(tmp_path: Path) -> None:
    manifest_data = _base_manifest()
    datasets = _fixture_dataset_sources()
    assert isinstance(datasets[0], dict)
    datasets[0] = {**datasets[0], "target_metrics": ["wer", "imaginary_metric"]}
    manifest_data["dataset_sources"] = datasets
    manifest = _write_manifest(tmp_path, manifest_data)

    with pytest.raises(ValueError, match="references unknown target metrics"):
        build_report(lane="real_product", manifest_path=manifest)


def test_real_lane_requires_dataset_annotation_coverage(tmp_path: Path) -> None:
    manifest_data = _base_manifest()
    stripped = []
    for dataset in _fixture_dataset_sources():
        assert isinstance(dataset, dict)
        annotation_types = [item for item in dataset["annotation_types"] if item != "active_speaker_video"]
        stripped.append({**dataset, "annotation_types": annotation_types or ["transcript"]})
    manifest_data["dataset_sources"] = stripped
    manifest = _write_manifest(tmp_path, manifest_data)

    with pytest.raises(ValueError, match="dataset_sources missing annotation types"):
        build_report(lane="real_product", manifest_path=manifest)


def test_real_lane_requires_all_capture_paths(tmp_path: Path) -> None:
    manifest_data = _base_manifest()
    manifest_data["capture_paths"] = [
        path
        for path in _fixture_capture_paths()
        if isinstance(path, dict) and path.get("id") != "google_meet_bot_free"
    ]
    manifest = _write_manifest(tmp_path, manifest_data)

    with pytest.raises(ValueError, match="missing capture paths"):
        build_report(lane="real_product", manifest_path=manifest)


def test_capture_paths_require_participant_metadata_and_consent(tmp_path: Path) -> None:
    manifest_data = _base_manifest()
    paths = _fixture_capture_paths()
    assert isinstance(paths[0], dict)
    paths[0] = {**paths[0], "participant_metadata": " "}
    manifest_data["capture_paths"] = paths
    manifest = _write_manifest(tmp_path, manifest_data)

    with pytest.raises(ValueError, match=r"capture_paths\[0\]\.participant_metadata must be a non-empty string"):
        build_report(lane="real_product", manifest_path=manifest)


def test_capture_paths_may_only_reference_required_evidence_types(tmp_path: Path) -> None:
    manifest_data = _base_manifest()
    paths = _fixture_capture_paths()
    assert isinstance(paths[0], dict)
    paths[0] = {**paths[0], "evidence": ["audio", "imaginary_artifact"]}
    manifest_data["capture_paths"] = paths
    manifest = _write_manifest(tmp_path, manifest_data)

    with pytest.raises(ValueError, match="references unknown evidence"):
        build_report(lane="real_product", manifest_path=manifest)


def test_real_lane_requires_all_speaker_operations(tmp_path: Path) -> None:
    manifest_data = _base_manifest()
    manifest_data["speaker_operations"] = [
        operation
        for operation in _fixture_speaker_operations()
        if isinstance(operation, dict) and operation.get("id") != "post_deletion_non_recognition"
    ]
    manifest = _write_manifest(tmp_path, manifest_data)

    with pytest.raises(ValueError, match="missing speaker operations"):
        build_report(lane="real_product", manifest_path=manifest)


def test_speaker_operations_require_privacy_and_confidence_policies(tmp_path: Path) -> None:
    manifest_data = _base_manifest()
    operations = _fixture_speaker_operations()
    assert isinstance(operations[0], dict)
    operations[0] = {**operations[0], "confidence_policy": " "}
    manifest_data["speaker_operations"] = operations
    manifest = _write_manifest(tmp_path, manifest_data)

    with pytest.raises(ValueError, match=r"speaker_operations\[0\]\.confidence_policy must be a non-empty string"):
        build_report(lane="real_product", manifest_path=manifest)


def test_speaker_operations_may_only_reference_required_evidence_types(tmp_path: Path) -> None:
    manifest_data = _base_manifest()
    operations = _fixture_speaker_operations()
    assert isinstance(operations[0], dict)
    operations[0] = {**operations[0], "evidence": ["speaker_profile_artifact", "imaginary_artifact"]}
    manifest_data["speaker_operations"] = operations
    manifest = _write_manifest(tmp_path, manifest_data)

    with pytest.raises(ValueError, match="references unknown evidence"):
        build_report(lane="real_product", manifest_path=manifest)


def test_speaker_operations_may_only_reference_known_metrics(tmp_path: Path) -> None:
    manifest_data = _base_manifest()
    operations = _fixture_speaker_operations()
    assert isinstance(operations[0], dict)
    operations[0] = {**operations[0], "metrics": ["speaker_identity_quality", "imaginary_metric"]}
    manifest_data["speaker_operations"] = operations
    manifest = _write_manifest(tmp_path, manifest_data)

    with pytest.raises(ValueError, match="references unknown metrics"):
        build_report(lane="real_product", manifest_path=manifest)


def test_real_lane_scores_lowest_required_quality_and_resolves_evidence(tmp_path: Path) -> None:
    evidence_names = [
        "audio",
        "video",
        "backend_logs",
        "frontend_logs",
        "screenshots",
        "metrics",
        "model_trajectories",
        "transcript_artifact",
        "speaker_profile_artifact",
        "consent_record",
        "retention_artifact",
    ]
    evidence = {}
    for name in evidence_names:
        filename = f"{name}.txt"
        (tmp_path / filename).write_text(name, encoding="utf-8")
        evidence[name] = filename
    manifest_data = _base_manifest()
    manifest_data["evidence"] = evidence
    manifest = _write_manifest(tmp_path, manifest_data)

    report = build_report(lane="real_product", manifest_path=manifest)

    assert report["publishable"] is True
    assert report["score"] == pytest.approx(0.77)
    assert report["metrics"]["wer"] == pytest.approx(0.09)
    assert report["metrics"]["p95_end_to_end_latency_ms"] == pytest.approx(1300)
    assert {dataset["id"] for dataset in report["dataset_sources"]} >= {"musan", "libricss", "chime6", "misp_meeting"}
    assert {path["id"] for path in report["capture_paths"]} >= {"zoom_bot", "google_meet_bot_free", "on_device_capture"}
    assert {operation["id"] for operation in report["speaker_operations"]} >= {
        "known_speaker_recognition",
        "voice_profile_deletion",
        "post_deletion_non_recognition",
        "multi_speaker_single_stream_attribution",
    }
    assert all(dataset["version"] for dataset in report["dataset_sources"])
    assert all(dataset["checksum"] for dataset in report["dataset_sources"])
    assert all(dataset["sample_count"] > 0 for dataset in report["dataset_sources"])
    assert all(dataset["duration_seconds"] > 0 for dataset in report["dataset_sources"])
    assert all(dataset["annotation_types"] for dataset in report["dataset_sources"])
    assert all(dataset["target_metrics"] for dataset in report["dataset_sources"])
    assert set(report["evidence_files"]) == set(evidence_names)
    assert all(Path(path).is_absolute() for path in report["evidence_files"].values())
