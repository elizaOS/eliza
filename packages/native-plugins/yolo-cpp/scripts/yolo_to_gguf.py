#!/usr/bin/env python3
"""Convert an Ultralytics YOLOv8n / YOLOv11n PyTorch checkpoint into a
single GGUF the yolo-cpp runtime loads through its in-house tensor
reader (``src/yolo_gguf.c``).

Default usage downloads the pretrained ``yolov8n.pt`` from the
ultralytics CDN on first run and writes a single GGUF:

  python3 yolo_to_gguf.py --variant yolov8n --output /tmp/yolov8n.gguf

Required dep:

  pip install --break-system-packages ultralytics

Tensors are emitted as fp32 for the first pass. Phase 3 will layer
Q4_POLAR / TurboQuant on top using the same per-tensor type override
the GGUF format already supports (mirrors ``polarquant_to_gguf.py``).

Per-tensor name convention (read by ``yolo_gguf.c``):

  <ultralytics state_dict key>     verbatim, e.g. ``model.0.conv.weight``

The dotted key is the PyTorch ``state_dict`` key verbatim. The C
runtime indexes by string, so renames here are renames in the C
runtime too — keep them stable.

BatchNorm tensors (``*.bn.weight``, ``*.bn.bias``, ``*.bn.running_mean``,
``*.bn.running_var``) ride along as fp32 sidecars; the runtime fuses
them into the preceding Conv at session-open time. The standard YOLO
BN epsilon (``1e-3`` per ``BatchNorm2d`` default) is recorded once as
``yolo.bn_eps`` rather than per-layer — Ultralytics does not vary it.

The decoupled head's DFL projection lives at ``model.22.dfl.conv.weight``
(yolov8) / ``model.23.dfl.conv.weight`` (yolov11) and is emitted under
its native key.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np


# ── Locked block-format constants — must match include/yolo/yolo.h ─────────
INPUT_SIZE = 640
NUM_CLASSES = 80
DFL_BINS = 16
SUPPORTED_VARIANTS = ("yolov8n", "yolov11n")
# Strides of the three detection scales (P3, P4, P5).
DETECTION_STRIDES = (8, 16, 32)
# YOLOv8 default BatchNorm2d epsilon (Ultralytics overrides PyTorch's
# 1e-5 default to 1e-3 in the BN constructors). Constant across layers.
BN_EPS_DEFAULT = 1e-3

# Pinned upstream commit. Ultralytics tag v8.4.51 = this commit. The
# runtime reads ``yolo.upstream_commit`` from the GGUF and rejects an
# unknown commit. Update both this constant and AGENTS.md when bumping.
ULTRALYTICS_UPSTREAM_COMMIT = "14ea57b11969cd872f15291e5d0bdc965bdb59f7"
ULTRALYTICS_UPSTREAM_TAG = "v8.4.51"


# ── tensor discovery ───────────────────────────────────────────────────────

def discover_tensors(checkpoint_path: Path | None, variant: str) -> dict[str, np.ndarray]:
    """Walk the Ultralytics state_dict and return a {name: np.ndarray} map
    keyed by the GGUF tensor name (the ultralytics dotted key, verbatim).

    If ``checkpoint_path`` is ``None`` the ultralytics pretrained weights
    are downloaded for the requested variant; otherwise the file at the
    given path is loaded directly.
    """
    state_dict = _load_state_dict(checkpoint_path, variant=variant)
    out: dict[str, np.ndarray] = {}
    for key, tensor in state_dict.items():
        # num_batches_tracked is a 0-d int64 scalar that BN never
        # consumes during inference — drop it.
        if key.endswith(".num_batches_tracked"):
            continue
        # Some Ultralytics checkpoints carry duplicate / EMA copies; the
        # state_dict we pull is the inference net, but we keep a hard
        # whitelist to stay strict.
        if not key.startswith("model."):
            raise KeyError(
                f"unexpected state_dict key {key!r} — wrong checkpoint?")
        arr = _to_numpy(tensor)
        if arr.ndim not in (1, 4):
            raise ValueError(
                f"tensor {key!r} has unexpected rank {arr.ndim} "
                f"(shape {arr.shape}); only 1-D (BN/bias) and 4-D (Conv) supported")
        out[key] = arr
    _sanity_check(out, variant)
    return out


def write_gguf(
    *,
    tensors: dict[str, np.ndarray],
    variant: str,
    output_path: Path,
) -> dict[str, object]:
    """Emit the GGUF file. Returns a small stats dict."""
    import gguf

    writer = gguf.GGUFWriter(str(output_path), arch="yolo")

    # ── metadata ─────────────────────────────────────────────────────────
    writer.add_string("yolo.detector", variant)
    writer.add_uint32("yolo.input_size", INPUT_SIZE)
    writer.add_uint32("yolo.num_classes", NUM_CLASSES)
    writer.add_uint32("yolo.dfl_bins", DFL_BINS)
    writer.add_string("yolo.upstream_commit", ULTRALYTICS_UPSTREAM_COMMIT)
    writer.add_string("yolo.upstream_tag", ULTRALYTICS_UPSTREAM_TAG)
    writer.add_float32("yolo.bn_eps", float(BN_EPS_DEFAULT))
    # Strides as a fixed-length array (3 entries: P3, P4, P5).
    writer.add_array("yolo.strides", list(DETECTION_STRIDES))

    # ── tensors ──────────────────────────────────────────────────────────
    # Conv2D weights (4-D) go fp16 to halve disk size; BN params + DFL
    # projection stay fp32 for precision (BN is precision-sensitive,
    # DFL is tiny). Sorted for determinism.
    n_conv_fp16 = 0
    n_bn_fp32 = 0
    for name in sorted(tensors.keys()):
        arr = tensors[name]
        if arr.ndim == 4:
            # Conv2d weight (rank 4 OIhw). Pack as fp16.
            writer.add_tensor(name, arr.astype(np.float16))
            n_conv_fp16 += 1
        else:
            # 1-D BN/bias scalar vector. Stay fp32.
            writer.add_tensor(name, arr.astype(np.float32))
            n_bn_fp32 += 1

    writer.write_header_to_file()
    writer.write_kv_data_to_file()
    writer.write_tensors_to_file()
    writer.close()

    return {
        "n_tensors_total": len(tensors),
        "n_tensors_conv_fp16": n_conv_fp16,
        "n_tensors_bn_fp32": n_bn_fp32,
        "variant": variant,
        "output_path": str(output_path),
        "upstream_commit": ULTRALYTICS_UPSTREAM_COMMIT,
        "upstream_tag": ULTRALYTICS_UPSTREAM_TAG,
    }


# ── helpers ────────────────────────────────────────────────────────────────

def _load_state_dict(checkpoint_path: Path | None, *, variant: str) -> dict:
    """Either load the supplied torch checkpoint or download Ultralytics'
    pretrained default. Returns a plain ``{str: torch.Tensor}`` dict.
    """
    if variant not in SUPPORTED_VARIANTS:
        raise ValueError(
            f"unsupported variant {variant!r}; expected one of {SUPPORTED_VARIANTS}")
    from ultralytics import YOLO  # type: ignore[import-not-found]
    if checkpoint_path is not None:
        m = YOLO(str(checkpoint_path))
    else:
        # YOLO("yolov8n.pt") triggers the download to the ultralytics
        # cache on first run (CDN: github.com/ultralytics/assets).
        m = YOLO(f"{variant}.pt")
    sd = m.model.state_dict()
    return dict(sd)


def _to_numpy(t) -> np.ndarray:
    arr = t.detach().cpu().numpy()
    return np.ascontiguousarray(arr)


# Reference tensors — the exact names + shapes we expect from the
# pretrained pin. Used to refuse silent upstream renames. Keep these in
# sync when bumping ULTRALYTICS_UPSTREAM_COMMIT.
_YOLOV8N_REQUIRED = {
    "model.0.conv.weight": (16, 3, 3, 3),
    "model.0.bn.weight": (16,),
    "model.0.bn.bias": (16,),
    "model.0.bn.running_mean": (16,),
    "model.0.bn.running_var": (16,),
    # Last backbone Conv before SPPF.
    "model.9.cv1.conv.weight": (128, 256, 1, 1),
    # Head DFL projection — a fixed 1x16 row that decodes anchor
    # distributions back to (left, top, right, bottom) offsets.
    "model.22.dfl.conv.weight": (1, 16, 1, 1),
    # Head class-branch final conv (per scale, 80 outputs). The mid
    # channel count is max(out_ch_of_branch_0, num_classes) per
    # Ultralytics' Detect head — 80 across the board for yolov8n.
    "model.22.cv3.0.2.weight": (80, 80, 1, 1),
    "model.22.cv3.0.2.bias": (80,),
    "model.22.cv3.2.2.weight": (80, 80, 1, 1),
    "model.22.cv3.2.2.bias": (80,),
    # Head box-branch final conv (per scale, 4*16=64 outputs).
    "model.22.cv2.0.2.weight": (64, 64, 1, 1),
    "model.22.cv2.0.2.bias": (64,),
    "model.22.cv2.2.2.weight": (64, 64, 1, 1),
    "model.22.cv2.2.2.bias": (64,),
}

_YOLOV11N_REQUIRED = {
    "model.0.conv.weight": (16, 3, 3, 3),
    "model.0.bn.weight": (16,),
    # YOLOv11 head moves to model.23.
    "model.23.dfl.conv.weight": (1, 16, 1, 1),
}


def _sanity_check(tensors: dict[str, np.ndarray], variant: str) -> None:
    required = _YOLOV8N_REQUIRED if variant == "yolov8n" else _YOLOV11N_REQUIRED
    missing = []
    mismatched = []
    for name, expected_shape in required.items():
        if name not in tensors:
            missing.append(name)
            continue
        actual = tuple(tensors[name].shape)
        if actual != expected_shape:
            mismatched.append((name, actual, expected_shape))
    if missing:
        raise KeyError(
            f"{variant}: missing required tensors {missing[:5]}"
            f"{'... (+more)' if len(missing) > 5 else ''}; upstream rename "
            f"or wrong checkpoint?")
    if mismatched:
        details = ", ".join(f"{n}: got {a} expected {e}" for n, a, e in mismatched[:3])
        raise ValueError(
            f"{variant}: tensor shape mismatch ({details}); upstream changed?")


def convert(
    *,
    checkpoint: Path | None,
    variant: str,
    output_path: Path,
) -> dict[str, object]:
    """Drive the conversion. Returns a small stats dict."""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    tensors = discover_tensors(checkpoint, variant)
    return write_gguf(
        tensors=tensors,
        variant=variant,
        output_path=output_path,
    )


def _build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    p.add_argument(
        "--checkpoint", type=Path, default=None,
        help="Optional path to an Ultralytics .pt checkpoint. If omitted, "
             "downloads the pretrained default for the requested variant.",
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
    print(f"[yolo_to_gguf] wrote {stats['output_path']}")
    print(f"  variant              = {stats['variant']}")
    print(f"  upstream_tag         = {stats['upstream_tag']}")
    print(f"  upstream_commit      = {stats['upstream_commit']}")
    print(f"  n_tensors_total      = {stats['n_tensors_total']}")
    print(f"  n_tensors_conv_fp16  = {stats['n_tensors_conv_fp16']}")
    print(f"  n_tensors_bn_fp32    = {stats['n_tensors_bn_fp32']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
