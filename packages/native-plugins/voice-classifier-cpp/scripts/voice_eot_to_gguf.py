#!/usr/bin/env python3
"""Convert an audio-side end-of-turn (EOT) detector checkpoint to a
GGUF file the voice-classifier-cpp runtime will load through its ggml
dispatcher.

This is a SKELETON. The TODO blocks below mark the work the real
conversion will do; they intentionally raise NotImplementedError so a
caller cannot mistake the stub for a working converter.

Suggested upstreams
-------------------
- `livekit/turn-detector` audio variants (the published HF repo today
  ships text-side variants — see
  `plugins/plugin-local-inference/src/services/voice/eot-classifier.ts`
  for the text-side wiring; this library targets the audio-side
  detector that pairs with them).
- `pipecat-ai/turn` — open-source turn-detection-from-audio model.
- A whisper-derived turn-completion classifier built on top of a
  Distil-Whisper or whisper-small encoder with a sigmoid head.

Inputs
------
- ``--encoder-checkpoint``: path to the upstream audio encoder
  checkpoint (PyTorch / safetensors).
- ``--head-checkpoint``: path to the binary turn-completion head
  (linear → sigmoid). May be the same file as --encoder-checkpoint.

Output
------
A GGUF file with one model bundle plus a small set of metadata keys
the runtime uses to refuse a mismatched build:

- ``voice_eot.variant``         = upstream identifier (locked).
- ``voice_eot.sample_rate``     = 16000 (locked).
- ``voice_eot.n_mels``          = 80   (locked, mel front-end).
- ``voice_eot.n_fft``           = 512  (locked).
- ``voice_eot.hop``             = 160  (locked).
- ``voice_eot.upstream_commit`` = pinned upstream commit (TODO:
                                  record at conversion time).

Type number for encoder + head is left as fp16 for the first pass.
"""

from __future__ import annotations

import argparse
from pathlib import Path


# ── Locked block-format constants ───────────────────────────────────────────
# Mirror the C-side header
# (`include/voice_classifier/voice_classifier.h`). The runtime checks
# each against the GGUF metadata.

VOICE_EOT_VARIANT = "TODO: pin upstream model identifier at conversion time"
SAMPLE_RATE = 16000
N_MELS = 80
N_FFT = 512
HOP = 160

# Pinned upstream commit. Update when re-pulling weights and re-test
# parity. The runtime reads this key from the GGUF and refuses to load
# an unknown commit.
VOICE_EOT_UPSTREAM_COMMIT = "TODO: pin upstream commit at conversion time"


def discover_encoder_tensors(checkpoint_path: Path) -> dict[str, object]:
    """Walk the audio encoder checkpoint and return a {name: tensor}
    map.

    TODO:
      - Open the PyTorch state_dict
        (``torch.load(checkpoint_path, map_location='cpu',
        weights_only=True)``).
      - Strip the ``module.`` / ``model.`` prefix the upstream adds.
      - Sanity-check tensor shapes against the reference architecture
        (whisper-derived encoder, custom small RNN/Transformer, etc.).
        Refuse to convert on any unexpected key — silent acceptance
        hides upstream renames.
      - Return a stable, sorted mapping keyed by GGUF tensor name.
    """
    raise NotImplementedError("discover_encoder_tensors: see TODO")


def discover_head_tensors(checkpoint_path: Path) -> dict[str, object]:
    """Walk the binary EOT head checkpoint and return a {name: tensor}
    map.

    TODO:
      - Same load path as the encoder.
      - Sanity-check that the output dim is 1 (sigmoid scalar) or 2
        (softmax over [non-EOT, EOT]). Both shapes are common; the
        runtime decode reads either, but they pack differently — record
        which shape was found in the GGUF metadata so the runtime
        decode picks the matching reduction.
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
      - Initialize ``gguf.GGUFWriter(str(output_path), arch="voice_eot")``.
      - Write the metadata keys documented at the top of this file:
        variant, sample_rate, n_mels, n_fft, hop, upstream_commit, plus
        ``voice_eot.head_shape`` ("sigmoid" | "softmax2") so the
        runtime decode picks the matching reduction.
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
        help="Path to the upstream audio encoder checkpoint.",
    )
    p.add_argument(
        "--head-checkpoint", type=Path, required=True,
        help=(
            "Path to the binary EOT head checkpoint (may be the same "
            "file as --encoder-checkpoint)."
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
