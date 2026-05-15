#!/usr/bin/env python3
"""Convert a speaker-embedding encoder checkpoint to a GGUF file the
voice-classifier-cpp runtime will load through its ggml dispatcher.

This is a SKELETON. The TODO blocks below mark the work the real
conversion will do; they intentionally raise NotImplementedError so a
caller cannot mistake the stub for a working converter.

Suggested upstream
------------------
- `speechbrain/spkrec-ecapa-voxceleb` (Apache-2.0). ECAPA-TDNN
  trained on VoxCeleb, native 192-dim embedding — matches the output
  dim the C-side header pins (`VOICE_SPEAKER_EMBEDDING_DIM`).

The legacy WeSpeaker ResNet34-LM encoder used today
(`plugins/plugin-local-inference/src/services/voice/speaker/encoder.ts`)
produces 256-dim embeddings; converting that upstream to a 192-dim
target would require a re-projection layer or re-training, so the
ECAPA upstream is the cleaner replacement target.

Inputs
------
- ``--encoder-checkpoint``: path to the upstream encoder checkpoint
  (PyTorch / safetensors).
- ``--projection-checkpoint``: optional. If the upstream's head emits
  a different dim than 192 (e.g. an x-vector with 512-dim output), pass
  a separately trained linear projection that maps to 192-dim. When
  omitted the script asserts the encoder's native dim is exactly 192.

Output
------
A GGUF file with one model bundle plus a small set of metadata keys
the runtime uses to refuse a mismatched build:

- ``voice_speaker.variant``       = upstream identifier (locked).
- ``voice_speaker.sample_rate``   = 16000 (locked).
- ``voice_speaker.n_mels``        = 80   (locked, mel front-end).
- ``voice_speaker.n_fft``         = 512  (locked).
- ``voice_speaker.hop``           = 160  (locked).
- ``voice_speaker.embedding_dim`` = 192  (locked).
- ``voice_speaker.l2_normalize``  = true (the runtime expects the
                                    encoder to L2-normalize before
                                    returning; the converter records
                                    this so a non-normalizing variant
                                    fails loudly at load time).
- ``voice_speaker.upstream_commit`` = pinned upstream commit (TODO:
                                      record at conversion time).

Type number for encoder (and projection, if present) is left as fp16
for the first pass.
"""

from __future__ import annotations

import argparse
from pathlib import Path


# ── Locked block-format constants ───────────────────────────────────────────
# Mirror the C-side header
# (`include/voice_classifier/voice_classifier.h`). The runtime checks
# each against the GGUF metadata.

VOICE_SPEAKER_VARIANT = "TODO: pin upstream model identifier at conversion time"
SAMPLE_RATE = 16000
N_MELS = 80
N_FFT = 512
HOP = 160
EMBEDDING_DIM = 192
L2_NORMALIZE = True

# Pinned upstream commit. Update when re-pulling weights and re-test
# parity. The runtime reads this key from the GGUF and refuses to load
# an unknown commit.
VOICE_SPEAKER_UPSTREAM_COMMIT = "TODO: pin upstream commit at conversion time"


def discover_encoder_tensors(checkpoint_path: Path) -> dict[str, object]:
    """Walk the speaker-encoder checkpoint and return a {name: tensor}
    map.

    TODO:
      - Open the PyTorch state_dict
        (``torch.load(checkpoint_path, map_location='cpu',
        weights_only=True)``).
      - Strip the ``module.`` / ``embedding_model.`` prefix the
        upstream adds.
      - Sanity-check tensor shapes against the reference ECAPA-TDNN
        layout (Conv1D blocks → SE blocks → attentive statistical
        pooling → linear projection). Refuse to convert on any
        unexpected key — silent acceptance hides upstream renames.
      - Return a stable, sorted mapping keyed by GGUF tensor name.
    """
    raise NotImplementedError("discover_encoder_tensors: see TODO")


def discover_projection_tensors(
    checkpoint_path: Path | None,
    encoder_native_dim: int,
) -> dict[str, object]:
    """Walk an optional projection checkpoint that maps encoder native
    dim down to EMBEDDING_DIM (192). When ``checkpoint_path`` is None
    this function asserts ``encoder_native_dim == EMBEDDING_DIM`` and
    returns an empty dict.

    TODO:
      - When checkpoint_path is None: assert encoder_native_dim ==
        EMBEDDING_DIM. Refuse to convert otherwise — silently truncating
        / padding the embedding to the target dim is the wrong fix.
      - When checkpoint_path is provided: load the state_dict, expect a
        single ``weight`` (and optional ``bias``) tensor whose
        ``out_features == EMBEDDING_DIM`` and ``in_features ==
        encoder_native_dim``. Refuse to convert on shape mismatch.
    """
    raise NotImplementedError("discover_projection_tensors: see TODO")


def write_gguf(
    *,
    encoder_tensors: dict[str, object],
    projection_tensors: dict[str, object],
    output_path: Path,
) -> dict[str, object]:
    """Emit the GGUF file.

    TODO:
      - Initialize ``gguf.GGUFWriter(str(output_path), arch="voice_speaker")``.
      - Write the metadata keys documented at the top of this file:
        variant, sample_rate, n_mels, n_fft, hop, embedding_dim,
        l2_normalize, upstream_commit.
      - Pack encoder + projection tensors as fp16 by default.
      - Return a small stats dict
        (n_tensors_encoder, n_tensors_projection, output_path).
    """
    raise NotImplementedError("write_gguf: see TODO")


def convert(
    *,
    encoder_checkpoint: Path,
    projection_checkpoint: Path | None,
    output_path: Path,
) -> dict[str, object]:
    """Drive the conversion. Returns a small stats dict."""
    if not encoder_checkpoint.exists():
        raise FileNotFoundError(encoder_checkpoint)
    if projection_checkpoint is not None and not projection_checkpoint.exists():
        raise FileNotFoundError(projection_checkpoint)

    output_path.parent.mkdir(parents=True, exist_ok=True)

    encoder_tensors = discover_encoder_tensors(encoder_checkpoint)
    # The projection helper needs to know the encoder's native output
    # dim to validate; the real `discover_encoder_tensors` will surface
    # that via a sentinel key in the returned map. The converter passes
    # it through here.
    encoder_native_dim_obj = encoder_tensors.get("__native_embedding_dim__")
    if not isinstance(encoder_native_dim_obj, int):
        raise NotImplementedError(
            "discover_encoder_tensors must surface "
            "'__native_embedding_dim__' (int) in its returned map"
        )
    projection_tensors = discover_projection_tensors(
        projection_checkpoint, encoder_native_dim_obj,
    )

    return write_gguf(
        encoder_tensors=encoder_tensors,
        projection_tensors=projection_tensors,
        output_path=output_path,
    )


def _build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    p.add_argument(
        "--encoder-checkpoint", type=Path, required=True,
        help="Path to the upstream speaker-encoder checkpoint.",
    )
    p.add_argument(
        "--projection-checkpoint", type=Path, default=None,
        help=(
            "Optional path to a linear projection checkpoint that maps "
            "encoder native dim down to 192-dim. Required when the "
            "encoder's native output dim is not 192."
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
        projection_checkpoint=args.projection_checkpoint,
        output_path=args.output,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
