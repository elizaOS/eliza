#!/usr/bin/env python3
"""Convert wespeaker-voxceleb-resnet34-LM ONNX to voice_speaker GGUF.

Downloads from elizaos/eliza-1 (voice/speaker-encoder/wespeaker-resnet34-lm.onnx)
or reads a local ONNX, then writes a GGUF whose tensor names match what
voice_speaker.c expects at session open.

The upstream ONNX uses numeric tensor names (367, 368, ...) for BN-folded
conv weights in the ResNet stages. This script maps them to the C-side names
using the known shape-based layout derived from SPK_PLAN in voice_speaker.c:

  stem.weight  [32, 1, 3, 3]   ← id 367
  stem.bias    [32]             ← id 368
  L1.B0..L4.B{n}.{a,b}.{weight,bias}   (3x3 conv stages)
  L{n}.B0.ds.{weight,bias}              (downsampling 1x1 convs)
  seg_1.weight [256, 5120]
  seg_1.bias   [256]
  mean_vec     [256]

Usage:
  python convert_wespeaker_to_gguf.py --out /tmp/eliza1_gguf_output/wespeaker-resnet34-lm.gguf
  python convert_wespeaker_to_gguf.py --onnx /path/to/model.onnx --out out.gguf
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
import onnx
from onnx import numpy_helper

HF_REPO = "elizaos/eliza-1"
HF_PATH = "voice/speaker-encoder/wespeaker-resnet34-lm.onnx"

# ResNet34-LM plan — mirrors SPK_PLAN in voice_speaker.c
# (blocks, in_channels, out_channels, stride)
_PLAN = [
    (3, 32, 32, 1),
    (4, 32, 64, 2),
    (6, 64, 128, 2),
    (3, 128, 256, 2),
]


def download_onnx(token: str | None) -> Path:
    from huggingface_hub import hf_hub_download
    local = hf_hub_download(repo_id=HF_REPO, filename=HF_PATH, token=token)
    return Path(local)


def build_tensor_map(onnx_path: Path) -> dict[str, np.ndarray]:
    """Map C-side tensor names → float32 numpy arrays."""
    model = onnx.load(str(onnx_path))
    inits = {init.name: numpy_helper.to_array(init).astype(np.float32)
             for init in model.graph.initializer}

    tensors: dict[str, np.ndarray] = {}

    # Named tensors (known names from ONNX inspection)
    tensors["seg_1.weight"] = inits["model.seg_1.weight"]
    tensors["seg_1.bias"] = inits["model.seg_1.bias"]
    tensors["mean_vec"] = inits["mean_vec"]

    # Numeric-keyed tensors — walk them in order and assign by expected shape.
    # The ONNX was exported with TorchScript and uses numeric names for all
    # BN-folded stage weights. We reconstruct the assignment by matching each
    # tensor's shape to the ResNet34 layout.

    # Build the expected weight sequence in stage order.
    expected: list[tuple[str, tuple[int, ...]]] = []
    # Stem
    expected.append(("stem.weight", (32, 1, 3, 3)))
    expected.append(("stem.bias", (32,)))
    for li, (blocks, in_ch, out_ch, stride) in enumerate(_PLAN):
        for bi in range(blocks):
            real_in = in_ch if bi == 0 else out_ch
            expected.append((f"L{li+1}.B{bi}.a.weight", (out_ch, real_in, 3, 3)))
            expected.append((f"L{li+1}.B{bi}.a.bias", (out_ch,)))
            expected.append((f"L{li+1}.B{bi}.b.weight", (out_ch, out_ch, 3, 3)))
            expected.append((f"L{li+1}.B{bi}.b.bias", (out_ch,)))
            if bi == 0 and (stride != 1 or real_in != out_ch):
                # Downsample 1x1 conv comes immediately after the 3x3 pair
                expected.append((f"L{li+1}.B{bi}.ds.weight", (out_ch, real_in, 1, 1)))
                expected.append((f"L{li+1}.B{bi}.ds.bias", (out_ch,)))

    # Filter numeric-named tensors (not the three named ones above)
    named = {"model.seg_1.weight", "model.seg_1.bias", "mean_vec"}
    numeric = [(k, v) for k, v in inits.items() if k not in named]
    # Sort by numeric key value
    def _sort_key(kv: tuple[str, np.ndarray]) -> int:
        try:
            return int(kv[0])
        except ValueError:
            return 999999
    numeric.sort(key=_sort_key)

    if len(numeric) != len(expected):
        print(f"[wespeaker] WARNING: {len(numeric)} numeric tensors, "
              f"{len(expected)} expected. Attempting shape-based match.",
              file=sys.stderr)

    # Match by shape in order
    exp_idx = 0
    for k, arr in numeric:
        if exp_idx >= len(expected):
            break
        name, shape = expected[exp_idx]
        if arr.shape == shape:
            tensors[name] = arr
            exp_idx += 1
        else:
            print(f"[wespeaker] shape mismatch: key={k} shape={arr.shape} "
                  f"expected={name} {shape}", file=sys.stderr)

    missing = [name for name, _ in expected if name not in tensors]
    if missing:
        raise RuntimeError(f"[wespeaker] failed to resolve tensors: {missing}")

    return tensors


def write_gguf(tensors: dict[str, np.ndarray], out_path: Path) -> None:
    import gguf

    out_path.parent.mkdir(parents=True, exist_ok=True)
    writer = gguf.GGUFWriter(str(out_path), "voice_speaker")
    writer.add_uint32("voice_speaker.sample_rate", 16000)
    writer.add_uint32("voice_speaker.embedding_dim", 256)
    writer.add_string("voice_speaker.variant", "wespeaker-resnet34-lm-int8")

    for name, arr in tensors.items():
        writer.add_tensor(name, np.ascontiguousarray(arr.astype(np.float32)))

    writer.write_header_to_file()
    writer.write_kv_data_to_file()
    writer.write_tensors_to_file()
    writer.close()
    print(f"[wespeaker] wrote {out_path} ({len(tensors)} tensors)", file=sys.stderr)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--onnx", type=Path, help="Local ONNX path (skips HF download)")
    ap.add_argument("--hf-token", default=None, help="HuggingFace token")
    ap.add_argument("--out", type=Path, required=True, help="Output GGUF path")
    args = ap.parse_args(argv)

    if args.onnx:
        onnx_path = args.onnx
    else:
        print(f"[wespeaker] downloading {HF_PATH} from {HF_REPO}", file=sys.stderr)
        onnx_path = download_onnx(args.hf_token)

    tensors = build_tensor_map(onnx_path)
    write_gguf(tensors, args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
