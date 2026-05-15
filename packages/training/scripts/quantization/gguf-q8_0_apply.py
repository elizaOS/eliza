"""Apply GGUF Q8_0 K-quant to a fine-tuned Qwen checkpoint.

This is the top rung of the Eliza-1 GGUF ladder. It reuses the same
llama.cpp conversion path as the Q6_K wrapper, changing only the quantization
level and sidecar name so the train -> quantize -> publish pipeline stays
reproducible across Q3_K_M/Q4_K_M/Q5_K_M/Q6_K/Q8_0.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType

QUANT_LEVEL = "Q8_0"


def _load_q6_wrapper() -> ModuleType:
    wrapper = Path(__file__).with_name("gguf-q6_k_apply.py")
    spec = importlib.util.spec_from_file_location("gguf_q6_k_apply", wrapper)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"unable to load {wrapper}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main(argv: list[str] | None = None) -> int:
    mod = _load_q6_wrapper()
    mod.QUANT_LEVEL = QUANT_LEVEL
    original_write_sidecar = mod.write_sidecar

    def write_q8_sidecar(output_dir: Path, _name: str, sidecar: dict[str, object]):
        q8_sidecar = {
            **sidecar,
            "notes": (
                "Q8_0 is the highest precision published GGUF rung in the "
                "Eliza-1 ladder. It is useful for workstation/cloud installs "
                "that want near-f16 quality while keeping the same "
                "llama.cpp-compatible artifact shape as the smaller K-quants."
            ),
        }
        return original_write_sidecar(output_dir, "gguf_q8_0.json", q8_sidecar)

    mod.write_sidecar = write_q8_sidecar
    return mod.main(argv)


if __name__ == "__main__":
    raise SystemExit(main())
