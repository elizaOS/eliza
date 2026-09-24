"""Tests for the Zoom / zoomGroupStats WebVTT -> meeting-artifact importer.

Deterministic and data-free: drives the parser over a synthetic fixture (no Zoom
account, no committed corpus rows) and asserts speaker turns, millisecond timing,
the diarized-speaker roster, and stable canonical foreign keys.
"""

from __future__ import annotations

from pathlib import Path

from elizaos_meeting_transcription_proof.zoom_vtt import (
    UNIDENTIFIED,
    parse_zoom_vtt,
)

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "zoom_transcript_sample.vtt"


def _load() -> str:
    return FIXTURE.read_text(encoding="utf-8")


def test_parses_every_cue_into_ordered_speaker_turns() -> None:
    parsed = parse_zoom_vtt(_load())
    assert len(parsed.spans) == 6
    # Order preserved; ms offsets correct (00:00:03.800 -> 3800).
    assert parsed.spans[0].speaker_label == "Alice Kim"
    assert parsed.spans[0].start_ms == 0
    assert parsed.spans[0].end_ms == 3500
    assert parsed.spans[1].speaker_label == "Bob Ng"
    assert parsed.spans[1].start_ms == 3800
    assert parsed.spans[1].text.startswith("Sounds good")


def test_handles_webvtt_voice_tag_form() -> None:
    parsed = parse_zoom_vtt(_load())
    # Cue 6 uses the <v Carol Diaz>...</v> voice-tag form.
    carol = parsed.spans[-1]
    assert carol.speaker_label == "Carol Diaz"
    assert "mobile build" in carol.text
    assert carol.start_ms == 16800


def test_diarization_roster_is_first_appearance_order() -> None:
    parsed = parse_zoom_vtt(_load())
    assert parsed.speaker_labels == ["Alice Kim", "Bob Ng", "Carol Diaz"]


def test_unlabeled_cue_maps_to_unidentified_speaker() -> None:
    vtt = "WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\njust some words with no speaker\n"
    parsed = parse_zoom_vtt(vtt)
    assert len(parsed.spans) == 1
    assert parsed.spans[0].speaker_label == UNIDENTIFIED
    assert parsed.spans[0].text == "just some words with no speaker"


def test_emits_canonical_meeting_artifact_segments_with_stable_keys() -> None:
    segments = parse_zoom_vtt(_load()).to_meeting_artifact_segments()
    spans = segments["transcriptSpans"]
    speakers = {s["id"]: s for s in segments["diarizedSpeakers"]}

    # Every span references a real diarized speaker (foreign key integrity).
    assert len(spans) == 6
    for span in spans:
        assert span["speakerId"] in speakers
        assert span["endMs"] >= span["startMs"]
        assert set(span) == {"id", "startMs", "endMs", "text", "speakerId"}

    # Stable, slugged speaker ids; named speakers resolved, none fabricated.
    assert speakers["speaker-alice-kim"]["name"]["displayName"] == "Alice Kim"
    assert speakers["speaker-alice-kim"]["name"]["provenance"] == "platform"
    assert speakers["speaker-alice-kim"]["status"] == "resolved"


def test_end_timestamp_clamped_not_negative_duration() -> None:
    # Malformed cue where end < start must not produce a negative-duration span.
    vtt = "WEBVTT\n\n00:00:05.000 --> 00:00:04.000\nDana: backwards timing\n"
    span = parse_zoom_vtt(vtt).spans[0]
    assert span.start_ms == 5000
    assert span.end_ms == 5000
