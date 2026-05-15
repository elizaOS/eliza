#!/usr/bin/env python3
"""Convert an Ultralytics YOLOv8n / YOLOv11n PyTorch checkpoint into a
single GGUF file that the yolo-cpp runtime will load through its ggml
dispatcher.

This is a SKELETON. The TODO blocks below mark the work the real
conversion will do; they intentionally raise NotImplementedError so a
caller cannot mistake the stub for a working converter.

Inputs
------
- ``--checkpoint``: path to an Ultralytics ``.pt`` checkpoint
  (e.g. ``yolov8n.pt`` or ``yolov11n.pt``). Ultralytics publishes both
  on their releases page; PyTorch ``.pt`` is the canonical format
  here because it preserves the named module hierarchy we read by
  string when packing.
- ``--variant``: must be ``yolov8n`` or ``yolov11n``. The runtime
  refuses to load a GGUF whose ``yolo.detector`` key is anything else.
- ``--output``: output GGUF path.

Output
------
A GGUF file with one model bundle plus a small set of metadata keys
the runtime uses to refuse a mismatched build:

- ``yolo.detector``        = "yolov8n" or "yolov11n" (locked).
- ``yolo.input_size``      = 640 (square, locked for both variants).
- ``yolo.num_classes``     = 80 (COCO).
- ``yolo.upstream_commit`` = pinned ultralytics/ultralytics commit
                             (TODO: record at conversion time so the
                             runtime can refuse loads from an older or
                             newer fork).

Tensor layout
-------------
The conversion packs each Conv2d weight as a single fp16 tensor and
each BatchNorm2d's running stats (gamma, beta, running_mean,
running_var, eps) as fp32 sidecar tensors keyed by the same module
path. The runtime fuses BN into the preceding Conv at session-open
time (Phase 2 implementation), so on disk both stay separated to keep
the conversion auditable.

The decoupled head's Distribution Focal Loss (DFL) projection
weights are emitted under ``model.<idx>.dfl.conv.weight`` exactly as
Ultralytics' state_dict names them; the runtime applies the DFL +
stride decode in the ggml graph (no preprocessing of head weights at
conversion time, so a follow-up DFL update upstream is a one-line
script change).

Architecture references (used to validate state-dict keys)
----------------------------------------------------------
- Backbone: CSPDarknet (YOLOv8n) / C2f-PSA backbone (YOLOv11n).
- Neck: PANet (FPN top-down + bottom-up paths).
- Head: decoupled box / class head, no anchor boxes (per-grid
  prediction). 4 + 80 = 84 channels per anchor cell.

The conversion script does NOT need to understand the full graph; it
just walks ``ckpt['model'].state_dict()`` and emits one GGUF tensor
per parameter. The runtime's ggml graph builder is the side that
knows how to wire those tensors into Conv -> BN -> SiLU -> ... ops.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path


# ── Locked constants — must match include/yolo/yolo.h ───────────────────────
INPUT_SIZE = 640
NUM_CLASSES = 80
SUPPORTED_VARIANTS = ("yolov8n", "yolov11n")

# Pinned upstream commit. Update when re-pulling weights and re-test
# parity against the Ultralytics Python reference. The runtime reads
# this key from the GGUF and refuses to load an unknown commit.
ULTRALYTICS_UPSTREAM_COMMIT = "TODO: pin ultralytics/ultralytics commit at conversion time"


def discover_conv_tensors(state_dict: dict[str, object]) -> dict[str, object]:
    """Walk the Ultralytics state_dict and return a {name: tensor} map
    of every Conv2d weight, keyed by GGUF tensor name.

    TODO:
      - Filter ``state_dict`` to entries whose key ends in
        ``.conv.weight`` (Ultralytics' standard module naming for
        Conv2d-inside-Conv-block) and to plain ``.weight`` keys whose
        owning module is a Conv2d (the head's prediction conv).
      - Refuse any unexpected key shape (rank != 4) — silent
        acceptance hides upstream renames.
      - Cast each tensor to fp16 (numpy ``float16``); the runtime
        upcasts to fp32 on demand.
      - Return a stable, sorted mapping keyed by GGUF tensor name
        (the dotted module path, verbatim).
    """
    raise NotImplementedError("discover_conv_tensors: see TODO")


def discover_batchnorm_tensors(state_dict: dict[str, object]) -> dict[str, object]:
    """Walk the state_dict and return a {name: tensor} map of every
    BatchNorm2d's per-channel parameters and running stats.

    TODO:
      - For each ``*.bn.*`` key family, emit four fp32 tensors per BN
        layer: ``weight`` (gamma), ``bias`` (beta), ``running_mean``,
        ``running_var``. Keep them as fp32 — BN scales are tiny but
        precision-sensitive.
      - Record the BN ``eps`` as a per-tensor fp32 scalar
        (``<bn-name>.eps``); Ultralytics does not vary eps between
        layers but we record per-layer to stay forward-compatible.
      - Refuse any state_dict that has ``num_batches_tracked`` keys
        outside the BN families — that signals a mis-rebased weights
        dump.
    """
    raise NotImplementedError("discover_batchnorm_tensors: see TODO")


def discover_head_tensors(state_dict: dict[str, object], variant: str) -> dict[str, object]:
    """Walk the state_dict and return a {name: tensor} map of the
    decoupled head's box and class prediction tensors plus the DFL
    projection weights.

    TODO:
      - YOLOv8: ``model.22.cv2.{0,1,2}.{0,1,2}.{conv,bn}.*`` for the
        box branch and ``model.22.cv3.{0,1,2}.{0,1,2}.{conv,bn}.*``
        for the class branch. The DFL projection lives at
        ``model.22.dfl.conv.weight``.
      - YOLOv11: same shape, head-block index changes
        (``model.23.*``); the DFL projection is identical.
      - Refuse any other variant string — the conversion script
        cannot blindly assume head indexing.
      - Cast to fp16 (matches the conv tensors above).
    """
    raise NotImplementedError("discover_head_tensors: see TODO")


def write_gguf(
    *,
    conv_tensors: dict[str, object],
    bn_tensors: dict[str, object],
    head_tensors: dict[str, object],
    variant: str,
    output_path: Path,
) -> dict[str, object]:
    """Emit the GGUF file.

    TODO:
      - Initialize ``gguf.GGUFWriter(str(output_path), arch="yolo")``.
      - Write the metadata keys documented at the top of this file.
      - Pack the conv + head tensors as fp16 by default; pack BN
        tensors as fp32. Mirror the layering in
        ``polarquant_to_gguf.py`` for the writer-API call sequence
        (add_tensor_info -> tensor data attached -> write_*).
      - Return a small stats dict (``n_tensors_total``,
        ``n_tensors_conv``, ``n_tensors_bn``, ``n_tensors_head``,
        ``output_path``).
    """
    raise NotImplementedError("write_gguf: see TODO")


def convert(
    *,
    checkpoint: Path,
    variant: str,
    output_path: Path,
) -> dict[str, object]:
    """Drive the conversion. Returns a small stats dict."""
    if variant not in SUPPORTED_VARIANTS:
        raise ValueError(
            f"unsupported variant {variant!r}; expected one of {SUPPORTED_VARIANTS}"
        )
    if not checkpoint.exists():
        raise FileNotFoundError(checkpoint)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # TODO: load_checkpoint
    #   ckpt = torch.load(checkpoint, map_location='cpu', weights_only=False)
    #   model = ckpt['model'].float()      # Ultralytics packs nn.Module + meta
    #   state_dict = model.state_dict()
    # The ``weights_only=False`` is unavoidable here — Ultralytics
    # ckpts pickle the module class, not just tensors. Run the
    # conversion only against trusted upstream checkpoints (record
    # the pinned commit in ``ULTRALYTICS_UPSTREAM_COMMIT``).
    raise NotImplementedError(
        "convert: load_checkpoint + walk state_dict; see TODOs in this file"
    )


def _build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    p.add_argument(
        "--checkpoint", type=Path, required=True,
        help="Path to the Ultralytics .pt checkpoint.",
    )
    p.add_argument(
        "--variant", choices=SUPPORTED_VARIANTS, required=True,
        help="Detector variant — yolov8n or yolov11n.",
    )
    p.add_argument(
        "--output", type=Path, required=True, help="Output GGUF path.",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_arg_parser().parse_args(argv)
    stats = convert(
        checkpoint=args.checkpoint,
        variant=args.variant,
        output_path=args.output,
    )
    print(json.dumps(stats, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
