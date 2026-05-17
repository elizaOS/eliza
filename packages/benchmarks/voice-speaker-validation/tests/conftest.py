"""
Shared pytest fixtures for voice-speaker-validation benchmark.

Provides:
  - loaded SpeechBrain ECAPA-TDNN speaker encoder (session-scoped)
  - loaded pyannote-style VAD-based diarizer (using speechbrain SpeakerDiarization or
    segment-based chunker as fallback since pyannote needs HF auth token)
  - fixture audio loader
  - in-memory VoiceProfileStore equivalent
"""

from __future__ import annotations

import json
import os
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import pytest
import soundfile as sf
import torch

FIXTURES_DIR = Path(__file__).parent.parent / "fixtures"
ARTIFACTS_DIR = Path(__file__).parent.parent / "artifacts"
TARGET_SR = 16_000


# ---------------------------------------------------------------------------
# Audio helpers
# ---------------------------------------------------------------------------

def load_wav_mono16k(path: Path) -> np.ndarray:
    """Load a WAV file and return float32 mono PCM at 16 kHz."""
    import librosa
    audio, sr = sf.read(str(path))
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if sr != TARGET_SR:
        audio = librosa.resample(audio, orig_sr=sr, target_sr=TARGET_SR)
    return audio.astype(np.float32)


def read_manifest() -> dict:
    manifest_path = FIXTURES_DIR / "manifest.json"
    with open(manifest_path) as f:
        return json.load(f)


# ---------------------------------------------------------------------------
# Speaker encoder via SpeechBrain ECAPA-TDNN
# ---------------------------------------------------------------------------

@dataclass
class SpeakerEncoder:
    """Thin wrapper around SpeechBrain ECAPA-TDNN for 256-dim speaker embeddings."""

    _classifier: Any = field(default=None, repr=False)
    dim: int = 192  # ECAPA-TDNN default output dim

    def encode(self, pcm: np.ndarray, sr: int = TARGET_SR) -> np.ndarray:
        """Encode a PCM array to a L2-normalised embedding vector."""
        import torch
        import torchaudio

        # ECAPA-TDNN expects 16 kHz
        waveform = torch.from_numpy(pcm).unsqueeze(0)  # [1, T]
        with torch.no_grad():
            embeddings = self._classifier.encode_batch(waveform)
            emb = embeddings.squeeze().cpu().numpy()
        # L2-normalise
        norm = np.linalg.norm(emb)
        if norm > 1e-8:
            emb = emb / norm
        return emb.astype(np.float32)

    @classmethod
    def load(cls) -> "SpeakerEncoder":
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            from speechbrain.inference import EncoderClassifier
            classifier = EncoderClassifier.from_hparams(
                source="speechbrain/spkrec-ecapa-voxceleb",
                savedir="/tmp/spkrec-ecapa",
                run_opts={"device": "cpu"},
            )
        obj = cls(_classifier=classifier)
        # Determine actual embedding dim from a test run
        test_audio = np.random.randn(TARGET_SR).astype(np.float32)
        emb = obj.encode(test_audio)
        obj.dim = len(emb)
        return obj


# ---------------------------------------------------------------------------
# Segment-based diarizer using energy VAD + speaker clustering
# ---------------------------------------------------------------------------

@dataclass
class SegmentDiarizer:
    """
    Simple energy-based segmenter + speaker clustering diarizer.

    Uses:
      1. Energy-based VAD to find speech segments (avoids pyannote HF-auth need).
      2. Speaker encoder embeddings per segment.
      3. Agglomerative clustering to assign speaker IDs.

    This is NOT a replacement for pyannote in production. It is used here
    as a self-contained test harness that exercises the same pipeline
    contract (segment boundaries + speaker cluster IDs) without needing
    a Hugging Face auth token.
    """

    encoder: SpeakerEncoder
    frame_ms: int = 30       # VAD frame size in ms
    hop_ms: int = 10         # VAD hop in ms
    energy_threshold_db: float = -35.0
    min_speech_ms: int = 500   # minimum speech segment length
    merge_gap_ms: int = 300    # merge gaps between speech segments

    def _energy_vad(self, pcm: np.ndarray) -> list[tuple[int, int]]:
        """Return list of (start_sample, end_sample) speech regions."""
        sr = TARGET_SR
        frame_samples = int(self.frame_ms * sr / 1000)
        hop_samples = int(self.hop_ms * sr / 1000)

        # Pad to full frames
        n_frames = max(1, (len(pcm) - frame_samples) // hop_samples + 1)
        is_speech = []
        for i in range(n_frames):
            start = i * hop_samples
            frame = pcm[start:start + frame_samples]
            if len(frame) < frame_samples:
                frame = np.pad(frame, (0, frame_samples - len(frame)))
            rms = np.sqrt(np.mean(frame ** 2))
            db = 20 * np.log10(max(rms, 1e-10))
            is_speech.append(db > self.energy_threshold_db)

        # Convert frame indices to sample ranges
        segments = []
        in_speech = False
        seg_start = 0
        for i, speech in enumerate(is_speech):
            if speech and not in_speech:
                seg_start = i * hop_samples
                in_speech = True
            elif not speech and in_speech:
                seg_end = i * hop_samples
                segments.append((seg_start, seg_end))
                in_speech = False
        if in_speech:
            segments.append((seg_start, len(pcm)))

        # Filter short segments
        min_samples = int(self.min_speech_ms * sr / 1000)
        segments = [(s, e) for s, e in segments if e - s >= min_samples]

        # Merge close segments
        merge_samples = int(self.merge_gap_ms * sr / 1000)
        merged = []
        for s, e in segments:
            if merged and s - merged[-1][1] < merge_samples:
                merged[-1] = (merged[-1][0], e)
            else:
                merged.append([s, e])
        return [(s, e) for s, e in merged]

    def diarize(self, pcm: np.ndarray) -> list[dict]:
        """
        Diarize `pcm` and return list of:
          {start_ms, end_ms, speaker_id, embedding, confidence}
        """
        from sklearn.cluster import AgglomerativeClustering
        from sklearn.preprocessing import normalize

        segments = self._energy_vad(pcm)
        if not segments:
            return []

        # Embed each segment
        embeddings = []
        valid_segments = []
        for s, e in segments:
            seg_audio = pcm[s:e]
            if len(seg_audio) < TARGET_SR // 2:
                # Too short to embed reliably
                emb = np.zeros(self.encoder.dim, dtype=np.float32)
            else:
                emb = self.encoder.encode(seg_audio)
            embeddings.append(emb)
            valid_segments.append((s, e))

        if not valid_segments:
            return []

        emb_matrix = np.stack(embeddings)

        # Choose cluster count using agglomerative dendrogram distances.
        # Strategy: perform full linkage with k=1..max_k; only increment k
        # when the minimum inter-cluster centroid cosine distance is below
        # the INTER_SPEAKER_SPLIT_THRESHOLD. This prevents splitting a
        # single speaker (high intra-cluster similarity = small inter distance).
        #
        # INTER_SPEAKER_SPLIT_THRESHOLD calibration for ECAPA-TDNN on TTS audio:
        #   - Intra-speaker (same TTS voice, different sentences): 0.50-0.66
        #   - Inter-speaker (pitch-shifted ±6 semitones): 0.10-0.15
        # Threshold at 0.35: split only when centroids are very clearly distinct
        # (< 0.35 cosine), which catches the 0.10-0.15 inter-speaker range
        # while respecting the 0.50+ intra-speaker TTS acoustic variance.
        INTER_SPEAKER_SPLIT_THRESHOLD = 0.35

        n = len(valid_segments)
        max_k = min(4, n)

        if n == 1:
            speaker_labels = [0]
        else:
            best_k = 1
            for k in range(2, max_k + 1):
                try:
                    agg = AgglomerativeClustering(
                        n_clusters=k,
                        metric="cosine",
                        linkage="average",
                    )
                    labels = agg.fit_predict(emb_matrix)
                    # Compute centroids per cluster
                    centroids = []
                    for ci in range(k):
                        mask = labels == ci
                        if mask.sum() == 0:
                            continue
                        c = emb_matrix[mask].mean(axis=0)
                        norm = np.linalg.norm(c)
                        c = c / norm if norm > 1e-8 else c
                        centroids.append(c)
                    if len(centroids) < 2:
                        break
                    # Min inter-cluster cosine similarity
                    min_inter = min(
                        float(np.dot(centroids[i], centroids[j]))
                        for i in range(len(centroids))
                        for j in range(i + 1, len(centroids))
                    )
                    # Only accept the split if clusters are sufficiently distinct
                    if min_inter < INTER_SPEAKER_SPLIT_THRESHOLD:
                        best_k = k
                    else:
                        # All splits at this k have very similar centroids → same speaker
                        break
                except Exception:
                    break

            agg = AgglomerativeClustering(
                n_clusters=best_k,
                metric="cosine",
                linkage="average",
            )
            speaker_labels = agg.fit_predict(emb_matrix).tolist() if best_k > 1 else [0] * n

        result = []
        for (s, e), spk_id, emb in zip(valid_segments, speaker_labels, embeddings):
            result.append({
                "start_ms": int(s / TARGET_SR * 1000),
                "end_ms": int(e / TARGET_SR * 1000),
                "speaker_id": int(spk_id),
                "embedding": emb,
                "confidence": 0.85,  # placeholder — real pyannote emits per-frame logits
            })
        return result


# ---------------------------------------------------------------------------
# In-memory VoiceProfileStore (mirrors the TypeScript implementation)
# ---------------------------------------------------------------------------

@dataclass
class VoiceProfile:
    profile_id: str
    centroid: np.ndarray
    sample_count: int = 0
    entity_id: str | None = None
    imprint_cluster_id: str = ""
    first_observed_at: float = field(default_factory=time.time)
    last_observed_at: float = field(default_factory=time.time)
    embedding_dim: int = 0

    def __post_init__(self):
        if not self.imprint_cluster_id:
            self.imprint_cluster_id = str(uuid.uuid4())
        if not self.embedding_dim:
            self.embedding_dim = len(self.centroid)


class InMemoryVoiceProfileStore:
    """Pure Python equivalent of plugin-local-inference's VoiceProfileStore."""

    def __init__(self, hot_cache_size: int = 30, match_threshold: float = 0.40):
        self._profiles: dict[str, VoiceProfile] = {}
        self._hot_cache: list[str] = []  # LRU ordered profile_ids
        self.hot_cache_size = hot_cache_size
        self.match_threshold = match_threshold

    def _sha(self, centroid: np.ndarray) -> str:
        import hashlib
        return "vp_" + hashlib.sha256(centroid.tobytes()).hexdigest()[:16]

    def add_or_refine(self, embedding: np.ndarray, entity_id: str | None = None) -> VoiceProfile:
        """Add a new profile or refine an existing one if close enough."""
        best_match, best_sim = self.find_best_match(embedding)
        if best_match and best_sim >= self.match_threshold:
            # Refine existing profile (online mean)
            prof = best_match
            n = prof.sample_count
            prof.centroid = (prof.centroid * n + embedding) / (n + 1)
            norm = np.linalg.norm(prof.centroid)
            if norm > 1e-8:
                prof.centroid = prof.centroid / norm
            prof.sample_count += 1
            prof.last_observed_at = time.time()
            if entity_id and not prof.entity_id:
                prof.entity_id = entity_id
            self._promote_lru(prof.profile_id)
            return prof
        else:
            # Create new profile
            profile_id = self._sha(embedding)
            prof = VoiceProfile(
                profile_id=profile_id,
                centroid=embedding.copy(),
                sample_count=1,
                entity_id=entity_id,
                embedding_dim=len(embedding),
            )
            self._profiles[profile_id] = prof
            self._promote_lru(profile_id)
            return prof

    def find_best_match(self, embedding: np.ndarray) -> tuple[VoiceProfile | None, float]:
        """Return (best_profile, cosine_similarity) or (None, 0.0)."""
        best_prof = None
        best_sim = 0.0
        for prof in self._profiles.values():
            sim = float(np.dot(embedding, prof.centroid))
            if sim > best_sim:
                best_sim = sim
                best_prof = prof
        return best_prof, best_sim

    def bind_entity(self, profile_id: str, entity_id: str) -> None:
        if profile_id in self._profiles:
            self._profiles[profile_id].entity_id = entity_id

    def _promote_lru(self, profile_id: str) -> None:
        if profile_id in self._hot_cache:
            self._hot_cache.remove(profile_id)
        self._hot_cache.insert(0, profile_id)
        if len(self._hot_cache) > self.hot_cache_size:
            self._hot_cache = self._hot_cache[:self.hot_cache_size]

    def is_hot(self, profile_id: str) -> bool:
        return profile_id in self._hot_cache

    @property
    def profile_count(self) -> int:
        return len(self._profiles)

    @property
    def profiles(self) -> dict[str, VoiceProfile]:
        return self._profiles


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def encoder() -> SpeakerEncoder:
    """Session-scoped ECAPA-TDNN encoder (download once)."""
    return SpeakerEncoder.load()


@pytest.fixture(scope="session")
def diarizer(encoder) -> SegmentDiarizer:
    """Session-scoped segment diarizer backed by the ECAPA encoder."""
    return SegmentDiarizer(encoder=encoder)


@pytest.fixture(scope="session")
def manifest() -> dict:
    return read_manifest()


@pytest.fixture(scope="session")
def fixtures_dir() -> Path:
    return FIXTURES_DIR


@pytest.fixture(scope="session")
def artifacts_dir() -> Path:
    run_id = os.environ.get("W3_6_RUN_ID", f"run-{int(time.time())}")
    out = ARTIFACTS_DIR / run_id
    out.mkdir(parents=True, exist_ok=True)
    return out


def load_fixture_audio(name: str) -> np.ndarray:
    path = FIXTURES_DIR / name
    return load_wav_mono16k(path)
