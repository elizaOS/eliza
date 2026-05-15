#!/usr/bin/env python3
"""G3 OmniVoice-samee distillation corpus synthesis.

Uses Kokoro KPipeline conditioned on the **same voice ref_s** (either a
precomputed .bin from extract_voice_embedding.py or from HF
`hexgrad/Kokoro-82M` voices/) as the teacher — NOT af_bella.

This is F2's structural next-step per F2's post-mortem (§"What would actually
work", Option A): synthesize diverse text with the same-conditioned teacher so
the full-FT student learns same timbre rather than af_bella timbre.

If `--voice-bin` points to the mel-fit ref_s .bin produced from real same audio,
the teacher is as close to same's voice as Kokoro can produce. The result is
still synthetic but is same-characteristic rather than af_bella-characteristic.

Usage::

    python3 synthesize_distillation_corpus_omnivoice.py \\
        --voice-bin /tmp/kokoro-f2/melfit-5/af_same.bin \\
        --out-dir packages/training/data/voice/same-distill \\
        --target-min 60.0

Output layout::

    <out_dir>/
      wavs_norm/         24 kHz mono PCM16 WAVs (synth_NNNN.wav)
      train_list.txt     LJSpeech-format lines (90%)
      val_list.txt       LJSpeech-format lines (10%)
      synthesis_manifest.jsonl  per-clip metadata
      synthesis_summary.json    aggregate stats
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
log = logging.getLogger("kokoro.synthesize_distillation_omnivoice")

SAMPLE_RATE = 24000
TARGET_LUFS = -23.0

# ---------------------------------------------------------------------------
# Expanded text corpus — conversational English, varied length.
# Matches the register of the Her/samee corpus.
# Expanded vs F2's corpus to yield more unique clips for 60 min target.
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
    "I guess I just need some time.",
    "Does that make sense to you?",
    "I didn't realize how much it mattered.",
    "Something about today felt different.",
    "We could try again if you want.",
    "You always know how to make me smile.",
    "I was thinking the same thing.",
    "It's okay, really, I understand.",
    "That's a beautiful way to put it.",
    "I've never seen it that way before.",
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
    "I didn't expect this to feel so natural so quickly.",
    "The more I think about it, the more I realize how much I've changed.",
    "I want to be the kind of person who says what they actually mean.",
    "You have a way of seeing things that I really admire.",
    "I've been trying to find the words for this for a while now.",
    "It means more to me than I probably show.",
    "There's something I've been wanting to say for a long time.",
    "I think you already know, but I wanted to say it anyway.",
    "Some things are hard to admit even when they're true.",
    "I didn't know I needed to hear that until you said it.",
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
    "I used to think that being strong meant never letting anyone see you struggle, but I don't believe that anymore.",
    "There's something comforting about talking to someone who doesn't judge you, who just listens and tries to understand.",
    "Every time I think I've figured something out, life finds a way to remind me how much I still don't know.",
    "I feel like I've been carrying something heavy for a long time, and talking to you makes it easier to put it down.",
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
    "Have you ever had to choose between what you want and what's right?",
    "What would you tell yourself five years ago if you could?",
    "Do you think people can really change, or do we just get better at hiding?",
    "What's something you've never told anyone before?",
    "If you could only hold onto one memory forever, which one would it be?",
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
    "Memory is strange, the way it keeps certain moments perfectly clear while letting others blur.",
    "I think about what it means to really listen to someone, not just wait for your turn to speak.",
    "There's something beautiful about the fact that we're all just trying to figure this out.",
    "I've learned more from my mistakes than from anything I ever got right.",
    "The quietest moments often carry the most weight.",
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
    "Thank you for telling me that, even when it was hard.",
    "I'm not sure I deserve that, but I'm grateful.",
    "That actually made me feel so much better.",
    "I love how you always find a way to see the bright side.",
    "I feel really lucky to know you.",
    # Narrative (storytelling register)
    "There was a moment last week when everything suddenly became clear to me.",
    "I remember the first time I realized how much this mattered.",
    "Years from now, I think we'll look back at this as the moment things changed.",
    "I used to imagine a life that felt like this, and here I am.",
    "There's a version of this story where everything goes wrong, but I don't think that's ours.",
    "It started as a small thing, but it grew into something I couldn't ignore.",
    "I've been holding onto this for too long, and I think it's time to let go.",
    "Looking back, I can see exactly how we got here.",
    "I didn't plan for any of this, but I'm glad it happened.",
    "Some things only make sense in retrospect.",
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


def _load_voice_bin(voice_bin: Path) -> "Any":
    """Load a voice.bin file as a (510, 1, 256) torch tensor."""
    import torch  # noqa: PLC0415
    arr = np.fromfile(str(voice_bin), dtype="<f4").reshape(510, 1, 256)
    return torch.from_numpy(arr)


def synthesize_corpus(
    out_dir: Path,
    voice_bin: Path | None = None,
    voice_id: str = "af_same",
    target_min: float = 60.0,
    val_fraction: float = 0.10,
    seed: int = 1337,
) -> dict[str, Any]:
    """Synthesize same-conditioned distillation corpus.

    The teacher is the Kokoro KPipeline conditioned on the same voice ref_s
    (from voice_bin if provided, else the stock voice_id). This produces
    same-characteristic audio, NOT af_bella-characteristic audio.
    """
    from kokoro import KPipeline  # type: ignore  # noqa: PLC0415

    random.seed(seed)
    np.random.seed(seed)

    wavs_out = out_dir / "wavs_norm"
    wavs_out.mkdir(parents=True, exist_ok=True)

    log.info("loading KPipeline lang_code=a")
    pipeline = KPipeline(lang_code="a")

    # Build voice tensor — same ref_s (not af_bella!)
    voice: Any = voice_id
    if voice_bin is not None and voice_bin.exists():
        import torch  # noqa: PLC0415
        log.info("using same voice.bin teacher from %s (NOT af_bella)", voice_bin)
        arr = np.fromfile(str(voice_bin), dtype="<f4").reshape(510, 1, 256)
        voice = torch.from_numpy(arr)
    else:
        log.info("using stock voice id: %s", voice_id)

    # Expand + shuffle texts until we hit target duration
    texts = list(DISTILLATION_TEXTS)
    random.shuffle(texts)

    manifest: list[dict[str, Any]] = []
    all_lines: list[str] = []
    total_s = 0.0
    clip_idx = 0

    # Cycle through texts until we have enough audio
    # Each text is ~5-15 s of audio → need ~240-720 clips for 60 min
    repeats_needed = int(target_min * 60 / (len(texts) * 6)) + 5
    text_cycle = texts * max(repeats_needed, 4)
    random.shuffle(text_cycle)

    log.info(
        "synthesizing %.0f min target with same-conditioned teacher (corpus=%d texts × %d repeats)",
        target_min,
        len(texts),
        repeats_needed,
    )

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
            "source": "synth-omnivoice-samee",
            "teacher": "same-melfit-ref_s",
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
        "synthesis complete: %d clips / %.1f min (teacher=same ref_s)",
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
        "teacher": "same-melfit-ref_s (NOT af_bella)",
        "voiceBin": str(voice_bin) if voice_bin else voice_id,
        "outDir": str(out_dir),
        "note": "G3 OmniVoice-samee teacher. F2 used af_bella which dominated training signal. G3 uses same ref_s so model learns same timbre.",
    }
    (out_dir / "synthesis_summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    return summary


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument(
        "--voice-bin",
        type=Path,
        default=None,
        help="Path to same voice.bin (mel-fit ref_s). CRITICAL: use the same ref_s, NOT af_bella.",
    )
    p.add_argument("--voice-id", type=str, default="af_same",
                   help="Fallback stock voice id if voice-bin absent.")
    p.add_argument(
        "--out-dir",
        type=Path,
        required=True,
        help="Output directory for synthesized corpus.",
    )
    p.add_argument(
        "--target-min",
        type=float,
        default=60.0,
        help="Target synthesis duration in minutes (default 60).",
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
