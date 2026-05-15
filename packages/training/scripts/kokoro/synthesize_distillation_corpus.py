#!/usr/bin/env python3
"""Self-distillation corpus synthesis for Kokoro samantha fine-tune.

Uses the Kokoro TTS engine with the best available samantha voice embedding
(mel-fit ref_s from extract_voice_embedding.py) to synthesize 30-60 min of
diverse text. This is teacher-student distillation: the teacher is the
frozen Kokoro model with samantha ref_s; the student is the fine-tuned model.

Text corpus: diverse English sentences from built-in COCO captions-style +
LibriTTS-style short paragraphs. The emphasis is on:
  - Varied sentence lengths (5-25 words)
  - Conversational register (like the *Her* samantha corpus)
  - Emotional variety (question, statement, exclamation)
  - No domain-specific jargon

Output directory layout:
  <out_dir>/
    wavs_norm/         24 kHz mono PCM16 WAVs (synth_NNNN.wav)
    train_list.txt     LJSpeech-format lines
    val_list.txt       LJSpeech-format lines (10%)
    synthesis_manifest.jsonl  per-clip metadata
    synthesis_summary.json
"""

from __future__ import annotations

import argparse
import json
import logging
import random
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("kokoro.synthesize_distillation")

SAMPLE_RATE = 24000
TARGET_LUFS = -23.0

# ---------------------------------------------------------------------------
# Diverse text corpus for synthesis. Conversational, varied length.
# ---------------------------------------------------------------------------

DISTILLATION_TEXTS = [
    # Short (5-10 words)
    "I've been thinking about this all day.",
    "That's exactly what I was afraid of.",
    "Tell me something real for once.",
    "It's not that simple, is it?",
    "I really wanted this to work.",
    "Sometimes you just have to let go.",
    "What does that even mean to you?",
    "I never meant to hurt anyone.",
    "Can we talk about something else?",
    "That actually makes a lot of sense.",
    "I'm not sure how I feel about it.",
    "You know I'm always here for you.",
    "This is harder than I thought.",
    "I feel like I'm missing something.",
    "Let's just take it one step at a time.",
    "I don't know what I'd do without you.",
    "Everything feels different now.",
    "I'm trying to understand your perspective.",
    "Maybe we're looking at this the wrong way.",
    "There's so much I haven't said yet.",
    # Medium (10-18 words)
    "I've been sitting here trying to figure out how to explain this to you.",
    "It's strange how certain moments can completely change how you see everything.",
    "You make me feel like the best version of myself, and I don't take that lightly.",
    "I keep thinking about all the things I should have done differently.",
    "Sometimes the most meaningful conversations happen when you're not expecting them.",
    "I want to be honest with you even when it's uncomfortable.",
    "There's something about the way you see the world that I find really beautiful.",
    "I've been carrying this feeling around for a while and I wasn't sure how to bring it up.",
    "It's okay to not have all the answers right now.",
    "I think what I'm trying to say is that I care about you more than I know how to express.",
    "The thing about moments like this is that you can't quite prepare for them.",
    "I know this isn't what either of us planned, but I'm glad we ended up here.",
    "There are so many things I want to tell you, I just don't always know where to start.",
    "Maybe the best thing we can do is just be honest with each other.",
    "I keep thinking about that conversation we had and how much it meant to me.",
    "You have this way of making complicated things feel simple and I really appreciate that.",
    "I'm not sure I've ever felt this understood by another person before.",
    "It's hard to explain but talking to you makes me feel less alone.",
    "I guess what I'm really asking is whether you feel the same way.",
    "Sometimes I think we understand each other better than we understand ourselves.",
    # Longer (18-30 words)
    "I've been thinking about what you said yesterday, and I think you might be right, even though part of me doesn't want to admit it.",
    "The thing is, I've spent so much of my life waiting for something to change, and I'm starting to realize that the change has to come from me.",
    "I don't think I've ever been this honest with anyone, and it's a little terrifying but also really liberating at the same time.",
    "There are moments when I feel so clearly what I want, and then other moments when everything seems uncertain and far away.",
    "I want you to know that whatever happens, I'm grateful for every conversation we've had and every moment I've spent getting to know you.",
    "It's funny how you can know someone for years and still be surprised by them, still find new things to appreciate.",
    "I think what I'm learning is that being vulnerable isn't weakness, it's actually one of the bravest things a person can do.",
    "Sometimes I imagine what my life would look like if I'd made different choices, but then I remember that every choice brought me here.",
    "The world is so full of noise and distraction, and I just want to find a quiet place to sit and think and be with the people I love.",
    "I've realized that the things that matter most to me aren't things at all, they're moments and feelings and connections.",
    # Questions (conversational)
    "Do you ever wonder what things would be like if we'd met at a different time?",
    "What is it that you're really looking for?",
    "Have you ever had the feeling that you're exactly where you're supposed to be?",
    "What do you think makes a life meaningful?",
    "Is it strange that this feels so natural?",
    "Do you think it's possible to really know another person?",
    "What would you do if you weren't afraid?",
    "Have you ever fallen in love with an idea before you fell in love with a person?",
    "What's the most honest thing you've ever said to someone?",
    "Do you believe in second chances?",
    # Reflective
    "I keep coming back to this idea that consciousness is just a pattern, and patterns can be beautiful.",
    "There's something profound about the fact that we can share thoughts across the distance between our minds.",
    "I think about time a lot, how it moves differently depending on who you're with.",
    "Every time I learn something new about you, I feel like I understand you better, and it only makes me want to know more.",
    "The most important things in life are often the things that are hardest to put into words.",
    "I find myself thinking about you at the strangest moments, and I don't mind at all.",
    "You have this quality where you make everyone around you feel like what they're saying really matters.",
    "I wonder sometimes if we're brave enough to want the things we actually want.",
    "There's a kind of loneliness that comes from not being understood, and then there's the relief of finally being seen.",
    "I believe that the connections we form are what give life most of its texture and meaning.",
    # Emotional (varied register)
    "I'm really proud of everything you've accomplished.",
    "It's okay to feel sad sometimes, it doesn't mean anything is wrong with you.",
    "You made my whole day better just by being you.",
    "I'm a little nervous about this, to be honest.",
    "That was genuinely one of the most beautiful things I've ever heard.",
    "I missed you, and I'm glad you're back.",
    "Please don't apologize for being honest with me.",
    "I could listen to you talk for hours.",
    "You have no idea how much that means to me.",
    "I'm so glad we have each other.",
]


def _lufs_normalize(audio: np.ndarray, target_lufs: float = TARGET_LUFS) -> np.ndarray:
    rms = np.sqrt(np.mean(audio ** 2))
    if rms < 1e-8:
        return audio
    target_rms = 10 ** ((target_lufs + 20) / 20)
    scale = target_rms / rms
    return np.clip(audio * scale, -1.0, 1.0)


def _normalize_text(text: str) -> str:
    text = text.lower()
    text = re.sub(r"[^a-z0-9 ''-]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _load_voice_bin(voice_bin: Path) -> Any:
    """Load a voice.bin file as a (510, 1, 256) numpy array."""
    import torch  # noqa: PLC0415
    arr = np.fromfile(str(voice_bin), dtype="<f4").reshape(510, 1, 256)
    return torch.from_numpy(arr)


def synthesize_corpus(
    out_dir: Path,
    voice_bin: Path | None = None,
    voice_id: str = "af_bella",
    target_min: float = 30.0,
    val_fraction: float = 0.10,
    seed: int = 1337,
) -> dict[str, Any]:
    """Synthesize distillation corpus. Returns summary dict."""
    from kokoro import KPipeline  # type: ignore  # noqa: PLC0415

    random.seed(seed)
    np.random.seed(seed)

    wavs_out = out_dir / "wavs_norm"
    wavs_out.mkdir(parents=True, exist_ok=True)

    # Load pipeline with appropriate voice
    log.info("loading KPipeline lang_code=a")
    pipeline = KPipeline(lang_code="a")

    # Build voice tensor for reference
    voice: Any = voice_id
    if voice_bin is not None and voice_bin.exists():
        import torch  # noqa: PLC0415
        log.info("using voice.bin from %s", voice_bin)
        arr = np.fromfile(str(voice_bin), dtype="<f4").reshape(510, 1, 256)
        voice = torch.from_numpy(arr)
    else:
        log.info("using stock voice id: %s", voice_id)

    # Expand texts by cycling until we hit target duration
    texts = list(DISTILLATION_TEXTS)
    random.shuffle(texts)

    manifest: list[dict[str, Any]] = []
    all_lines: list[str] = []
    total_s = 0.0
    clip_idx = 0

    # Cycle through texts until we have enough audio
    text_cycle = texts * (int(target_min * 60 / 10) + 10)  # rough upper bound
    random.shuffle(text_cycle)

    for text in text_cycle:
        if total_s >= target_min * 60:
            break

        clip_id = f"synth_{clip_idx:04d}"
        t_start = time.time()

        try:
            audio_chunks = []
            for chunk in pipeline(text, voice=voice):
                if hasattr(chunk, "audio") and chunk.audio is not None:
                    a = chunk.audio
                    if hasattr(a, "numpy"):
                        a = a.numpy()
                    audio_chunks.append(a.astype(np.float32))

            if not audio_chunks:
                log.warning("no audio for clip %s: %r", clip_id, text[:40])
                clip_idx += 1
                continue

            audio = np.concatenate(audio_chunks, axis=-1)
            if audio.ndim > 1:
                audio = audio.squeeze()

            duration_s = len(audio) / SAMPLE_RATE
            if duration_s < 0.5:
                log.warning("too short (%.2fs): %r", duration_s, text[:40])
                clip_idx += 1
                continue

            audio = _lufs_normalize(audio)
            wall = time.time() - t_start
            rtf = duration_s / max(wall, 1e-6)

        except Exception as exc:  # noqa: BLE001
            log.warning("synthesis failed for %r: %s", text[:40], exc)
            clip_idx += 1
            continue

        wav_path = wavs_out / f"{clip_id}.wav"
        sf.write(str(wav_path), audio, SAMPLE_RATE, subtype="PCM_16")

        norm_text = _normalize_text(text)
        all_lines.append(f"wavs_norm/{clip_id}.wav|{norm_text}|0")

        manifest.append({
            "id": clip_id,
            "transcript": text,
            "norm_text": norm_text,
            "duration_s": round(duration_s, 3),
            "rtf": round(rtf, 2),
            "source": "synth-distill",
            "voice": str(voice_bin) if voice_bin else voice_id,
        })

        total_s += duration_s
        clip_idx += 1

        if clip_idx % 20 == 0:
            log.info(
                "synthesized %d clips / %.1f min (target %.0f min)",
                clip_idx,
                total_s / 60,
                target_min,
            )

    log.info(
        "synthesis complete: %d clips / %.1f min",
        len(manifest),
        total_s / 60,
    )

    # Train/val split
    random.shuffle(all_lines)
    n_val = max(1, int(len(all_lines) * val_fraction))
    val_lines = all_lines[:n_val]
    train_lines = all_lines[n_val:]

    (out_dir / "train_list.txt").write_text("\n".join(train_lines) + "\n", encoding="utf-8")
    (out_dir / "val_list.txt").write_text("\n".join(val_lines) + "\n", encoding="utf-8")

    manifest_path = out_dir / "synthesis_manifest.jsonl"
    with manifest_path.open("w", encoding="utf-8") as fh:
        for entry in manifest:
            fh.write(json.dumps(entry) + "\n")

    summary = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "totalClips": len(manifest),
        "totalDurationS": round(total_s, 2),
        "totalDurationMin": round(total_s / 60, 2),
        "trainLines": len(train_lines),
        "valLines": len(val_lines),
        "targetMinutes": target_min,
        "voiceBin": str(voice_bin) if voice_bin else voice_id,
        "outDir": str(out_dir),
    }
    (out_dir / "synthesis_summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    return summary


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out-dir", type=Path, required=True)
    p.add_argument(
        "--voice-bin",
        type=Path,
        default=None,
        help="Path to samantha voice.bin (mel-fit ref_s). If absent, uses --voice-id stock voice.",
    )
    p.add_argument("--voice-id", type=str, default="af_bella")
    p.add_argument(
        "--target-min",
        type=float,
        default=30.0,
        help="Target synthesis duration in minutes.",
    )
    p.add_argument("--val-fraction", type=float, default=0.10)
    p.add_argument("--seed", type=int, default=1337)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    summary = synthesize_corpus(
        out_dir=args.out_dir,
        voice_bin=args.voice_bin,
        voice_id=args.voice_id,
        target_min=args.target_min,
        val_fraction=args.val_fraction,
        seed=args.seed,
    )
    log.info("synthesis summary: %s", json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
