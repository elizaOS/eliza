"""Apply TurboQuant KV-cache quantization to a fine-tuned Qwen checkpoint.

TurboQuant
    Zandieh, Daliri, Hadian, Mirrokni. *TurboQuant: Online Random
    Rotations for KV-Cache Quantization*. arXiv:2504.19874, ICLR 2026.
    PyPI: ``turbokv`` (import name: ``turboquant``).

This is a runtime KV-cache compressor. The on-disk safetensors are
unchanged. We:

1. Load the model (merging a LoRA adapter if ``--model`` is one).
2. Optionally calibrate ``skip_layers`` from a JSONL of prompts.
3. Save the (unchanged) merged weights and a ``turboquant.json``
   sidecar with the quantizer config so downstream loaders can
   reconstruct ``TurboQuantCache`` deterministically.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

import torch.nn as nn
from transformers.tokenization_utils_base import PreTrainedTokenizerBase

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from _common import (  # noqa: E402
    add_quantization_cli_args,
    get_text_config,
    head_dim_of,
    kernel_manifest_fragment,
    load_calibration_prompts,
    load_model_and_tokenizer,
    save_model,
    validate_quantization_args,
    write_sidecar,
)

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s"
)
log = logging.getLogger("turboquant_apply")


def calibrate_skip_layers(
    model: nn.Module,
    tokenizer: PreTrainedTokenizerBase,
    prompts: list[str],
    norm_threshold: float = 5.0,
) -> list[int]:
    """Union ``TurboQuantCache.calibrate_skip_layers`` results across prompts.

    The library helper inspects one calibration string at a time; we union
    its skip-sets to be conservative.
    """
    from turboquant import TurboQuantCache

    skip: set[int] = set()
    for i, prompt in enumerate(prompts):
        s = TurboQuantCache.calibrate_skip_layers(
            model, tokenizer, calibration_text=prompt, norm_threshold=norm_threshold
        )
        log.info("calibration prompt %d/%d -> skip %s", i + 1, len(prompts), sorted(s))
        skip |= s
    return sorted(skip)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    add_quantization_cli_args(ap)
    # Recipe-specific knobs.
    ap.add_argument("--nbits", type=int, default=4, choices=(2, 4))
    ap.add_argument("--residual-length", type=int, default=128)
    ap.add_argument("--base-seed", type=int, default=42)
    ap.add_argument("--norm-threshold", type=float, default=5.0)
    args = ap.parse_args(argv)

    validate_quantization_args(args)

    if args.dry_run:
        print(json.dumps(vars(args), indent=2, default=str))
        return 0

    out_dir = Path(args.output)
    model, tok = load_model_and_tokenizer(args.model, device_map=args.device)

    if args.calibration:
        prompts = load_calibration_prompts(args.calibration, n=args.calibration_samples)
        log.info("calibrating with %d prompts", len(prompts))
        skip_layers = calibrate_skip_layers(
            model, tok, prompts, norm_threshold=args.norm_threshold
        )
    else:
        log.info("no calibration; defaulting skip_layers to [0]")
        skip_layers = [0]

    save_model(model, tok, out_dir)

    text_cfg = get_text_config(model.config)
    head_dim = head_dim_of(text_cfg)

    sidecar_payload = {
        "method": "turboquant",
        "paper": "arXiv:2504.19874",
        "library": "turbokv (import: turboquant) v0.1.0",
        "source_model": args.model,
        "nbits": args.nbits,
        "residual_length": args.residual_length,
        "base_seed": args.base_seed,
        "skip_layers": skip_layers,
        "head_dim": head_dim,
        "num_hidden_layers": int(text_cfg.num_hidden_layers),
        "calibration_file": str(args.calibration) if args.calibration else None,
        "calibration_samples": args.calibration_samples if args.calibration else 0,
        "norm_threshold": args.norm_threshold,
        "kernel_manifest": kernel_manifest_fragment("turboquant"),
        "notes": (
            "TurboQuant is a runtime KV-cache compressor. The weights in "
            "this directory are unchanged. To use the quantized cache, "
            "construct turboquant.TurboQuantCache(model.config, nbits=..., "
            "base_seed=..., skip_layers=set(skip_layers)) and pass it to "
            "model.generate(past_key_values=cache)."
        ),
    }
    sidecar_path = write_sidecar(out_dir, "turboquant.json", sidecar_payload)
    log.info("wrote %s", sidecar_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
