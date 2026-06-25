#!/usr/bin/env python3
"""
Convert Ultralytics YOLOv8 PyTorch checkpoints to GGUF for the yolo.cpp runtime.

Usage:
    python scripts/convert.py --variant yolov8n
    python scripts/convert.py --variant yolov8n --out <state-dir>/models/vision/yolov8n.gguf

Requirements (install before running):
    pip install ultralytics gguf numpy torch

License note: Ultralytics ships under AGPL-3.0. This script reads the published
weights and writes them into a GGUF; the runtime (`src/yolo.cpp`) is a
clean-room ggml implementation. No Ultralytics code is copied into this repo.

What it does
------------
Walks the DetectionModel module tree and emits one of two tensor shapes:

  * ultralytics ``Conv`` (Conv2d + BatchNorm2d + SiLU): the BatchNorm is FOLDED
    into the preceding conv at convert time, producing a plain conv weight +
    bias. Emitted as ``<module>.weight`` (folded, shape [OC,IC,KH,KW]) and
    ``<module>.bias`` (folded, [OC]).  e.g. ``model.0.weight``, ``model.2.cv1.weight``.
  * bare ``Conv2d`` (the head's per-scale stage-2 1x1 projection, which has its
    own bias and no BN): emitted verbatim as ``<module>.weight`` / ``<module>.bias``.
    e.g. ``model.22.cv2.0.2.weight``.

The DFL ``model.22.dfl.conv`` buffer (a fixed arange(16)) is intentionally
skipped — the C runtime recomputes the DFL expectation directly.

ggml reads tensor ``ne`` as the REVERSED numpy shape, so a PyTorch conv weight
of numpy shape ``(OC, IC, KH, KW)`` is read by ggml as ``ne=[KW,KH,IC,OC]`` —
exactly the ``ggml_conv_2d`` kernel layout. No transpose is needed.

Metadata KV entries (read by ``yolo_init``):
    "yolo.variant"  : str
    "yolo.input_h"  : u32
    "yolo.input_w"  : u32
    "yolo.classes"  : str  (utf-8, newline separated, 80 COCO entries)
    "yolo.strides"  : i32[3]
"""

import argparse
import os
import sys

COCO_CLASSES = [
    "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train",
    "truck", "boat", "traffic light", "fire hydrant", "stop sign",
    "parking meter", "bench", "bird", "cat", "dog", "horse", "sheep", "cow",
    "elephant", "bear", "zebra", "giraffe", "backpack", "umbrella", "handbag",
    "tie", "suitcase", "frisbee", "skis", "snowboard", "sports ball", "kite",
    "baseball bat", "baseball glove", "skateboard", "surfboard", "tennis racket",
    "bottle", "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana",
    "apple", "sandwich", "orange", "broccoli", "carrot", "hot dog", "pizza",
    "donut", "cake", "chair", "couch", "potted plant", "bed", "dining table",
    "toilet", "tv", "laptop", "mouse", "remote", "keyboard", "cell phone",
    "microwave", "oven", "toaster", "sink", "refrigerator", "book", "clock",
    "vase", "scissors", "teddy bear", "hair drier", "toothbrush",
]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--variant",
        default="yolov8n",
        choices=("yolov8n", "yolov8s", "yolov8m", "yolov8l", "yolov8x"),
    )
    parser.add_argument(
        "--out",
        default=None,
        help="Output GGUF path. Defaults to "
        "$ELIZA_STATE_DIR/models/vision/<variant>.gguf "
        "(or ~/.eliza/models/vision/<variant>.gguf).",
    )
    parser.add_argument(
        "--weights",
        default=None,
        help="Path to the .pt checkpoint. Defaults to '<variant>.pt' "
        "(ultralytics auto-downloads it if absent).",
    )
    parser.add_argument(
        "--trust-checkpoint",
        action="store_true",
        help="Allow the torch.load(weights_only=False) fallback when the "
        "Ultralytics YOLO import fails. Only use with trusted checkpoints.",
    )
    args = parser.parse_args()

    try:
        import numpy as np
        import torch
        import torch.nn as nn
    except ImportError as exc:
        print(f"missing dependency: {exc}. pip install torch numpy", file=sys.stderr)
        return 2
    try:
        import gguf
    except ImportError:
        print("gguf not installed. pip install gguf", file=sys.stderr)
        return 2

    out_path = args.out
    if not out_path:
        state_dir = os.environ.get(
            "ELIZA_STATE_DIR", os.path.join(os.path.expanduser("~"), ".eliza")
        )
        out_path = os.path.join(state_dir, "models", "vision", f"{args.variant}.gguf")
    args.out = out_path

    weights = args.weights or f"{args.variant}.pt"
    print(f"[convert] loading {weights}", file=sys.stderr)
    # Prefer ultralytics; fall back to loading the DetectionModel straight from
    # the checkpoint only when the operator explicitly trusts the file. PyTorch
    # full-checkpoint unpickling can execute code.
    try:
        from ultralytics import YOLO
    except Exception as exc:  # noqa: BLE001 - torchvision registration can fail here
        if isinstance(exc, ModuleNotFoundError) and exc.name == "ultralytics":
            print("ultralytics not installed. pip install ultralytics", file=sys.stderr)
            return 2
        trust_checkpoint = args.trust_checkpoint or os.environ.get(
            "ELIZA_YOLO_TRUST_CHECKPOINT"
        ) in {"1", "true", "yes"}
        if not trust_checkpoint:
            print(
                f"[convert] ultralytics import failed ({exc}). Direct "
                "torch.load fallback requires --trust-checkpoint or "
                "ELIZA_YOLO_TRUST_CHECKPOINT=1 because PyTorch checkpoint "
                "unpickling can execute code.",
                file=sys.stderr,
            )
            return 2
        print(
            f"[convert] ultralytics unavailable ({exc}); "
            "loading trusted DetectionModel directly from checkpoint",
            file=sys.stderr,
        )
        try:
            checkpoint = torch.load(weights, map_location="cpu", weights_only=False)
        except FileNotFoundError:
            print(
                f"checkpoint not found: {weights}. Install ultralytics to auto-download "
                "default weights, or pass --weights with a local .pt file.",
                file=sys.stderr,
            )
            return 2
        except Exception as load_exc:
            print(f"torch.load failed for {weights}: {load_exc}", file=sys.stderr)
            return 2
        if isinstance(checkpoint, dict):
            model = checkpoint.get("ema")
            if model is None:
                model = checkpoint.get("model")
        elif isinstance(checkpoint, nn.Module):
            model = checkpoint
        else:
            model = None
        if not isinstance(model, nn.Module):
            print(
                f"checkpoint {weights} does not contain a recoverable nn.Module "
                "in 'ema' or 'model'",
                file=sys.stderr,
            )
            return 2
    else:
        model = YOLO(weights).model  # DetectionModel (nn.Module)
    model.eval().float()

    out_dir = os.path.dirname(os.path.abspath(args.out))
    os.makedirs(out_dir, exist_ok=True)

    writer = gguf.GGUFWriter(args.out, "yolo")
    writer.add_string("yolo.variant", args.variant)
    writer.add_uint32("yolo.input_h", 640)
    writer.add_uint32("yolo.input_w", 640)
    writer.add_string("yolo.classes", "\n".join(COCO_CLASSES))
    writer.add_array("yolo.strides", [8, 16, 32])

    def fold_bn(conv, bn):
        w = conv.weight.detach().float()  # [OC,IC,KH,KW]
        oc = w.shape[0]
        b = (
            conv.bias.detach().float()
            if conv.bias is not None
            else torch.zeros(oc, dtype=torch.float32)
        )
        gamma = bn.weight.detach().float()
        beta = bn.bias.detach().float()
        mean = bn.running_mean.detach().float()
        var = bn.running_var.detach().float()
        std = torch.sqrt(var + bn.eps)
        w_folded = w * (gamma / std).reshape(-1, 1, 1, 1)
        b_folded = beta + (b - mean) * gamma / std
        return w_folded, b_folded

    def as_f32(t):
        return np.ascontiguousarray(t.detach().cpu().numpy().astype(np.float32))

    emitted = []

    def emit(name, w, b):
        writer.add_tensor(name + ".weight", as_f32(w))
        writer.add_tensor(name + ".bias", as_f32(b))
        emitted.append((name, tuple(w.shape), tuple(b.shape)))

    n_conv = n_bare = 0
    for name, m in model.named_modules():
        cls = type(m).__name__
        if cls == "Conv" and hasattr(m, "conv") and hasattr(m, "bn"):
            # ultralytics CBS: fold BN into the conv.
            if isinstance(m.conv, nn.Conv2d) and isinstance(m.bn, nn.BatchNorm2d):
                w, b = fold_bn(m.conv, m.bn)
                emit(name, w, b)
                n_conv += 1
        elif cls == "Conv2d":
            # bare Conv2d. Skip the inner conv of a CBS (handled above) and the
            # fixed DFL buffer (recomputed in C). Keep only the head stage-2 1x1.
            if name.endswith(".conv"):
                continue
            if ".dfl" in name:
                continue
            if m.bias is None:
                b = torch.zeros(m.weight.shape[0], dtype=torch.float32)
            else:
                b = m.bias
            emit(name, m.weight, b)
            n_bare += 1

    print(
        f"[convert] folded {n_conv} CBS convs + {n_bare} bare head convs "
        f"= {len(emitted)} tensors",
        file=sys.stderr,
    )
    for name, ws, bs in emitted:
        print(f"  {name:<28} w{ws} b{bs}", file=sys.stderr)

    writer.write_header_to_file()
    writer.write_kv_data_to_file()
    writer.write_tensors_to_file()
    writer.close()
    print(f"[convert] wrote {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
