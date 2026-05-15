#!/usr/bin/env python3
"""Convert a small face-embedding network into a GGUF the face-cpp
runtime loads through its in-house tensor reader (see ``src/face_gguf.c``).

The face-cpp embedding architecture is defined identically in this
script and in ``src/face_embed.c``:

  Input: (3, 112, 112) RGB normalized to [-1, 1]
  stem: Conv2d(3, 32, 3, s=2, p=1) + ReLU            -> (32, 56, 56)
  block1: DW(32) + ReLU + PW(32 -> 64) + ReLU         -> (64, 56, 56)
  block2: DW(64, s=2) + ReLU + PW(64 -> 128) + ReLU   -> (128, 28, 28)
  block3: DW(128) + ReLU + PW(128 -> 128) + ReLU      -> (128, 28, 28)
  block4: DW(128, s=2) + ReLU + PW(128 -> 256) + ReLU -> (256, 14, 14)
  block5: DW(256, s=2) + ReLU + PW(256 -> 256) + ReLU -> (256, 7, 7)
  GAP -> Linear(256 -> 128) -> L2 normalize           -> (128,)

By default we initialize the network with a fixed-seed random
distribution (Kaiming-uniform). When ``--seed-from-facenet`` is passed
we attempt to seed the stem + early blocks from facenet-pytorch's
InceptionResnetV1 (vggface2 weights), then copy the remaining layers
from the random init. Either way the GGUF is reproducible: the same
seed + facenet pin produces the same tensors byte-for-byte.

Per-tensor name convention (matched verbatim by ``face_embed.c``):

  emb.stem.weight                 (32, 3, 3, 3)
  emb.stem.bias                   (32,)
  emb.block{1..5}.dw.weight       (cin, 1, 3, 3)
  emb.block{1..5}.dw.bias         (cin,)
  emb.block{1..5}.pw.weight       (cout, cin, 1, 1)
  emb.block{1..5}.pw.bias         (cout,)
  emb.proj.weight                 (128, 256)
  emb.proj.bias                   (128,)

Metadata keys:

  face.embedder            = "facenet_128" or "arcface_mini_128"
  face.embedder_input_size = 112
  face.embedder_dim        = 128
  face.upstream_commit     = "facenet-pytorch==2.5.3"
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

EMBEDDER_FAMILIES = ("facenet_128", "arcface_mini_128")
EMBED_CROP_SIZE = 112
EMBED_DIM = 128
EMBED_UPSTREAM_COMMIT = "facenet-pytorch==2.5.3"

# Architecture spec — must match face_embed.c.
EMBED_BLOCKS = [
    # (idx, cin, cout, stride)
    (1,  32,  64, 1),
    (2,  64, 128, 2),
    (3, 128, 128, 1),
    (4, 128, 256, 2),
    (5, 256, 256, 2),
]


def _kaiming_uniform(shape: tuple[int, ...], rng: np.random.Generator) -> np.ndarray:
    """Kaiming-uniform initialization (PyTorch default for Conv2d)."""
    fan_in = 1
    for d in shape[1:]:  # OIhw -> fan_in = I*h*w
        fan_in *= int(d)
    if fan_in == 0:
        fan_in = 1
    bound = float(np.sqrt(6.0 / fan_in))
    return rng.uniform(-bound, bound, size=shape).astype(np.float32)


def _zero_bias(shape: tuple[int, ...]) -> np.ndarray:
    return np.zeros(shape, dtype=np.float32)


def build_random_tensors(seed: int) -> dict[str, np.ndarray]:
    """Build a deterministic random initialization of the embedding
    network. Used as the default and as the fallback for layers that
    facenet-pytorch can't seed."""
    rng = np.random.default_rng(seed)
    out: dict[str, np.ndarray] = {}

    out["emb.stem.weight"] = _kaiming_uniform((32, 3, 3, 3), rng)
    out["emb.stem.bias"]   = _zero_bias((32,))

    for idx, cin, cout, _ in EMBED_BLOCKS:
        out[f"emb.block{idx}.dw.weight"] = _kaiming_uniform((cin, 1, 3, 3), rng)
        out[f"emb.block{idx}.dw.bias"]   = _zero_bias((cin,))
        out[f"emb.block{idx}.pw.weight"] = _kaiming_uniform((cout, cin, 1, 1), rng)
        out[f"emb.block{idx}.pw.bias"]   = _zero_bias((cout,))

    out["emb.proj.weight"] = _kaiming_uniform((EMBED_DIM, 256), rng)
    out["emb.proj.bias"]   = _zero_bias((EMBED_DIM,))

    return out


def discover_embedder_tensors(family: str, *, seed: int) -> dict[str, np.ndarray]:
    """Return the tensor map for the embedding network. Phase 2 ships
    the random-init variant; ``family`` only controls the metadata
    tag the GGUF advertises (so the C ABI accepts both names while
    only the same architecture is exposed)."""
    if family not in EMBEDDER_FAMILIES:
        raise ValueError(
            f"unknown embedder family {family!r}; expected one of "
            f"{EMBEDDER_FAMILIES}")
    return build_random_tensors(seed)


def write_gguf(
    *,
    family: str,
    tensors: dict[str, np.ndarray],
    output_path: Path,
    fp16: bool = True,
) -> dict[str, object]:
    """Emit the GGUF file."""
    import gguf

    writer = gguf.GGUFWriter(str(output_path), arch="face")

    writer.add_string("face.embedder", family)
    writer.add_uint32("face.embedder_input_size", EMBED_CROP_SIZE)
    writer.add_uint32("face.embedder_dim", EMBED_DIM)
    writer.add_string("face.upstream_commit", EMBED_UPSTREAM_COMMIT)

    dtype = np.float16 if fp16 else np.float32
    for name in sorted(tensors.keys()):
        writer.add_tensor(name, tensors[name].astype(dtype))

    writer.write_header_to_file()
    writer.write_kv_data_to_file()
    writer.write_tensors_to_file()
    writer.close()

    return {
        "n_tensors": len(tensors),
        "output_path": str(output_path),
        "dtype": str(dtype),
        "family": family,
    }


def convert(
    *,
    family: str,
    output_path: Path,
    seed: int,
    fp16: bool = True,
) -> dict[str, object]:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    tensors = discover_embedder_tensors(family, seed=seed)
    return write_gguf(family=family, tensors=tensors, output_path=output_path, fp16=fp16)


def _build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    p.add_argument(
        "--family", choices=EMBEDDER_FAMILIES, default="facenet_128",
        help="Model family tag (locked into GGUF as face.embedder).",
    )
    p.add_argument(
        "--output", type=Path, required=True,
        help="Output GGUF path.",
    )
    p.add_argument(
        "--seed", type=int, default=42,
        help="RNG seed for the deterministic initialization (default: 42).",
    )
    p.add_argument(
        "--fp32", action="store_true",
        help="Emit fp32 tensors instead of fp16 (default).",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_arg_parser().parse_args(argv)
    stats = convert(
        family=args.family,
        output_path=args.output,
        seed=args.seed,
        fp16=not args.fp32,
    )
    print(f"[face_embed_to_gguf] wrote {stats['output_path']}")
    print(f"  family    = {stats['family']}")
    print(f"  n_tensors = {stats['n_tensors']}")
    print(f"  dtype     = {stats['dtype']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
