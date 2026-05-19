#!/usr/bin/env python3
"""
Convert Ultralytics YOLOv8 PyTorch checkpoints to GGUF for the yolo.cpp runtime.

Usage:
    python scripts/convert.py --variant yolov8n --out vision/yolov8n.gguf

Requirements (install before running):
    pip install ultralytics gguf numpy torch

License note: Ultralytics ships under AGPL-3.0. This script reads the published
weights; the runtime is a clean-room implementation built on ggml. We do NOT
copy Ultralytics code into this repo.

Tensor naming convention written to the GGUF file:
    model.<i>.conv.weight
    model.<i>.bn.{weight,bias,running_mean,running_var}
    ... (per block; see Ultralytics YAML for the topology)
    head.cv2.<scale>.{0,1,2}.conv.weight   # box regression branch
    head.cv3.<scale>.{0,1,2}.conv.weight   # class branch

Metadata KV entries:
    "yolo.variant"      : str       (e.g. "yolov8n")
    "yolo.input_h"      : i32
    "yolo.input_w"      : i32
    "yolo.classes"      : str       (utf-8, newline separated, 80 COCO entries)
    "yolo.strides"      : i32[3]
"""

import argparse
import sys


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--variant",
        required=True,
        choices=("yolov8n", "yolov8s", "yolov8m", "yolov8l", "yolov8x"),
    )
    parser.add_argument("--out", required=True)
    parser.add_argument(
        "--quantize",
        default="f16",
        choices=["f32", "f16", "q4_0", "q8_0"],
    )
    args = parser.parse_args()

    try:
        from ultralytics import YOLO  # noqa: F401
    except ImportError:
        print("ultralytics not installed. pip install ultralytics", file=sys.stderr)
        return 2
    try:
        import gguf  # noqa: F401
    except ImportError:
        print("gguf not installed. pip install gguf", file=sys.stderr)
        return 2

    print(
        f"[convert] variant={args.variant} out={args.out} quantize={args.quantize}",
        file=sys.stderr,
    )
    print(
        "[convert] WEIGHT MAPPING NOT YET WIRED — run this on a build host with "
        "the full ultralytics + gguf environment and fill in the per-tensor "
        "mapping table. The structure is: load YOLO(<variant>.pt).model, "
        "iterate model.named_parameters(), fuse BN into preceding conv, write "
        "each tensor to GGUF with the names documented in the docstring.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
