"""Compatibility CLI for the canonical Q8_0 GGUF quantization profile."""

from __future__ import annotations

import logging
from pathlib import Path

from gguf_k_quant import (
    DEFAULT_LLAMA_CPP_DIR,
    QuantProfile,
    find_llama_convert_script,
    find_llama_quantize_binary,
    resolve_output_basename,
    run_command,
    run_quant_profile,
    smoke_load_gguf,
    write_sidecar,
)

QUANT_LEVEL = "Q8_0"
_FORK_LLAMA_CPP = DEFAULT_LLAMA_CPP_DIR
_PROFILE = QuantProfile(
    level=QUANT_LEVEL,
    sidecar_name="gguf_q8_0.json",
    notes=(
        "Q8_0 is the highest-precision published GGUF rung for workstation "
        "and Cloud installs that want near-f16 quality."
    ),
)
_LOG = logging.getLogger("gguf_q8_0_apply")


def _find_convert_script(llama_cpp_dir: Path | None) -> Path:
    return find_llama_convert_script(llama_cpp_dir)


def _find_quantize_binary(llama_cpp_dir: Path | None) -> Path:
    return find_llama_quantize_binary(llama_cpp_dir)


def _resolve_output_basename(model_id_or_path: str, _output_dir: Path) -> str:
    return resolve_output_basename(model_id_or_path, QUANT_LEVEL)


def _run(command: list[str | Path]) -> None:
    run_command(command, _LOG)


_smoke_load_gguf = smoke_load_gguf


def main(argv: list[str] | None = None) -> int:
    return run_quant_profile(
        _PROFILE,
        argv,
        find_convert_script=_find_convert_script,
        find_quantize_binary=_find_quantize_binary,
        write_sidecar=write_sidecar,
        run=_run,
        smoke_load=_smoke_load_gguf,
    )


if __name__ == "__main__":
    raise SystemExit(main())
