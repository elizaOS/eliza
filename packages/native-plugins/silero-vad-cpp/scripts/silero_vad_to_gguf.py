#!/usr/bin/env python3
"""Convert a snakers4/silero-vad v5 checkpoint into a single GGUF file
the silero-vad-cpp runtime loads through its in-house tensor reader
(see ``src/silero_vad_runtime.c``).

The upstream ships the v5 weights as a single ONNX model that switches
between two sample-rate-specific subgraphs at runtime
(``sr==8000`` vs ``sr==16000``). This converter targets the **16 kHz**
branch only — the runtime is dimensioned for that one and refuses to
load anything else.

Inputs
------
- ``--weights``: path to ``silero_vad.onnx`` from the pinned commit. If
  omitted, the converter downloads the file from the pinned commit.
- ``--output``: GGUF output path.

Architecture (v5, 16 kHz branch, all extracted from the ONNX as
``Constant`` nodes inside the ``If(sr==16000)`` else-branch):

  STFT front-end
    stft.forward_basis_buffer        (130, 1, 128)  fp32
      → Conv1D(in=1, out=130, k=128, stride=64) of reflection-padded
        input (pad=32 each side; 512 → 576 → 8 frames). The first 65
        output channels are the "real" part of a fixed STFT basis;
        channels 65..130 are the "imag" part. Magnitude is
        sqrt(real^2 + imag^2) → (1, 65, 8).

  Encoder (4 stacked Conv1D + ReLU)
    encoder.0.reparam_conv.weight    (128, 65, 3)
    encoder.0.reparam_conv.bias      (128)         stride=1, pad=1
    encoder.1.reparam_conv.weight    (64, 128, 3)
    encoder.1.reparam_conv.bias      (64)          stride=2, pad=1
    encoder.2.reparam_conv.weight    (64, 64, 3)
    encoder.2.reparam_conv.bias      (64)          stride=2, pad=1
    encoder.3.reparam_conv.weight    (128, 64, 3)
    encoder.3.reparam_conv.bias      (128)         stride=1, pad=1
      Final encoder activation: (1, 128, 2).

  Decoder LSTM (single layer, 128 → 128)
    decoder.rnn.weight_ih            (512, 128)    rows in i,f,g,o order
    decoder.rnn.weight_hh            (512, 128)    rows in i,f,g,o order
    decoder.rnn.bias_ih              (512)
    decoder.rnn.bias_hh              (512)
      Two timesteps per window (T=2 from the encoder); the LSTM hidden
      state carries from window N to window N+1 (managed by the runtime
      via ``silero_vad_state.h``).

  Output head
    decoder.decoder.2.weight         (1, 128, 1)   1×1 Conv1D 128→1
    decoder.decoder.2.bias           (1)
      Apply ReLU to the LSTM output, then 1×1 conv, then sigmoid →
      scalar speech probability in [0, 1].

Output GGUF metadata keys (all read by ``silero_vad_runtime.c``):
- ``silero_vad.variant``         = "silero_vad_v5"   (locked)
- ``silero_vad.window_samples``  = 512               (locked)
- ``silero_vad.sample_rate_hz``  = 16000             (locked)
- ``silero_vad.state_hidden_dim``= 128               (locked)
- ``silero_vad.state_cell_dim``  = 128               (locked)
- ``silero_vad.upstream_commit`` = pinned snakers4/silero-vad commit
- ``silero_vad.stft_filter_length`` = 128
- ``silero_vad.stft_hop``        = 64
- ``silero_vad.stft_pad``        = 32
- ``silero_vad.encoder_t``       = 2
- ``silero_vad.lstm_input_dim``  = 128

Tensors are written as fp16 by default (the entire model totals
~1.7 M parameters; fp16 produces a ~3.5 MB file). The runtime knows
how to upcast to fp32 at load time.
"""

from __future__ import annotations

import argparse
import sys
import urllib.request
from pathlib import Path
from typing import Dict

import numpy as np


# ── Locked block-format constants ───────────────────────────────────────────
# These match the macros in `include/silero_vad/silero_vad.h` exactly;
# the runtime reads the same values from the GGUF metadata and refuses
# to load on mismatch.

MODEL_VARIANT = "silero_vad_v5"
WINDOW_SAMPLES = 512
SAMPLE_RATE_HZ = 16000
STATE_HIDDEN_DIM = 128
STATE_CELL_DIM = 128

# STFT geometry (extracted from the ONNX `stft.forward_basis_buffer`
# shape and the Conv attributes inside the 16k branch).
STFT_FILTER_LENGTH = 128
STFT_HOP = 64
STFT_PAD = 32  # reflection padding applied to each side of the 512-sample window
ENCODER_T = 2  # encoder output timesteps per window (after stride 2,2)
LSTM_INPUT_DIM = 128

# Pinned upstream commit. The runtime reads this key from the GGUF and
# refuses to load when it differs from its own pin.
SILERO_VAD_UPSTREAM_COMMIT = "980b17e9d56463e51393a8d92ded473f1b17896a"

# Canonical upstream URL (raw fetch of the ONNX bundle at the pinned
# commit — this is the file the converter accepts as `--weights`).
UPSTREAM_ONNX_URL = (
    "https://github.com/snakers4/silero-vad/raw/"
    f"{SILERO_VAD_UPSTREAM_COMMIT}/src/silero_vad/data/silero_vad.onnx"
)


# Mapping from the ONNX constant name (after stripping the
# `If_0_else_branch__Inline_0__` prefix the upstream applies inside its
# sr-conditional `If` node) to the canonical GGUF tensor name the C
# runtime indexes by.
_TENSOR_RENAMES: Dict[str, str] = {
    "stft.forward_basis_buffer":       "vad.stft.basis",
    "encoder.0.reparam_conv.weight":   "vad.encoder.0.weight",
    "encoder.0.reparam_conv.bias":     "vad.encoder.0.bias",
    "encoder.1.reparam_conv.weight":   "vad.encoder.1.weight",
    "encoder.1.reparam_conv.bias":     "vad.encoder.1.bias",
    "encoder.2.reparam_conv.weight":   "vad.encoder.2.weight",
    "encoder.2.reparam_conv.bias":     "vad.encoder.2.bias",
    "encoder.3.reparam_conv.weight":   "vad.encoder.3.weight",
    "encoder.3.reparam_conv.bias":     "vad.encoder.3.bias",
    "decoder.rnn.weight_ih":           "vad.lstm.weight_ih",
    "decoder.rnn.weight_hh":           "vad.lstm.weight_hh",
    "decoder.rnn.bias_ih":             "vad.lstm.bias_ih",
    "decoder.rnn.bias_hh":             "vad.lstm.bias_hh",
    "decoder.decoder.2.weight":        "vad.head.weight",
    "decoder.decoder.2.bias":          "vad.head.bias",
}

# Reference shapes (fp32). Used to refuse silent upstream renames.
_EXPECTED_SHAPES: Dict[str, tuple] = {
    "vad.stft.basis":          (130, 1, 128),
    "vad.encoder.0.weight":    (128, 65, 3),
    "vad.encoder.0.bias":      (128,),
    "vad.encoder.1.weight":    (64, 128, 3),
    "vad.encoder.1.bias":      (64,),
    "vad.encoder.2.weight":    (64, 64, 3),
    "vad.encoder.2.bias":      (64,),
    "vad.encoder.3.weight":    (128, 64, 3),
    "vad.encoder.3.bias":      (128,),
    "vad.lstm.weight_ih":      (512, 128),
    "vad.lstm.weight_hh":      (512, 128),
    "vad.lstm.bias_ih":        (512,),
    "vad.lstm.bias_hh":        (512,),
    "vad.head.weight":         (1, 128, 1),
    "vad.head.bias":           (1,),
}


def discover_tensors(weights_path: Path) -> Dict[str, np.ndarray]:
    """Walk a snakers4/silero-vad v5 ONNX file and return a
    ``{canonical_name: np.ndarray}`` map.

    The v5 ONNX model wraps both sample-rate variants in a top-level
    `If(sr==8000)` node; weights are stored as `Constant` nodes inside
    each branch. We only target the **16 kHz branch** (the
    `else_branch` of the top-level `If`). All upstream constant names
    inside that branch carry the prefix
    `If_0_else_branch__Inline_0__` — we strip it, then map through
    `_TENSOR_RENAMES`, then sanity-check shapes against
    `_EXPECTED_SHAPES`.

    The TorchScript JIT path is intentionally not supported. The ONNX
    model is the canonical artifact; everything we need is in there,
    and supporting two formats just doubles the breakage surface.
    """
    if weights_path.suffix.lower() != ".onnx":
        raise ValueError(
            f"unsupported extension {weights_path.suffix!r}; this converter "
            f"only accepts the upstream ONNX file ({UPSTREAM_ONNX_URL})"
        )

    import onnx  # type: ignore[import-not-found]
    from onnx import numpy_helper  # type: ignore[import-not-found]

    model = onnx.load(str(weights_path))

    # Locate the top-level `If` and grab its `else_branch` (sr==16000).
    else_branch = None
    for node in model.graph.node:
        if node.op_type != "If":
            continue
        for attr in node.attribute:
            if attr.name == "else_branch":
                else_branch = attr.g
                break
        if else_branch is not None:
            break
    if else_branch is None:
        raise ValueError("v5 ONNX model has no top-level If/else_branch — wrong file?")

    prefix = "If_0_else_branch__Inline_0__"
    out: Dict[str, np.ndarray] = {}
    for node in else_branch.node:
        if node.op_type != "Constant":
            continue
        if not node.output:
            continue
        raw_name = node.output[0]
        # Only weights live with the inline prefix; numeric scalars used
        # by Slice/Pad ops use a different prefix and are irrelevant.
        if not raw_name.startswith(prefix):
            continue
        clean = raw_name[len(prefix):]
        canonical = _TENSOR_RENAMES.get(clean)
        if canonical is None:
            continue  # not a weight we care about (Slice indices, etc.)
        for attr in node.attribute:
            if attr.name == "value":
                out[canonical] = np.ascontiguousarray(numpy_helper.to_array(attr.t))
                break

    _sanity_check(out)
    return out


def _sanity_check(tensors: Dict[str, np.ndarray]) -> None:
    """Refuse to convert when an upstream rename has dropped or reshaped a
    weight. Silent acceptance hides the kind of breakage that produces
    subtly-wrong inference."""
    missing = [n for n in _EXPECTED_SHAPES if n not in tensors]
    if missing:
        raise KeyError(
            f"ONNX file is missing required tensors: {missing}. The upstream "
            f"may have renamed something; update _TENSOR_RENAMES in this "
            f"script and re-pin SILERO_VAD_UPSTREAM_COMMIT."
        )
    for name, expected in _EXPECTED_SHAPES.items():
        actual = tuple(tensors[name].shape)
        if actual != expected:
            raise ValueError(
                f"tensor {name} has shape {actual}, expected {expected}. "
                f"Refusing to write a GGUF the C runtime would mis-interpret."
            )


def write_gguf(
    *,
    tensors: Dict[str, np.ndarray],
    output_path: Path,
) -> Dict[str, object]:
    """Emit the GGUF file."""
    import gguf  # type: ignore[import-not-found]

    writer = gguf.GGUFWriter(str(output_path), arch="silero_vad")

    # Locked metadata keys.
    writer.add_string("silero_vad.variant", MODEL_VARIANT)
    writer.add_uint32("silero_vad.window_samples", WINDOW_SAMPLES)
    writer.add_uint32("silero_vad.sample_rate_hz", SAMPLE_RATE_HZ)
    writer.add_uint32("silero_vad.state_hidden_dim", STATE_HIDDEN_DIM)
    writer.add_uint32("silero_vad.state_cell_dim", STATE_CELL_DIM)
    writer.add_uint32("silero_vad.stft_filter_length", STFT_FILTER_LENGTH)
    writer.add_uint32("silero_vad.stft_hop", STFT_HOP)
    writer.add_uint32("silero_vad.stft_pad", STFT_PAD)
    writer.add_uint32("silero_vad.encoder_t", ENCODER_T)
    writer.add_uint32("silero_vad.lstm_input_dim", LSTM_INPUT_DIM)
    writer.add_string("silero_vad.upstream_commit", SILERO_VAD_UPSTREAM_COMMIT)

    # Tensors: fp16 to keep the file tiny. The C runtime upcasts at load
    # time. Sorted for determinism — the runtime indexes by name so write
    # order does not affect correctness.
    for name in sorted(tensors.keys()):
        arr = tensors[name].astype(np.float16)
        writer.add_tensor(name, arr)

    writer.write_header_to_file()
    writer.write_kv_data_to_file()
    writer.write_tensors_to_file()
    writer.close()

    total_bytes = sum(t.size * 2 for t in tensors.values())  # fp16 = 2 bytes/elem
    return {
        "n_tensors": len(tensors),
        "approx_tensor_bytes": total_bytes,
        "output_path": str(output_path),
        "upstream_commit": SILERO_VAD_UPSTREAM_COMMIT,
    }


def _download_weights(dest: Path) -> Path:
    """Download the pinned ONNX bundle. Raises if the upstream is
    unreachable — never silently uses a stale local copy."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"[silero_vad_to_gguf] downloading {UPSTREAM_ONNX_URL}", file=sys.stderr)
    with urllib.request.urlopen(UPSTREAM_ONNX_URL) as resp:
        data = resp.read()
    dest.write_bytes(data)
    return dest


def convert(*, weights_path: Path | None, output_path: Path) -> Dict[str, object]:
    """Drive the conversion. Returns a small stats dict."""
    output_path.parent.mkdir(parents=True, exist_ok=True)

    if weights_path is None:
        weights_path = output_path.parent / "silero_vad.onnx"
        _download_weights(weights_path)
    elif not weights_path.exists():
        raise FileNotFoundError(weights_path)

    tensors = discover_tensors(weights_path)
    return write_gguf(tensors=tensors, output_path=output_path)


def _build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    p.add_argument(
        "--weights",
        type=Path,
        default=None,
        help=(
            "Path to a snakers4/silero-vad v5 ONNX file. If omitted, the "
            "converter downloads the file pinned at "
            f"SILERO_VAD_UPSTREAM_COMMIT={SILERO_VAD_UPSTREAM_COMMIT}."
        ),
    )
    p.add_argument(
        "--output",
        type=Path,
        required=True,
        help="Output GGUF path.",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_arg_parser().parse_args(argv)
    stats = convert(weights_path=args.weights, output_path=args.output)
    print(f"[silero_vad_to_gguf] wrote {stats['output_path']}")
    print(f"  n_tensors           = {stats['n_tensors']}")
    print(f"  approx_tensor_bytes = {stats['approx_tensor_bytes']:,}")
    print(f"  upstream_commit     = {stats['upstream_commit']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:] if len(sys.argv) > 1 else None))
