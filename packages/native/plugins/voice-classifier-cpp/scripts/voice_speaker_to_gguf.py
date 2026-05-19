#!/usr/bin/env python3
"""Convert the WeSpeaker ResNet34-LM ONNX speaker encoder to GGUF.

K2 — real implementation. The fork-built native library (`voice_speaker.c`)
reads the GGUF produced by this script, runs the ResNet34 + statistics-
pool forward graph in pure C, and emits a 256-dim L2-normalized speaker
embedding.

Upstream
--------
- ``wenet-e2e/wespeaker`` ResNet34-LM trained on VoxCeleb2-dev,
  Large-Margin (LM) fine-tune. The ONNX export used here is staged on
  ``elizaos/eliza-1`` at ``voice/speaker-encoder/wespeaker-resnet34-lm.onnx``
  (~26 MB, fp32 weights; BN already folded into Conv biases by the
  export pipeline).

Architecture
------------
- Input: log-Mel-fbank features [B, T, 80] (kaldi style, no log-floor),
  CMN (per-utterance mean subtraction) applied by the runtime before
  the forward pass.
- Stem: Conv2D 1→32 (3x3, stride 1, pad 1) + ReLU
- ResNet34 backbone with channel sequence 32/64/128/256:
    * Layer 1: 3 BasicBlocks at 32 channels, no spatial downsample
    * Layer 2: 4 BasicBlocks, first block downsamples (stride 2,
      shortcut via 1x1 conv)
    * Layer 3: 6 BasicBlocks, same downsample pattern
    * Layer 4: 3 BasicBlocks, same
- Each BasicBlock: Conv3x3 + ReLU + Conv3x3 + Add(residual) + ReLU.
  BatchNorm pre-folded into Conv weight+bias at export time.
- Statistics pooling: ReduceMean(axis=-1) and Std(axis=-1) over the
  time dimension, producing a [B, 256, 10] tensor each; flatten + concat
  gives [B, 5120].
- Linear head: Gemm 5120→256 (`model.seg_1`).
- Final bias: subtract `mean_vec` (per-channel running mean from the
  large-margin fine-tune). The model output is NOT L2-normed inside the
  graph; the runtime L2-normalizes for cosine scoring.

Output GGUF layout
------------------
- arch="voice_speaker"
- Metadata keys (all required):
    voice_speaker.variant            = "wespeaker-resnet34-lm" (locked)
    voice_speaker.sample_rate        = 16000 (uint32)
    voice_speaker.n_mels             = 80    (uint32)
    voice_speaker.n_fft              = 400   (uint32) — kaldi 25ms window
    voice_speaker.hop                = 160   (uint32) — kaldi 10ms shift
    voice_speaker.embedding_dim      = 256   (uint32)
    voice_speaker.l2_normalize       = true  (bool)   — runtime L2-norms output
    voice_speaker.feature_type       = "kaldi_fbank_cmn" (string)
    voice_speaker.upstream_commit    = pinned-string
- Tensors (fp32, named with stable block path):
    stem.weight  [32, 1, 3, 3]
    stem.bias    [32]
    L1.B{0..2}.{a,b}.{weight,bias}
    L2.B0.{a,b,ds}.{weight,bias}; L2.B{1..3}.{a,b}.{weight,bias}
    L3.B0.{a,b,ds}.{weight,bias}; L3.B{1..5}.{a,b}.{weight,bias}
    L4.B0.{a,b,ds}.{weight,bias}; L4.B{1..2}.{a,b}.{weight,bias}
    seg_1.weight [256, 5120]
    seg_1.bias   [256]
    mean_vec     [256]
"""

from __future__ import annotations

import argparse
from pathlib import Path

import gguf
import numpy as np
import onnx
from onnx import numpy_helper


VOICE_SPEAKER_VARIANT = "wespeaker-resnet34-lm"
SAMPLE_RATE = 16000
N_MELS = 80
# Kaldi fbank pads the 25-ms (400-sample) window to the next power of two
# (512) before the FFT, then keeps `n_fft/2+1 = 257` real bins. The C-side
# header pins n_fft=512 for the same reason. The 25-ms window length is
# encoded separately by the runtime; the GGUF only records the FFT size.
N_FFT = 512
HOP = 160    # kaldi-style 10ms @ 16kHz
EMBEDDING_DIM = 256
L2_NORMALIZE = True
FEATURE_TYPE = "kaldi_fbank_cmn"
VOICE_SPEAKER_UPSTREAM_COMMIT = "elizaos/eliza-1@voice/speaker-encoder/wespeaker-resnet34-lm.onnx"


# Conv layout: each Conv node has (weight, bias) initializers in
# topological order. Standard ResNet34 layout.
BLOCK_PLAN: list[tuple[str, int]] = [
    ("stem", 1),
    ("L1.B0", 2), ("L1.B1", 2), ("L1.B2", 2),
    ("L2.B0", 3), ("L2.B1", 2), ("L2.B2", 2), ("L2.B3", 2),
    ("L3.B0", 3), ("L3.B1", 2), ("L3.B2", 2),
    ("L3.B3", 2), ("L3.B4", 2), ("L3.B5", 2),
    ("L4.B0", 3), ("L4.B1", 2), ("L4.B2", 2),
]


def _label_convs(model: onnx.ModelProto) -> dict[str, str]:
    """Walk Conv nodes in topological order, map them to canonical names.

    Returns a {canonical_name: initializer_name} map covering each
    Conv's weight and bias plus the seg_1 Gemm + mean_vec.
    """
    convs = [n for n in model.graph.node if n.op_type == "Conv"]
    expected = sum(c for _, c in BLOCK_PLAN)
    if len(convs) != expected:
        raise ValueError(
            f"expected {expected} Conv nodes for ResNet34-LM, got {len(convs)}"
        )
    labels: dict[str, str] = {}
    idx = 0
    for block, count in BLOCK_PLAN:
        if count == 1:
            labels[f"{block}.weight"] = convs[idx].input[1]
            labels[f"{block}.bias"] = convs[idx].input[2]
            idx += 1
        elif count == 2:
            labels[f"{block}.a.weight"] = convs[idx].input[1]
            labels[f"{block}.a.bias"] = convs[idx].input[2]
            idx += 1
            labels[f"{block}.b.weight"] = convs[idx].input[1]
            labels[f"{block}.b.bias"] = convs[idx].input[2]
            idx += 1
        elif count == 3:
            labels[f"{block}.a.weight"] = convs[idx].input[1]
            labels[f"{block}.a.bias"] = convs[idx].input[2]
            idx += 1
            labels[f"{block}.b.weight"] = convs[idx].input[1]
            labels[f"{block}.b.bias"] = convs[idx].input[2]
            idx += 1
            labels[f"{block}.ds.weight"] = convs[idx].input[1]
            labels[f"{block}.ds.bias"] = convs[idx].input[2]
            idx += 1
        else:
            raise AssertionError(count)

    # seg_1 Gemm
    gemm_nodes = [n for n in model.graph.node if n.op_type == "Gemm"]
    if len(gemm_nodes) != 1:
        raise ValueError(f"expected exactly 1 Gemm, got {len(gemm_nodes)}")
    gemm = gemm_nodes[0]
    labels["seg_1.weight"] = gemm.input[1]
    labels["seg_1.bias"] = gemm.input[2]

    # The final Sub subtracts mean_vec from the Gemm output.
    init_names = {i.name for i in model.graph.initializer}
    if "mean_vec" not in init_names:
        raise ValueError("upstream ONNX missing 'mean_vec' initializer")
    labels["mean_vec"] = "mean_vec"

    return labels


def _check_shapes(
    tensors: dict[str, np.ndarray],
) -> None:
    """Validate the discovered tensor shapes match the ResNet34-LM spec."""
    expected: dict[str, tuple[int, ...]] = {
        "stem.weight": (32, 1, 3, 3), "stem.bias": (32,),
        "seg_1.weight": (256, 5120), "seg_1.bias": (256,),
        "mean_vec": (256,),
    }
    # L1: 32→32
    for b in range(3):
        for s in ("a", "b"):
            expected[f"L1.B{b}.{s}.weight"] = (32, 32, 3, 3)
            expected[f"L1.B{b}.{s}.bias"] = (32,)
    # L2 downsample
    expected["L2.B0.a.weight"] = (64, 32, 3, 3); expected["L2.B0.a.bias"] = (64,)
    expected["L2.B0.b.weight"] = (64, 64, 3, 3); expected["L2.B0.b.bias"] = (64,)
    expected["L2.B0.ds.weight"] = (64, 32, 1, 1); expected["L2.B0.ds.bias"] = (64,)
    for b in range(1, 4):
        for s in ("a", "b"):
            expected[f"L2.B{b}.{s}.weight"] = (64, 64, 3, 3)
            expected[f"L2.B{b}.{s}.bias"] = (64,)
    # L3
    expected["L3.B0.a.weight"] = (128, 64, 3, 3); expected["L3.B0.a.bias"] = (128,)
    expected["L3.B0.b.weight"] = (128, 128, 3, 3); expected["L3.B0.b.bias"] = (128,)
    expected["L3.B0.ds.weight"] = (128, 64, 1, 1); expected["L3.B0.ds.bias"] = (128,)
    for b in range(1, 6):
        for s in ("a", "b"):
            expected[f"L3.B{b}.{s}.weight"] = (128, 128, 3, 3)
            expected[f"L3.B{b}.{s}.bias"] = (128,)
    # L4
    expected["L4.B0.a.weight"] = (256, 128, 3, 3); expected["L4.B0.a.bias"] = (256,)
    expected["L4.B0.b.weight"] = (256, 256, 3, 3); expected["L4.B0.b.bias"] = (256,)
    expected["L4.B0.ds.weight"] = (256, 128, 1, 1); expected["L4.B0.ds.bias"] = (256,)
    for b in range(1, 3):
        for s in ("a", "b"):
            expected[f"L4.B{b}.{s}.weight"] = (256, 256, 3, 3)
            expected[f"L4.B{b}.{s}.bias"] = (256,)

    if set(tensors.keys()) != set(expected.keys()):
        missing = set(expected) - set(tensors)
        extra = set(tensors) - set(expected)
        raise ValueError(
            f"tensor set mismatch. missing={sorted(missing)} extra={sorted(extra)}"
        )
    for name, want in expected.items():
        got = tuple(tensors[name].shape)
        if got != want:
            raise ValueError(f"{name}: expected shape {want}, got {got}")


def convert(
    *,
    onnx_path: Path,
    output_path: Path,
    quantize: str = "fp32",
) -> dict[str, object]:
    """Convert the WeSpeaker ONNX export to GGUF.

    Parameters
    ----------
    onnx_path : Path
        Path to the ResNet34-LM ONNX file.
    output_path : Path
        Path to the output GGUF.
    quantize : str
        ``"fp32"`` (default) or ``"fp16"``. The fork-built native runtime
        currently expects fp32; fp16 is a forward-compat hook.
    """
    if not onnx_path.exists():
        raise FileNotFoundError(onnx_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    model = onnx.load(str(onnx_path), load_external_data=False)
    labels = _label_convs(model)
    init_map = {i.name: i for i in model.graph.initializer}

    tensors: dict[str, np.ndarray] = {}
    for canonical, init_name in labels.items():
        if init_name not in init_map:
            raise ValueError(
                f"initializer '{init_name}' for '{canonical}' missing from ONNX"
            )
        arr = numpy_helper.to_array(init_map[init_name])
        if arr.dtype != np.float32:
            arr = arr.astype(np.float32)
        tensors[canonical] = arr

    _check_shapes(tensors)

    writer = gguf.GGUFWriter(str(output_path), arch="voice_speaker")
    writer.add_uint32("voice_speaker.sample_rate", SAMPLE_RATE)
    writer.add_uint32("voice_speaker.n_mels", N_MELS)
    writer.add_uint32("voice_speaker.n_fft", N_FFT)
    writer.add_uint32("voice_speaker.hop", HOP)
    writer.add_uint32("voice_speaker.embedding_dim", EMBEDDING_DIM)
    writer.add_bool("voice_speaker.l2_normalize", L2_NORMALIZE)
    writer.add_string("voice_speaker.variant", VOICE_SPEAKER_VARIANT)
    writer.add_string("voice_speaker.feature_type", FEATURE_TYPE)
    writer.add_string(
        "voice_speaker.upstream_commit", VOICE_SPEAKER_UPSTREAM_COMMIT
    )

    # Stable name order: parameters listed first, in topological order.
    ordered_names = ["stem.weight", "stem.bias"]
    for li, blk_count in [(1, 3), (2, 4), (3, 6), (4, 3)]:
        for bi in range(blk_count):
            blk = f"L{li}.B{bi}"
            ordered_names += [f"{blk}.a.weight", f"{blk}.a.bias"]
            ordered_names += [f"{blk}.b.weight", f"{blk}.b.bias"]
            if bi == 0 and li > 1:
                ordered_names += [f"{blk}.ds.weight", f"{blk}.ds.bias"]
    ordered_names += ["seg_1.weight", "seg_1.bias", "mean_vec"]
    assert set(ordered_names) == set(tensors.keys())

    n_params = 0
    for name in ordered_names:
        arr = tensors[name]
        if quantize == "fp16":
            arr = arr.astype(np.float16)
        # gguf-py expects raw_dtype only for non-default types — pass via
        # GGMLQuantizationType.
        writer.add_tensor(name, arr)
        n_params += int(arr.size)

    writer.write_header_to_file()
    writer.write_kv_data_to_file()
    writer.write_tensors_to_file()
    writer.close()

    return {
        "n_tensors": len(tensors),
        "n_params": n_params,
        "output_path": str(output_path),
        "quantize": quantize,
    }


def _build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    p.add_argument(
        "--onnx", type=Path, required=True,
        help="Path to wespeaker-resnet34-lm.onnx",
    )
    p.add_argument(
        "--output", type=Path, required=True,
        help="Output GGUF path.",
    )
    p.add_argument(
        "--quantize", choices=["fp32", "fp16"], default="fp32",
        help="Tensor quant (default: fp32; fp16 reserved for later).",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_arg_parser().parse_args(argv)
    stats = convert(
        onnx_path=args.onnx,
        output_path=args.output,
        quantize=args.quantize,
    )
    print(stats)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
