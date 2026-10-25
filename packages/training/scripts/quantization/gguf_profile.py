"""Convert and validate a checkpoint using a named GGUF quantization profile."""

from __future__ import annotations

import argparse
import sys
from .gguf_k_quant import (
    QuantProfile,
    run_quant_profile,
    find_llama_convert_script,
    find_llama_quantize_binary,
    write_sidecar,
    run_command,
    smoke_load_gguf,
)
import logging

PROFILES = {
    "Q3_K_M": QuantProfile(
        level="Q3_K_M",
        sidecar_name="gguf_q3_k_m.json",
        notes=(
            "Q3_K_M is the smallest viable K-quant in the canonical llama.cpp "
            "ladder; imatrix calibration is strongly recommended."
        ),
        calibration_help="An imatrix is strongly recommended for Q3_K_M.",
    ),
    "Q4_K_M": QuantProfile(
        level="Q4_K_M",
        sidecar_name="gguf_q4_k_m.json",
        notes=(
            "Q4_K_M is the standard llama.cpp sweet-spot K-quant, averaging "
            "about 4.5 bits per weight with a small quality gap to bf16."
        ),
    ),
    "Q5_K_M": QuantProfile(
        level="Q5_K_M",
        sidecar_name="gguf_q5_k_m.json",
        notes=(
            "Q5_K_M is the high-quality llama.cpp K-quant option, averaging "
            "about 5.5 bits per weight and remaining near-lossless on common metrics."
        ),
    ),
    "Q6_K": QuantProfile(
        level="Q6_K",
        sidecar_name="gguf_q6_k.json",
        notes=(
            "Q6_K is the largest canonical K-quant rung and targets effectively "
            "bf16-quality local inference without the full f16 file size."
        ),
    ),
    "Q8_0": QuantProfile(
        level="Q8_0",
        sidecar_name="gguf_q8_0.json",
        notes=(
            "Q8_0 is the highest-precision published GGUF rung for workstation "
            "and Cloud installs that want near-f16 quality."
        ),
    ),
}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, add_help=False)
    parser.add_argument("--profile", choices=PROFILES, required=True)
    selected, remaining = parser.parse_known_args(
        sys.argv[1:] if argv is None else argv
    )
    return run_quant_profile(
        PROFILES[selected.profile],
        remaining,
        find_convert_script=find_llama_convert_script,
        find_quantize_binary=find_llama_quantize_binary,
        write_sidecar=write_sidecar,
        run=lambda command: run_command(command, logging.getLogger(__name__)),
        smoke_load=smoke_load_gguf,
    )


if __name__ == "__main__":
    raise SystemExit(main())
