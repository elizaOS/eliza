"""Apply FP8 (E4M3) weight quantization to a fine-tuned Qwen checkpoint.

Wraps :mod:`torchao.float8` per the recipe in
https://pytorch.org/torchao/main/api_ref_quantization.html — converts every
``nn.Linear`` to its FP8 equivalent and saves the resulting safetensors so
that vLLM (or TensorRT-LLM) can serve it via ``--quantization fp8``.

Compute capability:

  * Hopper (sm_90, sm_90a) and Datacenter Blackwell (sm_100, B100/B200)
    have native FP8 tensor cores. Use this path.
  * Consumer Blackwell (RTX PRO 5000/6000 → sm_120) does **not** have
    a vendor-blessed FP8-Marlin path in vLLM yet (the matmul falls
    through to W8A16 emulation). On these targets prefer
    PolarQuant + AWQ-Marlin (``polarquant_apply.py``) — the script
    will exit 2 with an actionable message instead of producing weights
    that won't accelerate.
  * The fp8 cast itself is a one-shot transform; ``--calibration`` is
    accepted for CLI parity with the other quantizers but unused
    (E4M3 conversion is data-free, similar to PolarQuant).
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

import torch

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from _common import (  # noqa: E402
    load_model_and_tokenizer,
    save_model,
    write_sidecar,
)

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s"
)
log = logging.getLogger("fp8_apply")

# Compute-capability gate. Anything below sm_90 lacks native FP8 tensor cores;
# anything in the consumer Blackwell sm_120 family lacks a usable Marlin path
# in current vLLM/TensorRT-LLM and falls back to W8A16 emulation that is slower
# than bf16. Allow only sm_90/sm_90a/sm_100 (Datacenter Blackwell B100/B200).
_FP8_OK_MAJORS = {9, 10}


def _detect_fp8_capability() -> tuple[bool, str]:
    """Return (ok, reason). Reason is a human-readable string for both paths."""
    if not torch.cuda.is_available():
        return False, "CUDA not available — FP8 conversion needs a GPU device."
    major, minor = torch.cuda.get_device_capability(0)
    name = torch.cuda.get_device_name(0)
    if major not in _FP8_OK_MAJORS:
        return (
            False,
            f"GPU {name!r} is sm_{major}{minor} — native FP8 tensor cores "
            "require sm_90 (Hopper H100/H200) or sm_100 (Datacenter Blackwell "
            "B100/B200). Consumer Blackwell sm_120 (RTX PRO 5000/6000) lacks a "
            "vendor-blessed FP8-Marlin path in current vLLM. Use AWQ-Marlin via "
            "scripts/quantization/polarquant_apply.py instead.",
        )
    return True, f"sm_{major}{minor} device {name!r} supports native FP8."


def _convert_linears_to_fp8(model: torch.nn.Module) -> int:
    """Run torchao's FP8 conversion in place. Returns number of layers converted.

    ``torchao.float8.convert_to_float8_training`` (used here as a one-shot
    inference cast) walks every ``nn.Linear`` and swaps it for a
    ``Float8Linear`` whose weight is stored as E4M3 + per-tensor scale.
    save_pretrained handles the safetensors layout.
    """
    try:
        from torchao.float8 import (
            Float8LinearConfig,
            convert_to_float8_training,
        )
    except ImportError as exc:
        raise SystemExit(
            "torchao>=0.7 is required for FP8 conversion. Install via "
            "`uv pip install torchao` (or pin in pyproject.toml's `train` "
            "extra). Underlying error: " + str(exc)
        ) from exc

    cfg = Float8LinearConfig(
        # E4M3 is the de-facto inference choice (higher dynamic range
        # for activations than E5M2 at the same exponent count).
        cast_config_weight={"target_dtype": torch.float8_e4m3fn},
        cast_config_input={"target_dtype": torch.float8_e4m3fn},
        cast_config_grad_output={"target_dtype": torch.float8_e5m2},
    )

    n_before = sum(1 for m in model.modules() if isinstance(m, torch.nn.Linear))
    convert_to_float8_training(model, config=cfg)
    n_after_fp8 = sum(
        1
        for m in model.modules()
        if type(m).__name__.endswith("Float8Linear")
    )
    log.info(
        "converted %d/%d linears to Float8Linear (E4M3)",
        n_after_fp8,
        n_before,
    )
    return n_after_fp8


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    ap.add_argument(
        "--model",
        required=True,
        help="HF repo id or local path. LoRA adapter dirs are merged automatically.",
    )
    ap.add_argument("--output", required=True, type=Path)
    ap.add_argument(
        "--calibration",
        type=Path,
        default=None,
        help="Accepted for CLI parity; unused (E4M3 conversion is data-free).",
    )
    ap.add_argument("--calibration-samples", type=int, default=128)
    ap.add_argument("--device", default="cuda")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)

    if args.dry_run:
        ok, reason = _detect_fp8_capability() if torch.cuda.is_available() else (
            False,
            "dry-run on a host without CUDA — capability check skipped.",
        )
        print(json.dumps({**vars(args), "fp8_ok": ok, "reason": reason}, indent=2, default=str))
        return 0

    ok, reason = _detect_fp8_capability()
    if not ok:
        log.error("FP8 capability check failed: %s", reason)
        return 2

    out_dir = Path(args.output)
    model, tok = load_model_and_tokenizer(args.model, device_map=args.device)
    n_converted = _convert_linears_to_fp8(model)

    save_model(model, tok, out_dir)

    sidecar = {
        "method": "fp8_e4m3",
        "library": "torchao.float8",
        "source_model": args.model,
        "n_layers_converted": n_converted,
        "compute_capability": list(torch.cuda.get_device_capability(0)),
        "device_name": torch.cuda.get_device_name(0),
        "notes": (
            "FP8 (E4M3) weights produced via torchao.float8. Serve with "
            "vLLM `--quantization fp8` (Hopper H100/H200 or Datacenter "
            "Blackwell B100/B200). Consumer Blackwell sm_120 has no "
            "FP8-Marlin path in vLLM today; prefer AWQ-Marlin/PolarQuant."
        ),
    }
    sidecar_path = write_sidecar(out_dir, "fp8.json", sidecar)
    log.info("wrote %s", sidecar_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
