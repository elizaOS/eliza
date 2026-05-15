#!/usr/bin/env python3
"""Convert a Pyannote-3 segmentation diarizer checkpoint to a GGUF
file the voice-classifier-cpp runtime will load through its ggml
dispatcher.

This is a SKELETON. The TODO blocks below mark the work the real
conversion will do; they raise NotImplementedError so a caller
cannot mistake the stub for a working converter.

Upstream model
--------------
- `pyannote/segmentation-3.0` (MIT-licensed checkpoint; the wider
  pyannote toolkit is CC-BY-NC but the model itself is shippable).
- Architecture: SincNet front-end + LSTM + 7-class powerset
  classifier head.
- Frame rate at 16 kHz input: ~58.9 frames/sec → 589 frames per
  10 s window.

Output
------
A GGUF file with one model bundle plus metadata keys the runtime
reads to refuse mismatched builds:

- ``voice_diarizer.variant``      = upstream identifier (locked).
- ``voice_diarizer.sample_rate``  = 16000 (locked).
- ``voice_diarizer.num_classes``  = 7 (locked, powerset).
- ``voice_diarizer.window_samples`` = 160000 (locked, 10 s @ 16 kHz).
- ``voice_diarizer.frames_per_window`` = 589 (locked, pyannote-3 rate).
- ``voice_diarizer.upstream_commit`` = pinned at conversion time.
- ``voice_diarizer.license`` = "MIT" (pyannote-3.0 checkpoint).

Type number for the encoder + head is fp16 for the first pass; later
passes can layer Q4_POLAR / TurboQuant on top.
"""

from __future__ import annotations

import argparse
from pathlib import Path


# ── Locked block-format constants ───────────────────────────────────────────

VOICE_DIARIZER_VARIANT = "TODO: pin upstream model identifier at conversion time"
SAMPLE_RATE = 16000
NUM_CLASSES = 7
WINDOW_SAMPLES = 160_000
FRAMES_PER_WINDOW = 589
LICENSE = "MIT"

# The 7-class powerset vocabulary — the only valid output of the head.
POWERSET_LABELS = [
    "silence",
    "speaker_a",
    "speaker_b",
    "speaker_c",
    "speaker_a_b",
    "speaker_a_c",
    "speaker_b_c",
]

VOICE_DIARIZER_UPSTREAM_COMMIT = "TODO: pin upstream commit at conversion time"


def discover_tensors(checkpoint_path: Path) -> dict[str, object]:
    """Walk the pyannote-3 checkpoint and return a {name: tensor} map.

    TODO:
      - Open the upstream `pyannote-audio` PyTorch checkpoint
        (`torch.load(...)`).
      - Walk SincNet → LSTM → classifier head, stripping the
        `pyannote_audio_*` wrapper prefix.
      - Refuse unknown keys (silent acceptance hides upstream
        renames).
      - Return a stable, sorted mapping keyed by GGUF tensor name.
    """
    raise NotImplementedError("discover_tensors: see TODO")


def write_gguf(*, tensors: dict[str, object], output_path: Path) -> dict[str, object]:
    """Emit the GGUF file.

    TODO:
      - Initialize `gguf.GGUFWriter(str(output_path), arch="voice_diarizer")`.
      - Write the metadata keys documented at the top of this file.
      - Pack tensors as fp16 by default.
      - Return a small stats dict.
    """
    raise NotImplementedError("write_gguf: see TODO")


def convert(*, checkpoint: Path, output_path: Path) -> dict[str, object]:
    if not checkpoint.exists():
        raise FileNotFoundError(checkpoint)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    tensors = discover_tensors(checkpoint)
    return write_gguf(tensors=tensors, output_path=output_path)


def _build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    p.add_argument(
        "--checkpoint",
        type=Path,
        required=True,
        help="Path to the pyannote-segmentation-3.0 PyTorch checkpoint.",
    )
    p.add_argument(
        "--output",
        type=Path,
        required=True,
        help="Output GGUF path.",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_arg_parser().parse_args(argv)
    convert(checkpoint=args.checkpoint, output_path=args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
