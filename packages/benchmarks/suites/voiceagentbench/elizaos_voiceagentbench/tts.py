"""macOS ``say`` text-to-speech for local audio synthesis.

The canonical VoiceAgentBench audio lives on Hugging Face. When that dataset
isn't fetched locally, the local profile synthesizes audio from each task's
ground-truth transcript with macOS ``say`` so the ASR backend has real audio
to transcribe. The benchmark still scores the ASR transcript (not the
ground-truth text) against the agent, so this is a real voice path.
"""

from __future__ import annotations

import os
import subprocess
import tempfile
from pathlib import Path


def say_binary() -> Path:
    return Path(os.environ.get("VOICEBENCH_SAY_BIN") or "/usr/bin/say")


def synthesize_wav(text: str) -> bytes:
    """Render ``text`` to 16 kHz mono LEI16 WAV bytes via macOS ``say``."""
    if not text.strip():
        raise RuntimeError("cannot synthesize audio from empty text")
    binary = say_binary()
    if not binary.is_file():
        raise RuntimeError(f"macOS say binary not found at {binary}")
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as fh:
        out_path = Path(fh.name)
    try:
        proc = subprocess.run(
            [str(binary), "-o", str(out_path), "--data-format=LEI16@16000", text],
            capture_output=True,
            text=True,
            timeout=120,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"say TTS failed: {proc.stderr.strip()}")
        return out_path.read_bytes()
    finally:
        out_path.unlink(missing_ok=True)
