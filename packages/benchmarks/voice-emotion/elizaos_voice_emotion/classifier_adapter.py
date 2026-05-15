"""Emotion classifier adapter for the roundtrip bench.

Wraps the acoustic emotion classifier used by the runtime. Two modes:

  **Wav2Small ONNX (production)**
    The `elizaos/eliza-1` bundle ships a distilled Wav2Small ONNX (72K params,
    ~120 KB int8). When `onnx_path` is provided and exists, the adapter loads
    it via `onnxruntime` and calls our VAD-projection logic exactly as the TS
    runtime does. This is the real production path.

  **SUPERB proxy (development / CI)**
    When Wav2Small ONNX is not available, the adapter loads
    `superb/wav2vec2-base-superb-er` (IEMOCAP 4-class: neu/hap/ang/sad) as a
    proxy acoustic classifier. Its output is mapped to V-A-D space using a
    fixed correspondence table so the VAD projection logic is exercised.

    Proxy V-A-D mapping:
      neu (neutral) → V=0.55, A=0.35, D=0.50  → projects to `calm`
      hap (happy)   → V=0.80, A=0.55, D=0.50  → projects to `happy`
      ang (angry)   → V=0.15, A=0.80, D=0.80  → projects to `angry`
      sad (sad)     → V=0.20, A=0.25, D=0.30  → projects to `sad`

    The proxy classifier gives us real acoustic features from real audio —
    the roundtrip is NOT mocked. Only the final classification model is
    different from what ships in production.

Regardless of mode, the adapter always:
  - Returns `VadProjectionResult` from `elizaos_voice_emotion.vad_projection`.
  - Reports `latency_ms` for the bench latency metric.
  - Follows the same abstention contract (confidence < 0.35 → None).
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from elizaos_voice_emotion.vad_projection import (
    EXPRESSIVE_EMOTION_TAGS,
    VadProjectionResult,
    project_vad_to_expressive_emotion,
)

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# SUPERB proxy — IEMOCAP label → synthetic V-A-D
# ---------------------------------------------------------------------------

# These values are chosen so that project_vad_to_expressive_emotion maps
# them to the intuitive 7-class target. Verified against the corner fixtures
# in vad_projection.py.
_SUPERB_LABEL_TO_VAD: dict[str, tuple[float, float, float]] = {
    "neu": (0.55, 0.35, 0.50),  # → calm
    "hap": (0.80, 0.55, 0.50),  # → happy
    "ang": (0.15, 0.80, 0.80),  # → angry
    "sad": (0.20, 0.25, 0.30),  # → sad
}


@dataclass
class ClassifierOutput:
    """One classification result from the adapter."""

    emotion: str | None
    """Projected 7-class label, or None when confidence < 0.35 (abstained)."""
    confidence: float
    scores: dict[str, float]
    latency_ms: float
    backend: str
    """'wav2small-onnx' | 'superb-proxy'."""
    raw_vad: tuple[float, float, float] | None = None
    """(valence, arousal, dominance) when available."""


@dataclass
class ClassifierAdapter:
    """Acoustic emotion classifier adapter.

    Instantiate once per bench run; the internal session/model is loaded
    lazily on the first call to `classify()`.
    """

    onnx_path: Path | None = None
    """Path to the Wav2Small ONNX. When None, falls back to SUPERB proxy."""

    _session: object | None = field(default=None, init=False, repr=False)
    _hf_model: object | None = field(default=None, init=False, repr=False)
    _hf_feat: object | None = field(default=None, init=False, repr=False)
    _backend: str = field(default="", init=False, repr=False)

    def _load(self) -> None:
        if self._backend:
            return
        if self.onnx_path and self.onnx_path.exists():
            self._load_wav2small()
        else:
            self._load_superb_proxy()

    def _load_wav2small(self) -> None:
        """Load the Wav2Small ONNX via onnxruntime."""
        import onnxruntime as ort  # type: ignore[import-untyped]

        so = ort.SessionOptions()
        so.intra_op_num_threads = 2
        self._session = ort.InferenceSession(
            str(self.onnx_path), sess_options=so
        )
        self._backend = "wav2small-onnx"
        logger.info("[classifier-adapter] loaded Wav2Small ONNX from %s", self.onnx_path)

    def _load_superb_proxy(self) -> None:
        """Load superb/wav2vec2-base-superb-er as proxy classifier."""
        from transformers import (  # type: ignore[import-untyped]
            AutoFeatureExtractor,
            AutoModelForAudioClassification,
        )
        import torch  # type: ignore[import-untyped]

        self._hf_feat = AutoFeatureExtractor.from_pretrained(
            "superb/wav2vec2-base-superb-er"
        )
        self._hf_model = AutoModelForAudioClassification.from_pretrained(
            "superb/wav2vec2-base-superb-er"
        )
        self._hf_model.eval()
        self._backend = "superb-proxy"
        logger.info("[classifier-adapter] loaded SUPERB proxy (Wav2Small ONNX not found)")

    def classify(self, audio_16k: np.ndarray) -> ClassifierOutput:
        """Classify a 16 kHz mono float32 PCM utterance.

        Args:
            audio_16k: Mono float32 PCM at 16 kHz, normalised to [-1, 1].
                       Must be ≥ 1.0 s (16 000 samples). Longer inputs are
                       truncated to the trailing 12 s window.

        Returns:
            ClassifierOutput with the projected emotion + scores.
        """
        if len(audio_16k) < 16_000:
            raise ValueError(
                f"[classifier-adapter] audio too short: {len(audio_16k)} samples < 16 000"
            )
        # Truncate to trailing 12 s window (matches TS WAV2SMALL_MAX_SAMPLES).
        if len(audio_16k) > 192_000:
            audio_16k = audio_16k[-192_000:]

        self._load()
        if self._backend == "wav2small-onnx":
            return self._classify_wav2small(audio_16k)
        return self._classify_superb_proxy(audio_16k)

    def _classify_wav2small(self, audio_16k: np.ndarray) -> ClassifierOutput:
        """Wav2Small ONNX forward pass + VAD projection."""
        import onnxruntime as ort  # type: ignore[import-untyped]

        session = self._session
        assert session is not None
        input_name = session.get_inputs()[0].name  # type: ignore[attr-defined]
        inp = audio_16k.reshape(1, -1).astype(np.float32)
        t0 = time.perf_counter()
        outputs = session.run(None, {input_name: inp})  # type: ignore[attr-defined]
        latency_ms = (time.perf_counter() - t0) * 1000.0

        # Wav2Small output: [1, 3] → (valence, arousal, dominance)
        vad_raw = outputs[0][0]
        v, a, d = float(vad_raw[0]), float(vad_raw[1]), float(vad_raw[2])
        result = project_vad_to_expressive_emotion(v, a, d)
        return ClassifierOutput(
            emotion=result.emotion,
            confidence=result.confidence,
            scores=result.scores,
            latency_ms=latency_ms,
            backend="wav2small-onnx",
            raw_vad=(v, a, d),
        )

    def _classify_superb_proxy(self, audio_16k: np.ndarray) -> ClassifierOutput:
        """SUPERB IEMOCAP proxy → V-A-D proxy mapping → VAD projection."""
        import torch  # type: ignore[import-untyped]

        feat = self._hf_feat
        model = self._hf_model
        assert feat is not None and model is not None

        inputs = feat(audio_16k, sampling_rate=16_000, return_tensors="pt")
        t0 = time.perf_counter()
        with torch.no_grad():
            logits = model(**inputs).logits[0]
        latency_ms = (time.perf_counter() - t0) * 1000.0

        probs = torch.softmax(logits, dim=-1).cpu().numpy()
        raw_labels: list[str] = list(model.config.id2label.values())  # type: ignore[attr-defined]

        # Build probability-weighted V-A-D by mixing the per-label proxy VAD.
        v_mix = 0.0
        a_mix = 0.0
        d_mix = 0.0
        for i, lbl in enumerate(raw_labels):
            p = float(probs[i])
            vad_proxy = _SUPERB_LABEL_TO_VAD.get(lbl)
            if vad_proxy is None:
                continue
            v_mix += p * vad_proxy[0]
            a_mix += p * vad_proxy[1]
            d_mix += p * vad_proxy[2]

        result = project_vad_to_expressive_emotion(v_mix, a_mix, d_mix)

        # Build 7-class score dict from the projection (proxy has no direct
        # 7-class output — the scores come from the VAD projection).
        return ClassifierOutput(
            emotion=result.emotion,
            confidence=result.confidence,
            scores=result.scores,
            latency_ms=latency_ms,
            backend="superb-proxy",
            raw_vad=(v_mix, a_mix, d_mix),
        )

    @property
    def backend(self) -> str:
        """Backend name after lazy loading, or empty string before first classify()."""
        return self._backend
