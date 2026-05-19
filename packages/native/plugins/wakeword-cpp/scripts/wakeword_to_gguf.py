#!/usr/bin/env python3
"""Convert openWakeWord's three streaming graphs (melspectrogram,
embedding model, classifier head) into three GGUF files the
wakeword-cpp runtime loads through its in-house tensor reader (see
``src/wakeword_runtime.c``).

Upstream
--------
Repo:    https://github.com/dscripka/openWakeWord  (Apache-2.0)
Pinned commit: see ``OPENWAKEWORD_UPSTREAM_COMMIT`` below. The runtime
              reads this key from each GGUF and refuses to load when
              the pin disagrees.

Three ONNX graphs are bundled per wake-word model:

  1. ``melspectrogram.onnx`` — 16 kHz PCM → 32-bin log-mel frames at a
     10 ms (160-sample) hop, 32 ms (512-sample) STFT window. The graph
     is a Conv1D(real) + Conv1D(imag) + power + matmul(melW) + dB-log
     pipeline; only static tensors (the two STFT bases and the mel
     filter matrix) need to ride in the GGUF — the dB-log block is
     reproduced in C.
  2. ``embedding_model.onnx`` — sliding 76-mel-frame window → 96-dim
     embedding. 20 Conv2D layers, fused-BN biases, LeakyReLU(alpha=0.2)
     followed by max(0, x) (an explicit floor that removes the leaky
     negative slope at inference), 4 MaxPool layers. Input shape
     (batch, 76, 32, 1), output (batch, 1, 1, 96).
  3. ``<wake-phrase>.onnx`` — a 4-layer dense head over the last 16
     embeddings → P(wake) ∈ [0, 1]. The head shipped today
     (``hey-eliza-int8.onnx``) is the upstream ``hey_jarvis_v0.1``
     post-trained on the eliza wake phrase. Architecture:
       Flatten(16, 96) → Gemm(1536 → 96) → LayerNorm(96)
                       → ReLU → Gemm(96 → 96)
                       → ReLU → Gemm(96 → 1)
                       → Sigmoid

Inputs
------
- ``--melspec-onnx``    path to ``melspectrogram.onnx``
- ``--embedding-onnx``  path to ``embedding_model.onnx``
- ``--classifier-onnx`` path to the wake-phrase classifier ONNX
                        (e.g. ``hey-eliza-int8.onnx``)

Outputs (three GGUFs in ``--out-dir``)
-------
- ``<phrase>.melspec.gguf``    — fp16 STFT bases + fp16 mel matrix +
                                 metadata.
- ``<phrase>.embedding.gguf``  — fp16 conv weights + fp16 biases +
                                 architecture metadata.
- ``<phrase>.classifier.gguf`` — fp16 Gemm/LayerNorm weights + fp16
                                 biases.

All three carry the same ``wakeword.upstream_commit`` pin; the runtime
refuses to mix GGUFs from different conversions.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Dict

import numpy as np

# ── Locked block-format constants — the runtime refuses GGUFs that disagree ──
# These mirror the openWakeWord upstream graph dimensions exactly. The
# C reference in ``src/wakeword_internal.h`` carries the same numbers.
MELSPEC_N_MELS = 32
MELSPEC_N_FFT = 512
MELSPEC_HOP = 160
MELSPEC_WIN = 512
MELSPEC_N_BINS = MELSPEC_N_FFT // 2 + 1  # 257
EMBEDDING_DIM = 96
EMBEDDING_WINDOW = 76  # mel frames per embedding step
HEAD_WINDOW = 16       # embeddings per classifier step

# Pinned upstream commit (latest stable as of bring-up). Update this and
# re-run conversion when re-pulling the openWakeWord release. The
# runtime reads the matching key from each GGUF and refuses to load on
# a mismatch.
OPENWAKEWORD_UPSTREAM_COMMIT = "368c03716d1e92591906a84949bc477f3a834455"
OPENWAKEWORD_RELEASE_URL = (
    "https://github.com/dscripka/openWakeWord/releases/tag/v0.5.1"
)

# ── melspec ────────────────────────────────────────────────────────────────

# Canonical GGUF tensor names the C runtime expects.
MELSPEC_TENSOR_REAL = "wakeword.melspec.stft_real"
MELSPEC_TENSOR_IMAG = "wakeword.melspec.stft_imag"
MELSPEC_TENSOR_MELW = "wakeword.melspec.melW"


def discover_melspec_tensors(onnx_path: Path) -> Dict[str, np.ndarray]:
    """Walk ``melspectrogram.onnx`` and return the static tensors the
    C-side melspec replicates: the real and imaginary STFT bases
    (Conv1D weights, shape (257, 1, 512)) and the mel filter matrix
    (shape (257, 32)).

    The dB-log post-processing (clip → log → *10/ln(10) → -ref → relmax
    floor at -80 dB) is implemented in C — its constants are baked into
    the runtime and never travel in the GGUF.
    """
    import onnx
    from onnx import numpy_helper

    model = onnx.load(str(onnx_path))
    initializers = {init.name: numpy_helper.to_array(init) for init in model.graph.initializer}

    expected = {
        "0.stft.conv_real.weight": (257, 1, 512),
        "0.stft.conv_imag.weight": (257, 1, 512),
        "1.melW": (257, 32),
    }
    out: Dict[str, np.ndarray] = {}
    for src, shape in expected.items():
        if src not in initializers:
            raise KeyError(
                f"melspec ONNX missing required initializer {src!r}; "
                f"upstream may have renamed it. Re-pin "
                f"OPENWAKEWORD_UPSTREAM_COMMIT and update this script."
            )
        arr = initializers[src]
        if tuple(arr.shape) != shape:
            raise ValueError(
                f"melspec initializer {src} has shape {tuple(arr.shape)}, "
                f"expected {shape}"
            )
        out[src] = arr

    return {
        MELSPEC_TENSOR_REAL: np.ascontiguousarray(out["0.stft.conv_real.weight"]),
        MELSPEC_TENSOR_IMAG: np.ascontiguousarray(out["0.stft.conv_imag.weight"]),
        MELSPEC_TENSOR_MELW: np.ascontiguousarray(out["1.melW"]),
    }


# ── embedding ──────────────────────────────────────────────────────────────

# Conv layers in the embedding model, ordered by graph traversal. Each
# entry is (gguf_tensor_name, src_weight_initializer, src_bias_initializer
# or None when this is the final 1x1 conv that has no bias, kernel_h,
# kernel_w, pad_h, pad_w, c_out, c_in, has_max_pool_after).
#
# Pads come from the ONNX `pads` attribute formatted as [top, left, bottom, right].
# Every layer in this network uses pad = 1 on the trailing time dim for
# 1x3 kernels and pad = 0 (with manual ONNX pad attrs that include 1 on
# both right edges for some kernels) for 3x1 kernels. We canonicalize
# the pad pair as (pad_h, pad_w) and the C runtime applies them
# symmetrically — verified against the openWakeWord ONNX
# `auto_pad=NOTSET` semantics.

# Layout of the conv stack as it appears in embedding_model.onnx:
# (idx, kernel_h, kernel_w, pad_h, pad_w, has_bias, maxpool_after?)
# maxpool_after is one of:
#   None      — no maxpool
#   (kh, kw, sh, sw)  — maxpool params (kernel_size and stride)
EMBEDDING_LAYERS = [
    # idx=0: first conv, 3x3 with pads [0,1,0,1] = (0,1) symmetric
    {"idx": 0,  "kh": 3, "kw": 3, "ph": 0, "pw": 1, "bias": True,  "maxpool": None,            "cout": 24,  "cin": 1},
    {"idx": 1,  "kh": 1, "kw": 3, "ph": 0, "pw": 1, "bias": True,  "maxpool": None,            "cout": 24,  "cin": 24},
    {"idx": 2,  "kh": 3, "kw": 1, "ph": 0, "pw": 0, "bias": True,  "maxpool": (2,2,2,2),       "cout": 24,  "cin": 24},
    {"idx": 3,  "kh": 1, "kw": 3, "ph": 0, "pw": 1, "bias": True,  "maxpool": None,            "cout": 48,  "cin": 24},
    {"idx": 4,  "kh": 3, "kw": 1, "ph": 0, "pw": 0, "bias": True,  "maxpool": None,            "cout": 48,  "cin": 48},
    {"idx": 5,  "kh": 1, "kw": 3, "ph": 0, "pw": 1, "bias": True,  "maxpool": None,            "cout": 48,  "cin": 48},
    {"idx": 6,  "kh": 3, "kw": 1, "ph": 0, "pw": 0, "bias": True,  "maxpool": (1,2,1,2),       "cout": 48,  "cin": 48},
    {"idx": 7,  "kh": 1, "kw": 3, "ph": 0, "pw": 1, "bias": True,  "maxpool": None,            "cout": 72,  "cin": 48},
    {"idx": 8,  "kh": 3, "kw": 1, "ph": 0, "pw": 0, "bias": True,  "maxpool": None,            "cout": 72,  "cin": 72},
    {"idx": 9,  "kh": 1, "kw": 3, "ph": 0, "pw": 1, "bias": True,  "maxpool": None,            "cout": 72,  "cin": 72},
    {"idx": 10, "kh": 3, "kw": 1, "ph": 0, "pw": 0, "bias": True,  "maxpool": (2,2,2,2),       "cout": 72,  "cin": 72},
    {"idx": 11, "kh": 1, "kw": 3, "ph": 0, "pw": 1, "bias": True,  "maxpool": None,            "cout": 96,  "cin": 72},
    {"idx": 12, "kh": 3, "kw": 1, "ph": 0, "pw": 0, "bias": True,  "maxpool": None,            "cout": 96,  "cin": 96},
    {"idx": 13, "kh": 1, "kw": 3, "ph": 0, "pw": 1, "bias": True,  "maxpool": None,            "cout": 96,  "cin": 96},
    {"idx": 14, "kh": 3, "kw": 1, "ph": 0, "pw": 0, "bias": True,  "maxpool": (1,2,1,2),       "cout": 96,  "cin": 96},
    {"idx": 15, "kh": 1, "kw": 3, "ph": 0, "pw": 1, "bias": True,  "maxpool": None,            "cout": 96,  "cin": 96},
    {"idx": 16, "kh": 3, "kw": 1, "ph": 0, "pw": 0, "bias": True,  "maxpool": None,            "cout": 96,  "cin": 96},
    {"idx": 17, "kh": 1, "kw": 3, "ph": 0, "pw": 1, "bias": True,  "maxpool": None,            "cout": 96,  "cin": 96},
    {"idx": 18, "kh": 3, "kw": 1, "ph": 0, "pw": 0, "bias": True,  "maxpool": (2,2,2,2),       "cout": 96,  "cin": 96},
    # final 1x1-style conv: 3x1 kernel applied to (1, 1) → (1,1) with no bias
    {"idx": 19, "kh": 3, "kw": 1, "ph": 0, "pw": 0, "bias": False, "maxpool": None,            "cout": 96,  "cin": 96},
]


def _emb_weight_name(idx: int) -> str:
    if idx == 19:
        return "model/conv2d_19/Conv2D/ReadVariableOp:0"
    if idx == 0:
        return "model/conv2d/Conv2D_weights_fused_bn"
    return f"model/conv2d_{idx}/Conv2D_weights_fused_bn"


def _emb_bias_name(idx: int) -> str:
    if idx == 0:
        return "model/conv2d/Conv2D_bias_fused_bn"
    return f"model/conv2d_{idx}/Conv2D_bias_fused_bn"


def discover_embedding_tensors(onnx_path: Path) -> Dict[str, np.ndarray]:
    """Walk ``embedding_model.onnx`` and return the per-conv weight + bias
    tensors keyed by canonical GGUF names (``wakeword.embedding.conv<idx>.weight``
    and ``wakeword.embedding.conv<idx>.bias``).

    Sanity-checks each tensor shape against the declared layout. Any
    mismatch is a hard error — silent acceptance hides upstream renames
    that would produce subtly-wrong inference.
    """
    import onnx
    from onnx import numpy_helper

    model = onnx.load(str(onnx_path))
    initializers = {init.name: numpy_helper.to_array(init) for init in model.graph.initializer}

    out: Dict[str, np.ndarray] = {}
    for layer in EMBEDDING_LAYERS:
        idx = layer["idx"]
        wname = _emb_weight_name(idx)
        if wname not in initializers:
            raise KeyError(f"embedding ONNX missing weight {wname!r} for conv {idx}")
        warr = initializers[wname]
        expected_shape = (layer["cout"], layer["cin"], layer["kh"], layer["kw"])
        if tuple(warr.shape) != expected_shape:
            raise ValueError(
                f"embedding conv{idx} weight shape {tuple(warr.shape)} != expected {expected_shape}"
            )
        out[f"wakeword.embedding.conv{idx}.weight"] = np.ascontiguousarray(warr)

        if layer["bias"]:
            bname = _emb_bias_name(idx)
            if bname not in initializers:
                raise KeyError(f"embedding ONNX missing bias {bname!r} for conv {idx}")
            barr = initializers[bname]
            expected_bshape = (layer["cout"],)
            if tuple(barr.shape) != expected_bshape:
                raise ValueError(
                    f"embedding conv{idx} bias shape {tuple(barr.shape)} != expected {expected_bshape}"
                )
            out[f"wakeword.embedding.conv{idx}.bias"] = np.ascontiguousarray(barr)

    return out


# ── classifier ─────────────────────────────────────────────────────────────

# (gguf name, src initializer name, expected shape)
CLASSIFIER_TENSORS = [
    ("wakeword.classifier.gemm0.weight", "net.1.weight", (96, 1536)),
    ("wakeword.classifier.gemm0.bias",   "net.1.bias",   (96,)),
    ("wakeword.classifier.ln.weight",    "net.2.weight", (96,)),
    ("wakeword.classifier.ln.bias",      "net.2.bias",   (96,)),
    ("wakeword.classifier.gemm1.weight", "net.4.weight", (96, 96)),
    ("wakeword.classifier.gemm1.bias",   "net.4.bias",   (96,)),
    ("wakeword.classifier.gemm2.weight", "net.6.weight", (1, 96)),
    ("wakeword.classifier.gemm2.bias",   "net.6.bias",   (1,)),
]


def discover_classifier_tensors(onnx_path: Path) -> Dict[str, np.ndarray]:
    """Walk a wake-phrase classifier ONNX and return the dense head's
    weights keyed by canonical GGUF names. Architecture is locked at:
    Flatten(16, 96) → Gemm(1536→96) → LayerNorm(96) → ReLU → Gemm(96→96)
    → ReLU → Gemm(96→1) → Sigmoid.
    """
    import onnx
    from onnx import numpy_helper

    model = onnx.load(str(onnx_path))
    initializers = {init.name: numpy_helper.to_array(init) for init in model.graph.initializer}

    out: Dict[str, np.ndarray] = {}
    for gguf_name, src_name, shape in CLASSIFIER_TENSORS:
        if src_name not in initializers:
            raise KeyError(
                f"classifier ONNX missing initializer {src_name!r}; head architecture changed?"
            )
        arr = initializers[src_name]
        if tuple(arr.shape) != shape:
            raise ValueError(
                f"classifier {src_name} has shape {tuple(arr.shape)}, expected {shape}"
            )
        out[gguf_name] = np.ascontiguousarray(arr)
    return out


# ── GGUF writers ───────────────────────────────────────────────────────────

def _common_metadata() -> Dict[str, object]:
    return {
        "wakeword.upstream_commit": OPENWAKEWORD_UPSTREAM_COMMIT,
        "wakeword.release_url": OPENWAKEWORD_RELEASE_URL,
        "wakeword.melspec_n_mels": MELSPEC_N_MELS,
        "wakeword.melspec_n_fft": MELSPEC_N_FFT,
        "wakeword.melspec_hop": MELSPEC_HOP,
        "wakeword.melspec_win": MELSPEC_WIN,
        "wakeword.embedding_dim": EMBEDDING_DIM,
        "wakeword.embedding_window": EMBEDDING_WINDOW,
        "wakeword.head_window": HEAD_WINDOW,
    }


def _write_metadata(writer, meta: Dict[str, object], phrase: str) -> None:
    writer.add_string("wakeword.phrase", phrase)
    for key, val in meta.items():
        if isinstance(val, str):
            writer.add_string(key, val)
        elif isinstance(val, int):
            writer.add_uint32(key, int(val))
        elif isinstance(val, float):
            writer.add_float32(key, float(val))
        else:
            raise TypeError(f"unhandled metadata type for {key}: {type(val)}")


def write_gguf(
    *,
    arch: str,
    tensors: Dict[str, np.ndarray],
    metadata: Dict[str, object],
    phrase: str,
    output_path: Path,
) -> Dict[str, object]:
    """Emit a single GGUF file as fp16 tensors + the supplied metadata.
    The C runtime indexes tensors by name, so write order does not
    affect correctness — sorted for determinism.
    """
    import gguf

    writer = gguf.GGUFWriter(str(output_path), arch=arch)
    _write_metadata(writer, metadata, phrase)

    total_bytes = 0
    for name in sorted(tensors.keys()):
        arr16 = tensors[name].astype(np.float16)
        writer.add_tensor(name, arr16)
        total_bytes += arr16.size * 2

    writer.write_header_to_file()
    writer.write_kv_data_to_file()
    writer.write_tensors_to_file()
    writer.close()

    return {
        "arch": arch,
        "n_tensors": len(tensors),
        "approx_tensor_bytes": total_bytes,
        "output_path": str(output_path),
    }


def convert(
    *,
    melspec_onnx: Path,
    embedding_onnx: Path,
    classifier_onnx: Path,
    phrase: str,
    out_dir: Path,
) -> Dict[str, object]:
    """Drive the conversion. Returns a small per-file stats dict."""
    for p, label in [
        (melspec_onnx, "--melspec-onnx"),
        (embedding_onnx, "--embedding-onnx"),
        (classifier_onnx, "--classifier-onnx"),
    ]:
        if not p.exists():
            raise FileNotFoundError(f"{label} not found: {p}")

    out_dir.mkdir(parents=True, exist_ok=True)
    base = phrase.replace(" ", "-").lower()
    common_meta = _common_metadata()

    melspec_tensors = discover_melspec_tensors(melspec_onnx)
    embedding_tensors = discover_embedding_tensors(embedding_onnx)
    classifier_tensors = discover_classifier_tensors(classifier_onnx)

    return {
        "melspec": write_gguf(
            arch="wakeword-melspec",
            tensors=melspec_tensors,
            metadata=common_meta,
            phrase=phrase,
            output_path=out_dir / f"{base}.melspec.gguf",
        ),
        "embedding": write_gguf(
            arch="wakeword-embedding",
            tensors=embedding_tensors,
            metadata=common_meta,
            phrase=phrase,
            output_path=out_dir / f"{base}.embedding.gguf",
        ),
        "classifier": write_gguf(
            arch="wakeword-classifier",
            tensors=classifier_tensors,
            metadata=common_meta,
            phrase=phrase,
            output_path=out_dir / f"{base}.classifier.gguf",
        ),
    }


def _build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    p.add_argument("--melspec-onnx",    type=Path, required=True,
                   help="Path to openWakeWord's melspectrogram.onnx.")
    p.add_argument("--embedding-onnx",  type=Path, required=True,
                   help="Path to openWakeWord's embedding_model.onnx.")
    p.add_argument("--classifier-onnx", type=Path, required=True,
                   help="Path to the wake-phrase classifier ONNX (e.g. hey-eliza-int8.onnx).")
    p.add_argument("--phrase", type=str, default="hey eliza",
                   help="Wake phrase the classifier was trained on (default: 'hey eliza').")
    p.add_argument("--out-dir", type=Path, required=True,
                   help="Directory the three GGUFs are written to.")
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_arg_parser().parse_args(argv)
    stats = convert(
        melspec_onnx=args.melspec_onnx,
        embedding_onnx=args.embedding_onnx,
        classifier_onnx=args.classifier_onnx,
        phrase=args.phrase,
        out_dir=args.out_dir,
    )
    for stage, st in stats.items():
        print(
            f"[wakeword_to_gguf] {stage:10s} -> {st['output_path']}  "
            f"({st['n_tensors']} tensors, ~{st['approx_tensor_bytes']:,} bytes)"
        )
    print(f"[wakeword_to_gguf] upstream_commit = {OPENWAKEWORD_UPSTREAM_COMMIT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:] if len(sys.argv) > 1 else None))
