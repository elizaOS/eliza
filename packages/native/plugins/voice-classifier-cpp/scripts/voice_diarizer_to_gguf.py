#!/usr/bin/env python3
"""Convert a Pyannote-3 segmentation diarizer checkpoint to a GGUF
file the voice-classifier-cpp runtime loads via a pure-C forward pass.

Source
------
The upstream `pyannote/segmentation-3.0` PyTorch checkpoint is gated
on HuggingFace, so this converter pulls the already-exported ONNX
graph from `onnx-community/pyannote-segmentation-3.0` (ungated,
MIT). Both routes land identical weight tensors — the only fork-side
parametric op (SincNet's sinc filterbank) has been baked into the
fp32 Conv1d kernel at export time, so this converter just reads the
40 initializers out of the ONNX file and packs them into GGUF.

K3 note: the ONNX file is ~12 MB fp32. With per-tensor q8_0 we land
around 4 MB; we keep fp32 for now to make numerical-parity
verification trivial.

Architecture
------------
- SincNet front-end:
    wav_norm1d (InstanceNorm 1D, affine, 1 channel)
    sincnet.conv1d.0 (precomputed sinc filterbank: [80, 1, 251], stride=10)
    MaxPool(3, stride=3) → InstanceNorm(80, affine) → LeakyReLU
    sincnet.conv1d.1 (Conv1d: 80→60, kernel=5, stride=1)
    MaxPool(3, stride=3) → InstanceNorm(60, affine) → LeakyReLU
    sincnet.conv1d.2 (Conv1d: 60→60, kernel=5, stride=1)
    MaxPool(3, stride=3) → InstanceNorm(60, affine) → LeakyReLU
- BiLSTM × 4:
    Layer 0: input=60,  hidden=128, bidirectional → output 256
    Layer 1: input=256, hidden=128, bidirectional → output 256
    Layer 2: input=256, hidden=128, bidirectional → output 256
    Layer 3: input=256, hidden=128, bidirectional → output 256
- Classifier head:
    Linear 256 → 128 (bias only — weight in MatMul_915)
    Linear 128 → 128 (bias only — weight in MatMul_916)
    Linear 128 → 7   (bias only — weight in MatMul_917)
    LogSoftmax over 7 classes

Output GGUF metadata
--------------------
- voice_diarizer.variant           = "pyannote-segmentation-3.0"
- voice_diarizer.sample_rate       = 16000
- voice_diarizer.num_classes       = 7
- voice_diarizer.window_samples    = 80000 (5 s @ 16 kHz; matches ONNX)
- voice_diarizer.frames_per_window = 293
- voice_diarizer.license           = "MIT"
- voice_diarizer.upstream_commit   = pinned at conversion time
- voice_diarizer.lstm_layers       = 4
- voice_diarizer.lstm_hidden       = 128
- voice_diarizer.linear0_out       = 128
- voice_diarizer.linear1_out       = 128

Tensor names in the GGUF
------------------------
The C-side forward pass (`voice_diarizer.c`) hardcodes these names:

  sincnet.norm_in.weight, sincnet.norm_in.bias            # wav_norm1d  [1]
  sincnet.conv0.weight                                     # sinc kernel [80, 1, 251]
  sincnet.norm0.weight, sincnet.norm0.bias                 # [80]
  sincnet.conv1.weight, sincnet.conv1.bias                 # [60, 80, 5]
  sincnet.norm1.weight, sincnet.norm1.bias                 # [60]
  sincnet.conv2.weight, sincnet.conv2.bias                 # [60, 60, 5]
  sincnet.norm2.weight, sincnet.norm2.bias                 # [60]
  lstm.{L}.W_ih                                            # [4, 4*128, in_size]  (gates concatenated)
  lstm.{L}.W_hh                                            # [4, 4*128, 128]
  lstm.{L}.b_ih                                            # [4, 4*128]
  lstm.{L}.b_hh                                            # [4, 4*128]
   ↑ direction split: dir 0 = forward, dir 1 = backward; gates ordered IOFG (ONNX) → C re-packs as ICFO for cell math
  linear0.weight   [256, 128] (we store row-major: out_features × in_features)
  linear0.bias     [128]
  linear1.weight   [128, 128]
  linear1.bias     [128]
  classifier.weight [7, 128]
  classifier.bias   [7]
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Any

import numpy as np
import onnx
from onnx import numpy_helper

import gguf

# Locked block-format constants — must match voice_classifier.h.
VOICE_DIARIZER_VARIANT = "pyannote-segmentation-3.0"
SAMPLE_RATE = 16000
NUM_CLASSES = 7
WINDOW_SAMPLES = 80_000  # 5 s @ 16 kHz; matches upstream ONNX export
FRAMES_PER_WINDOW = 293  # pyannote-3 frame rate at 5 s windows
LICENSE = "MIT"
LSTM_LAYERS = 4
LSTM_HIDDEN = 128
LINEAR0_OUT = 128
LINEAR1_OUT = 128

# Default upstream commit pinned to the onnx-community export used here.
DEFAULT_UPSTREAM_COMMIT = "733a93b6473d019a773298e08cefa686894b1854"

# The 7-class powerset vocabulary — the only valid output of the head.
POWERSET_LABELS = [
    "silence",
    "speaker_a",
    "speaker_b",
    "speaker_c",
    "speaker_a_b",
    "speaker_a_c",
    "speaker_b_c",
]


def _find_init(model: onnx.ModelProto, name: str) -> np.ndarray:
    for w in model.graph.initializer:
        if w.name == name:
            return numpy_helper.to_array(w)
    raise KeyError(f"initializer {name!r} not found in ONNX graph")


def discover_tensors(onnx_path: Path) -> dict[str, np.ndarray]:
    """Walk the pyannote-3 ONNX graph and return a {gguf_name: np.ndarray}
    map. Raises if any expected weight is missing — silent acceptance
    of upstream renames would mis-attribute speakers."""
    model = onnx.load(str(onnx_path))

    # The ONNX export uses a fixed (and stable) initializer naming convention.
    # We pull the SincNet weights by name.
    sincnet_norm_in_w = _find_init(model, "sincnet.wav_norm1d.weight")
    sincnet_norm_in_b = _find_init(model, "sincnet.wav_norm1d.bias")
    # The Sinc-Conv kernel is precomputed at export time; it lives under
    # the "Concat_2_output_0" suffix because the exporter wrapped the sinc
    # synthesis in an If branch for batch dispatch.
    sincnet_conv0_w = _find_init(model, "/sincnet/conv1d.0/Concat_2_output_0")
    sincnet_norm0_w = _find_init(model, "sincnet.norm1d.0.weight")
    sincnet_norm0_b = _find_init(model, "sincnet.norm1d.0.bias")
    sincnet_conv1_w = _find_init(model, "sincnet.conv1d.1.weight")
    sincnet_conv1_b = _find_init(model, "sincnet.conv1d.1.bias")
    sincnet_norm1_w = _find_init(model, "sincnet.norm1d.1.weight")
    sincnet_norm1_b = _find_init(model, "sincnet.norm1d.1.bias")
    sincnet_conv2_w = _find_init(model, "sincnet.conv1d.2.weight")
    sincnet_conv2_b = _find_init(model, "sincnet.conv1d.2.bias")
    sincnet_norm2_w = _find_init(model, "sincnet.norm1d.2.weight")
    sincnet_norm2_b = _find_init(model, "sincnet.norm1d.2.bias")

    # Sanity-check the shapes — refuse anything that doesn't match the
    # canonical pyannote-3 architecture so a future variant doesn't
    # silently land bad weights.
    assert sincnet_norm_in_w.shape == (1,), sincnet_norm_in_w.shape
    assert sincnet_conv0_w.shape == (80, 1, 251), sincnet_conv0_w.shape
    assert sincnet_norm0_w.shape == (80,), sincnet_norm0_w.shape
    assert sincnet_conv1_w.shape == (60, 80, 5), sincnet_conv1_w.shape
    assert sincnet_norm1_w.shape == (60,), sincnet_norm1_w.shape
    assert sincnet_conv2_w.shape == (60, 60, 5), sincnet_conv2_w.shape
    assert sincnet_norm2_w.shape == (60,), sincnet_norm2_w.shape

    # LSTM: the ONNX export uses anonymous initializer names because the
    # PyTorch export pass renumbered them. We rely on graph-order
    # ordering: 4 LSTM nodes appear in the graph (one per stacked
    # layer), each with 3 weight inputs (W=ih, R=hh, B). The ONNX LSTM
    # op concatenates forward+reverse along the first dim (size 2 for
    # bidirectional), gates IOFC ordered.
    lstm_nodes = [n for n in model.graph.node if n.op_type == "LSTM"]
    assert len(lstm_nodes) == LSTM_LAYERS, f"expected {LSTM_LAYERS} LSTM nodes, got {len(lstm_nodes)}"

    lstm_weights: list[dict[str, np.ndarray]] = []
    for li, node in enumerate(lstm_nodes):
        # node.input[1] = W (input weights), [2] = R (recurrent), [3] = B (bias)
        w_name = node.input[1]
        r_name = node.input[2]
        b_name = node.input[3]
        W = _find_init(model, w_name)  # [2, 4H, in_size]
        R = _find_init(model, r_name)  # [2, 4H, H]
        B = _find_init(model, b_name)  # [2, 8H]  (W bias + R bias concatenated)

        in_size = 60 if li == 0 else 256
        assert W.shape == (2, 4 * LSTM_HIDDEN, in_size), (li, W.shape)
        assert R.shape == (2, 4 * LSTM_HIDDEN, LSTM_HIDDEN), (li, R.shape)
        assert B.shape == (2, 8 * LSTM_HIDDEN), (li, B.shape)

        # ONNX LSTM gate ordering: I, O, F, C (concatenated along the 4H axis).
        # We re-pack to the cell-math convention used in the C forward:
        # I, F, G(=C), O (matches PyTorch's nn.LSTM/CuDNN). The C code reads
        # the tensors back with this ordering; documented at the call site.
        def _reorder_iofc_to_ifgo(t: np.ndarray) -> np.ndarray:
            # t has 4*H along axis 1 (or axis -1 for bias).
            H = LSTM_HIDDEN
            axis = 1 if t.ndim == 3 else 1
            slices = []
            for dir_idx in range(t.shape[0]):
                tt = t[dir_idx]
                # axis 0 of tt is 4H
                i = tt[0 * H:1 * H]
                o = tt[1 * H:2 * H]
                f = tt[2 * H:3 * H]
                c = tt[3 * H:4 * H]
                ifgo = np.concatenate([i, f, c, o], axis=0)
                slices.append(ifgo)
            return np.stack(slices, axis=0)

        def _reorder_iofc_to_ifgo_bias(t: np.ndarray) -> np.ndarray:
            # t: [2, 8H]; 8H = (Wb_iofc | Rb_iofc) per direction.
            H = LSTM_HIDDEN
            out = np.zeros_like(t)
            for d in range(t.shape[0]):
                # First 4H: Wb (iofc order)
                wb = t[d, :4 * H]
                rb = t[d, 4 * H:]
                wb_i, wb_o, wb_f, wb_c = wb[:H], wb[H:2*H], wb[2*H:3*H], wb[3*H:4*H]
                rb_i, rb_o, rb_f, rb_c = rb[:H], rb[H:2*H], rb[2*H:3*H], rb[3*H:4*H]
                out[d, :4 * H] = np.concatenate([wb_i, wb_f, wb_c, wb_o])
                out[d, 4 * H:] = np.concatenate([rb_i, rb_f, rb_c, rb_o])
            return out

        W_ifgo = _reorder_iofc_to_ifgo(W)
        R_ifgo = _reorder_iofc_to_ifgo(R)
        B_ifgo = _reorder_iofc_to_ifgo_bias(B)

        # Split bias into b_ih and b_hh (W bias and R bias) — the C side
        # adds both per timestep (PyTorch / ONNX convention).
        b_ih = B_ifgo[:, :4 * LSTM_HIDDEN]   # [2, 4H]
        b_hh = B_ifgo[:, 4 * LSTM_HIDDEN:]   # [2, 4H]

        lstm_weights.append({
            "W_ih": W_ifgo.astype(np.float32),  # [2, 4H, in_size]
            "W_hh": R_ifgo.astype(np.float32),  # [2, 4H, H]
            "b_ih": b_ih.astype(np.float32),    # [2, 4H]
            "b_hh": b_hh.astype(np.float32),    # [2, 4H]
        })

    # Linear / classifier:
    # ONNX exports MatMul with shape [in, out] when reading the right-hand
    # operand (Y = X @ W). We store row-major out × in to match the C side's
    # convention.
    linear0_w_raw = _find_init(model, "onnx::MatMul_915")    # [256, 128] in × out
    linear0_b     = _find_init(model, "linear.0.bias")        # [128]
    linear1_w_raw = _find_init(model, "onnx::MatMul_916")    # [128, 128]
    linear1_b     = _find_init(model, "linear.1.bias")        # [128]
    cls_w_raw     = _find_init(model, "onnx::MatMul_917")    # [128, 7]
    cls_b         = _find_init(model, "classifier.bias")     # [7]

    # Transpose to [out, in] (row-major) for the C kernel.
    linear0_w = linear0_w_raw.T.astype(np.float32)  # [128, 256]
    linear1_w = linear1_w_raw.T.astype(np.float32)  # [128, 128]
    cls_w     = cls_w_raw.T.astype(np.float32)      # [7, 128]

    assert linear0_w.shape == (128, 256), linear0_w.shape
    assert linear1_w.shape == (128, 128), linear1_w.shape
    assert cls_w.shape == (7, 128), cls_w.shape

    out: dict[str, np.ndarray] = {
        "sincnet.norm_in.weight": sincnet_norm_in_w.astype(np.float32),
        "sincnet.norm_in.bias":   sincnet_norm_in_b.astype(np.float32),
        "sincnet.conv0.weight":   sincnet_conv0_w.astype(np.float32),
        "sincnet.norm0.weight":   sincnet_norm0_w.astype(np.float32),
        "sincnet.norm0.bias":     sincnet_norm0_b.astype(np.float32),
        "sincnet.conv1.weight":   sincnet_conv1_w.astype(np.float32),
        "sincnet.conv1.bias":     sincnet_conv1_b.astype(np.float32),
        "sincnet.norm1.weight":   sincnet_norm1_w.astype(np.float32),
        "sincnet.norm1.bias":     sincnet_norm1_b.astype(np.float32),
        "sincnet.conv2.weight":   sincnet_conv2_w.astype(np.float32),
        "sincnet.conv2.bias":     sincnet_conv2_b.astype(np.float32),
        "sincnet.norm2.weight":   sincnet_norm2_w.astype(np.float32),
        "sincnet.norm2.bias":     sincnet_norm2_b.astype(np.float32),
        "linear0.weight":         linear0_w,
        "linear0.bias":           linear0_b.astype(np.float32),
        "linear1.weight":         linear1_w,
        "linear1.bias":           linear1_b.astype(np.float32),
        "classifier.weight":      cls_w,
        "classifier.bias":        cls_b.astype(np.float32),
    }
    for li in range(LSTM_LAYERS):
        wts = lstm_weights[li]
        out[f"lstm.{li}.W_ih"] = wts["W_ih"]
        out[f"lstm.{li}.W_hh"] = wts["W_hh"]
        out[f"lstm.{li}.b_ih"] = wts["b_ih"]
        out[f"lstm.{li}.b_hh"] = wts["b_hh"]
    return out


def write_gguf(*, tensors: dict[str, np.ndarray], output_path: Path,
               upstream_commit: str) -> dict[str, Any]:
    """Emit the GGUF file with the pyannote-3 weights + metadata."""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    writer = gguf.GGUFWriter(str(output_path), arch="voice_diarizer")

    # Metadata (the C-side voice_gguf_loader.c reads these keys).
    writer.add_uint32("voice_diarizer.sample_rate", SAMPLE_RATE)
    writer.add_uint32("voice_diarizer.num_classes", NUM_CLASSES)
    writer.add_uint32("voice_diarizer.window_samples", WINDOW_SAMPLES)
    writer.add_uint32("voice_diarizer.frames_per_window", FRAMES_PER_WINDOW)
    writer.add_uint32("voice_diarizer.lstm_layers", LSTM_LAYERS)
    writer.add_uint32("voice_diarizer.lstm_hidden", LSTM_HIDDEN)
    writer.add_uint32("voice_diarizer.linear0_out", LINEAR0_OUT)
    writer.add_uint32("voice_diarizer.linear1_out", LINEAR1_OUT)
    writer.add_string("voice_diarizer.variant", VOICE_DIARIZER_VARIANT)
    writer.add_string("voice_diarizer.license", LICENSE)
    writer.add_string("voice_diarizer.upstream_commit", upstream_commit)

    # Powerset label table — surfaced by the C side as a 7-element string
    # array so the JS side can render labels without a hardcoded table.
    writer.add_array("voice_diarizer.powerset_labels", POWERSET_LABELS)

    # Add tensors. Use fp32 for the first cut — int8 quant is a follow-up.
    for name, arr in tensors.items():
        if not arr.flags.c_contiguous:
            arr = np.ascontiguousarray(arr)
        writer.add_tensor(name, arr, raw_dtype=gguf.GGMLQuantizationType.F32)

    writer.write_header_to_file()
    writer.write_kv_data_to_file()
    writer.write_tensors_to_file()
    writer.close()

    stats: dict[str, Any] = {
        "output_path": str(output_path),
        "size_bytes": output_path.stat().st_size,
        "tensor_count": len(tensors),
        "variant": VOICE_DIARIZER_VARIANT,
        "window_samples": WINDOW_SAMPLES,
        "frames_per_window": FRAMES_PER_WINDOW,
    }
    return stats


def convert(*, onnx_path: Path, output_path: Path,
            upstream_commit: str = DEFAULT_UPSTREAM_COMMIT) -> dict[str, Any]:
    if not onnx_path.exists():
        raise FileNotFoundError(onnx_path)
    tensors = discover_tensors(onnx_path)
    return write_gguf(
        tensors=tensors,
        output_path=output_path,
        upstream_commit=upstream_commit,
    )


def _build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    p.add_argument(
        "--onnx",
        type=Path,
        help="Path to the pyannote-segmentation-3.0 ONNX file. "
             "If omitted, downloads from onnx-community/pyannote-segmentation-3.0.",
    )
    p.add_argument(
        "--output",
        type=Path,
        required=True,
        help="Output GGUF path.",
    )
    p.add_argument(
        "--upstream-commit",
        default=DEFAULT_UPSTREAM_COMMIT,
        help="Upstream snapshot commit to pin in metadata.",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_arg_parser().parse_args(argv)
    onnx_path: Path
    if args.onnx is None:
        from huggingface_hub import hf_hub_download
        token = os.environ.get("HF_TOKEN") or None
        local = hf_hub_download(
            repo_id="onnx-community/pyannote-segmentation-3.0",
            filename="onnx/model.onnx",
            token=token,
        )
        onnx_path = Path(local)
    else:
        onnx_path = args.onnx
    stats = convert(
        onnx_path=onnx_path,
        output_path=args.output,
        upstream_commit=args.upstream_commit,
    )
    print(f"Wrote {stats['output_path']} ({stats['size_bytes']:,} bytes, "
          f"{stats['tensor_count']} tensors).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
