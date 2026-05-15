#!/usr/bin/env python3
"""Convert the BlazeFace front-model checkpoint (Google MediaPipe) into
a GGUF file the face-cpp runtime will load through its ggml dispatcher.

This is a SKELETON. The TODO blocks below mark the work the real
conversion will do; they intentionally raise NotImplementedError so a
caller cannot mistake the stub for a working converter.

Inputs
------
- ``--checkpoint``: path to the BlazeFace front-model weights. The
  canonical upstream is the 128x128 ``face_detection_front.tflite``
  shipped with mediapipe:
    https://github.com/google/mediapipe/blob/master/mediapipe/modules/face_detection/face_detection_front.tflite
  Several PyTorch ports exist (e.g. hollance/BlazeFace-PyTorch); the
  conversion path here addresses tensors by their PyTorch state-dict
  names because that's the more stable surface.

Output
------
A GGUF file with one model bundle plus a small set of metadata keys
the runtime uses to refuse a mismatched build:

- ``face.detector``           = "blazeface_front" (locked).
- ``face.detector_input_size``= 128 (BlazeFace front-model convention).
- ``face.anchor_count``       = 896 (matches FACE_DETECTOR_ANCHOR_COUNT).
- ``face.anchor_strides``     = [8, 16] (locked schedule).
- ``face.anchor_per_cell``    = [2, 6] (locked schedule).
- ``face.upstream_commit``    = pinned google/mediapipe commit (TODO:
                                 record at conversion time so the
                                 runtime can refuse loads from an
                                 older or newer fork).

Type number for the convolution weights is left as fp16 for the first
pass; later passes can layer Q4_POLAR / TurboQuant on top using the
same conversion path that ``polarquant_to_gguf.py`` demonstrates.

The architecture is small enough (~250 KB at fp16) that quantizing the
detector head is mostly a curiosity — the model is dominated by ~40
3x3 depthwise + pointwise convolutions and a single classification +
regression head per stride.
"""

from __future__ import annotations

import argparse
from pathlib import Path


# ── Locked block-format constants ───────────────────────────────────────────
# Must agree with FACE_DETECTOR_INPUT_SIZE / FACE_DETECTOR_ANCHOR_COUNT in
# include/face/face.h. Changing either side without the other is a hard
# load failure at runtime.

DETECTOR_NAME = "blazeface_front"
DETECTOR_INPUT_SIZE = 128
ANCHOR_COUNT = 896
ANCHOR_STRIDES = (8, 16)
ANCHOR_PER_CELL = (2, 6)

# Pinned upstream commit. Update when re-pulling weights and re-test
# parity against the MediaPipe reference. The runtime reads this key
# from the GGUF and refuses to load an unknown commit.
BLAZEFACE_UPSTREAM_COMMIT = "TODO: pin google/mediapipe commit at conversion time"


def discover_blazeface_tensors(checkpoint_path: Path) -> dict[str, object]:
    """Walk the BlazeFace state_dict and return a {name: tensor} map.

    TODO:
      - Open the PyTorch state_dict (``torch.load(checkpoint_path,
        map_location='cpu', weights_only=True)``) for the
        hollance/BlazeFace-PyTorch port, OR parse the .tflite directly
        with tflite-runtime / iree-import-tflite.
      - Strip the wrapper prefix the port adds.
      - Sanity-check tensor shapes against the reference architecture
        (BlazeBlock backbone with 16/24/24/24/48/48/48/96/96 channels;
        two classifier heads + two regressor heads at strides 8 and
        16). Refuse to convert on any unexpected key — silent
        acceptance hides upstream renames.
      - Return a stable, sorted mapping keyed by GGUF tensor name.
    """
    raise NotImplementedError("discover_blazeface_tensors: see TODO")


def write_gguf(
    *,
    tensors: dict[str, object],
    output_path: Path,
) -> dict[str, object]:
    """Emit the GGUF file.

    TODO:
      - Initialize ``gguf.GGUFWriter(str(output_path), arch="face")``.
      - Write the metadata keys documented at the top of this file.
      - Pack the convolution weights as fp16 by default.
      - Return a small stats dict (n_tensors, output_path).
    """
    raise NotImplementedError("write_gguf: see TODO")


def convert(
    *,
    checkpoint: Path,
    output_path: Path,
) -> dict[str, object]:
    """Drive the conversion. Returns a small stats dict."""
    if not checkpoint.exists():
        raise FileNotFoundError(checkpoint)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    tensors = discover_blazeface_tensors(checkpoint)
    return write_gguf(tensors=tensors, output_path=output_path)


def _build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    p.add_argument(
        "--checkpoint", type=Path, required=True,
        help="Path to the BlazeFace front-model checkpoint (.pt or .tflite).",
    )
    p.add_argument(
        "--output", type=Path, required=True,
        help="Output GGUF path.",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_arg_parser().parse_args(argv)
    convert(checkpoint=args.checkpoint, output_path=args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
