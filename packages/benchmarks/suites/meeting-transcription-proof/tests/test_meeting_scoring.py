"""Tests for the deterministic meeting scoring + baseline comparison harness.

Model-free: exercises WER / DER / speaker-attribution and the compare.py-style
baseline report over synthetic span sets (no audio, no models).
"""

from __future__ import annotations

from elizaos_meeting_transcription_proof.meeting_scoring import (
    Span,
    compare_to_baseline,
    diarization_error_rate,
    score_transcript,
    speaker_attribution_accuracy,
    transcript_wer,
    word_error_rate,
)
from elizaos_meeting_transcription_proof.zoom_vtt import parse_zoom_vtt


def _ref() -> list[Span]:
    return [
        Span(0, 1000, "hello everyone", "A"),
        Span(1000, 2000, "hi there", "B"),
        Span(2000, 3000, "lets begin", "A"),
    ]


def test_word_error_rate_basic() -> None:
    assert word_error_rate("the quick brown fox", "the quick brown fox") == 0.0
    # one substitution over 4 ref tokens
    assert word_error_rate("the quick brown fox", "the quick red fox") == 0.25
    assert word_error_rate("", "") == 0.0
    assert word_error_rate("", "extra") == 1.0


def test_perfect_hypothesis_scores_zero_error_full_attribution() -> None:
    ref = _ref()
    scores = score_transcript(ref, ref)
    assert scores["transcript_word_error_rate"] == 0.0
    assert scores["diarization_error_rate"] == 0.0
    assert scores["speaker_attribution_accuracy"] == 1.0


def test_speaker_label_permutation_is_mapped_not_penalized() -> None:
    # Same timing/speech, speaker labels renamed (A->X, B->Y): a good diarizer
    # gets full credit under optimal label mapping.
    ref = _ref()
    hyp = [
        Span(0, 1000, "hello everyone", "X"),
        Span(1000, 2000, "hi there", "Y"),
        Span(2000, 3000, "lets begin", "X"),
    ]
    assert speaker_attribution_accuracy(ref, hyp) == 1.0
    assert diarization_error_rate(ref, hyp) == 0.0


def test_speaker_confusion_raises_der() -> None:
    ref = _ref()
    # Middle turn attributed to the wrong (mapped) speaker: 1000ms confusion / 3000ms.
    hyp = [
        Span(0, 1000, "hello everyone", "A"),
        Span(1000, 2000, "hi there", "A"),  # should be B
        Span(2000, 3000, "lets begin", "A"),
    ]
    der = diarization_error_rate(ref, hyp)
    assert abs(der - (1000 / 3000)) < 1e-9
    assert abs(speaker_attribution_accuracy(ref, hyp) - (2000 / 3000)) < 1e-9


def test_missed_speech_counts_toward_der() -> None:
    ref = _ref()
    hyp = [Span(0, 1000, "hello everyone", "A")]  # last 2000ms missed
    assert abs(diarization_error_rate(ref, hyp) - (2000 / 3000)) < 1e-9


def test_transcript_wer_over_spans() -> None:
    ref = _ref()
    hyp = [
        Span(0, 1000, "hello everyone", "A"),
        Span(1000, 2000, "hi friend", "B"),  # 'there'->'friend' : 1 sub / 6 ref tokens
        Span(2000, 3000, "lets begin", "A"),
    ]
    assert abs(transcript_wer(ref, hyp) - (1 / 6)) < 1e-9


def test_compare_to_baseline_candidate_beats_baseline() -> None:
    ref = _ref()
    # Candidate is perfect; baseline confuses the middle speaker.
    candidate = ref
    baseline = [
        Span(0, 1000, "hello everyone", "A"),
        Span(1000, 2000, "hi there", "A"),
        Span(2000, 3000, "lets begin", "A"),
    ]
    report = compare_to_baseline(ref, candidate, baseline)
    assert report["passed"] is True
    der = report["metrics"]["diarization_error_rate"]
    assert der["candidate"] == 0.0
    assert der["baseline"] > 0.0
    assert der["lower_is_better"] is True
    assert der["improvement"] > 0.0


def test_compare_to_baseline_candidate_worse_fails() -> None:
    ref = _ref()
    baseline = ref  # perfect baseline
    candidate = [
        Span(0, 1000, "hello everyone", "A"),
        Span(1000, 2000, "hi there", "A"),  # confusion
        Span(2000, 3000, "lets begin", "A"),
    ]
    report = compare_to_baseline(ref, candidate, baseline)
    assert report["passed"] is False


def test_scores_zoom_vtt_parser_output_directly() -> None:
    # The reference can come straight from the .vtt importer.
    vtt = (
        "WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\nAlice: hello\n\n"
        "2\n00:00:01.000 --> 00:00:02.000\nBob: hi\n"
    )
    ref_spans = parse_zoom_vtt(vtt).spans
    scores = score_transcript(ref_spans, ref_spans)
    assert scores["diarization_error_rate"] == 0.0
    assert scores["speaker_attribution_accuracy"] == 1.0
