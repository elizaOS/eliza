#!/usr/bin/env python3
"""Convert pyannote-segmentation-3.0 int8 ONNX to voice_diarizer GGUF.

Downloads from elizaos/eliza-1 (voice/diarizer/pyannote-segmentation-3.0-int8.onnx)
or reads a local ONNX, then dequantizes and writes a GGUF whose tensor names
match what voice_diarizer.c expects (diar_resolve_tensors).

ONNX→C tensor name mapping (after dequantization + reshape where needed):

  sincnet.wav_norm1d.weight → sincnet.norm_in.weight [1]
  sincnet.wav_norm1d.bias   → sincnet.norm_in.bias   [1]
  /sincnet/conv1d.0/...quantized (int8, per-dir scale)
                            → sincnet.conv0.weight    [80, 1, 251]
  sincnet.norm1d.0.weight   → sincnet.norm0.weight   [80]
  sincnet.norm1d.0.bias     → sincnet.norm0.bias     [80]
  sincnet.conv1d.1.weight*  → sincnet.conv1.weight   [60, 80, 5]
  sincnet.conv1d.1.bias     → sincnet.conv1.bias     [60]
  sincnet.norm1d.1.weight   → sincnet.norm1.weight   [60]
  sincnet.norm1d.1.bias     → sincnet.norm1.bias     [60]
  sincnet.conv1d.2.weight*  → sincnet.conv2.weight   [60, 60, 5]
  sincnet.conv1d.2.bias     → sincnet.conv2.bias     [60]
  sincnet.norm1d.2.weight   → sincnet.norm2.weight   [60]
  sincnet.norm1d.2.bias     → sincnet.norm2.bias     [60]
  onnx::LSTM_{783/826/869/912}[:,  :512] → lstm.{0-3}.b_ih  [2, 4H]
  onnx::LSTM_{783/826/869/912}[:, 512:] → lstm.{0-3}.b_hh  [2, 4H]
  onnx::LSTM_{784/827/870/913}* (int8) T → lstm.{0-3}.W_ih  [2, 4H, in]
  onnx::LSTM_{785/828/871/914}* (int8) T → lstm.{0-3}.W_hh  [2, 4H, H]
  onnx::MatMul_915* T          → linear0.weight   [128, 256]
  linear.0.bias                → linear0.bias     [128]
  onnx::MatMul_916* T          → linear1.weight   [128, 128]
  linear.1.bias                → linear1.bias     [128]
  onnx::MatMul_917* T          → classifier.weight [7, 128]
  classifier.bias              → classifier.bias   [7]

Usage:
  python convert_pyannote_to_gguf.py --out /tmp/eliza1_gguf_output/pyannote-segmentation-3.0.gguf
  python convert_pyannote_to_gguf.py --onnx /path/to/model.onnx --out out.gguf
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
import onnx
from onnx import numpy_helper

HF_REPO = "elizaos/eliza-1"
HF_PATH = "voice/diarizer/pyannote-segmentation-3.0-int8.onnx"

# LSTM per-layer ONNX tensor id offsets (base ids from inspection)
_LSTM_BIAS_IDS = [783, 826, 869, 912]
_LSTM_W_IH_IDS = [784, 827, 870, 913]
_LSTM_W_HH_IDS = [785, 828, 871, 914]


def download_onnx(token: str | None) -> Path:
    from huggingface_hub import hf_hub_download
    local = hf_hub_download(repo_id=HF_REPO, filename=HF_PATH, token=token)
    return Path(local)


def _dequant_per_dir(q: np.ndarray, scale: np.ndarray, zp: np.ndarray) -> np.ndarray:
    """Dequantize int8 tensor with per-direction scale/zp, shape [dirs, ...]."""
    out = q.astype(np.float32)
    for d in range(q.shape[0]):
        out[d] = (out[d] - float(zp[d])) * float(scale[d])
    return out


def _dequant_scalar(q: np.ndarray, scale: np.ndarray, zp: np.ndarray) -> np.ndarray:
    """Dequantize int8 tensor with scalar scale/zp."""
    return (q.astype(np.float32) - float(zp)) * float(scale)


def build_tensor_map(onnx_path: Path) -> dict[str, np.ndarray]:
    model = onnx.load(str(onnx_path))
    inits = {init.name: numpy_helper.to_array(init) for init in model.graph.initializer}

    tensors: dict[str, np.ndarray] = {}

    # SincNet input norm (1-channel InstanceNorm)
    tensors["sincnet.norm_in.weight"] = inits["sincnet.wav_norm1d.weight"].astype(np.float32)
    tensors["sincnet.norm_in.bias"] = inits["sincnet.wav_norm1d.bias"].astype(np.float32)

    # SincNet conv0 [80, 1, 251] — baked sinc filterbank (int8, per-dir scale)
    conv0_q = inits["/sincnet/conv1d.0/Concat_2_output_0_quantized"]
    conv0_s = inits["/sincnet/conv1d.0/Concat_2_output_0_scale"]
    conv0_zp = inits["/sincnet/conv1d.0/Concat_2_output_0_zero_point"]
    # conv0_q shape is [80, 1, 251]; scale is scalar
    tensors["sincnet.conv0.weight"] = _dequant_scalar(conv0_q, conv0_s, conv0_zp)

    # InstanceNorm after SincNet
    tensors["sincnet.norm0.weight"] = inits["sincnet.norm1d.0.weight"].astype(np.float32)
    tensors["sincnet.norm0.bias"] = inits["sincnet.norm1d.0.bias"].astype(np.float32)

    # Conv1 [60, 80, 5]
    conv1_q = inits["sincnet.conv1d.1.weight_quantized"]
    conv1_s = inits["sincnet.conv1d.1.weight_scale"]
    conv1_zp = inits["sincnet.conv1d.1.weight_zero_point"]
    tensors["sincnet.conv1.weight"] = _dequant_scalar(conv1_q, conv1_s, conv1_zp)
    tensors["sincnet.conv1.bias"] = inits["sincnet.conv1d.1.bias"].astype(np.float32)
    tensors["sincnet.norm1.weight"] = inits["sincnet.norm1d.1.weight"].astype(np.float32)
    tensors["sincnet.norm1.bias"] = inits["sincnet.norm1d.1.bias"].astype(np.float32)

    # Conv2 [60, 60, 5]
    conv2_q = inits["sincnet.conv1d.2.weight_quantized"]
    conv2_s = inits["sincnet.conv1d.2.weight_scale"]
    conv2_zp = inits["sincnet.conv1d.2.weight_zero_point"]
    tensors["sincnet.conv2.weight"] = _dequant_scalar(conv2_q, conv2_s, conv2_zp)
    tensors["sincnet.conv2.bias"] = inits["sincnet.conv1d.2.bias"].astype(np.float32)
    tensors["sincnet.norm2.weight"] = inits["sincnet.norm1d.2.weight"].astype(np.float32)
    tensors["sincnet.norm2.bias"] = inits["sincnet.norm1d.2.bias"].astype(np.float32)

    # BiLSTM layers
    # ONNX stores W_ih as [dirs, input_size, 4H] — transpose to [dirs, 4H, input_size]
    # ONNX stores W_hh as [dirs, hidden, 4H] — transpose to [dirs, 4H, hidden]
    # ONNX bias: [dirs, 8H] = [b_ih (4H) | b_hh (4H)] concatenated
    for li in range(4):
        bias_key = f"onnx::LSTM_{_LSTM_BIAS_IDS[li]}"
        wih_base = f"onnx::LSTM_{_LSTM_W_IH_IDS[li]}"
        whh_base = f"onnx::LSTM_{_LSTM_W_HH_IDS[li]}"

        bias = inits[bias_key].astype(np.float32)  # [2, 1024]
        H = bias.shape[1] // 2
        tensors[f"lstm.{li}.b_ih"] = bias[:, :H]    # [2, 4H=512]
        tensors[f"lstm.{li}.b_hh"] = bias[:, H:]    # [2, 4H=512]

        # W_ih: [dirs, in_size, 4H] int8 → dequant → transpose → [dirs, 4H, in_size]
        w_ih_q = inits[f"{wih_base}_quantized"]
        w_ih_s = inits[f"{wih_base}_scale"]
        w_ih_zp = inits[f"{wih_base}_zero_point"]
        w_ih = _dequant_per_dir(w_ih_q, w_ih_s, w_ih_zp)
        tensors[f"lstm.{li}.W_ih"] = w_ih.transpose(0, 2, 1)  # [dirs, 4H, in]

        # W_hh: [dirs, hidden, 4H] int8 → dequant → transpose → [dirs, 4H, hidden]
        w_hh_q = inits[f"{whh_base}_quantized"]
        w_hh_s = inits[f"{whh_base}_scale"]
        w_hh_zp = inits[f"{whh_base}_zero_point"]
        w_hh = _dequant_per_dir(w_hh_q, w_hh_s, w_hh_zp)
        tensors[f"lstm.{li}.W_hh"] = w_hh.transpose(0, 2, 1)  # [dirs, 4H, hidden]

    # Linear layers — stored as MatMul int8 weights in transposed form
    # [in_features, out_features] → need [out_features, in_features] for y = x @ W^T
    def _dequant_matmul(base: str) -> np.ndarray:
        q = inits[f"{base}_quantized"]
        s = inits[f"{base}_scale"]
        zp = inits[f"{base}_zero_point"]
        return _dequant_scalar(q, s, zp).T  # transpose: [out, in]

    tensors["linear0.weight"] = _dequant_matmul("onnx::MatMul_915")  # [128, 256]
    tensors["linear0.bias"] = inits["linear.0.bias"].astype(np.float32)
    tensors["linear1.weight"] = _dequant_matmul("onnx::MatMul_916")  # [128, 128]
    tensors["linear1.bias"] = inits["linear.1.bias"].astype(np.float32)
    tensors["classifier.weight"] = _dequant_matmul("onnx::MatMul_917")  # [7, 128]
    tensors["classifier.bias"] = inits["classifier.bias"].astype(np.float32)

    return tensors


def write_gguf(tensors: dict[str, np.ndarray], out_path: Path) -> None:
    import gguf

    out_path.parent.mkdir(parents=True, exist_ok=True)
    writer = gguf.GGUFWriter(str(out_path), "voice_diarizer")
    writer.add_uint32("voice_diarizer.sample_rate", 16000)
    writer.add_uint32("voice_diarizer.num_classes", 7)
    writer.add_uint32("voice_diarizer.frames_per_window", 293)
    writer.add_string("voice_diarizer.variant", "pyannote-segmentation-3.0-int8")

    for name, arr in tensors.items():
        writer.add_tensor(name, np.ascontiguousarray(arr.astype(np.float32)))

    writer.write_header_to_file()
    writer.write_kv_data_to_file()
    writer.write_tensors_to_file()
    writer.close()
    print(f"[pyannote] wrote {out_path} ({len(tensors)} tensors)", file=sys.stderr)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--onnx", type=Path, help="Local ONNX path (skips HF download)")
    ap.add_argument("--hf-token", default=None)
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args(argv)

    if args.onnx:
        onnx_path = args.onnx
    else:
        print(f"[pyannote] downloading {HF_PATH} from {HF_REPO}", file=sys.stderr)
        onnx_path = download_onnx(args.hf_token)

    tensors = build_tensor_map(onnx_path)
    write_gguf(tensors, args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
