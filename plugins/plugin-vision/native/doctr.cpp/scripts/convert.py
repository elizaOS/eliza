#!/usr/bin/env python3
"""
Convert Mindee doCTR PyTorch checkpoints to GGUF for the doctr.cpp runtime.

Usage:
    python scripts/convert.py --variant db_mobilenet_v3_large --out vision/doctr-det.gguf
    python scripts/convert.py --variant crnn_mobilenet_v3_small --out vision/doctr-rec.gguf

This script is a SCAFFOLD. The actual tensor-name mapping table is intentionally
left as a TODO until a build-host with `python-doctr` and `gguf` installed runs
the conversion end-to-end. The structure below is the contract the C++ loader
will read against (see src/doctr_det.cpp / src/doctr_rec.cpp).

Requirements (install before running):
    pip install python-doctr[torch] gguf numpy

Tensor naming convention written to the GGUF file:
    Detection:
        backbone.stem.conv.weight
        backbone.stem.bn.{weight,bias,running_mean,running_var}
        backbone.blocks.<i>.conv1.weight
        backbone.blocks.<i>.bn1.{weight,bias,running_mean,running_var}
        ... (per inverted-residual block; see torchvision MobileNetV3 mapping)
        head.conv1.weight
        head.bn1.weight
        head.up1.weight
        head.up2.weight
        head.out.weight
    Recognition:
        backbone.* (mobilenetv3-small mapping)
        lstm.weight_ih_l{0,1}
        lstm.weight_hh_l{0,1}
        lstm.bias_ih_l{0,1}
        lstm.bias_hh_l{0,1}
        head.weight
        head.bias

Metadata KV entries:
    "doctr.det.variant" | "doctr.rec.variant" : str
    "doctr.<stage>.mean"     : f32[3]
    "doctr.<stage>.std"      : f32[3]
    "doctr.<stage>.input_h"  : i32
    "doctr.<stage>.input_w"  : i32
    "doctr.rec.charset"      : str (utf-8, newline-separated)
"""

import argparse
import sys

VALID_VARIANTS = (
    "db_mobilenet_v3_large",
    "crnn_mobilenet_v3_small",
)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--variant", required=True, choices=VALID_VARIANTS)
    parser.add_argument("--out", required=True, help="Output GGUF path")
    parser.add_argument(
        "--quantize",
        default="f16",
        choices=["f32", "f16", "q4_0", "q8_0"],
        help="Tensor quantization for conv/linear weights",
    )
    args = parser.parse_args()

    try:
        from doctr.models import recognition, detection  # noqa: F401
    except ImportError:
        print(
            "python-doctr not installed. Install with: pip install 'python-doctr[torch]'",
            file=sys.stderr,
        )
        return 2

    try:
        import gguf  # noqa: F401
    except ImportError:
        print(
            "gguf library not installed. Install with: pip install gguf",
            file=sys.stderr,
        )
        return 2

    print(f"[convert] variant={args.variant} out={args.out} quantize={args.quantize}",
          file=sys.stderr)
    print(
        "[convert] WEIGHT MAPPING NOT YET WIRED — run this on a build host with "
        "the full python-doctr environment and fill in the per-tensor mapping "
        "table per the docstring above.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
