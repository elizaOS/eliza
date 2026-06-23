"""Apply fused-TurboQuant (Triton-kernel KV-cache quantization) to a checkpoint.

Fused-TurboQuant is a Triton-kernel implementation of the TurboQuant
scheme (arXiv:2504.19874). The math matches the pure-PyTorch ``turbokv``
0.1.0 release used by ``turboquant_apply.py``; the difference is engineering:
encode/decode/Q@K^T run in Triton kernels rather than vectorized PyTorch.

This script validates that the patch wires up cleanly, then saves the
unchanged merged base weights and a ``fused_turboquant.json`` sidecar
recording the quantizer config. The kernels live in user code at
inference time, not in the safetensors.

The ``--calibration`` flag is accepted for CLI parity but unused: the
RHT seeds and Lloyd-Max codebooks are data-oblivious.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

_HERE = Path(__file__).resolve().parent
# vendored hf/__init__.py imports as `quantization.fused_turboquant_vendored.*`
# so we need `scripts/` on the path. Put it FIRST so `quantization.*` resolves
# correctly before _HERE (which lets `_common` work).
_SCRIPTS = _HERE.parent
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from _common import (  # noqa: E402
    add_quantization_cli_args,
    get_text_config,
    kernel_manifest_fragment,
    load_model_and_tokenizer,
    save_model,
    validate_quantization_args,
    write_sidecar,
)

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s"
)
log = logging.getLogger("fused_turboquant_apply")


_KNOWN_GOOD_ARCH_SUBSTRINGS = ("qwen2", "qwen3", "llama", "gemma", "mistral")


@dataclass(frozen=True)
class FusedTurboQuantRecipe:
    """Knobs handed to fused-TurboQuant's ``patch_model`` for one model."""

    bits: int = 4
    compress_v: bool = True
    verify: bool = True
    head_dim: int | None = None

    def to_json(self) -> dict[str, object]:
        return {
            **asdict(self),
            "paper": "arXiv:2504.19874",
            "library": "fused-turboquant 0.1.0",
            "kernels": "triton",
        }


def _format_compat_report(report: dict[str, object]) -> str:
    lines = [
        f"  architecture:        {report['architecture']}",
        f"  known_compatible:    {report['known_compatible']}",
        f"  compatible:          {report['compatible']}",
        f"  head_dim:            {report['head_dim']} (valid={report['head_dim_valid']})",
        f"  n_q_heads / n_kv:    {report['n_q_heads']} / {report['n_kv_heads']}",
        f"  eligible_layers:     {report['eligible_layers']} / {report['total_layers']}",
        f"  rope_detected:       {report['rope_detected']}",
        f"  sliding_window:      {report['sliding_window']}",
        f"  fused_qkv_layers:    {report['fused_qkv_layers']}",
        f"  cross_attention:     {report['cross_attention_layers']}",
        f"  vision_skipped:      {report['vision_layers_skipped']}",
    ]
    if report["unsupported_features"]:
        lines.append(f"  unsupported:         {report['unsupported_features']}")
    if report["issues"]:
        lines.append("  issues:")
        for issue in report["issues"]:
            lines.append(f"    - {issue}")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    add_quantization_cli_args(ap)
    # Recipe-specific knobs.
    ap.add_argument("--bits", type=int, default=4, choices=(3, 4))
    ap.add_argument("--no-compress-v", action="store_true")
    ap.add_argument("--head-dim", type=int, default=None)
    ap.add_argument("--no-verify", action="store_true")
    args = ap.parse_args(argv)

    validate_quantization_args(args)

    if args.dry_run:
        print(json.dumps(vars(args), indent=2, default=str))
        return 0

    out_dir = Path(args.output)
    model, tok = load_model_and_tokenizer(args.model, device_map=args.device)

    arch_lc = (getattr(model.config, "model_type", "") or "").lower()
    if not any(s in arch_lc for s in _KNOWN_GOOD_ARCH_SUBSTRINGS):
        log.warning(
            "Architecture %r is not on the known-good list %s; "
            "fused-TurboQuant will still run check_model_compatibility() but "
            "the patch may reject this model.",
            arch_lc,
            _KNOWN_GOOD_ARCH_SUBSTRINGS,
        )

    from quantization.fused_turboquant_vendored.hf import (
        check_model_compatibility,
        patch_model,
        unpatch_model,
    )

    log.info("running check_model_compatibility ...")
    report = check_model_compatibility(model)
    log.info("compatibility report:\n%s", _format_compat_report(report))
    if not report["compatible"]:
        msg = (
            "fused-TurboQuant compatibility check failed: "
            f"{report['issues'] or report['unsupported_features']}"
        )
        log.error(msg)
        return 2

    recipe = FusedTurboQuantRecipe(
        bits=args.bits,
        compress_v=not args.no_compress_v,
        verify=not args.no_verify,
        head_dim=args.head_dim,
    )

    log.info(
        "patching model (bits=%d, compress_v=%s, verify=%s) to validate kernel wiring",
        recipe.bits, recipe.compress_v, recipe.verify,
    )
    cache = patch_model(
        model,
        bits=recipe.bits,
        head_dim=recipe.head_dim,
        verify=recipe.verify,
        compress_v=recipe.compress_v,
    )
    log.info(
        "patch_model returned %s with %d cache layers",
        type(cache).__name__,
        max(len(cache._compressed_keys), len(cache._compressed_values)),
    )
    # Unpatch before saving so on-disk weights are byte-identical to the base.
    unpatch_model(model)
    cache.reset()
    del cache

    save_model(model, tok, out_dir)

    text_cfg = get_text_config(model.config)
    head_dim = recipe.head_dim or report["head_dim"]
    sidecar_payload = {
        "method": "fused-turboquant",
        "source_model": args.model,
        "recipe": recipe.to_json(),
        "head_dim": int(head_dim),
        "n_q_heads": int(report["n_q_heads"]),
        "n_kv_heads": int(report["n_kv_heads"]),
        "num_hidden_layers": int(text_cfg.num_hidden_layers),
        "eligible_layers": int(report["eligible_layers"]),
        "architecture": report["architecture"],
        "calibration_file": str(args.calibration) if args.calibration else None,
        "calibration_samples": args.calibration_samples if args.calibration else 0,
        "kernel_manifest": kernel_manifest_fragment("fused-turboquant"),
        "notes": (
            "fused-TurboQuant is a runtime KV-cache compressor. The weights "
            "in this directory are unchanged. To use the quantized cache at "
            "inference time, call "
            "quantization.fused_turboquant_vendored.hf.patch_model(model, "
            "bits=..., compress_v=...) and pass the returned cache to "
            "model.generate(past_key_values=cache, use_cache=True)."
        ),
    }
    sidecar_path = write_sidecar(out_dir, "fused_turboquant.json", sidecar_payload)
    log.info("wrote %s", sidecar_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
