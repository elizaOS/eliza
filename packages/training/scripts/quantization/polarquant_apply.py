"""Apply PolarQuant to a HuggingFace causal-LM checkpoint.

PolarQuant
    Vicentino, Caio. *PolarQuant: Optimal Gaussian Weight Quantization via
    Hadamard Rotation for LLM Compression*. arXiv:2603.29078, March 2026.
    Reference: https://github.com/caiovicentino/eoq-quantization @
    15a12160245d7d3015290c6c5b6dbb7f22094d5e.

Walks every ``nn.Linear`` whose weight tensor has at least ``--min-numel``
elements and replaces its ``weight`` with the PolarQuant round-trip
reconstruction (per-block L2 normalize -> WHT -> Lloyd-Max -> optional
1-bit QJL residual -> inverse). Saves the resulting model + a sidecar
``polarquant_artifacts.safetensors`` carrying the int8 codes + fp16
norms (the format a downstream INT4 inference kernel consumes).

PolarQuant is data-free: ``--calibration`` is accepted only for CLI
parity with the other quantizers.
"""

from __future__ import annotations

import argparse
import gc
import json
import logging
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path

import torch
import torch.nn as nn
from safetensors.torch import save_file
from transformers import AutoConfig

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from _common import (  # noqa: E402
    kernel_manifest_fragment,
    load_model_and_tokenizer,
    save_model,
)
from polarquant.polar_quant import (  # noqa: E402
    PolarQuantResult,
    polar_dequantize,
    polar_quantize,
)

logger = logging.getLogger("polarquant_apply")


# Architectures we have explicitly verified against the standard
# ``self_attn.{q,k,v,o}_proj`` / ``mlp.{gate,up,down}_proj`` linear layout.
_KNOWN_GOOD_ARCH_SUBSTRINGS = ("qwen2", "qwen3", "llama", "mistral", "phi3")


@dataclass(frozen=True)
class PolarQuantRecipe:
    """Knobs handed to PolarQuant for one model."""

    bits: int = 4
    block_size: int = 128
    use_qjl: bool = True
    min_numel: int = 4096
    skip_lm_head: bool = True
    skip_embedding: bool = True
    dtype: str = "float16"

    def to_json(self) -> dict[str, object]:
        return {
            **asdict(self),
            "paper": "arXiv:2603.29078",
            "upstream_commit": "15a12160245d7d3015290c6c5b6dbb7f22094d5e",
            "upstream_repo": "https://github.com/caiovicentino/eoq-quantization",
        }


def _iter_linears(
    model: nn.Module,
    *,
    min_numel: int,
    skip_lm_head: bool,
    skip_embedding: bool,
) -> list[tuple[str, nn.Linear]]:
    """Linears we want to quantize, in deterministic order.

    Skips small projections / MoE routers (``min_numel``), the LM head
    (weight-tied on Qwen-family models), and embedding tables (lookups,
    not multiplies).
    """
    out: list[tuple[str, nn.Linear]] = []
    for name, module in model.named_modules():
        if not isinstance(module, nn.Linear):
            continue
        if skip_lm_head and name.endswith("lm_head"):
            continue
        if skip_embedding and "embed" in name:
            continue
        if module.weight.numel() < min_numel:
            continue
        out.append((name, module))
    return out


def _quantize_linear_inplace(
    layer: nn.Linear,
    *,
    bits: int,
    block_size: int,
    use_qjl: bool,
) -> tuple[PolarQuantResult, float]:
    """Run PolarQuant on one linear's weight, write the reconstruction back.

    Returns ``(result, mse)`` where ``mse`` is the reconstruction MSE.
    """
    weight = layer.weight.data
    target_dtype = weight.dtype
    target_device = weight.device

    result = polar_quantize(
        weight.detach().to(torch.float32),
        bits=bits,
        block_size=block_size,
        use_qjl=use_qjl,
    )

    recon = polar_dequantize(result, device=target_device).to(target_dtype)
    mse = (weight.float() - recon.float()).pow(2).mean().item()

    with torch.no_grad():
        layer.weight.data.copy_(recon)
    del recon
    return result, mse


def _save_artifacts(
    artifacts: dict[str, PolarQuantResult],
    *,
    output_dir: Path,
) -> Path:
    """Persist int8 codes + fp16 norms (+ optional QJL bits) to a single
    safetensors blob keyed by parameter name.
    """
    flat: dict[str, torch.Tensor] = {}
    for name, res in artifacts.items():
        flat[f"{name}.codes"] = res.codes.detach().to(torch.int8).cpu().contiguous()
        flat[f"{name}.norms"] = res.norms.detach().to(torch.float16).cpu().contiguous()
        if res.use_qjl and res.qjl_signs is not None:
            flat[f"{name}.qjl"] = res.qjl_signs.detach().to(torch.uint8).cpu().contiguous()

    sidecar = output_dir / "polarquant_artifacts.safetensors"
    sidecar.parent.mkdir(parents=True, exist_ok=True)
    save_file(flat, str(sidecar))
    return sidecar


def quantize_checkpoint(
    *,
    model_id_or_path: str,
    output_dir: Path,
    recipe: PolarQuantRecipe,
    device: str = "auto",
    save_artifacts: bool = True,
    progress_every: int = 32,
) -> dict[str, object]:
    """Load -> PolarQuant every linear -> save. Returns a stats dict."""
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    logger.info("Loading config for %s", model_id_or_path)
    config = AutoConfig.from_pretrained(model_id_or_path, trust_remote_code=True)
    arch_lc = (getattr(config, "model_type", "") or "").lower()
    if not any(s in arch_lc for s in _KNOWN_GOOD_ARCH_SUBSTRINGS):
        logger.warning(
            "Architecture %r is not on the known-good list %s; PolarQuant "
            "will proceed but the reconstruction quality has not been "
            "verified for this model family in this repo.",
            arch_lc,
            _KNOWN_GOOD_ARCH_SUBSTRINGS,
        )

    dtype_map = {
        "float16": torch.float16,
        "bfloat16": torch.bfloat16,
        "float32": torch.float32,
    }
    dtype = dtype_map[recipe.dtype]
    device_map = device if device != "auto" else None

    logger.info("Loading model weights (dtype=%s, device=%s)", recipe.dtype, device)
    model, tokenizer = load_model_and_tokenizer(
        model_id_or_path, device_map=device_map, dtype=dtype
    )
    if device == "auto" and torch.cuda.is_available():
        model = model.to("cuda")
    model.eval()

    layers = _iter_linears(
        model,
        min_numel=recipe.min_numel,
        skip_lm_head=recipe.skip_lm_head,
        skip_embedding=recipe.skip_embedding,
    )
    logger.info("Found %d linear layers eligible for PolarQuant", len(layers))

    artifacts: dict[str, PolarQuantResult] = {}
    mses: list[float] = []
    n_params_quantized = 0
    t0 = time.perf_counter()

    for i, (name, layer) in enumerate(layers, start=1):
        n_params_quantized += layer.weight.numel()
        result, mse = _quantize_linear_inplace(
            layer,
            bits=recipe.bits,
            block_size=recipe.block_size,
            use_qjl=recipe.use_qjl,
        )
        if save_artifacts:
            artifacts[f"{name}.weight"] = result
        else:
            del result
        mses.append(mse)

        if i % progress_every == 0 or i == len(layers):
            elapsed = time.perf_counter() - t0
            avg_mse = sum(mses) / len(mses)
            logger.info(
                "  [%4d/%d] %s  numel=%d  mse=%.3e  avg_mse=%.3e  elapsed=%.1fs",
                i, len(layers), name, layer.weight.numel(), mse, avg_mse, elapsed,
            )

    # save_pretrained shards on CPU; move first so we don't allocate a
    # multi-shard CUDA-resident state dict.
    model.to("cpu")
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()

    logger.info("Saving quantized model to %s", output_dir)
    save_model(model, tokenizer, output_dir)

    sidecar_path: Path | None = None
    if save_artifacts and artifacts:
        sidecar_path = _save_artifacts(artifacts, output_dir=output_dir)
        logger.info("Saved PolarQuant artifacts to %s", sidecar_path)

    config_path = output_dir / "polarquant_config.json"
    config_path.write_text(
        json.dumps(
            {
                "source_model": model_id_or_path,
                "recipe": recipe.to_json(),
                "n_layers_quantized": len(layers),
                "n_params_quantized": n_params_quantized,
                "average_block_mse": sum(mses) / max(1, len(mses)),
                "max_block_mse": max(mses) if mses else 0.0,
                "elapsed_seconds": time.perf_counter() - t0,
                "kernel_manifest": kernel_manifest_fragment("polarquant"),
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    return {
        "output_dir": str(output_dir),
        "n_layers": len(layers),
        "n_params": n_params_quantized,
        "average_mse": sum(mses) / max(1, len(mses)),
        "sidecar": str(sidecar_path) if sidecar_path else None,
        "config_path": str(config_path),
    }


def _build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description=(
            "Apply PolarQuant (arXiv:2603.29078) to a HF causal-LM checkpoint."
        ),
    )
    p.add_argument("--model", required=True, help="HF repo id or local path.")
    p.add_argument("--output", required=True, type=Path)
    p.add_argument(
        "--calibration",
        type=Path,
        default=None,
        help="Accepted but unused (PolarQuant is data-free); validated for existence.",
    )
    p.add_argument("--calibration-samples", type=int, default=128)
    p.add_argument("--bits", type=int, default=4, choices=[2, 3, 4, 5, 6])
    p.add_argument("--block-size", type=int, default=128)
    p.add_argument("--no-qjl", action="store_true")
    p.add_argument("--min-numel", type=int, default=4096)
    p.add_argument("--include-lm-head", action="store_true")
    p.add_argument("--include-embedding", action="store_true")
    p.add_argument(
        "--dtype", default="float16", choices=["float16", "bfloat16", "float32"]
    )
    p.add_argument("--device", default="auto")
    p.add_argument("--no-artifacts", action="store_true")
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate inputs and print the recipe; don't load or save weights.",
    )
    p.add_argument(
        "--log-level",
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_arg_parser().parse_args(argv)

    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="[%(asctime)s] %(name)s %(levelname)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    if args.calibration is not None and not args.calibration.exists():
        raise FileNotFoundError(
            f"--calibration path does not exist: {args.calibration}. "
            "PolarQuant doesn't read it, but if you pass the flag it still "
            "has to point at a real file."
        )

    recipe = PolarQuantRecipe(
        bits=args.bits,
        block_size=args.block_size,
        use_qjl=not args.no_qjl,
        min_numel=args.min_numel,
        skip_lm_head=not args.include_lm_head,
        skip_embedding=not args.include_embedding,
        dtype=args.dtype,
    )

    if args.dry_run:
        print(json.dumps({"recipe": recipe.to_json(), "model": args.model}, indent=2))
        return 0

    stats = quantize_checkpoint(
        model_id_or_path=args.model,
        output_dir=args.output,
        recipe=recipe,
        device=args.device,
        save_artifacts=not args.no_artifacts,
    )
    print(json.dumps(stats, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
