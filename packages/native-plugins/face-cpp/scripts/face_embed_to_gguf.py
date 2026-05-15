#!/usr/bin/env python3
"""Convert a face-embedding network checkpoint into a GGUF the
face-cpp runtime will load through its ggml dispatcher.

This is a SKELETON. The TODO blocks below mark the work the real
conversion will do; they intentionally raise NotImplementedError so a
caller cannot mistake the stub for a working converter.

Two upstreams are supported (pick one per conversion run):

- ``insightface buffalo_s`` (recommended): ArcFace-mini variant trained
  on MS1M-V3 / refined Glint. Lightweight (~5 MB at fp16) and produces
  L2-normalized 128-d embeddings. Repo:
    https://github.com/deepinsight/insightface
  The ``buffalo_s`` pack ships ``w600k_mbf.onnx`` (MobileFaceNet
  backbone) — extract its weights to a state_dict before conversion.

- ``facenet-pytorch`` (alternative): FaceNet-style InceptionResnetV1
  trained on VGGFace2, 128-d output (the package can be configured for
  128-d via the ``num_features`` head replacement). Repo:
    https://github.com/timesler/facenet-pytorch

Both produce 128-d unit-norm embeddings, which is what
FACE_EMBED_DIM in ``include/face/face.h`` is dimensioned around.

Inputs
------
- ``--checkpoint``: path to the embedding-network weights (insightface
  ``.onnx`` or facenet-pytorch ``.pt``).
- ``--family``: ``arcface_mini_128`` or ``facenet_128`` — locked into
  the GGUF as the ``face.embedder`` key so the runtime can dispatch
  the right preprocessor.

Output
------
A GGUF file with one model bundle plus the metadata keys:

- ``face.embedder``           = one of FACE_EMBEDDER_* (locked).
- ``face.embedder_input_size``= 112 (matches FACE_EMBED_CROP_SIZE).
- ``face.embedder_dim``       = 128 (matches FACE_EMBED_DIM).
- ``face.upstream_commit``    = pinned upstream commit (TODO).

Backbones tend to be more sensitive to quantization than the BlazeFace
detector; recommend keeping fp16 for the first pass and only layering
TurboQuant / Q4_POLAR after measuring per-pair distance drift.
"""

from __future__ import annotations

import argparse
from pathlib import Path


# ── Locked block-format constants ───────────────────────────────────────────
# Must agree with FACE_EMBED_CROP_SIZE / FACE_EMBED_DIM in
# include/face/face.h.

EMBEDDER_FAMILIES = ("arcface_mini_128", "facenet_128")
EMBED_CROP_SIZE = 112
EMBED_DIM = 128

# Pinned upstream commit. Update when re-pulling weights and re-test
# parity against the chosen reference. The runtime reads this key from
# the GGUF and refuses to load an unknown commit.
EMBED_UPSTREAM_COMMIT = "TODO: pin upstream commit at conversion time"


def discover_embedder_tensors(
    checkpoint_path: Path, family: str
) -> dict[str, object]:
    """Walk the embedding-network checkpoint and return a {name:
    tensor} map.

    TODO:
      - Branch on ``family``:
          arcface_mini_128: load via onnxruntime / onnx and re-export
            the MobileFaceNet weights as fp16.
          facenet_128: load PyTorch state_dict, replace the final
            classifier head with a 128-d projection, re-fit / pull from
            the checkpoint that already has 128-d output.
      - Sanity-check tensor shapes against the reference architecture.
        Refuse to convert on any unexpected key — silent acceptance
        hides upstream renames.
      - Return a stable, sorted mapping keyed by GGUF tensor name.
    """
    raise NotImplementedError("discover_embedder_tensors: see TODO")


def write_gguf(
    *,
    family: str,
    tensors: dict[str, object],
    output_path: Path,
) -> dict[str, object]:
    """Emit the GGUF file.

    TODO:
      - Initialize ``gguf.GGUFWriter(str(output_path), arch="face")``.
      - Write the metadata keys documented at the top of this file.
      - Pack the backbone weights as fp16 by default.
      - Return a small stats dict (n_tensors, output_path).
    """
    raise NotImplementedError("write_gguf: see TODO")


def convert(
    *,
    checkpoint: Path,
    family: str,
    output_path: Path,
) -> dict[str, object]:
    """Drive the conversion. Returns a small stats dict."""
    if family not in EMBEDDER_FAMILIES:
        raise ValueError(
            f"unknown embedder family {family!r}; expected one of "
            f"{EMBEDDER_FAMILIES}"
        )
    if not checkpoint.exists():
        raise FileNotFoundError(checkpoint)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    tensors = discover_embedder_tensors(checkpoint, family)
    return write_gguf(family=family, tensors=tensors, output_path=output_path)


def _build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    p.add_argument(
        "--checkpoint", type=Path, required=True,
        help="Path to the embedding-network checkpoint.",
    )
    p.add_argument(
        "--family", choices=EMBEDDER_FAMILIES, required=True,
        help="Model family (locked into GGUF as face.embedder).",
    )
    p.add_argument(
        "--output", type=Path, required=True,
        help="Output GGUF path.",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_arg_parser().parse_args(argv)
    convert(
        checkpoint=args.checkpoint,
        family=args.family,
        output_path=args.output,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
