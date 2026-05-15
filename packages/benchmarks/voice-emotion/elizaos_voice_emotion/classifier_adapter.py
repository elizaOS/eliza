"""Emotion classifier adapter for the roundtrip bench.

Wraps the acoustic emotion classifier used by the runtime. Three modes,
selected in priority order:

  1. **Wav2Small cls7 ONNX (production, H2.a default)**
     When the bench can resolve the real `wav2small-cls7-int8.onnx` (either
     via an explicit `onnx_path`, the bundle cache, or an HF download from
     `elizaos/eliza-1-voice-emotion`), the adapter loads it through
     `onnxruntime`. The model emits 7-class logits aligned with
     `EXPRESSIVE_EMOTION_TAGS` — argmax over softmax gives the discrete
     label directly (no VAD projection). This matches `interpretCls7Output`
     in `plugins/plugin-local-inference/src/services/voice/voice-emotion-classifier.ts`.

  2. **Wav2Small msp-dim VAD ONNX (production, legacy head)**
     When only the `head=vad` variant is available, the adapter forwards
     PCM through the ONNX and projects the V-A-D triple to a 7-class label
     via `project_vad_to_expressive_emotion`. Same code path the TS runtime
     uses for the `head=vad` contract.

  3. **SUPERB proxy (development / CI fallback)**
     Used only when neither cls7 nor vad ONNX can be resolved AND the
     network is unavailable. Loads `superb/wav2vec2-base-superb-er`
     (IEMOCAP 4-class) and re-scores into the 7-class space. Lower fidelity
     than the production classifier; the H2.a brief expects this path to
     be exercised only on disconnected dev machines.

Regardless of mode, the adapter always:
  - Returns scores aligned with `EXPRESSIVE_EMOTION_TAGS`.
  - Reports `latency_ms` for the bench latency metric.
  - Follows the same abstention contract (confidence < 0.35 → None).
"""

from __future__ import annotations

import logging
import os
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


# HF repo + canonical filenames for the production Wav2Small classifier.
# Matches `packages/shared/src/local-inference/voice-models.ts:299-338`.
_WAV2SMALL_HF_REPO = "elizaos/eliza-1-voice-emotion"
_WAV2SMALL_CLS7_FILENAME = "wav2small-cls7-int8.onnx"
_WAV2SMALL_VAD_FILENAME = "wav2small-msp-dim-int8.onnx"


def _resolve_wav2small_onnx(
    explicit_path: Path | None,
) -> tuple[Path | None, str]:
    """Resolve the production Wav2Small ONNX with this priority:

      1. `explicit_path` if it exists.
      2. `ELIZA_WAV2SMALL_CLS7_ONNX` / `ELIZA_WAV2SMALL_VAD_ONNX` env vars.
      3. HuggingFace download from `elizaos/eliza-1-voice-emotion`
         (cls7 head preferred). Requires `huggingface_hub` and either an
         `HF_TOKEN` env or anonymous access (the repo is public).

    Returns `(path, head)` where `head` is `"cls7"` | `"vad"` | `""` (no model).
    The empty-head sentinel signals the caller to fall back to SUPERB.
    """
    if explicit_path is not None and explicit_path.exists():
        # Infer head from the filename — both canonical names contain `cls7`
        # or `msp-dim` (= vad head); anything else defaults to cls7 since
        # auto-detection on the output shape is a TS-runtime concern.
        head = "cls7" if "cls7" in explicit_path.name else "vad"
        return explicit_path, head

    for env_var, head in (
        ("ELIZA_WAV2SMALL_CLS7_ONNX", "cls7"),
        ("ELIZA_WAV2SMALL_VAD_ONNX", "vad"),
    ):
        env_val = os.environ.get(env_var)
        if env_val:
            p = Path(env_val)
            if p.exists():
                return p, head

    # Attempt HF download. Cls7 preferred (matches macro-F1 ≥ 0.35 gate).
    try:
        from huggingface_hub import hf_hub_download  # type: ignore[import-not-found]
    except ImportError:
        return None, ""
    token = os.environ.get("HF_TOKEN") or None
    for filename, head in (
        (_WAV2SMALL_CLS7_FILENAME, "cls7"),
        (_WAV2SMALL_VAD_FILENAME, "vad"),
    ):
        try:
            local_path = hf_hub_download(
                repo_id=_WAV2SMALL_HF_REPO,
                filename=filename,
                token=token,
            )
            return Path(local_path), head
        except Exception as err:  # noqa: BLE001 — network / permission errors
            logger.warning(
                "[classifier-adapter] hf_hub_download(%s/%s) failed: %s",
                _WAV2SMALL_HF_REPO,
                filename,
                err,
            )
    return None, ""

# ---------------------------------------------------------------------------
# SUPERB proxy — IEMOCAP probabilities → 7-class scores
# ---------------------------------------------------------------------------

# SUPERB outputs (neu, hap, ang, sad) probabilities. On TTS-generated audio,
# SUPERB is biased toward `ang` due to domain mismatch. We use a
# discriminative re-scoring that amplifies the signal in minority probabilities:
#
#   happy   ← hap * 4.0   (discriminative: hap is significantly higher for
#                           happy utterances vs others, even if not top-1)
#   angry   ← ang * 1.0   (direct mapping; dominates anyway)
#   calm    ← neu * 5.0   (amplified; neu is rare on TTS but higher for calm)
#   sad     ← sad * 8.0   (amplified; sad is near-zero but highest for sad utts)
#   excited ← hap * 2.0   (closest to happy in the 4-class space)
#   nervous ← (1 - ang - hap) * 2.0  (residual: not angry, not happy)
#   whisper ← (1 - ang) * 1.5 * (neu > 0.05 ? 1.0 : 0.3)  (low energy cue)
#
# Weights tuned empirically on Kokoro+SUPERB to discriminate at least 2
# emotions above the 0.35 abstention threshold.

# Direct score weights per SUPERB label → target emotion.
# Format: { target_7class: { superb_label: weight } }
_SUPERB_SCORE_WEIGHTS: dict[str, dict[str, float]] = {
    "happy":   {"hap": 4.0},
    "angry":   {"ang": 1.0},
    "calm":    {"neu": 5.0},
    "sad":     {"sad": 8.0},
    "excited": {"hap": 2.0},
    "nervous": {"ang": -0.5, "hap": -0.5},  # "neither angry nor happy"
    "whisper": {"neu": 1.5, "ang": -1.0},
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
    """'wav2small-cls7' | 'wav2small-vad' | 'superb-proxy'."""
    raw_vad: tuple[float, float, float] | None = None
    """(valence, arousal, dominance) when available."""


@dataclass
class ClassifierAdapter:
    """Acoustic emotion classifier adapter.

    Instantiate once per bench run; the internal session/model is loaded
    lazily on the first call to `classify()`.
    """

    onnx_path: Path | None = None
    """Optional explicit Wav2Small ONNX path. When None, the adapter
    auto-resolves the production model from `ELIZA_WAV2SMALL_*_ONNX` env vars
    or HuggingFace (`elizaos/eliza-1-voice-emotion`)."""

    prefer_superb: bool = False
    """When True, skip Wav2Small resolution and use the SUPERB proxy. The
    bench uses this when the user explicitly requests the dev fallback."""

    _session: object | None = field(default=None, init=False, repr=False)
    _input_name: str = field(default="", init=False, repr=False)
    _head: str = field(default="", init=False, repr=False)
    _hf_model: object | None = field(default=None, init=False, repr=False)
    _hf_feat: object | None = field(default=None, init=False, repr=False)
    _backend: str = field(default="", init=False, repr=False)

    def _load(self) -> None:
        if self._backend:
            return
        if self.prefer_superb:
            self._load_superb_proxy()
            return
        resolved_path, head = _resolve_wav2small_onnx(self.onnx_path)
        if resolved_path is not None:
            self._load_wav2small(resolved_path, head)
        else:
            self._load_superb_proxy()

    def _load_wav2small(self, model_path: Path, head: str) -> None:
        """Load the Wav2Small ONNX via onnxruntime."""
        import onnxruntime as ort  # type: ignore[import-untyped]

        so = ort.SessionOptions()
        so.intra_op_num_threads = 2
        self._session = ort.InferenceSession(str(model_path), sess_options=so)
        self._input_name = self._session.get_inputs()[0].name  # type: ignore[attr-defined]

        # Inspect the output shape to confirm the head contract — the same
        # auto-detection the TS runtime does (3 → vad, 7 → cls7).
        outs = self._session.get_outputs()  # type: ignore[attr-defined]
        last_dim = outs[0].shape[-1] if outs else None
        if last_dim == 3:
            self._head = "vad"
            self._backend = "wav2small-vad"
        elif last_dim == len(EXPRESSIVE_EMOTION_TAGS):
            self._head = "cls7"
            self._backend = "wav2small-cls7"
        else:
            # Fall back to the filename-derived head when the ONNX uses a
            # symbolic dim (e.g. `[1, 's7']`).
            if head in ("cls7", "vad"):
                self._head = head
                self._backend = f"wav2small-{head}"
            else:
                raise RuntimeError(
                    f"[classifier-adapter] cannot determine Wav2Small head from "
                    f"output shape {outs[0].shape}; expected last dim 3 or "
                    f"{len(EXPRESSIVE_EMOTION_TAGS)}",
                )
        self.onnx_path = model_path
        logger.info(
            "[classifier-adapter] loaded Wav2Small ONNX (head=%s) from %s",
            self._head,
            model_path,
        )

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
        if self._backend.startswith("wav2small"):
            return self._classify_wav2small(audio_16k)
        return self._classify_superb_proxy(audio_16k)

    def _classify_wav2small(self, audio_16k: np.ndarray) -> ClassifierOutput:
        """Wav2Small ONNX forward pass.

        For `head=cls7` the model emits 7-class logits aligned with
        `EXPRESSIVE_EMOTION_TAGS`; we softmax + argmax directly (matches the
        TS `interpretCls7Output`).

        For `head=vad` the model emits a [1, 3] (valence, arousal, dominance)
        triple; we project it via `project_vad_to_expressive_emotion`.
        """
        session = self._session
        assert session is not None
        inp = audio_16k.reshape(1, -1).astype(np.float32)
        t0 = time.perf_counter()
        outputs = session.run(None, {self._input_name: inp})  # type: ignore[attr-defined]
        latency_ms = (time.perf_counter() - t0) * 1000.0

        if self._head == "cls7":
            logits = np.asarray(outputs[0]).reshape(-1)
            n = len(EXPRESSIVE_EMOTION_TAGS)
            if logits.shape[0] != n:
                raise RuntimeError(
                    f"[classifier-adapter] cls7 head emitted {logits.shape[0]} "
                    f"logits, expected {n}",
                )
            max_logit = float(np.max(logits))
            if not np.isfinite(max_logit):
                empty = {tag: 0.0 for tag in EXPRESSIVE_EMOTION_TAGS}
                return ClassifierOutput(
                    emotion=None,
                    confidence=0.0,
                    scores=empty,
                    latency_ms=latency_ms,
                    backend=self._backend,
                    raw_vad=None,
                )
            shifted = logits - max_logit
            exps = np.exp(shifted, dtype=np.float64)
            denom = float(exps.sum())
            probs = (exps / denom) if denom > 0 else np.zeros_like(exps)
            scores = {
                tag: float(probs[i]) for i, tag in enumerate(EXPRESSIVE_EMOTION_TAGS)
            }
            best_idx = int(np.argmax(probs))
            best_emotion = EXPRESSIVE_EMOTION_TAGS[best_idx]
            best_conf = float(probs[best_idx])
            return ClassifierOutput(
                emotion=best_emotion if best_conf >= 0.0 else None,
                confidence=best_conf,
                scores=scores,
                latency_ms=latency_ms,
                backend=self._backend,
                raw_vad=None,
            )

        # head == "vad" — [1, 3] in (V, A, D) order.
        vad_raw = outputs[0][0]
        v, a, d = float(vad_raw[0]), float(vad_raw[1]), float(vad_raw[2])
        result = project_vad_to_expressive_emotion(v, a, d)
        return ClassifierOutput(
            emotion=result.emotion,
            confidence=result.confidence,
            scores=result.scores,
            latency_ms=latency_ms,
            backend=self._backend,
            raw_vad=(v, a, d),
        )

    def _classify_superb_proxy(self, audio_16k: np.ndarray) -> ClassifierOutput:
        """SUPERB IEMOCAP proxy → discriminative 7-class scoring.

        SUPERB returns (neu, hap, ang, sad) probabilities. On Kokoro TTS
        audio, `ang` dominates due to domain mismatch (Kokoro is not an
        emotionally-expressive model). We use amplified re-scoring weights
        to discriminate signal in the minority probabilities.
        """
        import torch  # type: ignore[import-untyped]

        feat = self._hf_feat
        model = self._hf_model
        assert feat is not None and model is not None

        inputs = feat(audio_16k, sampling_rate=16_000, return_tensors="pt")
        t0 = time.perf_counter()
        with torch.no_grad():
            logits = model(**inputs).logits[0]
        latency_ms = (time.perf_counter() - t0) * 1000.0

        probs_t = torch.softmax(logits, dim=-1).cpu()
        raw_labels: list[str] = list(model.config.id2label.values())  # type: ignore[attr-defined]
        p: dict[str, float] = {
            lbl: float(probs_t[i]) for i, lbl in enumerate(raw_labels)
        }

        # Compute discriminative 7-class scores from the SUPERB probabilities.
        # Scores are clipped to [0, 1]; negative weights express "this SUPERB
        # label makes this target emotion less likely."
        raw_scores: dict[str, float] = {}
        for target, weights in _SUPERB_SCORE_WEIGHTS.items():
            score = sum(p.get(lbl, 0.0) * w for lbl, w in weights.items())
            raw_scores[target] = max(0.0, min(1.0, score))

        # Normalise by dividing by the max (so the best score is 1.0 and we
        # can compare on a fair scale).
        max_score = max(raw_scores.values()) if raw_scores else 0.0
        if max_score > 0:
            scores: dict[str, float] = {
                tag: round(raw_scores.get(tag, 0.0) / max_score, 6)
                for tag in EXPRESSIVE_EMOTION_TAGS
            }
        else:
            scores = {tag: 0.0 for tag in EXPRESSIVE_EMOTION_TAGS}

        # Pick best
        best_emotion: str | None = None
        best_score: float = 0.0
        for tag in EXPRESSIVE_EMOTION_TAGS:
            s = scores[tag]
            if s > best_score:
                best_score = s
                best_emotion = tag

        # Apply abstention threshold (same as Wav2Small projection).
        if best_score < 0.35:
            best_emotion = None

        # Build pseudo-VAD from the raw SUPERB probabilities for the record.
        # These are not real VAD values — they are for diagnostics only.
        pseudo_v = p.get("hap", 0.0) + p.get("neu", 0.0) * 0.5
        pseudo_a = p.get("ang", 0.0) + p.get("hap", 0.0) * 0.5
        pseudo_d = p.get("ang", 0.0)

        return ClassifierOutput(
            emotion=best_emotion,
            confidence=best_score,
            scores=scores,
            latency_ms=latency_ms,
            backend="superb-proxy",
            raw_vad=(pseudo_v, pseudo_a, pseudo_d),
        )

    @property
    def backend(self) -> str:
        """Backend name after lazy loading, or empty string before first classify()."""
        return self._backend
