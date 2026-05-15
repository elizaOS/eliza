#!/usr/bin/env python3
"""Convert a voice-emotion classifier checkpoint to a GGUF file the
voice-classifier-cpp runtime will load through its ggml dispatcher.

This is a SKELETON. The TODO blocks below mark the work the real
conversion will do; they intentionally raise NotImplementedError so a
caller cannot mistake the stub for a working converter.

Suggested upstreams
-------------------
- `harshit345/xlsr-wav2vec-speech-emotion-recognition` (CC-BY-NC —
  research only; would need a license-clean replacement before
  shipping).
- `speechbrain/emotion-recognition-wav2vec2-IEMOCAP` (Apache-2.0).
- A small student distilled from
  `audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim` plus a
  V-A-D → 7-class projection table (matches the architecture used
  today by `voice-emotion-classifier.ts`).

Inputs
------
- ``--encoder-checkpoint``: path to the upstream encoder checkpoint
  (PyTorch ``.pt`` / safetensors). The encoder is whatever
  wav2vec2 / HuBERT-style backbone the upstream uses.
- ``--head-checkpoint``: path to the linear classification head that
  maps encoder features to 7 logits over the basic-emotion classes.
  The two may live in the same file; the script accepts that case
  (pass the same path twice).

Output
------
A GGUF file with one model bundle plus a small set of metadata keys
the runtime uses to refuse a mismatched build:

- ``voice_emotion.variant``      = upstream identifier (locked).
- ``voice_emotion.sample_rate``  = 16000 (locked).
- ``voice_emotion.n_mels``       = 80  (locked, mel front-end).
- ``voice_emotion.n_fft``        = 512 (locked).
- ``voice_emotion.hop``          = 160 (locked).
- ``voice_emotion.num_classes``  = 7   (locked).
- ``voice_emotion.class_order``  = JSON-encoded canonical class names
                                   in the locked order
                                   ["neutral", "happy", "sad",
                                    "angry", "fear", "disgust",
                                    "surprise"].
- ``voice_emotion.upstream_commit`` = pinned upstream commit (TODO:
                                      record at conversion time).

Type number for the encoder + head is left as fp16 for the first
pass; later passes can layer Q4_POLAR / TurboQuant on top.
"""

from __future__ import annotations

import argparse
from pathlib import Path


# ── Locked block-format constants ───────────────────────────────────────────
# These mirror the C-side header
# (`include/voice_classifier/voice_classifier.h`). The runtime checks
# each against the GGUF metadata and refuses mismatched bundles.

VOICE_EMOTION_VARIANT = "TODO: pin upstream model identifier at conversion time"
SAMPLE_RATE = 16000
N_MELS = 80
N_FFT = 512
HOP = 160
NUM_CLASSES = 7
CLASS_ORDER = [
    "neutral",
    "happy",
    "sad",
    "angry",
    "fear",
    "disgust",
    "surprise",
]

# Pinned upstream commit. Update when re-pulling weights and re-test
# parity against the upstream Python reference. The runtime reads this
# key from the GGUF and refuses to load an unknown commit.
VOICE_EMOTION_UPSTREAM_COMMIT = "TODO: pin upstream commit at conversion time"


def discover_encoder_tensors(checkpoint_path: Path) -> dict[str, object]:
    """Walk the encoder checkpoint and return a {name: tensor} map.

    TODO:
      - Open the PyTorch state_dict
        (``torch.load(checkpoint_path, map_location='cpu',
        weights_only=True)``).
      - Strip the ``module.`` / ``model.`` prefix the upstream adds.
      - Sanity-check tensor shapes against the reference architecture
        (wav2vec2 / HuBERT / SpeechBrain encoder). Refuse to convert
        on any unexpected key — silent acceptance hides upstream
        renames.
      - Return a stable, sorted mapping keyed by GGUF tensor name.
    """
    raise NotImplementedError("discover_encoder_tensors: see TODO")


def discover_head_tensors(checkpoint_path: Path) -> dict[str, object]:
    """Walk the classifier head checkpoint and return a {name: tensor}
    map. The head is the linear projection from encoder feature dim to
    7 logits.

    TODO:
      - Same load path as the encoder.
      - Sanity-check that the output dim is exactly NUM_CLASSES — refuse
        to convert otherwise; an N-class head will silently misalign
        with the locked CLASS_ORDER vocabulary.
      - If the upstream packs the head and encoder in the same file,
        accept that case (the caller passes the same path twice).
    """
    raise NotImplementedError("discover_head_tensors: see TODO")


def write_gguf(
    *,
    encoder_tensors: dict[str, object],
    head_tensors: dict[str, object],
    output_path: Path,
) -> dict[str, object]:
    """Emit the GGUF file.

    TODO:
      - Initialize ``gguf.GGUFWriter(str(output_path), arch="voice_emotion")``.
      - Write the metadata keys documented at the top of this file:
        variant, sample_rate, n_mels, n_fft, hop, num_classes,
        class_order (JSON list), upstream_commit.
      - Pack encoder + head tensors as fp16 by default.
      - Return a small stats dict
        (n_tensors_encoder, n_tensors_head, output_path).
    """
    raise NotImplementedError("write_gguf: see TODO")


def convert(
    *,
    encoder_checkpoint: Path,
    head_checkpoint: Path,
    output_path: Path,
) -> dict[str, object]:
    """Drive the conversion. Returns a small stats dict."""
    if not encoder_checkpoint.exists():
        raise FileNotFoundError(encoder_checkpoint)
    if not head_checkpoint.exists():
        raise FileNotFoundError(head_checkpoint)

    output_path.parent.mkdir(parents=True, exist_ok=True)

    encoder_tensors = discover_encoder_tensors(encoder_checkpoint)
    head_tensors = discover_head_tensors(head_checkpoint)

    return write_gguf(
        encoder_tensors=encoder_tensors,
        head_tensors=head_tensors,
        output_path=output_path,
    )


def _build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    p.add_argument(
        "--encoder-checkpoint", type=Path, required=True,
        help="Path to the upstream emotion-classifier encoder checkpoint.",
    )
    p.add_argument(
        "--head-checkpoint", type=Path, required=True,
        help=(
            "Path to the 7-class linear classification head checkpoint "
            "(may be the same file as --encoder-checkpoint)."
        ),
    )
    p.add_argument(
        "--output", type=Path, required=True,
        help="Output GGUF path.",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_arg_parser().parse_args(argv)
    convert(
        encoder_checkpoint=args.encoder_checkpoint,
        head_checkpoint=args.head_checkpoint,
        output_path=args.output,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
