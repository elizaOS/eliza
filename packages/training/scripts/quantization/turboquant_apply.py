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
    # Long-context / trellis path. Per packages/training/AGENTS.md §3,
    # experiments that intentionally target extended context can route the
    # K-cache through Trellis-Coded Quantization (`turbo3_tcq`) instead of
    # plain `turbo3`/`turbo4`. The weights are still unchanged on disk — this
    # only flips which KV cache type the runtime is told to use, recorded in
    # the sidecar so the manifest builder + downloader pick `turbo3_tcq`.
    ap.add_argument(
        "--trellis",
        action="store_true",
        help=(
            "Long-context path: record turbo3_tcq as the K-cache type in the "
            "sidecar (use for the largest variant of a tier, e.g. 27b-1m)."
        ),
    )
    ap.add_argument(
        "--context-length",
        type=int,
        default=None,
        help=(
            "Trained/served context length for this variant (e.g. 1048576 "
            "for 27b-1m). Recorded in the sidecar. Implies --trellis when "
            ">= 65536."
        ),
    )
    args = ap.parse_args(argv)
    if args.context_length is not None and args.context_length >= 65536:
        args.trellis = True

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

    # Which KV cache type the runtime uses for K. Long-context variants take
    # the trellis path (turbo3_tcq); everything else uses the per-block
    # turbo3/turbo4 layout selected by --nbits.
    cache_type_k = "turbo3_tcq" if args.trellis else f"turbo{args.nbits}_0"

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
        "trellis": bool(args.trellis),
        "context_length": (
            int(args.context_length) if args.context_length is not None else None
        ),
        "cache_type_k": cache_type_k,
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
