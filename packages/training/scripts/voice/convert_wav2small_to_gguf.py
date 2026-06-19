#!/usr/bin/env python3
"""Convert Wav2Small MSP-dim int8 ONNX to voice_emotion GGUF.

Downloads from elizaos/eliza-1 (voice/voice-emotion/wav2small-msp-dim-int8.onnx)
or reads a local ONNX, then dequantizes and writes a GGUF whose tensor names
match what voice_emotion.c expects.

Architecture (from distill_wav2small.py Student):
  LogMel frozen front-end (baked Conv1d)
  → conv1: Conv1d(80 → 48, kernel=3, pad=1)  [ReLU]
  → conv2: Conv1d(48 → 56, kernel=3, pad=1)  [ReLU]
  → TransformerEncoder × 2 (d=56, nhead=4, ffn=112)
  → mean pool
  → head_vad: Linear(56 → 3)  [sigmoid V-A-D]

ONNX int8 initializer layout → C tensor names:

  conv1.weight_quantized (int8 [48,80,3]) → conv1.weight  [48,80,3]
  conv1.bias                              → conv1.bias    [48]
  conv2.weight_quantized (int8 [56,48,3]) → conv2.weight  [56,48,3]
  conv2.bias                              → conv2.bias    [56]

  Transformer layer {n}:
    val_{19|111}_quantized int8 [56,168]^T → enc.{n}.self_attn.in_proj.weight [168,56]
    enc.layers.{n}.self_attn.in_proj_bias    → enc.{n}.self_attn.in_proj.bias  [168]
    enc.layers.{n}.self_attn.out_proj.weight_quantized [56,56]^T
                                             → enc.{n}.self_attn.out_proj.weight [56,56]
    enc.layers.{n}.self_attn.out_proj.bias   → enc.{n}.self_attn.out_proj.bias [56]
    val_{105|191}_quantized [56,112]^T       → enc.{n}.linear1.weight   [112,56]
    enc.layers.{n}.linear1.bias              → enc.{n}.linear1.bias     [112]
    val_{107|193}_quantized [112,56]^T       → enc.{n}.linear2.weight   [56,112]
    enc.layers.{n}.linear2.bias              → enc.{n}.linear2.bias     [56]
    enc.layers.{n}.norm1.weight              → enc.{n}.norm1.weight     [56]
    enc.layers.{n}.norm1.bias               → enc.{n}.norm1.bias       [56]
    enc.layers.{n}.norm2.weight              → enc.{n}.norm2.weight     [56]
    enc.layers.{n}.norm2.bias               → enc.{n}.norm2.bias       [56]

  head_vad.weight_quantized [56,3]^T → head.weight  [3,56]
  head_vad.bias                      → head.bias    [3]

KV metadata:
  voice_emotion.sample_rate = 16000
  voice_emotion.n_mels = 80
  voice_emotion.n_fft = 512  (C-side VOICE_CLASSIFIER_N_FFT)
  voice_emotion.hop = 160
  voice_emotion.num_classes = 7
  voice_emotion.variant = "wav2small-msp-dim-int8"
  voice_emotion.stft_bins = 201  (N_FFT_logmel/2+1 = 400/2+1)
  voice_emotion.conv1_out = 48
  voice_emotion.conv2_out = 56
  voice_emotion.d_model = 56
  voice_emotion.ffn_dim = 112
  voice_emotion.num_layers = 2
  voice_emotion.num_heads = 4

Usage:
  python convert_wav2small_to_gguf.py --out /tmp/eliza1_gguf_output/wav2small-msp-dim-int8.gguf
  python convert_wav2small_to_gguf.py --onnx /path/to/model.onnx --out out.gguf
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
import onnx
from onnx import numpy_helper

HF_REPO = "elizaos/eliza-1"
HF_PATH = "voice/voice-emotion/wav2small-msp-dim-int8.onnx"

# Architecture constants (from distill_wav2small.py Student)
D_MODEL = 56
DFF = 112
MID = 48
N_HEAD = 4
N_LAYERS = 2
N_MELS = 80
STFT_BINS = 201   # LogMel N_FFT=400, bins=400//2+1

# ONNX val_ names for int8 quantized weight tensors per layer
# Determined by inspection: layer 0 uses val_19, val_105, val_107
#                            layer 1 uses val_111, val_191, val_193
_LAYER_IN_PROJ_NAMES = ["val_19", "val_111"]
_LAYER_FFN1_NAMES = ["val_105", "val_191"]
_LAYER_FFN2_NAMES = ["val_107", "val_193"]


def download_onnx(token: str | None) -> Path:
    from huggingface_hub import hf_hub_download
    local = hf_hub_download(repo_id=HF_REPO, filename=HF_PATH, token=token)
    return Path(local)


def _dequant(inits: dict[str, np.ndarray], base_name: str) -> np.ndarray:
    """Dequantize scalar-scale int8 weight: W = (q - zp) * scale."""
    q = inits[f"{base_name}_quantized"].astype(np.float32)
    scale = float(inits[f"{base_name}_scale"])
    zp = float(inits[f"{base_name}_zero_point"])
    return (q - zp) * scale


def build_tensor_map(onnx_path: Path) -> dict[str, np.ndarray]:
    model = onnx.load(str(onnx_path))
    inits = {init.name: numpy_helper.to_array(init) for init in model.graph.initializer}

    tensors: dict[str, np.ndarray] = {}

    # Conv blocks — weight stored as [out, in, k] int8, no transpose needed
    tensors["conv1.weight"] = _dequant(inits, "conv1.weight")  # [48, 80, 3]
    tensors["conv1.bias"] = inits["conv1.bias"].astype(np.float32)
    tensors["conv2.weight"] = _dequant(inits, "conv2.weight")  # [56, 48, 3]
    tensors["conv2.bias"] = inits["conv2.bias"].astype(np.float32)

    # Transformer encoder layers
    for li in range(N_LAYERS):
        pfx = f"encoder.layers.{li}"

        # in_proj weight stored as [D, 3*D] = [56, 168] — transpose to [3D, D] = [168, 56]
        in_proj_w = _dequant(inits, _LAYER_IN_PROJ_NAMES[li]).T  # [168, 56]
        tensors[f"enc.{li}.self_attn.in_proj.weight"] = in_proj_w
        tensors[f"enc.{li}.self_attn.in_proj.bias"] = \
            inits[f"{pfx}.self_attn.in_proj_bias"].astype(np.float32)

        # out_proj weight stored as [D, D] = [56, 56] — need [D, D] (no transpose for matmul)
        # PyTorch Linear weight is [out, in]; ONNX stores as transposed for MatMul: [in, out]
        # So we transpose to get [out, in] = [56, 56]
        out_proj_base = f"{pfx}.self_attn.out_proj.weight"
        out_proj_w = _dequant(inits, out_proj_base).T  # [56, 56]
        tensors[f"enc.{li}.self_attn.out_proj.weight"] = out_proj_w
        tensors[f"enc.{li}.self_attn.out_proj.bias"] = \
            inits[f"{pfx}.self_attn.out_proj.bias"].astype(np.float32)

        # FFN: linear1 weight [D, DFF]=[56,112] → transpose → [DFF, D]=[112, 56]
        tensors[f"enc.{li}.linear1.weight"] = _dequant(inits, _LAYER_FFN1_NAMES[li]).T
        tensors[f"enc.{li}.linear1.bias"] = \
            inits[f"{pfx}.linear1.bias"].astype(np.float32)

        # FFN: linear2 weight [DFF, D]=[112,56] → transpose → [D, DFF]=[56, 112]
        tensors[f"enc.{li}.linear2.weight"] = _dequant(inits, _LAYER_FFN2_NAMES[li]).T
        tensors[f"enc.{li}.linear2.bias"] = \
            inits[f"{pfx}.linear2.bias"].astype(np.float32)

        tensors[f"enc.{li}.norm1.weight"] = inits[f"{pfx}.norm1.weight"].astype(np.float32)
        tensors[f"enc.{li}.norm1.bias"] = inits[f"{pfx}.norm1.bias"].astype(np.float32)
        tensors[f"enc.{li}.norm2.weight"] = inits[f"{pfx}.norm2.weight"].astype(np.float32)
        tensors[f"enc.{li}.norm2.bias"] = inits[f"{pfx}.norm2.bias"].astype(np.float32)

    # V-A-D head — weight stored as [D, out] = [56, 3] → transpose → [3, 56]
    head_w = _dequant(inits, "head_vad.weight").T   # [3, 56]
    tensors["head.weight"] = head_w
    tensors["head.bias"] = inits["head_vad.bias"].astype(np.float32)

    return tensors


def write_gguf(tensors: dict[str, np.ndarray], out_path: Path) -> None:
    import gguf

    out_path.parent.mkdir(parents=True, exist_ok=True)
    writer = gguf.GGUFWriter(str(out_path), "voice_emotion")
    writer.add_uint32("voice_emotion.sample_rate", 16000)
    writer.add_uint32("voice_emotion.n_mels", N_MELS)
    writer.add_uint32("voice_emotion.n_fft", 512)   # VOICE_CLASSIFIER_N_FFT
    writer.add_uint32("voice_emotion.hop", 160)
    writer.add_uint32("voice_emotion.num_classes", 7)
    writer.add_string("voice_emotion.variant", "wav2small-msp-dim-int8")
    writer.add_uint32("voice_emotion.stft_bins", STFT_BINS)
    writer.add_uint32("voice_emotion.conv1_out", MID)
    writer.add_uint32("voice_emotion.conv2_out", D_MODEL)
    writer.add_uint32("voice_emotion.d_model", D_MODEL)
    writer.add_uint32("voice_emotion.ffn_dim", DFF)
    writer.add_uint32("voice_emotion.num_layers", N_LAYERS)
    writer.add_uint32("voice_emotion.num_heads", N_HEAD)

    for name, arr in tensors.items():
        writer.add_tensor(name, np.ascontiguousarray(arr.astype(np.float32)))

    writer.write_header_to_file()
    writer.write_kv_data_to_file()
    writer.write_tensors_to_file()
    writer.close()
    print(f"[wav2small] wrote {out_path} ({len(tensors)} tensors)", file=sys.stderr)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--onnx", type=Path, help="Local ONNX path (skips HF download)")
    ap.add_argument("--hf-token", default=None)
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args(argv)

    if args.onnx:
        onnx_path = args.onnx
    else:
        print(f"[wav2small] downloading {HF_PATH} from {HF_REPO}", file=sys.stderr)
        onnx_path = download_onnx(args.hf_token)

    tensors = build_tensor_map(onnx_path)
    write_gguf(tensors, args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
