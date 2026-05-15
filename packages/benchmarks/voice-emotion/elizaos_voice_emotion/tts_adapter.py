"""TTS adapter for the emotion roundtrip bench.

Supports two backends:
  - **Kokoro 82M** (`kokoro` package, hexgrad/Kokoro-82M on HuggingFace) —
    real neural TTS, no inference-time emotion conditioning. Emotion is
    conveyed via text-side prosody hints (emotionally-loaded words + speed).
  - **MMS-TTS** (`facebook/mms-tts-eng`, transformers) —
    neutral baseline TTS. Used when Kokoro is unavailable.

Both backends output 16 kHz mono float32 PCM that the emotion classifier
can process directly.

Kokoro prosody-prompt workaround:
  The Kokoro ONNX signature `(input_ids, style, speed)` has no emotion
  parameter. Per Wave 3 W3-5 spec + EMOTION_MAP.md §3, emotion is induced
  via emotionally-loaded text and `speed` variation correlated with arousal:
    - excited / angry  → speed ≥ 1.2
    - happy            → speed ≈ 1.1
    - calm / sad       → speed ≤ 0.85
    - nervous          → speed ≈ 0.9
    - whisper          → speed ≈ 0.8 + whisper text cue

  This is a documented limitation. Per-emotion style vectors are an I7
  (kokoro fine-tune) deliverable.
"""

from __future__ import annotations

import importlib
import logging
import typing
from dataclasses import dataclass

import numpy as np

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Emotion-conditioned utterance corpus
# ---------------------------------------------------------------------------

# One utterance per emotion — text chosen for strong affective content.
# Speed multiplier encodes arousal level for Kokoro.
# These are the canonical prosody hints for the roundtrip bench.
EMOTION_UTTERANCES: dict[str, tuple[str, float]] = {
    "happy": (
        "This is absolutely wonderful! I am so happy and grateful today!",
        1.1,
    ),
    "sad": (
        "I feel terribly heartbroken and lost. Everything is gone. I miss them so much.",
        0.78,
    ),
    "angry": (
        "This is completely outrageous! I am furious and I demand answers right now!",
        1.25,
    ),
    "nervous": (
        "I am really not sure about this. I keep worrying something will go wrong.",
        0.92,
    ),
    "calm": (
        "Let us take a slow, quiet breath together. Everything is still and peaceful.",
        0.83,
    ),
    "excited": (
        "Oh wow, this is incredible! Yes! I cannot believe how amazing this is!",
        1.28,
    ),
    "whisper": (
        "Shh, be very quiet. Just a whisper. Soft and gentle, nothing but stillness.",
        0.78,
    ),
}

# Sample rate of the classifier (Wav2Small / SUPERB proxy).
TARGET_SAMPLE_RATE = 16_000
# Sample rate Kokoro outputs (24 kHz).
KOKORO_SAMPLE_RATE = 24_000


@dataclass
class SynthesisResult:
    """Output of one TTS synthesis call."""

    emotion: str
    """Intended emotion label (the input to TTS)."""
    text: str
    """Utterance text (including any prosody hints)."""
    audio_16k: np.ndarray
    """Mono float32 PCM at 16 kHz, normalised to [-1, 1]."""
    backend: str
    """'kokoro' | 'mms-tts'."""
    sample_rate: int = TARGET_SAMPLE_RATE
    duration_s: float = 0.0
    speed: float = 1.0


# ---------------------------------------------------------------------------
# Backend helpers
# ---------------------------------------------------------------------------


def _resample_24k_to_16k(audio_24k: np.ndarray) -> np.ndarray:
    """Downsample from 24 kHz to 16 kHz using scipy.signal.resample_poly."""
    try:
        from scipy.signal import resample_poly  # type: ignore[import-untyped]
    except ImportError:
        # Fallback: simple decimation (loses some quality but good enough for
        # the bench which cares about acoustic features, not audiophile quality).
        ratio = TARGET_SAMPLE_RATE / KOKORO_SAMPLE_RATE  # 2/3
        n_out = int(len(audio_24k) * ratio)
        return np.interp(
            np.linspace(0, len(audio_24k) - 1, n_out),
            np.arange(len(audio_24k)),
            audio_24k,
        ).astype(np.float32)
    # 24 kHz → 16 kHz: up=2, down=3.
    return resample_poly(audio_24k, 2, 3).astype(np.float32)


def _synthesize_kokoro(
    emotion: str,
    text: str,
    speed: float,
    voice: str = "af_bella",
) -> np.ndarray:
    """Synthesize with Kokoro 82M. Returns 16 kHz mono float32 PCM."""
    kokoro = importlib.import_module("kokoro")
    KPipeline = getattr(kokoro, "KPipeline")
    pipeline = KPipeline(lang_code="a")
    chunks: list[np.ndarray] = []
    for _gs, _ps, audio in pipeline(text, voice=voice, speed=speed):
        chunks.append(np.asarray(audio, dtype=np.float32))
    audio_24k = np.concatenate(chunks) if chunks else np.zeros(KOKORO_SAMPLE_RATE, dtype=np.float32)
    return _resample_24k_to_16k(audio_24k)


def _synthesize_mms_tts(text: str) -> np.ndarray:
    """Synthesize with facebook/mms-tts-eng. Returns 16 kHz mono float32 PCM."""
    import torch  # type: ignore[import-untyped]
    from transformers import AutoModelForTextToWaveform, AutoProcessor  # type: ignore[import-untyped]

    processor = AutoProcessor.from_pretrained("facebook/mms-tts-eng")
    model = AutoModelForTextToWaveform.from_pretrained("facebook/mms-tts-eng")
    model.eval()
    inputs = processor(text, return_tensors="pt")
    with torch.no_grad():
        waveform = model(**inputs).waveform[0]
    audio = waveform.cpu().numpy().astype(np.float32)
    # MMS-TTS outputs at 16 kHz natively.
    return audio


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def synthesize_all_emotions(
    *,
    backend: str = "auto",
    voice: str = "af_bella",
    emotions: tuple[str, ...] | None = None,
) -> list[SynthesisResult]:
    """Synthesize one utterance per emotion label.

    Args:
        backend: 'kokoro' | 'mms-tts' | 'auto' (tries kokoro first).
        voice: Kokoro voice id (ignored for mms-tts).
        emotions: Subset of EMOTION_UTTERANCES to synthesize. None = all.

    Returns:
        List of SynthesisResult, one per requested emotion.
    """
    if emotions is None:
        emotions = tuple(EMOTION_UTTERANCES.keys())

    resolved_backend = backend
    if backend == "auto":
        try:
            importlib.import_module("kokoro")
            resolved_backend = "kokoro"
        except ImportError:
            resolved_backend = "mms-tts"
    logger.info("[tts-adapter] using backend=%s", resolved_backend)

    results: list[SynthesisResult] = []
    for emotion in emotions:
        if emotion not in EMOTION_UTTERANCES:
            raise ValueError(f"Unknown emotion label: {emotion!r}")
        text, speed = EMOTION_UTTERANCES[emotion]

        if resolved_backend == "kokoro":
            audio = _synthesize_kokoro(emotion, text, speed, voice=voice)
        else:
            audio = _synthesize_mms_tts(text)

        duration_s = len(audio) / TARGET_SAMPLE_RATE
        results.append(
            SynthesisResult(
                emotion=emotion,
                text=text,
                audio_16k=audio,
                backend=resolved_backend,
                sample_rate=TARGET_SAMPLE_RATE,
                duration_s=duration_s,
                speed=speed if resolved_backend == "kokoro" else 1.0,
            )
        )
        logger.info(
            "[tts-adapter] synthesized emotion=%s len=%d (%.2fs)",
            emotion,
            len(audio),
            duration_s,
        )

    return results


def synthesize_emotion(
    emotion: str,
    *,
    backend: str = "auto",
    voice: str = "af_bella",
) -> SynthesisResult:
    """Synthesize a single emotion utterance."""
    results = synthesize_all_emotions(backend=backend, voice=voice, emotions=(emotion,))
    return results[0]
