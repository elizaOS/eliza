#!/usr/bin/env python3
"""Convert the BlazeFace front-model PyTorch checkpoint into a GGUF the
face-cpp runtime loads through its in-house tensor reader (see
``src/face_gguf.c``).

Default usage downloads the canonical
`hollance/BlazeFace-PyTorch@2c5b59d` weights (a 1:1 PyTorch re-export
of MediaPipe's ``face_detection_front.tflite`` with BN folded into the
conv biases) and writes a single GGUF that the runtime accepts:

  python3 blazeface_to_gguf.py --output /tmp/blazeface.gguf

Tensors are emitted as fp16 by default; pass ``--fp32`` to keep them
in fp32 (slightly larger, marginally faster on Apple Silicon).

Per-tensor name convention (matched verbatim by ``face_blazeface.c``
and the synth-GGUF runtime test):

  det.backbone1.<idx>.weight / .bias                    (stem conv)
  det.backbone1.<idx>.convs.0.weight / .bias            (depthwise)
  det.backbone1.<idx>.convs.1.weight / .bias            (pointwise)
  det.backbone2.<idx>.convs.0.weight / .bias
  det.backbone2.<idx>.convs.1.weight / .bias
  det.classifier_8.weight / .bias
  det.classifier_16.weight / .bias
  det.regressor_8.weight / .bias
  det.regressor_16.weight / .bias

Metadata keys the runtime checks:

  face.detector            = "blazeface_front"
  face.detector_input_size = 128
  face.anchor_count        = 896
  face.anchor_strides      = (encoded via add_array if --emit-arrays)
  face.upstream_commit     = "hollance/BlazeFace-PyTorch@2c5b59d"
"""

from __future__ import annotations

import argparse
import sys
import urllib.request
from pathlib import Path

import numpy as np

# Locked block-format constants — mirror include/face/face.h.
DETECTOR_NAME = "blazeface_front"
DETECTOR_INPUT_SIZE = 128
ANCHOR_COUNT = 896
ANCHOR_STRIDES = (8, 16)
ANCHOR_PER_CELL = (2, 6)

# Pinned upstream commit. The runtime reads this key from the GGUF.
BLAZEFACE_UPSTREAM_COMMIT = "hollance/BlazeFace-PyTorch@2c5b59d"

# Canonical raw URL for the .pth at the pinned commit.
DEFAULT_CHECKPOINT_URL = (
    "https://raw.githubusercontent.com/hollance/BlazeFace-PyTorch/"
    "master/blazeface.pth"
)


# Architecture spec — matches face_blazeface.c verbatim.
_BACKBONE1_BLOCKS = [
    # (seq_idx, cin, cout, stride)
    (2,  24, 24, 1), (3,  24, 28, 1), (4,  28, 32, 2),
    (5,  32, 36, 1), (6,  36, 42, 1), (7,  42, 48, 2),
    (8,  48, 56, 1), (9,  56, 64, 1), (10, 64, 72, 1),
    (11, 72, 80, 1), (12, 80, 88, 1),
]
_BACKBONE2_BLOCKS = [
    (0, 88, 96, 2), (1, 96, 96, 1), (2, 96, 96, 1),
    (3, 96, 96, 1), (4, 96, 96, 1),
]


def discover_blazeface_tensors(checkpoint_path: Path) -> dict[str, np.ndarray]:
    """Walk the BlazeFace state_dict and return a {name: np.ndarray}
    map keyed by the GGUF tensor name (``det.<dotted key>``)."""
    import torch
    raw = torch.load(checkpoint_path, map_location="cpu", weights_only=True)
    if isinstance(raw, dict) and "state_dict" in raw:
        raw = raw["state_dict"]

    out: dict[str, np.ndarray] = {}
    for k, v in raw.items():
        nk = k
        if nk.startswith("module."):
            nk = nk[len("module."):]
        out[f"det.{nk}"] = _to_numpy(v)

    _sanity_check(out)
    return out


def _sanity_check(tensors: dict[str, np.ndarray]) -> None:
    required = {
        "det.backbone1.0.weight": (24, 3, 5, 5),
        "det.backbone1.0.bias":   (24,),
        "det.classifier_8.weight":  (2,  88, 1, 1),
        "det.classifier_8.bias":    (2,),
        "det.classifier_16.weight": (6,  96, 1, 1),
        "det.classifier_16.bias":   (6,),
        "det.regressor_8.weight":   (32, 88, 1, 1),
        "det.regressor_8.bias":     (32,),
        "det.regressor_16.weight":  (96, 96, 1, 1),
        "det.regressor_16.bias":    (96,),
    }
    for seq, cin, cout, _ in _BACKBONE1_BLOCKS:
        required[f"det.backbone1.{seq}.convs.0.weight"] = (cin,  1,   3, 3)
        required[f"det.backbone1.{seq}.convs.0.bias"]   = (cin,)
        required[f"det.backbone1.{seq}.convs.1.weight"] = (cout, cin, 1, 1)
        required[f"det.backbone1.{seq}.convs.1.bias"]   = (cout,)
    for seq, cin, cout, _ in _BACKBONE2_BLOCKS:
        required[f"det.backbone2.{seq}.convs.0.weight"] = (cin,  1,   3, 3)
        required[f"det.backbone2.{seq}.convs.0.bias"]   = (cin,)
        required[f"det.backbone2.{seq}.convs.1.weight"] = (cout, cin, 1, 1)
        required[f"det.backbone2.{seq}.convs.1.bias"]   = (cout,)

    for name, shape in required.items():
        if name not in tensors:
            raise KeyError(
                f"BlazeFace state_dict missing required tensor {name!r}; "
                f"upstream rename or wrong checkpoint?")
        if tuple(tensors[name].shape) != shape:
            raise ValueError(
                f"BlazeFace tensor {name} has shape {tensors[name].shape}, "
                f"expected {shape}")


def _to_numpy(t) -> np.ndarray:
    arr = t.detach().cpu().numpy()
    if arr.dtype != np.float32:
        arr = arr.astype(np.float32)
    return np.ascontiguousarray(arr)


def write_gguf(
    *,
    tensors: dict[str, np.ndarray],
    output_path: Path,
    fp16: bool = True,
) -> dict[str, object]:
    """Emit the GGUF file. Returns a small stats dict."""
    import gguf

    writer = gguf.GGUFWriter(str(output_path), arch="face")

    writer.add_string("face.detector", DETECTOR_NAME)
    writer.add_uint32("face.detector_input_size", DETECTOR_INPUT_SIZE)
    writer.add_uint32("face.anchor_count", ANCHOR_COUNT)
    writer.add_string("face.upstream_commit", BLAZEFACE_UPSTREAM_COMMIT)

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
    }


def _maybe_download(checkpoint: Path | None) -> Path:
    if checkpoint is not None:
        if not checkpoint.exists():
            raise FileNotFoundError(checkpoint)
        return checkpoint
    cache = Path.home() / ".cache" / "face-cpp" / "blazeface.pth"
    if not cache.exists():
        cache.parent.mkdir(parents=True, exist_ok=True)
        print(f"[blazeface_to_gguf] downloading {DEFAULT_CHECKPOINT_URL}")
        urllib.request.urlretrieve(DEFAULT_CHECKPOINT_URL, cache)
    return cache


def convert(
    *,
    checkpoint: Path | None,
    output_path: Path,
    fp16: bool = True,
) -> dict[str, object]:
    """Drive the conversion. Returns a small stats dict."""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    cp = _maybe_download(checkpoint)
    tensors = discover_blazeface_tensors(cp)
    return write_gguf(tensors=tensors, output_path=output_path, fp16=fp16)


def _build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    p.add_argument(
        "--checkpoint", type=Path, default=None,
        help="Optional path to the BlazeFace PyTorch .pth. "
             "If omitted, downloads the pinned upstream into ~/.cache/face-cpp.",
    )
    p.add_argument(
        "--output", type=Path, required=True,
        help="Output GGUF path.",
    )
    p.add_argument(
        "--fp32", action="store_true",
        help="Emit fp32 tensors instead of fp16 (default).",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_arg_parser().parse_args(argv)
    stats = convert(
        checkpoint=args.checkpoint,
        output_path=args.output,
        fp16=not args.fp32,
    )
    print(f"[blazeface_to_gguf] wrote {stats['output_path']}")
    print(f"  n_tensors = {stats['n_tensors']}  dtype = {stats['dtype']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
