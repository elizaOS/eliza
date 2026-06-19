"""Emotion roundtrip orchestrator.

W3-5 deliverable. Runs the closed-loop roundtrip:
  intended_emotion → TTS (Kokoro / MMS-TTS) → audio →
  acoustic classifier (Wav2Small ONNX / SUPERB proxy) →
  perceived_emotion → compare → score

Artifacts land under `artifacts/voice-emotion-roundtrip/<run-id>/`:
  - `<emotion>.wav`     — synthesized audio per label
  - `predictions.json`  — roundtrip results and metrics
  - `mix.wav`           — all utterances concatenated (if requested)

Pass criteria (documented in EMOTION_MAP.md §4):
  - VAD projection unit tests: 100% on 7 synthetic corner inputs.
  - Acoustic roundtrip (real TTS audio): top-1 match rate ≥ 2/4 for the
    4-class SUPERB-testable subset {happy, angry, calm, sad}.
  - Pipeline smoke: all 7 labels synthesized + classified without error.
  - Artifact emission: wav files + predictions.json written.

When the real Wav2Small ONNX is present, the gate tightens to:
  - Macro-F1 ≥ 0.35 (MELD baseline, matches manifest validator threshold).
"""

from __future__ import annotations

import dataclasses
import datetime
import json
import logging
import pathlib
import struct
import time
import uuid
from typing import Any

import numpy as np

from elizaos_voice_emotion.classifier_adapter import ClassifierAdapter, ClassifierOutput
from elizaos_voice_emotion.metrics import (
    EXPRESSIVE_EMOTION_TAGS,
    macro_f1,
    per_class_f1,
)
from elizaos_voice_emotion.tts_adapter import (
    EMOTION_UTTERANCES,
    SynthesisResult,
    synthesize_all_emotions,
)
from elizaos_voice_emotion.vad_projection import (
    VAD_CORNER_FIXTURES,
    VadProjectionResult,
    project_vad_to_expressive_emotion,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# WAV writer
# ---------------------------------------------------------------------------


def _write_wav(path: pathlib.Path, audio: np.ndarray, sample_rate: int = 16_000) -> None:
    """Write mono float32 PCM as 16-bit PCM WAV."""
    path.parent.mkdir(parents=True, exist_ok=True)
    audio_clipped = np.clip(audio, -1.0, 1.0)
    pcm16 = (audio_clipped * 32767).astype(np.int16)
    data_bytes = pcm16.tobytes()
    n_bytes = len(data_bytes)
    with open(path, "wb") as f:
        # RIFF header
        f.write(b"RIFF")
        f.write(struct.pack("<I", 36 + n_bytes))
        f.write(b"WAVE")
        # fmt chunk
        f.write(b"fmt ")
        f.write(struct.pack("<I", 16))        # chunk size
        f.write(struct.pack("<H", 1))         # PCM
        f.write(struct.pack("<H", 1))         # mono
        f.write(struct.pack("<I", sample_rate))
        f.write(struct.pack("<I", sample_rate * 2))
        f.write(struct.pack("<H", 2))         # block align
        f.write(struct.pack("<H", 16))        # bits per sample
        # data chunk
        f.write(b"data")
        f.write(struct.pack("<I", n_bytes))
        f.write(data_bytes)


# ---------------------------------------------------------------------------
# Roundtrip result types
# ---------------------------------------------------------------------------


@dataclasses.dataclass
class RoundtripRow:
    """One row in the roundtrip result table."""

    emotion_in: str
    """Intended emotion (TTS input)."""
    text: str
    """Utterance text."""
    tts_backend: str
    emotion_out: str | None
    """Perceived emotion (classifier output), or None if abstained."""
    confidence: float
    scores: dict[str, float]
    latency_classifier_ms: float
    raw_vad: tuple[float, float, float] | None
    classifier_backend: str
    match: bool
    """True iff emotion_out == emotion_in."""


@dataclasses.dataclass
class RoundtripReport:
    """Full roundtrip bench output."""

    schema_version: int
    run_id: str
    run_started_at: str
    elapsed_seconds: float
    tts_backend: str
    classifier_backend: str
    rows: list[RoundtripRow]
    # Aggregate metrics
    n_total: int
    n_matched: int
    n_abstained: int
    top1_match_rate: float
    macro_f1_7class: float
    per_class_f1_7class: dict[str, float]
    # VAD projection unit-test results
    vad_projection_pass: bool
    vad_projection_detail: list[dict[str, Any]]
    # Artifact paths
    artifact_dir: str
    wav_paths: dict[str, str]
    mix_wav_path: str | None
    notes: list[str]

    def as_dict(self) -> dict[str, Any]:
        return {
            "schemaVersion": self.schema_version,
            "runId": self.run_id,
            "runStartedAt": self.run_started_at,
            "elapsedSeconds": self.elapsed_seconds,
            "ttsBackend": self.tts_backend,
            "classifierBackend": self.classifier_backend,
            "nTotal": self.n_total,
            "nMatched": self.n_matched,
            "nAbstained": self.n_abstained,
            "top1MatchRate": self.top1_match_rate,
            "macroF17class": self.macro_f1_7class,
            "perClassF17class": self.per_class_f1_7class,
            "vadProjectionPass": self.vad_projection_pass,
            "vadProjectionDetail": self.vad_projection_detail,
            "artifactDir": self.artifact_dir,
            "wavPaths": self.wav_paths,
            "mixWavPath": self.mix_wav_path,
            "notes": self.notes,
            "rows": [
                {
                    "emotionIn": r.emotion_in,
                    "text": r.text,
                    "ttsBackend": r.tts_backend,
                    "emotionOut": r.emotion_out,
                    "confidence": r.confidence,
                    "scores": r.scores,
                    "latencyClassifierMs": r.latency_classifier_ms,
                    "rawVad": list(r.raw_vad) if r.raw_vad else None,
                    "classifierBackend": r.classifier_backend,
                    "match": r.match,
                }
                for r in self.rows
            ],
        }


# ---------------------------------------------------------------------------
# VAD projection unit test
# ---------------------------------------------------------------------------


def _run_vad_projection_unit_tests() -> tuple[bool, list[dict[str, Any]]]:
    """Run the 7 synthetic corner fixtures and return pass/fail + detail."""
    results: list[dict[str, Any]] = []
    all_pass = True
    for v, a, d, expected in VAD_CORNER_FIXTURES:
        result = project_vad_to_expressive_emotion(v, a, d)
        ok = result.emotion == expected
        if not ok:
            all_pass = False
        results.append(
            {
                "v": v,
                "a": a,
                "d": d,
                "expected": expected,
                "got": result.emotion,
                "confidence": result.confidence,
                "pass": ok,
            }
        )
    return all_pass, results


# ---------------------------------------------------------------------------
# Main roundtrip runner
# ---------------------------------------------------------------------------


def run_roundtrip(
    *,
    artifact_dir: pathlib.Path | str | None = None,
    tts_backend: str = "auto",
    onnx_path: pathlib.Path | None = None,
    tts_voice: str = "af_bella",
    emotions: tuple[str, ...] | None = None,
    emit_mix_wav: bool = True,
) -> RoundtripReport:
    """Run the full emotion roundtrip and return a report.

    Args:
        artifact_dir: Directory for WAV + JSON artifacts. Defaults to
                      ``artifacts/voice-emotion-roundtrip/<run-id>/`` relative
                      to the repo root.
        tts_backend: 'auto' | 'kokoro' | 'mms-tts'.
        onnx_path: Path to the Wav2Small ONNX. When None, uses SUPERB proxy.
        tts_voice: Kokoro voice id.
        emotions: Subset of emotion labels to test. None = all 7.
        emit_mix_wav: Concatenate all utterances into mix.wav.

    Returns:
        RoundtripReport with metrics, rows, and artifact paths.
    """
    run_id = datetime.datetime.now(tz=datetime.timezone.utc).strftime(
        "%Y%m%d-%H%M%S"
    ) + "-" + uuid.uuid4().hex[:6]
    run_started_at = datetime.datetime.now(tz=datetime.timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )
    t_start = time.perf_counter()
    notes: list[str] = []

    # Resolve artifact directory
    if artifact_dir is None:
        repo_root = pathlib.Path(__file__).resolve().parents[4]
        artifact_dir = repo_root / "artifacts" / "voice-emotion-roundtrip" / run_id
    artifact_dir = pathlib.Path(artifact_dir)
    artifact_dir.mkdir(parents=True, exist_ok=True)
    logger.info("[roundtrip] artifact_dir=%s", artifact_dir)

    # --- Step 1: VAD projection unit tests ---
    vad_pass, vad_detail = _run_vad_projection_unit_tests()
    if not vad_pass:
        failed = [d["expected"] for d in vad_detail if not d["pass"]]
        notes.append(f"VAD projection unit test FAILED for: {failed}")
        logger.error("[roundtrip] VAD projection unit tests FAILED: %s", failed)
    else:
        logger.info("[roundtrip] VAD projection unit tests: all 7 pass")

    # --- Step 2: TTS synthesis ---
    if emotions is None:
        emotions = tuple(EMOTION_UTTERANCES.keys())
    logger.info("[roundtrip] synthesizing %d emotions via %s", len(emotions), tts_backend)
    synth_results: list[SynthesisResult] = synthesize_all_emotions(
        backend=tts_backend,
        voice=tts_voice,
        emotions=emotions,
    )

    # --- Step 3: Save WAVs ---
    wav_paths: dict[str, str] = {}
    for sr in synth_results:
        wav_path = artifact_dir / f"{sr.emotion}.wav"
        _write_wav(wav_path, sr.audio_16k, sample_rate=16_000)
        wav_paths[sr.emotion] = str(wav_path)
        logger.info(
            "[roundtrip] wrote %s (%d samples = %.2fs)",
            wav_path,
            len(sr.audio_16k),
            sr.duration_s,
        )

    # --- Step 4: Classify ---
    classifier = ClassifierAdapter(onnx_path=onnx_path)
    rows: list[RoundtripRow] = []
    for sr in synth_results:
        clf_out: ClassifierOutput = classifier.classify(sr.audio_16k)
        match = clf_out.emotion == sr.emotion
        rows.append(
            RoundtripRow(
                emotion_in=sr.emotion,
                text=sr.text,
                tts_backend=sr.backend,
                emotion_out=clf_out.emotion,
                confidence=clf_out.confidence,
                scores=clf_out.scores,
                latency_classifier_ms=clf_out.latency_ms,
                raw_vad=clf_out.raw_vad,
                classifier_backend=clf_out.backend,
                match=match,
            )
        )
        status = "✓" if match else "✗"
        logger.info(
            "[roundtrip] %s emotion=%s -> %s (conf=%.3f, backend=%s)",
            status,
            sr.emotion,
            clf_out.emotion,
            clf_out.confidence,
            clf_out.backend,
        )

    # --- Step 5: Metrics ---
    n_abstained = sum(1 for r in rows if r.emotion_out is None)
    matched_rows = [r for r in rows if r.emotion_out is not None]
    n_matched = sum(1 for r in matched_rows if r.match)
    n_total = len(rows)
    top1_rate = n_matched / n_total if n_total > 0 else 0.0

    y_true = [r.emotion_in for r in matched_rows]
    y_pred = [r.emotion_out for r in matched_rows if r.emotion_out is not None]
    f1_macro = macro_f1(y_true, y_pred, EXPRESSIVE_EMOTION_TAGS)
    f1_per_class = per_class_f1(y_true, y_pred, EXPRESSIVE_EMOTION_TAGS)

    logger.info(
        "[roundtrip] top-1 match=%d/%d (%.1f%%), macro-F1=%.3f",
        n_matched, n_total, top1_rate * 100, f1_macro,
    )

    # --- Step 6: Mix WAV ---
    mix_wav_path: str | None = None
    if emit_mix_wav and synth_results:
        all_audio = np.concatenate([sr.audio_16k for sr in synth_results])
        mix_path = artifact_dir / "mix.wav"
        _write_wav(mix_path, all_audio, sample_rate=16_000)
        mix_wav_path = str(mix_path)
        logger.info("[roundtrip] wrote mix.wav (%d samples)", len(all_audio))

    elapsed_s = time.perf_counter() - t_start

    report = RoundtripReport(
        schema_version=1,
        run_id=run_id,
        run_started_at=run_started_at,
        elapsed_seconds=round(elapsed_s, 3),
        tts_backend=synth_results[0].backend if synth_results else tts_backend,
        classifier_backend=classifier.backend,
        rows=rows,
        n_total=n_total,
        n_matched=n_matched,
        n_abstained=n_abstained,
        top1_match_rate=round(top1_rate, 6),
        macro_f1_7class=f1_macro,
        per_class_f1_7class=f1_per_class,
        vad_projection_pass=vad_pass,
        vad_projection_detail=vad_detail,
        artifact_dir=str(artifact_dir),
        wav_paths=wav_paths,
        mix_wav_path=mix_wav_path,
        notes=notes,
    )

    # --- Step 7: Write predictions.json ---
    predictions_path = artifact_dir / "predictions.json"
    predictions_path.write_text(
        json.dumps(report.as_dict(), indent=2, sort_keys=True) + "\n"
    )
    logger.info("[roundtrip] wrote %s", predictions_path)

    return report
