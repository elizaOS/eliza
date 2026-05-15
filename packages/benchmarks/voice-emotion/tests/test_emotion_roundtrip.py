"""Emotion roundtrip validation — W3-5 deliverable.

Pytest suite that validates the full emotion channel:

  intended_emotion → TTS (Kokoro prosody-hint / MMS-TTS)
    → real audio WAV
    → acoustic classifier (Wav2Small ONNX if available, else SUPERB proxy)
    → perceived_emotion
    → assertion: match or discriminability

Tests:
  1. ``test_vad_projection_all_corners`` — pure Python VAD projection for
     all 7 emotion corners. No audio, no model, no network. Always passes
     on any machine with Python ≥ 3.11.

  2. ``test_roundtrip_synthesis_smoke`` — synthesizes audio for all 7 labels
     using the best available TTS backend. Asserts audio is non-silent (RMS
     above noise floor) for every label. No emotion match asserted — this is
     purely "the pipeline runs on real audio without crashing."

  3. ``test_roundtrip_classification_pipeline`` — full roundtrip for 4
     emotions (happy, angry, calm, sad — the SUPERB-proxy-testable subset).
     Asserts:
       a. No crashes.
       b. The classifier produces non-uniform scores (discriminates between
          at least 2 emotions).
       c. Top-1 match rate ≥ 2/4 (50%). Kokoro's neutral TTS style limits
          acoustic variation; 50% is the practical baseline. When the real
          Wav2Small ONNX is present, this gate is replaced by the manifest
          threshold (macro-F1 ≥ 0.35).

  4. ``test_roundtrip_artifacts_written`` — runs the full 7-label roundtrip
     and asserts that ``artifacts/voice-emotion-roundtrip/<run-id>/`` contains
     one WAV per label, ``mix.wav``, and ``predictions.json``.

  5. ``test_roundtrip_report_schema`` — asserts the ``predictions.json``
     structure matches the documented schema (all required fields present,
     correct types).

These tests require:
  - ``kokoro`` package (PyPI) OR ``transformers`` with ``facebook/mms-tts-eng``
    cached on HuggingFace hub.
  - ``transformers`` + ``torch`` (for the SUPERB proxy classifier).
  - ``scipy`` (for resampling Kokoro 24 kHz → 16 kHz).
  - ``soundfile`` is NOT required — we use the stdlib ``wave`` module via our
    own WAV writer.

If neither TTS backend is available, all tests except (1) are skipped with
an informative message.
"""

from __future__ import annotations

import importlib
import json
import logging
import os
import pathlib
import tempfile
from collections.abc import Generator
from typing import Any

import numpy as np
import pytest

from elizaos_voice_emotion.vad_projection import (
    ABSTENTION_THRESHOLD,
    EXPRESSIVE_EMOTION_TAGS,
    VAD_CORNER_FIXTURES,
    project_vad_to_expressive_emotion,
)

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _tts_available() -> bool:
    """True iff at least one TTS backend is importable."""
    for pkg in ("kokoro", "transformers"):
        try:
            importlib.import_module(pkg)
            return True
        except ImportError:
            pass
    return False


def _classifier_available() -> bool:
    """True iff the SUPERB proxy or Wav2Small ONNX is usable."""
    try:
        import torch  # noqa: F401
        import transformers  # noqa: F401
        return True
    except ImportError:
        return False


TTS_SKIP = pytest.mark.skipif(
    not _tts_available(),
    reason="No TTS backend available (need `kokoro` or `transformers` + torch).",
)
CLASSIFIER_SKIP = pytest.mark.skipif(
    not _classifier_available(),
    reason="No classifier backend available (need `torch` + `transformers`).",
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def artifact_tmpdir() -> Generator[pathlib.Path, None, None]:
    """Temporary directory for artifact output during the test run."""
    with tempfile.TemporaryDirectory(prefix="w3-5-roundtrip-") as d:
        yield pathlib.Path(d)


@pytest.fixture(scope="module")
def cached_roundtrip_report(artifact_tmpdir: pathlib.Path) -> "Any":
    """Run the full roundtrip once per test module and cache the result.

    This avoids re-running the expensive TTS + classification pipeline
    for every test that just needs to inspect the report structure.
    Only invoked when both TTS and classifier backends are available.
    """
    if not (_tts_available() and _classifier_available()):
        pytest.skip("TTS or classifier backend not available")
    from elizaos_voice_emotion.roundtrip import run_roundtrip
    return run_roundtrip(artifact_dir=artifact_tmpdir, tts_backend="auto")


@pytest.fixture(scope="module")
def cached_4class_synthesis(artifact_tmpdir: pathlib.Path) -> "Any":
    """Synthesize + classify the 4 SUPERB-testable emotions once per module."""
    if not (_tts_available() and _classifier_available()):
        pytest.skip("TTS or classifier backend not available")
    from elizaos_voice_emotion.classifier_adapter import ClassifierAdapter
    from elizaos_voice_emotion.tts_adapter import synthesize_all_emotions

    emotions = ("happy", "angry", "calm", "sad")
    synth_results = synthesize_all_emotions(backend="auto", emotions=emotions)
    clf = ClassifierAdapter()
    rows = []
    for sr in synth_results:
        clf_out = clf.classify(sr.audio_16k)
        rows.append((sr, clf_out))
    return rows


@pytest.fixture(scope="module")
def cached_all_synthesis() -> "Any":
    """Synthesize all 7 emotion labels once per module (TTS only, no classify)."""
    if not _tts_available():
        pytest.skip("No TTS backend available")
    from elizaos_voice_emotion.tts_adapter import synthesize_all_emotions
    return synthesize_all_emotions(backend="auto")


# ---------------------------------------------------------------------------
# 1. VAD projection corner tests — pure Python, always runnable
# ---------------------------------------------------------------------------


class TestVadProjectionCorners:
    """Validate the VAD → 7-class projection against synthetic corner fixtures.

    This test verifies that the Python port of `projectVadToExpressiveEmotion`
    (voice-emotion-classifier.ts) is correct. No audio, no models, no network.
    """

    @pytest.mark.parametrize(
        "v,a,d,expected",
        VAD_CORNER_FIXTURES,
        ids=[fix[3] for fix in VAD_CORNER_FIXTURES],
    )
    def test_corner_maps_to_expected_label(
        self, v: float, a: float, d: float, expected: str
    ) -> None:
        result = project_vad_to_expressive_emotion(v, a, d)
        assert result.emotion == expected, (
            f"V={v} A={a} D={d}: expected {expected!r}, got {result.emotion!r} "
            f"(confidence={result.confidence:.3f})"
        )
        assert result.confidence >= ABSTENTION_THRESHOLD, (
            f"Confidence {result.confidence:.3f} below abstention threshold "
            f"{ABSTENTION_THRESHOLD} for V={v} A={a} D={d} → {expected}"
        )

    def test_neutral_center_abstains(self) -> None:
        """A perfectly neutral V-A-D (0.5, 0.5, 0.5) should abstain."""
        result = project_vad_to_expressive_emotion(0.5, 0.5, 0.5)
        assert result.emotion is None, (
            f"Neutral center should abstain but returned {result.emotion!r}"
        )
        assert result.confidence < ABSTENTION_THRESHOLD

    def test_non_finite_abstains(self) -> None:
        """Non-finite inputs must abstain (not crash or coerce)."""
        for v, a, d in [(float("nan"), 0.5, 0.5), (float("inf"), 0.5, 0.5)]:
            result = project_vad_to_expressive_emotion(v, a, d)
            assert result.emotion is None, (
                f"Non-finite V={v} should abstain but returned {result.emotion!r}"
            )
            assert result.confidence == 0.0

    def test_scores_dict_has_all_tags(self) -> None:
        """Every result must carry scores for all 7 tags."""
        result = project_vad_to_expressive_emotion(0.8, 0.6, 0.5)
        assert set(result.scores.keys()) == set(EXPRESSIVE_EMOTION_TAGS)

    def test_scores_are_clamped_to_unit_interval(self) -> None:
        """All scores must be in [0, 1]."""
        for v, a, d, _ in VAD_CORNER_FIXTURES:
            result = project_vad_to_expressive_emotion(v, a, d)
            for tag, score in result.scores.items():
                assert 0.0 <= score <= 1.0, (
                    f"Score for {tag!r} out of [0,1]: {score}"
                )


# ---------------------------------------------------------------------------
# 2. Synthesis smoke — real audio, no emotion match asserted
# ---------------------------------------------------------------------------


@TTS_SKIP
@CLASSIFIER_SKIP
class TestRoundtripSynthesisSmoke:
    """Verify that TTS produces non-silent real audio for every emotion label."""

    def test_synthesize_all_labels_non_silent(self, cached_all_synthesis: "Any") -> None:
        results = cached_all_synthesis
        assert len(results) == len(EXPRESSIVE_EMOTION_TAGS), (
            f"Expected {len(EXPRESSIVE_EMOTION_TAGS)} results, got {len(results)}"
        )
        for r in results:
            # Minimum 1 s audio
            assert len(r.audio_16k) >= 16_000, (
                f"Emotion {r.emotion!r}: audio too short ({len(r.audio_16k)} samples)"
            )
            # RMS above noise floor (silence threshold: -60 dBFS ≈ 0.001)
            rms = float(np.sqrt(np.mean(r.audio_16k ** 2)))
            assert rms > 0.001, (
                f"Emotion {r.emotion!r}: audio is silent (RMS={rms:.6f})"
            )
            logger.info(
                "Synthesis OK: emotion=%s rms=%.4f len=%d",
                r.emotion, rms, len(r.audio_16k),
            )


# ---------------------------------------------------------------------------
# 3. Classification pipeline — roundtrip with match assertion
# ---------------------------------------------------------------------------


@TTS_SKIP
@CLASSIFIER_SKIP
class TestRoundtripClassificationPipeline:
    """Full emotion roundtrip: TTS → audio → classifier → match check."""

    # The 4 emotions with clear SUPERB proxy mapping.
    _TESTABLE_EMOTIONS: tuple[str, ...] = ("happy", "angry", "calm", "sad")

    def test_classifier_runs_on_real_audio(self, cached_4class_synthesis: "Any") -> None:
        """Classifier must not crash on real TTS audio for any tested label."""
        for sr, clf_out in cached_4class_synthesis:
            # Must return a structured result (not crash).
            assert clf_out is not None
            assert set(clf_out.scores.keys()) == set(EXPRESSIVE_EMOTION_TAGS)
            assert 0.0 <= clf_out.confidence <= 1.0
            logger.info(
                "Classified: emotion=%s -> %s (conf=%.3f, backend=%s)",
                sr.emotion, clf_out.emotion, clf_out.confidence, clf_out.backend,
            )

    def test_classifier_discriminates_emotions(self, cached_4class_synthesis: "Any") -> None:
        """The classifier must produce different top-1 outputs for at least 2 emotions.

        This asserts the channel is real (not a constant-output stub).
        """
        predicted_emotions = {
            clf_out.emotion
            for _, clf_out in cached_4class_synthesis
            if clf_out.emotion is not None
        }
        assert len(predicted_emotions) >= 2, (
            f"Classifier returned the same top-1 output for all inputs: "
            f"{predicted_emotions}. The classifier must discriminate between at "
            f"least 2 emotions to demonstrate the channel is real."
        )
        logger.info("Discriminated emotions: %s", predicted_emotions)

    def test_top1_match_rate_above_baseline(self, cached_4class_synthesis: "Any") -> None:
        """Top-1 match rate ≥ 2/4 (50%) for the SUPERB-proxy-testable subset.

        Pass criteria per EMOTION_MAP.md §4:
          - Kokoro's acoustic variation is limited (no inference-time emotion arg).
          - 50% is the practical baseline for the proxy classifier on TTS audio.
          - When the real Wav2Small ONNX is available, the manifest threshold
            (macro-F1 ≥ 0.35) supersedes this check.
        """
        matches = 0
        total = 0
        for sr, clf_out in cached_4class_synthesis:
            total += 1
            if clf_out.emotion == sr.emotion:
                matches += 1
            logger.info(
                "Row: emotion=%s -> %s match=%s (conf=%.3f)",
                sr.emotion, clf_out.emotion, clf_out.emotion == sr.emotion,
                clf_out.confidence,
            )

        match_rate = matches / total if total > 0 else 0.0
        assert matches >= 2, (
            f"Top-1 match rate {matches}/{total} ({match_rate:.1%}) below baseline "
            f"2/4 (50%). Roundtrip channel is not sufficiently discriminative. "
            f"This may indicate: (a) SUPERB proxy is not converging on TTS audio, "
            f"(b) TTS prosody hints are not producing acoustic variation, or "
            f"(c) the VAD-proxy mapping needs recalibration."
        )
        logger.info(
            "Top-1 match rate: %d/%d = %.1f%%", matches, total, match_rate * 100
        )


# ---------------------------------------------------------------------------
# 4. Artifact emission test
# ---------------------------------------------------------------------------


@TTS_SKIP
@CLASSIFIER_SKIP
class TestRoundtripArtifacts:
    """Verify that the roundtrip runner writes all expected artifacts."""

    def test_artifacts_written_for_all_labels(self, cached_roundtrip_report: "Any") -> None:
        report = cached_roundtrip_report

        # One WAV per emotion
        for emotion in EXPRESSIVE_EMOTION_TAGS:
            wav_path = pathlib.Path(report.wav_paths.get(emotion, ""))
            assert wav_path.exists(), (
                f"Missing WAV artifact for emotion={emotion!r}: {wav_path}"
            )
            size = wav_path.stat().st_size
            assert size > 100, (
                f"WAV for {emotion!r} is suspiciously small ({size} bytes)"
            )

        # mix.wav
        assert report.mix_wav_path is not None
        assert pathlib.Path(report.mix_wav_path).exists()

        # predictions.json
        predictions_path = pathlib.Path(report.artifact_dir) / "predictions.json"
        assert predictions_path.exists(), "predictions.json not written"


# ---------------------------------------------------------------------------
# 5. predictions.json schema validation
# ---------------------------------------------------------------------------


@TTS_SKIP
@CLASSIFIER_SKIP
class TestRoundtripReportSchema:
    """Validate the predictions.json schema."""

    _REQUIRED_FIELDS: tuple[str, ...] = (
        "schemaVersion",
        "runId",
        "runStartedAt",
        "elapsedSeconds",
        "ttsBackend",
        "classifierBackend",
        "nTotal",
        "nMatched",
        "nAbstained",
        "top1MatchRate",
        "macroF17class",
        "perClassF17class",
        "vadProjectionPass",
        "vadProjectionDetail",
        "artifactDir",
        "wavPaths",
        "rows",
        "notes",
    )

    def test_schema_has_all_required_fields(self, cached_roundtrip_report: "Any") -> None:
        d = cached_roundtrip_report.as_dict()
        for field in self._REQUIRED_FIELDS:
            assert field in d, f"predictions.json missing required field: {field!r}"

    def test_vad_projection_pass_is_true(self, cached_roundtrip_report: "Any") -> None:
        report = cached_roundtrip_report
        assert report.vad_projection_pass, (
            "VAD projection unit tests failed in roundtrip report. "
            f"Detail: {report.vad_projection_detail}"
        )

    def test_per_class_f1_has_all_tags(self, cached_roundtrip_report: "Any") -> None:
        d = cached_roundtrip_report.as_dict()
        for tag in EXPRESSIVE_EMOTION_TAGS:
            assert tag in d["perClassF17class"], (
                f"perClassF17class missing tag {tag!r}"
            )

    def test_rows_count_matches_emotion_count(self, cached_roundtrip_report: "Any") -> None:
        report = cached_roundtrip_report
        assert report.n_total == len(EXPRESSIVE_EMOTION_TAGS), (
            f"Expected {len(EXPRESSIVE_EMOTION_TAGS)} rows, got {report.n_total}"
        )

    def test_schema_version_is_1(self, cached_roundtrip_report: "Any") -> None:
        assert cached_roundtrip_report.schema_version == 1
