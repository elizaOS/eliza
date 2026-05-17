"""VAD → 7-class expressive emotion projection — Python port.

This is the **exact** Python equivalent of
`plugins/plugin-local-inference/src/services/voice/voice-emotion-classifier.ts`'s
`projectVadToExpressiveEmotion` function.

Correctness contract:
  - The coefficient table (`_COEFF`) must match the TS constants byte-for-byte.
  - The abstention threshold (0.35) must match the TS constant.
  - The `EXPRESSIVE_EMOTION_TAGS` tuple order must match the TS and Python
    metrics module.

The roundtrip test (`tests/test_emotion_roundtrip.py`) verifies both:
  1. Known-corner synthetic V-A-D inputs produce the correct discrete label.
  2. Real TTS audio processed through a proxy acoustic extractor produces
     non-zero scores (smoke — the pipeline is live, not mocked).
"""

from __future__ import annotations

import math
from typing import NamedTuple

# Must stay in sync with:
#   TS: plugins/plugin-local-inference/src/services/voice/expressive-tags.ts
#   Py: packages/benchmarks/voice-emotion/elizaos_voice_emotion/metrics.py
EXPRESSIVE_EMOTION_TAGS: tuple[str, ...] = (
    "happy",
    "sad",
    "angry",
    "nervous",
    "calm",
    "excited",
    "whisper",
)

# Minimum score to surface a discrete label (below this → abstain).
# Must match the TS constant (voice-emotion-classifier.ts:198).
ABSTENTION_THRESHOLD: float = 0.35


class VadProjectionResult(NamedTuple):
    """Result of projectVadToExpressiveEmotion — mirrors the TS return shape."""

    emotion: str | None
    """Best discrete label, or None when confidence < ABSTENTION_THRESHOLD."""
    confidence: float
    """Confidence in the best label, [0, 1]."""
    scores: dict[str, float]
    """Per-class soft scores aligned with `EXPRESSIVE_EMOTION_TAGS`."""


def _clamp01(v: float) -> float:
    """Clamp to [0, 1]. Non-finite inputs return 0 (mirrors TS `clamp01`)."""
    if not math.isfinite(v):
        return 0.0
    if v < 0.0:
        return 0.0
    if v > 1.0:
        return 1.0
    return v


def project_vad_to_expressive_emotion(
    valence: float,
    arousal: float,
    dominance: float,
) -> VadProjectionResult:
    """Project a continuous V-A-D triple into the 7-class EXPRESSIVE_EMOTION_TAGS.

    Mirrors `projectVadToExpressiveEmotion` in
    `plugins/plugin-local-inference/src/services/voice/voice-emotion-classifier.ts`
    exactly. Coefficients and logic must stay in sync with that file.

    Sign convention (audeering teacher, mirrored by Wav2Small):
      valence   — high = positive affect (happy, calm), low = negative (sad, angry).
      arousal   — high = energetic (excited, angry), low = subdued (calm, sad).
      dominance — high = assertive (angry), low = submissive (nervous, whisper).

    Args:
        valence: Valence in [0, 1].
        arousal: Arousal in [0, 1].
        dominance: Dominance in [0, 1].

    Returns:
        VadProjectionResult with emotion, confidence, and per-class scores.
    """
    # Non-finite inputs: abstain. Mirrors the explicit early-return in TS.
    if (
        not math.isfinite(valence)
        or not math.isfinite(arousal)
        or not math.isfinite(dominance)
    ):
        zero_scores = {tag: 0.0 for tag in EXPRESSIVE_EMOTION_TAGS}
        return VadProjectionResult(emotion=None, confidence=0.0, scores=zero_scores)

    v = _clamp01(valence)
    a = _clamp01(arousal)
    d = _clamp01(dominance)

    # Center each axis at 0.5; magnitudes in [-0.5, 0.5].
    vC = v - 0.5
    aC = a - 0.5
    dC = d - 0.5

    # Each class scores only from off-center signal.
    # Coefficients must match voice-emotion-classifier.ts exactly.
    scores: dict[str, float] = {
        # happy — high V, mid-high A, low |D| spread
        "happy": _clamp01(vC * 1.4 + max(0.0, aC) * 0.6 - abs(dC) * 0.4),
        # excited — high V, very high A
        "excited": _clamp01(vC * 0.9 + aC * 1.6),
        # calm — high V, low A
        "calm": _clamp01(max(0.0, vC) * 1.4 - aC * 1.2 - abs(dC) * 0.3),
        # sad — low V, low A, low D
        "sad": _clamp01(-vC * 1.4 - aC * 0.8 - dC * 0.4),
        # angry — low V, high A, high D
        "angry": _clamp01(-vC * 1.1 + aC * 1.2 + dC * 1.0),
        # nervous — low-mid V, mid-high A, low D
        "nervous": _clamp01(-vC * 0.7 + aC * 0.9 - dC * 1.2),
        # whisper — very low A and very low D
        "whisper": _clamp01(-aC * 1.4 - dC * 1.4),
    }

    best_emotion: str | None = None
    best_score: float = 0.0
    for tag in EXPRESSIVE_EMOTION_TAGS:
        s = scores[tag]
        if s > best_score:
            best_score = s
            best_emotion = tag

    if best_score < ABSTENTION_THRESHOLD:
        return VadProjectionResult(
            emotion=None,
            confidence=best_score,
            scores=scores,
        )

    return VadProjectionResult(
        emotion=best_emotion,
        confidence=best_score,
        scores=scores,
    )


# ---------------------------------------------------------------------------
# Synthetic V-A-D corner fixtures — one clear "canonical corner" per emotion.
# These are used by the roundtrip test to verify the projection table matches
# the TS implementation without needing the Wav2Small ONNX.
# ---------------------------------------------------------------------------

#: Canonical synthetic V-A-D per emotion.
#: Format: (valence, arousal, dominance, expected_label)
VAD_CORNER_FIXTURES: tuple[tuple[float, float, float, str], ...] = (
    (0.80, 0.60, 0.50, "happy"),    # high V, mid-high A
    (0.85, 0.95, 0.50, "excited"),  # high V, very high A
    (0.75, 0.20, 0.50, "calm"),     # high V, low A
    (0.20, 0.25, 0.30, "sad"),      # low V, low A, low D
    (0.15, 0.80, 0.80, "angry"),    # low V, high A, high D
    (0.30, 0.65, 0.20, "nervous"),  # low V, mid A, low D
    (0.50, 0.10, 0.10, "whisper"),  # very low A + very low D
)
