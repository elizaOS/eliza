"""H2.b — Production diarization + speaker-encoder stack for the bench.

Provides the canonical Pyannote-segmentation-3.0 + WeSpeaker ResNet34-LM
pipeline used by the runtime, available behind the
`PRODUCTION_SPEAKER_STACK=1` flag. The W3-6 test suite kept the SpeechBrain
ECAPA + energy-VAD path as the default because the production ONNX weights
were not yet pushed to HuggingFace at the time. H4 confirmed both ONNX
files now live on `elizaos/eliza-1`:

  - voice/diarizer/pyannote-segmentation-3.0-int8.onnx (1.5 MB)
  - voice/speaker-encoder/wespeaker-resnet34-lm.onnx (25 MB)

This module mirrors the runtime contract exactly:
  - PyannoteDiarizer eats raw [1, 1, num_samples] float32 PCM @ 16 kHz and
    emits per-frame 7-class logits. We threshold the three speaker-activity
    channels (cols 0..2) to recover binary speaker presence per frame,
    then merge consecutive frames into segment dicts.
  - WespeakerEncoder eats 80-dim Kaldi Fbank features and emits a 256-dim
    embedding. We L2-normalize before returning so cosine and dot-product
    are equivalent.

The high-level `ProductionDiarizer` glues VAD + encoder + agglomerative
clustering into the same `diarize(pcm) -> list[dict]` shape as the W3-6
`SegmentDiarizer`, so the existing test assertions apply verbatim.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

TARGET_SR = 16_000

# Pyannote-3.0 segmentation model emits 7 columns:
#   [0..2] are the three speaker-activity heads (one per simultaneous speaker)
#   [3..6] are pairwise overlap masks (not used here)
# Per-frame hop is 16.7 ms (270 samples @ 16 kHz) per the upstream config.
_PYANNOTE_FRAME_HOP_SAMPLES = 270
_PYANNOTE_RECEPTIVE_SAMPLES = 80_000  # 5-second windows (5 * 16 000)
_PYANNOTE_SPEAKER_HEADS = 3
_PYANNOTE_ACTIVITY_THRESHOLD = 0.5

# WeSpeaker ResNet34-LM ingests 80-dim Kaldi Fbank (25 ms frames, 10 ms hop).
_WESPEAKER_N_MELS = 80
_WESPEAKER_FRAME_LENGTH_MS = 25
_WESPEAKER_FRAME_SHIFT_MS = 10


def production_stack_enabled() -> bool:
    """Read the PRODUCTION_SPEAKER_STACK flag once per call."""
    val = os.environ.get("PRODUCTION_SPEAKER_STACK", "").strip().lower()
    return val in ("1", "true", "yes", "on")


def _hf_download(filename: str) -> Path:
    """Download a file from elizaos/eliza-1 with the optional HF_TOKEN."""
    from huggingface_hub import hf_hub_download  # type: ignore[import-not-found]

    token = os.environ.get("HF_TOKEN") or None
    local = hf_hub_download(
        repo_id="elizaos/eliza-1",
        filename=filename,
        token=token,
    )
    return Path(local)


@dataclass
class PyannoteDiarizer:
    """Pyannote-segmentation-3.0 ONNX wrapper.

    `segment(pcm)` returns `[(start_sample, end_sample, speaker_idx), ...]`,
    where `speaker_idx` is the column of the activity head that fired (one
    of {0, 1, 2}). The activity head provides a stable per-window speaker
    identity that the downstream clustering step refines.
    """

    onnx_path: Path
    _session: Any = field(default=None, init=False, repr=False)

    @classmethod
    def load(cls) -> "PyannoteDiarizer":
        return cls(onnx_path=_hf_download(
            "voice/diarizer/pyannote-segmentation-3.0-int8.onnx",
        ))

    def __post_init__(self) -> None:
        import onnxruntime as ort  # type: ignore[import-untyped]

        so = ort.SessionOptions()
        so.intra_op_num_threads = 2
        self._session = ort.InferenceSession(str(self.onnx_path), sess_options=so)

    def segment(self, pcm: np.ndarray) -> list[tuple[int, int, int]]:
        """Run the segmentation model with 5-second sliding windows.

        pyannote-segmentation-3.0 ONNX emits 7-class powerset logits per
        frame:
          - 0 = silence
          - 1..3 = single speaker (window-local index)
          - 4..6 = two-speaker overlap pairs (1+2, 1+3, 2+3)

        We softmax + argmax across the 7 classes, treat class 0 as silence,
        classes 1..3 as single-speaker activity (the window-local speaker
        index is `class_idx - 1`), and class >=4 as overlap (mapped to the
        higher-numbered participant for embedding extraction).

        Speaker identity from this stage is **window-local** — the global
        speaker labelling is recovered by the downstream
        WeSpeaker-embedding clustering pass.

        Returns `[(start_sample, end_sample, window_local_speaker), ...]`.
        """
        if pcm.dtype != np.float32:
            pcm = pcm.astype(np.float32)
        window = _PYANNOTE_RECEPTIVE_SAMPLES
        step = window // 2
        original_size = pcm.size
        if pcm.size < window:
            pcm = np.concatenate(
                [pcm, np.zeros(window - pcm.size, dtype=np.float32)],
            )

        # Powerset class index → list of single-speaker indices active.
        # Per pyannote-audio Powerset(max_speakers=3, max_overlap=2).
        powerset_to_speakers: dict[int, list[int]] = {
            0: [],          # silence
            1: [0],         # speaker 0
            2: [1],         # speaker 1
            3: [2],         # speaker 2
            4: [0, 1],      # overlap 0+1
            5: [0, 2],      # overlap 0+2
            6: [1, 2],      # overlap 1+2
        }

        all_segments: list[tuple[int, int, int, int]] = []
        # (start_sample, end_sample, window_idx, window_local_speaker)

        for w_idx, start in enumerate(
            range(0, pcm.size - window + 1, step),
        ):
            chunk = pcm[start : start + window]
            inp = chunk.reshape(1, 1, -1).astype(np.float32)
            logits = self._session.run(None, {"input_values": inp})[0][0]
            # Softmax across the 7 powerset classes.
            shifted = logits - logits.max(axis=-1, keepdims=True)
            exps = np.exp(shifted)
            probs = exps / exps.sum(axis=-1, keepdims=True)
            argmax_per_frame = probs.argmax(axis=-1)
            num_frames = argmax_per_frame.shape[0]
            samples_per_frame = window // num_frames

            # Walk the frame-level argmax stream, merging consecutive frames
            # that have the same window-local speaker into a segment.
            active_per_spk: dict[int, int] = {}
            for fi in range(num_frames):
                cls = int(argmax_per_frame[fi])
                speakers = powerset_to_speakers[cls]
                frame_start = start + fi * samples_per_frame
                frame_end = frame_start + samples_per_frame
                for spk in list(active_per_spk.keys()):
                    if spk not in speakers:
                        seg_start = active_per_spk.pop(spk)
                        all_segments.append((seg_start, frame_end, w_idx, spk))
                for spk in speakers:
                    if spk not in active_per_spk:
                        active_per_spk[spk] = frame_start
            window_end = start + num_frames * samples_per_frame
            for spk, seg_start in active_per_spk.items():
                all_segments.append((seg_start, window_end, w_idx, spk))

        if not all_segments:
            return []

        # Encode window+speaker into a flat per-window-local-index. We
        # cannot trust that "speaker 0 in window 0" is the same person as
        # "speaker 0 in window 1" — pyannote-3 randomizes the head order
        # per window. The downstream WeSpeaker clustering step recovers the
        # global identity. We assign a unique pseudo-id per (window, spk)
        # so segments from different windows always go to clustering, and
        # only within-window same-spk segments are merged.
        all_segments.sort()
        merged: list[list[int]] = []
        max_size = original_size
        for s, e, w_idx, spk in all_segments:
            e = min(e, max_size)
            if e <= s:
                continue
            pseudo_id = w_idx * 8 + spk
            if (
                merged
                and merged[-1][2] == pseudo_id
                and s - merged[-1][1] < int(0.2 * TARGET_SR)
            ):
                merged[-1][1] = max(merged[-1][1], e)
            else:
                merged.append([s, e, pseudo_id])

        # Drop anything shorter than 500 ms — embedding stage needs >= 500
        # ms to produce a stable cosine.
        min_samples = TARGET_SR // 2
        return [(s, e, h) for s, e, h in merged if e - s >= min_samples]


@dataclass
class WespeakerEncoder:
    """WeSpeaker ResNet34-LM ONNX wrapper (256-dim, L2-normalized)."""

    onnx_path: Path
    dim: int = 256
    _session: Any = field(default=None, init=False, repr=False)

    @classmethod
    def load(cls) -> "WespeakerEncoder":
        return cls(
            onnx_path=_hf_download("voice/speaker-encoder/wespeaker-resnet34-lm.onnx"),
        )

    def __post_init__(self) -> None:
        import onnxruntime as ort  # type: ignore[import-untyped]

        so = ort.SessionOptions()
        so.intra_op_num_threads = 2
        self._session = ort.InferenceSession(str(self.onnx_path), sess_options=so)

    def _fbank(self, pcm: np.ndarray) -> np.ndarray:
        """Compute 80-dim Kaldi Fbank features at 25 ms / 10 ms."""
        import torch  # type: ignore[import-untyped]
        import torchaudio.compliance.kaldi as kaldi  # type: ignore[import-untyped]

        if pcm.dtype != np.float32:
            pcm = pcm.astype(np.float32)
        wav = torch.from_numpy(pcm).unsqueeze(0)
        feat = kaldi.fbank(
            wav,
            sample_frequency=TARGET_SR,
            num_mel_bins=_WESPEAKER_N_MELS,
            frame_length=_WESPEAKER_FRAME_LENGTH_MS,
            frame_shift=_WESPEAKER_FRAME_SHIFT_MS,
            energy_floor=0.0,
            dither=0.0,
        )
        # WeSpeaker recipe applies CMN over the utterance.
        feat = feat - feat.mean(dim=0, keepdim=True)
        return feat.numpy().astype(np.float32)

    def encode(self, pcm: np.ndarray, sr: int = TARGET_SR) -> np.ndarray:
        if sr != TARGET_SR:
            raise ValueError(f"WespeakerEncoder requires 16 kHz, got {sr}")
        feats = self._fbank(pcm)
        # Model wants [1, T, 80].
        inp = feats[np.newaxis, ...].astype(np.float32)
        emb = self._session.run(None, {"feats": inp})[0][0]  # [256]
        norm = float(np.linalg.norm(emb))
        if norm > 1e-8:
            emb = emb / norm
        return emb.astype(np.float32)


@dataclass
class ProductionDiarizer:
    """Same interface as `SegmentDiarizer` — drop-in for the tests.

    Pipeline:
      1. `PyannoteDiarizer.segment(pcm)` → per-head activity intervals.
      2. `WespeakerEncoder.encode(segment_pcm)` → 256-dim L2-normalized
         embeddings per segment.
      3. Agglomerative clustering (cosine, average linkage) refines the
         per-head IDs into a globally-consistent speaker labelling. We use
         the inter-cluster cosine threshold of 0.46 (matches the W3-6
         calibration on real speech with WeSpeaker).
    """

    diarizer: PyannoteDiarizer
    encoder: WespeakerEncoder

    @classmethod
    def load(cls) -> "ProductionDiarizer":
        return cls(diarizer=PyannoteDiarizer.load(), encoder=WespeakerEncoder.load())

    def diarize(self, pcm: np.ndarray) -> list[dict]:
        from sklearn.cluster import AgglomerativeClustering  # type: ignore[import-not-found]

        segments = self.diarizer.segment(pcm)
        if not segments:
            return []
        embeddings: list[np.ndarray] = []
        valid: list[tuple[int, int, int]] = []
        for s, e, head in segments:
            seg = pcm[s:e]
            if seg.size < TARGET_SR // 2:
                continue
            embeddings.append(self.encoder.encode(seg))
            valid.append((s, e, head))
        if not valid:
            return []
        emb = np.stack(embeddings)
        n = len(valid)
        max_k = min(4, n)
        if n == 1:
            speaker_labels = [0]
        else:
            best_k = 1
            best_labels = [0] * n
            # The WeSpeaker int8 model produces well-separated speakers on
            # natural speech (intra >= 0.7, inter <= 0.45). On pitch-shifted
            # TTS the gap is wider (the SegmentDiarizer doc explains this).
            split_threshold = 0.46
            for k in range(2, max_k + 1):
                try:
                    agg = AgglomerativeClustering(
                        n_clusters=k,
                        metric="cosine",
                        linkage="average",
                    )
                    labels = agg.fit_predict(emb)
                except Exception:  # noqa: BLE001
                    break
                centroids: list[np.ndarray] = []
                for ci in range(k):
                    mask = labels == ci
                    if not mask.any():
                        continue
                    c = emb[mask].mean(axis=0)
                    n_c = float(np.linalg.norm(c))
                    centroids.append(c / n_c if n_c > 1e-8 else c)
                if len(centroids) < 2:
                    break
                min_inter = min(
                    float(np.dot(centroids[i], centroids[j]))
                    for i in range(len(centroids))
                    for j in range(i + 1, len(centroids))
                )
                if min_inter < split_threshold:
                    best_k = k
                    best_labels = labels.tolist()
                else:
                    break
            speaker_labels = best_labels if best_k > 1 else [0] * n

        result: list[dict] = []
        for (s, e, _head), spk_id, vec in zip(valid, speaker_labels, embeddings):
            result.append(
                {
                    "start_ms": int(s / TARGET_SR * 1000),
                    "end_ms": int(e / TARGET_SR * 1000),
                    "speaker_id": int(spk_id),
                    "embedding": vec,
                    "confidence": 0.95,
                },
            )
        return result
