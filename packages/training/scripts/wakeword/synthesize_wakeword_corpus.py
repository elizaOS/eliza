#!/usr/bin/env python3
"""Synthesize a "hey eliza" wake-word training corpus with piper-tts.

Companion to ``train_eliza1_wakeword_head.py``. The trainer expects two
directories of 16 kHz mono PCM16 WAVs — positives that say the wake phrase and
negatives that do not. openWakeWord's notebook synthesizes both with a
permissively-licensed TTS (piper) across many voices/speeds/pitches, then
augments with noise. This script does that with piper-tts (MIT; the
rhasspy/piper-voices are MIT / public-domain-leaning) so the trained head stays
redistributable.

What it produces
----------------
- ``--positives-dir`` : the phrase ("hey eliza" and natural spelling/punctuation
  variants) across every piper voice on disk, many length-scales (speed),
  noise-scale / noise-w (timbre/prosody) settings, and — for the multi-speaker
  ``libritts`` voice — a sweep of speaker ids. Each clip is centered and
  padded to a fixed window with light gain + background-noise augmentation.
- ``--negatives-dir`` : (a) hard near-phrases ("hey alexa", "hey lisa",
  "eliza", "hey there", "elissa", …) that share phonemes with the wake word
  but must NOT fire; (b) a large bank of generic English sentences/words;
  (c) the repo's real-speech fixtures (``--extra-negatives`` WAVs) chopped into
  windows; all noise-augmented. More + harder negatives ⇒ fewer false-accepts.

Everything is resampled to 16 kHz mono PCM16 (the trainer's required format)
with ``librosa`` / ``soundfile``.

This is deterministic given ``--seed`` (piper sampling + numpy augmentation are
seeded) so a corpus can be regenerated for provenance.
"""

from __future__ import annotations

import argparse
import glob
import json
import math
import os
import random
import wave
from pathlib import Path

# Pin every numeric backend (piper's onnxruntime, numpy/scipy BLAS) to a single
# thread *before* they load. Wake-word corpus synthesis is embarrassingly
# parallel across clips, so the throughput win comes from running many of these
# processes (one per core) rather than from intra-op threading — which only
# contends when several piper inferences fight for the same cores.
for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import numpy as np

SAMPLE_RATE = 16_000
# Fixed clip length fed to the trainer. "hey eliza" at normal speed is ~0.95 s;
# the head windows 16 embeddings (~1.4 s of context after the front-end warms
# up). We pad/center to 2.0 s so the embedding stream always covers the phrase.
CLIP_SECONDS = 2.0
CLIP_SAMPLES = int(SAMPLE_RATE * CLIP_SECONDS)

# Natural spelling / punctuation variants of the wake phrase. Piper phonemizes
# each slightly differently, which broadens the positive set without changing
# the target word.
POSITIVE_VARIANTS = [
    "hey eliza",
    "hey, eliza",
    "hey eliza.",
    "hey eliza!",
    "hey eliza?",
    "Hey Eliza",
    "hey  eliza",
    "hey eliza, ",
]

# Hard negatives — phonetically adjacent to "hey eliza". These are what a
# wake-word head most easily false-accepts on, so we over-represent them.
HARD_NEGATIVE_PHRASES = [
    "hey alexa",
    "hey siri",
    "hey google",
    "hey lisa",
    "hey liza",
    "hey elissa",
    "hey melissa",
    "hey theresa",
    "hey eliza's",
    "hello eliza",
    "hey there",
    "hey you",
    "hey now",
    "hey wait",
    "eliza",
    "elissa",
    "elisa",
    "a pizza",
    "he sees a",
    "hey please",
    "hey easy",
    "lisa",
    "see ya",
    "hey",
    "okay",
    "anita",
    "hey idea",
    "hey it's a",
]

# Generic negative speech — ordinary words/sentences with no wake phrase.
GENERIC_NEGATIVE_PHRASES = [
    "what time is it",
    "turn on the lights",
    "play some music",
    "what is the weather today",
    "remind me to call mom",
    "set a timer for ten minutes",
    "how are you doing",
    "i need to go to the store",
    "the quick brown fox jumps over the lazy dog",
    "thank you very much",
    "can you help me with this",
    "let me think about it",
    "that sounds like a good plan",
    "i will be there in five minutes",
    "send a message to my friend",
    "open the front door",
    "what is on my calendar",
    "tell me a joke",
    "the meeting is at three o'clock",
    "i am running a little late",
    "could you repeat that please",
    "the weather is nice outside",
    "we should grab lunch sometime",
    "where did i leave my keys",
    "the answer is forty two",
    "she sells seashells by the seashore",
    "good morning everyone",
    "i love this song",
    "please call me back later",
    "the project is almost finished",
    "let's schedule a meeting for tomorrow",
    "do you know what day it is",
    "my favorite color is blue",
    "the train leaves at noon",
    "i think it might rain later",
    "this coffee is really good",
    "have you seen my phone anywhere",
    "we are out of milk again",
    "the dog needs to go outside",
    "happy birthday to you",
]


def _have_piper() -> bool:
    try:
        import piper  # noqa: F401
    except Exception:  # noqa: BLE001
        return False
    return True


def _load_voices(voices_dir: Path) -> list[tuple[str, dict]]:
    """Return [(onnx_path, config_dict)] for every piper voice in ``voices_dir``."""
    out: list[tuple[str, dict]] = []
    for onnx in sorted(glob.glob(str(voices_dir / "*.onnx"))):
        cfg_path = onnx + ".json"
        if not os.path.isfile(cfg_path):
            continue
        cfg = json.load(open(cfg_path))
        out.append((onnx, cfg))
    return out


def _resample_to_16k_mono(audio: np.ndarray, src_sr: int) -> np.ndarray:
    """Resample to 16 kHz mono with scipy polyphase (≈50× faster than
    librosa's soxr_hq and inaudibly close for speech)."""
    from math import gcd

    from scipy.signal import resample_poly

    if audio.ndim > 1:
        audio = audio.mean(axis=0)
    audio = audio.astype(np.float32)
    if src_sr != SAMPLE_RATE:
        g = gcd(int(src_sr), SAMPLE_RATE)
        up = SAMPLE_RATE // g
        down = int(src_sr) // g
        audio = resample_poly(audio, up, down).astype(np.float32)
    return audio


def _center_pad(audio: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """Pad/crop ``audio`` to CLIP_SAMPLES, placing the speech at a random offset
    so the head does not learn a fixed temporal position for the phrase."""
    n = audio.shape[0]
    if n >= CLIP_SAMPLES:
        start = rng.integers(0, n - CLIP_SAMPLES + 1)
        return audio[start : start + CLIP_SAMPLES]
    out = np.zeros(CLIP_SAMPLES, dtype=np.float32)
    max_off = CLIP_SAMPLES - n
    off = int(rng.integers(0, max_off + 1))
    out[off : off + n] = audio
    return out


def _augment(audio: np.ndarray, rng: np.random.Generator, noise_bank: list[np.ndarray]) -> np.ndarray:
    """Light gain + additive background noise (white + optional real ambient)."""
    out = audio.copy()
    # random gain 0.6..1.15
    out *= float(rng.uniform(0.6, 1.15))
    # additive white noise at a random SNR (12..40 dB)
    sig_pow = float(np.mean(out**2)) + 1e-9
    snr_db = float(rng.uniform(12.0, 40.0))
    noise_pow = sig_pow / (10 ** (snr_db / 10.0))
    out = out + rng.normal(0.0, math.sqrt(noise_pow), size=out.shape).astype(np.float32)
    # 35% of the time mix in a real ambient snippet
    if noise_bank and rng.random() < 0.35:
        amb = noise_bank[int(rng.integers(0, len(noise_bank)))]
        if amb.shape[0] >= CLIP_SAMPLES:
            s = int(rng.integers(0, amb.shape[0] - CLIP_SAMPLES + 1))
            amb = amb[s : s + CLIP_SAMPLES]
        else:
            amb = np.pad(amb, (0, CLIP_SAMPLES - amb.shape[0]))
        out = out + float(rng.uniform(0.05, 0.30)) * amb
    # clip
    peak = float(np.max(np.abs(out))) + 1e-9
    if peak > 1.0:
        out = out / peak * 0.98
    return out.astype(np.float32)


def _write_wav(path: Path, audio: np.ndarray) -> None:
    pcm = np.clip(audio, -1.0, 1.0)
    pcm16 = (pcm * 32767.0).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm16.tobytes())


def _load_noise_bank(paths: list[str]) -> list[np.ndarray]:
    import soundfile as sf

    bank: list[np.ndarray] = []
    for p in paths:
        try:
            data, sr = sf.read(p, dtype="float32")
            bank.append(_resample_to_16k_mono(data.T if data.ndim > 1 else data, sr))
        except Exception as e:  # noqa: BLE001
            print(f"[corpus] skip noise fixture {p}: {e}")
    return bank


def _synth_phrase(voice, text: str, syn_cfg) -> np.ndarray:
    """Synthesize one phrase to a float32 mono array at the voice's sample rate."""
    chunks = []
    for ch in voice.synthesize(text, syn_config=syn_cfg):
        a = np.frombuffer(ch.audio_int16_bytes, dtype="<i2").astype(np.float32) / 32768.0
        chunks.append(a)
    if not chunks:
        return np.zeros(1, dtype=np.float32)
    return np.concatenate(chunks)


def synthesize(
    *,
    voices_dir: Path,
    positives_dir: Path,
    negatives_dir: Path,
    n_positives: int,
    n_negatives: int,
    extra_negatives: list[str],
    seed: int,
    prefix: str = "",
) -> dict:
    from piper import PiperVoice, SynthesisConfig

    rng = np.random.default_rng(seed)
    random.seed(seed)

    voices = _load_voices(voices_dir)
    if not voices:
        raise RuntimeError(f"no piper *.onnx voices in {voices_dir}")
    print(f"[corpus] {len(voices)} piper voices loaded from {voices_dir}")

    noise_bank = _load_noise_bank(extra_negatives)
    print(f"[corpus] {len(noise_bank)} real-ambient noise fixtures for augmentation")

    positives_dir.mkdir(parents=True, exist_ok=True)
    negatives_dir.mkdir(parents=True, exist_ok=True)

    # Pre-load PiperVoice objects (loading is the slow part; reuse them).
    loaded = []
    for onnx, cfg in voices:
        v = PiperVoice.load(onnx, config_path=onnx + ".json")
        n_speakers = int(cfg.get("num_speakers", 1))
        sr = int(cfg.get("audio", {}).get("sample_rate", 22050))
        loaded.append((Path(onnx).stem, v, n_speakers, sr))

    length_scales = [0.80, 0.90, 1.0, 1.10, 1.25, 1.4]
    noise_scales = [0.5, 0.667, 0.85]
    noise_ws = [0.6, 0.8, 1.0]

    # ── positives ──────────────────────────────────────────────────────────
    pos_written = 0
    i = 0
    while pos_written < n_positives:
        name, v, n_speakers, sr = loaded[i % len(loaded)]
        text = POSITIVE_VARIANTS[int(rng.integers(0, len(POSITIVE_VARIANTS)))]
        spk = int(rng.integers(0, n_speakers)) if n_speakers > 1 else None
        syn = SynthesisConfig(
            speaker_id=spk,
            length_scale=float(length_scales[int(rng.integers(0, len(length_scales)))]),
            noise_scale=float(noise_scales[int(rng.integers(0, len(noise_scales)))]),
            noise_w_scale=float(noise_ws[int(rng.integers(0, len(noise_ws)))]),
        )
        try:
            raw = _synth_phrase(v, text, syn)
        except Exception as e:  # noqa: BLE001
            print(f"[corpus] positive synth failed ({name}/{text}): {e}")
            i += 1
            continue
        audio = _resample_to_16k_mono(raw, sr)
        audio = _center_pad(audio, rng)
        audio = _augment(audio, rng, noise_bank)
        _write_wav(positives_dir / f"{prefix}pos-{pos_written:06d}.wav", audio)
        pos_written += 1
        i += 1
        if pos_written % 500 == 0:
            print(f"[corpus] positives {pos_written}/{n_positives}")

    # ── negatives ──────────────────────────────────────────────────────────
    # Over-represent hard near-phrases (40% of the synthetic negatives).
    neg_written = 0
    j = 0

    # First, chop the real-speech fixtures into windows — these are gold
    # negatives (real human speech that is not the phrase).
    for amb in noise_bank:
        for start in range(0, max(1, amb.shape[0] - CLIP_SAMPLES + 1), CLIP_SAMPLES // 2):
            seg = amb[start : start + CLIP_SAMPLES]
            if seg.shape[0] < SAMPLE_RATE // 2:
                continue
            seg = _center_pad(seg, rng)
            seg = _augment(seg, rng, noise_bank)
            _write_wav(negatives_dir / f"{prefix}neg-fix-{neg_written:06d}.wav", seg)
            neg_written += 1

    while neg_written < n_negatives:
        name, v, n_speakers, sr = loaded[j % len(loaded)]
        if rng.random() < 0.40:
            text = HARD_NEGATIVE_PHRASES[int(rng.integers(0, len(HARD_NEGATIVE_PHRASES)))]
        else:
            text = GENERIC_NEGATIVE_PHRASES[int(rng.integers(0, len(GENERIC_NEGATIVE_PHRASES)))]
        spk = int(rng.integers(0, n_speakers)) if n_speakers > 1 else None
        syn = SynthesisConfig(
            speaker_id=spk,
            length_scale=float(length_scales[int(rng.integers(0, len(length_scales)))]),
            noise_scale=float(noise_scales[int(rng.integers(0, len(noise_scales)))]),
            noise_w_scale=float(noise_ws[int(rng.integers(0, len(noise_ws)))]),
        )
        try:
            raw = _synth_phrase(v, text, syn)
        except Exception as e:  # noqa: BLE001
            print(f"[corpus] negative synth failed ({name}/{text}): {e}")
            j += 1
            continue
        audio = _resample_to_16k_mono(raw, sr)
        audio = _center_pad(audio, rng)
        audio = _augment(audio, rng, noise_bank)
        _write_wav(negatives_dir / f"{prefix}neg-{neg_written:06d}.wav", audio)
        neg_written += 1
        j += 1
        if neg_written % 500 == 0:
            print(f"[corpus] negatives {neg_written}/{n_negatives}")

    return {"positives": pos_written, "negatives": neg_written}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--voices-dir", type=Path, required=True, help="Dir of piper *.onnx + *.onnx.json voices.")
    ap.add_argument("--positives-dir", type=Path, required=True)
    ap.add_argument("--negatives-dir", type=Path, required=True)
    ap.add_argument("--n-positives", type=int, default=6000)
    ap.add_argument("--n-negatives", type=int, default=9000)
    ap.add_argument(
        "--extra-negatives",
        type=str,
        nargs="*",
        default=[],
        help="Real-speech WAVs (any sr) used both as negative windows and as augmentation noise.",
    )
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument(
        "--prefix",
        type=str,
        default="",
        help="Filename prefix, so parallel shards writing to the same dirs do not collide (e.g. 's0-').",
    )
    args = ap.parse_args(argv)

    if not _have_piper():
        print("[corpus] piper is not importable; install piper-tts. STOP.", flush=True)
        return 2

    stats = synthesize(
        voices_dir=args.voices_dir,
        positives_dir=args.positives_dir,
        negatives_dir=args.negatives_dir,
        n_positives=args.n_positives,
        n_negatives=args.n_negatives,
        extra_negatives=args.extra_negatives,
        seed=args.seed,
        prefix=args.prefix,
    )
    print(f"[corpus] DONE: {stats['positives']} positives, {stats['negatives']} negatives")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
