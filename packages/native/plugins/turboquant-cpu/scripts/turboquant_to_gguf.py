#!/usr/bin/env python3
"""Convert a TurboQuant safetensors sidecar into a GGUF file whose
weight-cache tensors are typed `GGML_TYPE_TBQ3_0=44` or
`GGML_TYPE_TBQ4_0=45`.

STATUS
------
Skeleton. The block layout (`tbq_block_tbq{3,4}_0`), codebooks, and
preconditioner are all implemented in
`../src/tbq_block_ref.c`. This converter wires those into a GGUF
writer the same way `polarquant_to_gguf.py` does for `Q4_POLAR=45`.
The pieces still to land:

  - `pack_layer_tbq3` / `pack_layer_tbq4` that call the C reference
    via ctypes (the polarquant converter does this with
    `polarquant.so`).
  - The GGUF header metadata block:
        turboquant.block_size       = 32  (QK_TBQ, locked)
        turboquant.bits             = 3 | 4
        turboquant.precondition     = "wht-32+signs"
        turboquant.signs_seed       = "fork-static-32"
        turboquant.upstream_commit  = pinned fork commit
  - A test_converter.py mirror of polarquant-cpu's that round-trips a
    tiny weight through encoder + GGUF writer + GGUFReader.

Inputs
------
- Base model HF checkpoint: provides shapes + `config.json`. Weights
  are not consumed; only shapes are needed.
- TurboQuant sidecar (safetensors) produced by
  `packages/training/scripts/quantization/turboquant_apply.py` /
  `fused_turboquant_apply.py`. The sidecar carries per-tensor int8
  codes + fp16 RMS scales for every quantized linear weight.

Output
------
A GGUF whose target tensors hold packed `block_tbq3_0` (14 B/32 floats)
or `block_tbq4_0` (18 B/32 floats) records. Per-tensor element shapes
are preserved exactly.

The GGML enum slots assumed here match the elizaOS llama.cpp fork at
plugins/plugin-local-inference/native/llama.cpp/ggml/include/ggml.h:

    GGML_TYPE_TBQ3_0    = 44
    GGML_TYPE_TBQ4_0    = 45
    GGML_TYPE_TBQ3_TCQ  = 48

Stock llama.cpp builds without the fork will refuse to load any GGUF
that mentions these slots.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


GGML_TYPE_TBQ3_0 = 44
GGML_TYPE_TBQ4_0 = 45
GGML_TYPE_TBQ3_TCQ = 48

QK_TBQ = 32


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sidecar", required=True, type=Path,
                        help="path to turboquant_artifacts.safetensors")
    parser.add_argument("--base-model", required=True, type=Path,
                        help="path to the base HF model directory")
    parser.add_argument("--output", required=True, type=Path,
                        help="output GGUF path")
    parser.add_argument("--bits", choices=["3", "4"], default="4",
                        help="3 -> TBQ3_0, 4 -> TBQ4_0")
    args = parser.parse_args()

    sys.stderr.write(
        "[turboquant_to_gguf] not implemented yet — see module docstring.\n"
        "[turboquant_to_gguf] inputs validated:\n"
        f"    sidecar    = {args.sidecar}\n"
        f"    base-model = {args.base_model}\n"
        f"    output     = {args.output}\n"
        f"    bits       = {args.bits}\n"
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
