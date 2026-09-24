from __future__ import annotations

from pathlib import Path

import pytest

from elizaos_meeting_corpus_importers import (
    P0_CORPUS_IDS,
    P1_CORPUS_IDS,
    build_cache_manifest,
    load_fixture_references,
    parse_fixture_reference,
    reference_to_rttm,
    registry,
)


FIXTURES = Path(__file__).parent.parent / "fixtures" / "synthetic_p0_fixtures.json"


def test_registry_covers_required_p0_and_p1_corpora():
    specs = registry()

    assert set(P0_CORPUS_IDS) <= set(specs)
    assert set(P1_CORPUS_IDS) <= set(specs)
    assert set(P0_CORPUS_IDS) == {
        "ami",
        "chime6",
        "chime7_dasr",
        "dipco",
        "libricss",
        "voxconverse",
        "dihard",
        "musan",
        "whamr",
        "librimix",
    }
    for corpus_id in P0_CORPUS_IDS:
        spec = specs[corpus_id]
        assert spec.license
        assert spec.citation
        assert spec.required_paths
        assert spec.metrics_supported


def test_missing_local_corpora_fail_honestly(tmp_path: Path):
    manifest = build_cache_manifest(tmp_path)

    assert manifest["schemaVersion"] == "eliza.meeting_corpus_manifest.v1"
    assert len(manifest["entries"]) == len(P0_CORPUS_IDS)
    assert {entry["status"] for entry in manifest["entries"]} == {"missing"}
    assert all(entry["canRun"] is False for entry in manifest["entries"])
    assert all(entry["missingPaths"] for entry in manifest["entries"])


def test_available_cache_manifest_is_deterministic(tmp_path: Path):
    for corpus_id, spec in registry().items():
        if corpus_id not in P0_CORPUS_IDS:
            continue
        for relative in spec.required_paths:
            path = tmp_path / corpus_id / relative
            if "." in Path(relative).name:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("fixture", encoding="utf-8")
            else:
                path.mkdir(parents=True, exist_ok=True)

    first = build_cache_manifest(tmp_path)
    second = build_cache_manifest(tmp_path)

    assert first == second
    assert {entry["status"] for entry in first["entries"]} == {"available"}
    assert all(entry["canRun"] is True for entry in first["entries"])


def test_synthetic_fixture_file_parses_one_reference_per_p0_corpus():
    references = load_fixture_references(FIXTURES)

    assert {reference["corpusId"] for reference in references} == set(P0_CORPUS_IDS)
    for reference in references:
        assert reference["schemaVersion"] == "eliza.meeting_corpus_reference.v1"
        assert reference["license"] == "synthetic-fixture-only"
        assert reference["citation"]
        assert reference["audio"]["uri"].startswith("fixtures/")
        assert reference["speakerTurns"]
        assert reference["transcript"]
        assert reference["rttm"].startswith(f"SPEAKER {reference['recordingId']}")
        assert reference["annotationCoverage"]
        assert reference["metricsSupported"]


def test_rttm_output_uses_seconds_and_speaker_ids():
    reference = {
        "recordingId": "demo",
        "speakerTurns": [
            {"speakerId": "speaker_a", "startMs": 250, "endMs": 1250},
            {"speakerId": "speaker_b", "startMs": 1500, "endMs": 2250},
        ],
    }

    assert reference_to_rttm(reference).splitlines() == [
        "SPEAKER demo 1 0.250 1.000 <NA> <NA> speaker_a <NA> <NA>",
        "SPEAKER demo 1 1.500 0.750 <NA> <NA> speaker_b <NA> <NA>",
    ]


def test_parser_rejects_unknown_corpus_and_missing_license():
    with pytest.raises(ValueError, match="unknown corpusId"):
        parse_fixture_reference(
            {
                "corpusId": "not-real",
                "recordingId": "x",
                "license": "fixture",
                "citation": "fixture",
                "audio": {"uri": "x.wav", "durationMs": 1, "sampleRateHz": 16000, "channels": 1},
                "sourceStreams": [{"id": "s"}],
                "speakerTurns": [{"speakerId": "a", "startMs": 0, "endMs": 1}],
                "transcript": [{"speakerId": "a", "startMs": 0, "endMs": 1}],
            }
        )

    with pytest.raises(ValueError, match="license is required"):
        parse_fixture_reference(
            {
                "corpusId": "ami",
                "recordingId": "x",
                "citation": "fixture",
                "audio": {"uri": "x.wav", "durationMs": 1, "sampleRateHz": 16000, "channels": 1},
                "sourceStreams": [{"id": "s"}],
                "speakerTurns": [{"speakerId": "a", "startMs": 0, "endMs": 1}],
                "transcript": [{"speakerId": "a", "startMs": 0, "endMs": 1}],
            }
        )


def test_parser_rejects_inverted_turn_boundaries():
    with pytest.raises(ValueError, match="endMs must be greater than startMs"):
        parse_fixture_reference(
            {
                "corpusId": "ami",
                "recordingId": "x",
                "license": "fixture",
                "citation": "fixture",
                "audio": {"uri": "x.wav", "durationMs": 1, "sampleRateHz": 16000, "channels": 1},
                "sourceStreams": [{"id": "s"}],
                "speakerTurns": [{"speakerId": "a", "startMs": 5, "endMs": 1}],
                "transcript": [{"speakerId": "a", "startMs": 0, "endMs": 1}],
            }
        )
