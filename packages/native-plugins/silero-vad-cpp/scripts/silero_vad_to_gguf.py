#!/usr/bin/env python3
"""Convert a snakers4/silero-vad v5 checkpoint into a single GGUF file
the silero-vad-cpp runtime will load through its ggml dispatcher.

This is a SKELETON. The TODO blocks below mark the work the real
conversion will do; they intentionally raise NotImplementedError so a
caller cannot mistake the stub for a working converter.

Inputs
------
- ``--weights``: path to a snakers4/silero-vad v5 artifact. The
  upstream ships both a PyTorch JIT (``silero_vad.jit``) and an ONNX
  bundle (``silero_vad.onnx``); this converter accepts either. The
  canonical download URLs are:

    https://github.com/snakers4/silero-vad/blob/master/src/silero_vad/data/silero_vad.onnx
    https://github.com/snakers4/silero-vad/blob/master/src/silero_vad/data/silero_vad.jit

  Pin the upstream commit you pulled the file from in
  ``SILERO_VAD_UPSTREAM_COMMIT`` below; the runtime reads the same
  pin from the GGUF and refuses to load an unknown commit.

Output
------
A GGUF file the runtime loads through `silero_vad_open`. Metadata
keys the runtime uses to refuse a mismatched build:

- ``silero_vad.variant``         = "silero_vad_v5" (locked).
- ``silero_vad.window_samples``  = 512 (locked — the v5 graph only
                                   accepts this window size at 16 kHz).
- ``silero_vad.sample_rate_hz``  = 16000 (locked).
- ``silero_vad.state_hidden_dim``= 64 (locked — must match the C
                                   header's `SILERO_VAD_STATE_HIDDEN_DIM`).
- ``silero_vad.state_cell_dim``  = 64 (locked — must match the C
                                   header's `SILERO_VAD_STATE_CELL_DIM`).
- ``silero_vad.upstream_commit`` = pinned snakers4/silero-vad commit
                                   (TODO: record at conversion time).

Type number for every tensor is left as native fp16 for the first
pass; later passes can layer the existing TurboQuant / Q4_POLAR types
on the LSTM gate matrices using the same conversion path that
``polarquant_to_gguf.py`` and ``doctr_to_gguf.py`` demonstrate.
"""

from __future__ import annotations

import argparse
from pathlib import Path


# ── Locked block-format constants ───────────────────────────────────────────
# These four constants pin the contract between this converter and the C
# runtime. They must match the macros in
# `include/silero_vad/silero_vad.h` exactly; the runtime reads the same
# values from the GGUF metadata and refuses to load on mismatch.

MODEL_VARIANT = "silero_vad_v5"
WINDOW_SAMPLES = 512
SAMPLE_RATE_HZ = 16000
STATE_HIDDEN_DIM = 64
STATE_CELL_DIM = 64

# Pinned upstream commit. Update when re-pulling weights and re-test
# parity against the snakers4/silero-vad Python reference. The runtime
# reads this key from the GGUF and refuses to load an unknown commit.
SILERO_VAD_UPSTREAM_COMMIT = (
    "TODO: pin snakers4/silero-vad commit at conversion time"
)

# Canonical upstream URLs. Recorded here so the conversion recipe is
# discoverable even if the README lags behind. Pick whichever artifact
# the local environment can read; the converter accepts both shapes.
UPSTREAM_ONNX_URL = (
    "https://github.com/snakers4/silero-vad/blob/master/"
    "src/silero_vad/data/silero_vad.onnx"
)
UPSTREAM_JIT_URL = (
    "https://github.com/snakers4/silero-vad/blob/master/"
    "src/silero_vad/data/silero_vad.jit"
)


def discover_tensors(weights_path: Path) -> dict[str, object]:
    """Walk the silero-vad v5 weights file and return a {name: tensor}
    map keyed by the GGUF tensor names the runtime expects.

    TODO:
      - Detect input format by extension (``.onnx`` vs ``.jit``).
      - For ONNX: open with ``onnx.load(weights_path)`` and walk
        ``model.graph.initializer``; map upstream initializer names
        (``stft.weight``, ``encoder.0.weight``, ``lstm.weight_ih``,
        ``lstm.weight_hh``, ``lstm.bias_ih``, ``lstm.bias_hh``,
        ``decoder.0.weight``, ``decoder.0.bias``) to the runtime's
        canonical names.
      - For JIT: ``torch.jit.load(weights_path).state_dict()`` and the
        same prefix-strip + rename pass.
      - Sanity-check tensor shapes against the v5 architecture (single
        LSTM layer, 64-dim hidden, 64-dim cell). Refuse to convert on
        any unexpected key — silent acceptance hides upstream renames.
      - Return a stable, sorted mapping so the GGUF tensor order is
        deterministic across runs.
    """
    raise NotImplementedError("discover_tensors: see TODO")


def write_gguf(
    *,
    tensors: dict[str, object],
    output_path: Path,
) -> dict[str, object]:
    """Emit the GGUF file.

    TODO:
      - Initialize ``gguf.GGUFWriter(str(output_path), arch="silero_vad")``.
      - Write the metadata keys documented at the top of this file
        (variant, window_samples, sample_rate_hz, state_hidden_dim,
        state_cell_dim, upstream_commit).
      - Pack every tensor as fp16 by default; leave a hook for
        TurboQuant / Q4_POLAR follow-ups on the LSTM gate matrices
        (mirror the layering in ``polarquant_to_gguf.py``).
      - Return a small stats dict (n_tensors, total_bytes, output_path).
    """
    raise NotImplementedError("write_gguf: see TODO")


def convert(*, weights_path: Path, output_path: Path) -> dict[str, object]:
    """Drive the conversion. Returns a small stats dict."""
    if not weights_path.exists():
        raise FileNotFoundError(weights_path)

    output_path.parent.mkdir(parents=True, exist_ok=True)

    tensors = discover_tensors(weights_path)

    return write_gguf(tensors=tensors, output_path=output_path)


def _build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    p.add_argument(
        "--weights",
        type=Path,
        required=True,
        help=(
            "Path to a snakers4/silero-vad v5 weights file (ONNX or "
            "TorchScript JIT). Canonical sources:\n"
            f"  {UPSTREAM_ONNX_URL}\n"
            f"  {UPSTREAM_JIT_URL}"
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
    convert(weights_path=args.weights, output_path=args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
