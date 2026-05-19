#!/usr/bin/env python3
"""Convert the Eliza-1 Wav2Small ONNX emotion classifier to a GGUF file
the voice-classifier-cpp runtime loads through its fp32 forward pass.

This is a REAL conversion that produces a numerical-parity-target GGUF.

The Eliza-1 wav2small student (`elizaos/eliza-1:voice/voice-emotion/`)
is a tiny (~72K-param) emotion classifier distilled from the audeering
MSP-Dim teacher. The ONNX is INT8-dynamic-quantized; we DEQUANTIZE
every weight tensor to fp32 at conversion time so the C forward pass
runs a clean fp32 graph and only has to worry about activation-side
numerics. This loses the int8 size advantage but keeps the model under
~1 MB and removes a whole class of quant-related parity drift.

Architecture (extracted from the ONNX graph, see
`docs/voice/wav2small.md`):

    pcm[1, T]  (float32, 16 kHz)
      ↓ unsqueeze → [1, 1, T]
      ↓ Conv1d(cos_w, stride=160) → cos_stft[1, 201, T_stft]   # 400-pt STFT
      ↓ Conv1d(sin_w, stride=160) → sin_stft[1, 201, T_stft]
      ↓ cos² + sin² → power[1, 201, T_stft]
      ↓ einsum(mel_mat[80,201], power) → mel_pow[1, 80, T_stft]
      ↓ log(clamp(.., 1e-8)) → log_mel[1, 80, T_stft]
      ↓ Conv1d(80→48, k=3, p=1) + bias + ReLU
      ↓ Conv1d(48→56, k=3, p=1) + bias + ReLU
      ↓ Transpose to [1, T_stft, 56]
      ↓ TransformerEncoderLayer(d=56, h=1, ffn=112, ReLU) × 2
        (in_proj: 3*56=168 → 56*3; out_proj: 56→56; ffn: 56→112→56)
      ↓ mean over T_stft → [1, 56]
      ↓ Linear(56 → 7) → cls_logits[1, 7]

Class order (Eliza-1 cls7 head, locked):
    [happy, sad, angry, nervous, calm, excited, whisper]

Front-end constants (locked at conversion time):
    sample_rate=16000, n_fft=400, hop=160, n_mels=80

Notes on parity:
    - DynamicQuantizeLinear in the ONNX dynamically computes activation
      scales at runtime. We run pure fp32 in the C forward, so the
      activation-side drift is at the int8 quantization noise floor
      (~1e-3 typically). For 7-class argmax decisions this is well
      below the per-class margin in practice.
    - The transformer uses 1 head, dim=56, ReLU FFN (not GELU). This
      is the actual Wav2Small (Wagner et al., arXiv:2408.13920)
      configuration, not the brief's stated 4-head 128-dim variant.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import onnx
from gguf import GGUFWriter, GGMLQuantizationType
from onnx import numpy_helper

# ── Locked block-format constants (mirror voice_classifier.h) ────────────────

CLASS_ORDER = [
    "happy",
    "sad",
    "angry",
    "nervous",
    "calm",
    "excited",
    "whisper",
]
NUM_CLASSES = len(CLASS_ORDER)

SAMPLE_RATE = 16000
N_FFT = 400          # actual model uses 400-pt STFT (NOT the 512 in older notes)
HOP = 160            # 10 ms hop at 16 kHz
N_MELS = 80
STFT_BINS = N_FFT // 2 + 1   # 201

# Model dimensions (extracted from the ONNX initializer shapes — these
# are LOCKED to this specific Wav2Small variant; converters for other
# variants will set different values).
CONV1_OUT = 48
CONV2_OUT = 56
D_MODEL = 56
FFN_DIM = 112
NUM_LAYERS = 2
NUM_HEADS = 1

VOICE_EMOTION_VARIANT = "elizaos/eliza-1:wav2small-cls7"

# ── Helpers ──────────────────────────────────────────────────────────────────


def dequantize_int8(qweight: np.ndarray, scale: np.ndarray, zp: np.ndarray) -> np.ndarray:
    """Standard ONNX (qweight - zp) * scale dequant. Handles both
    scalar-per-tensor and per-channel scales/zps."""
    return (qweight.astype(np.int32) - zp.astype(np.int32)).astype(np.float32) * scale.astype(np.float32)


def load_initializers(onnx_path: Path) -> dict[str, np.ndarray]:
    model = onnx.load(str(onnx_path))
    out: dict[str, np.ndarray] = {}
    for init in model.graph.initializer:
        out[init.name] = numpy_helper.to_array(init)
    return out


def get_fp32(inits: dict[str, np.ndarray], base: str) -> np.ndarray:
    """Resolve an fp32 weight: if {base}_quantized exists, dequant;
    else return inits[base] directly."""
    qkey = f"{base}_quantized"
    if qkey in inits:
        return dequantize_int8(
            inits[qkey],
            inits[f"{base}_scale"],
            inits[f"{base}_zero_point"],
        )
    return inits[base].astype(np.float32, copy=False)


def write_tensor(writer: GGUFWriter, name: str, arr: np.ndarray) -> None:
    """Write a fp32 tensor. GGUF stores tensors with explicit shape;
    GGML loads them in the same orientation."""
    arr = np.ascontiguousarray(arr.astype(np.float32))
    writer.add_tensor(name, arr, raw_dtype=GGMLQuantizationType.F32)


def convert(onnx_path: Path, output_path: Path) -> dict[str, object]:
    if not onnx_path.exists():
        raise FileNotFoundError(onnx_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    inits = load_initializers(onnx_path)

    # ── extract and dequant all weights ──────────────────────────────────
    # STFT / mel front-end
    cos_w = get_fp32(inits, "base.logmel.cos_w")        # [201, 1, 400]
    sin_w = get_fp32(inits, "base.logmel.sin_w")        # [201, 1, 400]
    mel_mat = inits["base.logmel.mel_mat"].astype(np.float32)  # [80, 201]

    # CNN front-end
    conv1_w = get_fp32(inits, "base.conv1.weight")      # [48, 80, 3]
    conv1_b = inits["base.conv1.bias"].astype(np.float32)
    conv2_w = get_fp32(inits, "base.conv2.weight")      # [56, 48, 3]
    conv2_b = inits["base.conv2.bias"].astype(np.float32)

    # Transformer (2 layers)
    layers = []
    for i in range(NUM_LAYERS):
        # MHA in-proj concats Q,K,V: weight [3*d_model, d_model] but in
        # ONNX it's stored as the val_19 / val_111 quantized matmul
        # weight with shape [d_model, 3*d_model] (the matmul is
        # x @ w → so w is [in_features, out_features] = [56, 168]).
        # The corresponding bias is in_proj_bias [3*d_model] = [168].
        in_proj_w_keys = {0: "val_19", 1: "val_111"}
        in_proj_w = get_fp32(inits, in_proj_w_keys[i])  # [56, 168]
        in_proj_b = inits[f"base.encoder.layers.{i}.self_attn.in_proj_bias"].astype(np.float32)

        # MHA out-proj
        out_proj_w = get_fp32(inits, f"base.encoder.layers.{i}.self_attn.out_proj.weight")  # [56, 56]
        out_proj_b = inits[f"base.encoder.layers.{i}.self_attn.out_proj.bias"].astype(np.float32)

        # FFN: linear1 + linear2 (with ReLU between)
        # linear1: x @ W → [d, ffn]; ONNX stores W as quantized matmul
        # weight at val_105 (layer 0) / val_191 (layer 1).
        ffn1_w_keys = {0: "val_105", 1: "val_191"}
        ffn2_w_keys = {0: "val_107", 1: "val_193"}
        ffn1_w = get_fp32(inits, ffn1_w_keys[i])         # [56, 112]
        ffn1_b = inits[f"base.encoder.layers.{i}.linear1.bias"].astype(np.float32)
        ffn2_w = get_fp32(inits, ffn2_w_keys[i])         # [112, 56]
        ffn2_b = inits[f"base.encoder.layers.{i}.linear2.bias"].astype(np.float32)

        # LayerNorms
        norm1_w = inits[f"base.encoder.layers.{i}.norm1.weight"].astype(np.float32)
        norm1_b = inits[f"base.encoder.layers.{i}.norm1.bias"].astype(np.float32)
        norm2_w = inits[f"base.encoder.layers.{i}.norm2.weight"].astype(np.float32)
        norm2_b = inits[f"base.encoder.layers.{i}.norm2.bias"].astype(np.float32)

        layers.append({
            "in_proj_w": in_proj_w,
            "in_proj_b": in_proj_b,
            "out_proj_w": out_proj_w,
            "out_proj_b": out_proj_b,
            "ffn1_w": ffn1_w,
            "ffn1_b": ffn1_b,
            "ffn2_w": ffn2_w,
            "ffn2_b": ffn2_b,
            "norm1_w": norm1_w,
            "norm1_b": norm1_b,
            "norm2_w": norm2_w,
            "norm2_b": norm2_b,
        })

    # Classification head
    head_w = get_fp32(inits, "base.head_aux.weight")    # [56, 7]
    head_b = inits["base.head_aux.bias"].astype(np.float32)

    # ── write GGUF ─────────────────────────────────────────────────────────
    writer = GGUFWriter(str(output_path), arch="voice_emotion")

    # Metadata block — the C-side `voice_emotion_open` reads these and
    # refuses to load on mismatch.
    writer.add_uint32("voice_emotion.sample_rate", SAMPLE_RATE)
    writer.add_uint32("voice_emotion.n_mels", N_MELS)
    writer.add_uint32("voice_emotion.n_fft", N_FFT)
    writer.add_uint32("voice_emotion.hop", HOP)
    writer.add_uint32("voice_emotion.num_classes", NUM_CLASSES)
    writer.add_uint32("voice_emotion.stft_bins", STFT_BINS)
    writer.add_uint32("voice_emotion.conv1_out", CONV1_OUT)
    writer.add_uint32("voice_emotion.conv2_out", CONV2_OUT)
    writer.add_uint32("voice_emotion.d_model", D_MODEL)
    writer.add_uint32("voice_emotion.ffn_dim", FFN_DIM)
    writer.add_uint32("voice_emotion.num_layers", NUM_LAYERS)
    writer.add_uint32("voice_emotion.num_heads", NUM_HEADS)
    writer.add_string("voice_emotion.variant", VOICE_EMOTION_VARIANT)
    writer.add_string("voice_emotion.class_order", json.dumps(CLASS_ORDER))

    # Tensors. Names use a flat scheme the C side knows.
    write_tensor(writer, "stft.cos_w", cos_w)
    write_tensor(writer, "stft.sin_w", sin_w)
    write_tensor(writer, "mel.filter", mel_mat)
    write_tensor(writer, "conv1.weight", conv1_w)
    write_tensor(writer, "conv1.bias", conv1_b)
    write_tensor(writer, "conv2.weight", conv2_w)
    write_tensor(writer, "conv2.bias", conv2_b)
    for i, L in enumerate(layers):
        for tname, arr in L.items():
            write_tensor(writer, f"layer{i}.{tname}", arr)
    write_tensor(writer, "head.weight", head_w)
    write_tensor(writer, "head.bias", head_b)

    writer.write_header_to_file()
    writer.write_kv_data_to_file()
    writer.write_tensors_to_file()
    writer.close()

    n_tensors = (
        3  # stft + mel
        + 4  # conv1+conv2 weights+biases
        + len(layers) * 12
        + 2  # head
    )

    return {
        "n_tensors": n_tensors,
        "output_path": str(output_path),
        "sample_rate": SAMPLE_RATE,
        "num_classes": NUM_CLASSES,
        "class_order": CLASS_ORDER,
        "variant": VOICE_EMOTION_VARIANT,
    }


def _build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    p.add_argument(
        "--onnx", type=Path, required=True,
        help="Path to the upstream Wav2Small ONNX (cls7 head).",
    )
    p.add_argument(
        "--output", type=Path, required=True,
        help="Output GGUF path.",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_arg_parser().parse_args(argv)
    stats = convert(onnx_path=args.onnx, output_path=args.output)
    print(json.dumps(stats, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
