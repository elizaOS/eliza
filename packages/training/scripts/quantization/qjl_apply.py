"""Apply QJL (1-bit Quantized JL) key-side KV-cache compression to a checkpoint.

QJL
    Zandieh, Daliri, Han. *QJL: 1-Bit Quantized JL Transform for KV Cache
    Quantization with Zero Overhead*. arXiv:2406.03482, AAAI 2025.
    Reference impl vendored under ``./qjl/`` from
    https://github.com/amirzandieh/QJL @ 648b3641.

QJL is the key-side companion to TurboQuant's value-side compressor.
Both were authored by Amir Zandieh; they compose. With QJL on K and
TurboQuant on V the KV cache shrinks ~10x at long context (1 bit per K
coord + 4 bits per V coord).

Like TurboQuant, QJL is a runtime KV-cache compressor: it does not
shrink ``model.safetensors`` on disk. This script:

1. Loads a HF causal-LM checkpoint (merging a LoRA adapter if present).
2. Optionally walks a small calibration set to estimate per-layer
   outlier-coordinate statistics.
3. Saves the (unchanged) merged weights and a ``qjl_config.json``
   sidecar with the projection geometry, outlier counts, layer split,
   and PRNG seed needed to reconstruct the JL projection at inference.

The vendored CUDA C++ extension under ``./qjl/`` must be compiled before
inference can use the quantized cache. This script does not trigger the
build (apply-time vs runtime separation). See ``qjl/`` for build details.
"""

from __future__ import annotations

import argparse
import importlib
import json
import logging
import math
import sys
from pathlib import Path
from typing import Callable

import torch
import torch.nn as nn
from transformers.cache_utils import Cache
from transformers.tokenization_utils_base import PreTrainedTokenizerBase

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from _common import (  # noqa: E402
    full_attention_layer_indices,
    get_text_config,
    head_dim_of,
    kernel_manifest_fragment,
    load_calibration_prompts,
    load_model_and_tokenizer,
    save_model,
    write_sidecar,
)

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s"
)
log = logging.getLogger("qjl_apply")


# Outlier sketch dimension per layer-class (matches upstream defaults).
_OUTLIER_DIM_GENERAL = 256
_OUTLIER_DIM_INITIAL = 128


def calibrate_key_outliers(
    model: nn.Module,
    tokenizer: PreTrainedTokenizerBase,
    prompts: list[str],
    *,
    head_dim: int,
    outlier_count_general: int,
    outlier_count_initial_layers: int,
    initial_layers_count: int,
    layer_indices: list[int],
) -> dict[str, object]:
    """Forward calibration prompts and record per-layer K coordinate norms.

    The actual outlier *values* are recomputed at inference time by upstream
    ``QJLKeyQuantizer.build_sketch``; we fix the per-layer *budget* here.
    """
    text_cfg = get_text_config(model.config)
    num_kv_heads = (
        getattr(text_cfg, "num_key_value_heads", None) or text_cfg.num_attention_heads
    )

    layer_norms: dict[int, torch.Tensor] = {}

    def _make_hook(layer_idx: int) -> Callable[[nn.Module, object, object], None]:
        def _hook(_module: nn.Module, _input: object, output: object) -> None:
            t = output[0] if isinstance(output, tuple) else output
            if not isinstance(t, torch.Tensor):
                return
            if t.dim() == 3:
                B, T, D = t.shape
                t = t.view(B, T, num_kv_heads, head_dim)
            norms = t.float().norm(dim=1).mean(dim=(0, 1))  # (head_dim,)
            prev = layer_norms.get(layer_idx)
            if prev is None:
                layer_norms[layer_idx] = norms.detach().cpu()
            else:
                layer_norms[layer_idx] = prev * 0.5 + norms.detach().cpu() * 0.5

        return _hook

    handles: list[object] = []
    for i in layer_indices:
        if i >= len(model.model.layers):
            continue
        layer = model.model.layers[i]
        attn = getattr(layer, "self_attn", None)
        if attn is None:
            continue
        k_proj = getattr(attn, "k_proj", None)
        if k_proj is None:
            continue
        handles.append(k_proj.register_forward_hook(_make_hook(i)))

    try:
        model.eval()
        for i, prompt in enumerate(prompts):
            ids = tokenizer(
                prompt, return_tensors="pt", truncation=True, max_length=2048
            ).to(model.device)
            with torch.no_grad():
                model(**ids, use_cache=False)
            if (i + 1) % 16 == 0:
                log.info("  calibration: %d/%d prompts", i + 1, len(prompts))
    finally:
        for h in handles:
            h.remove()  # type: ignore[attr-defined]

    ratios: list[float] = []
    per_layer: dict[int, int] = {}
    for i, norms in layer_norms.items():
        if norms.numel() == 0:
            continue
        med = float(norms.median())
        mx = float(norms.max())
        ratios.append(mx / max(med, 1e-9))
        is_initial = i < initial_layers_count
        per_layer[i] = (
            outlier_count_initial_layers if is_initial else outlier_count_general
        )

    return {
        "n_prompts": len(prompts),
        "n_full_attention_layers_calibrated": len(layer_norms),
        "median_outlier_norm_ratio": (
            float(sum(ratios) / len(ratios)) if ratios else 0.0
        ),
        "per_layer_outlier_count": {str(k): v for k, v in sorted(per_layer.items())},
        "initial_layers_count_used": initial_layers_count,
    }


def kv_bytes_per_token_analytic(
    config: object,
    *,
    key_quantization_bits: int,
    key_quantization_bits_initial_layers: int,
    initial_layers_count: int,
    outlier_count_general: int,
    outlier_count_initial_layers: int,
    value_bits: int,
    group_size: int = 32,
) -> tuple[int, int]:
    """Per-token KV bytes for baseline (bf16 cache) vs QJL+TurboQuant.

    K-cache geometry mirrors upstream ``QJLKeyQuantizer.build_sketch``:
    every ``group_size`` tokens share one outlier-index table and one
    outlier sketch row, but each token has its own 1-bit JL sketch row +
    bf16 norm. V-cache geometry matches TurboQuant.
    """
    text_cfg = get_text_config(config)
    head_dim = head_dim_of(text_cfg)
    num_kv_heads = (
        getattr(text_cfg, "num_key_value_heads", None) or text_cfg.num_attention_heads
    )
    full_idx = full_attention_layer_indices(text_cfg)

    bytes_per_group = 0
    bytes_per_group_baseline = 0

    for i in full_idx:
        coords_k = num_kv_heads * head_dim
        coords_v = num_kv_heads * head_dim
        bytes_per_group_baseline += group_size * 2 * (coords_k + coords_v)

        if i < initial_layers_count:
            kbits = key_quantization_bits_initial_layers
            okount = outlier_count_initial_layers
            odim = _OUTLIER_DIM_INITIAL
        else:
            kbits = key_quantization_bits
            okount = outlier_count_general
            odim = _OUTLIER_DIM_GENERAL

        per_token_per_head = math.ceil(kbits / 8) + 2
        per_group_per_head_amortized = math.ceil(okount * odim / 8) + okount
        bytes_per_group += num_kv_heads * (
            per_token_per_head * group_size + per_group_per_head_amortized
        )

        v_per_token = math.ceil(coords_v * value_bits / 8) + num_kv_heads * 2
        bytes_per_group += group_size * v_per_token

    return bytes_per_group_baseline // group_size, bytes_per_group // group_size


def _qjl_kernel_module() -> object:
    """Add the vendored qjl/ directory to sys.path and import the dispatch wrapper."""
    qjl_dir = str(_HERE / "qjl")
    if qjl_dir not in sys.path:
        sys.path.insert(0, qjl_dir)
    return importlib.import_module("qjl_kernel")


def _build_jl_projections(
    *,
    head_dim: int,
    full_attn_layer_indices: list[int],
    initial_layers_count: int,
    proj_dim_general: int,
    proj_dim_initial: int,
    seed: int,
    device: torch.device,
    dtype: torch.dtype,
) -> dict[int, torch.Tensor]:
    """Per-layer ``(head_dim, proj_dim)`` row-major JL projection matrices.

    Layout matches the canonical kernel reference at
    ``eliza/packages/native-plugins/qjl-cpu/include/qjl/qjl.h`` (Π row-major,
    indexed as ``prj[i*proj_dim + j]``) and the verify harness reference at
    ``eliza/packages/inference/verify/qjl_polar_ref.c``. A row of the matrix
    is ``proj_dim`` floats; with the canonical (head_dim=128, proj_dim=256)
    that's 1024 bytes per row and 131072 bytes (128 KiB) per matrix.

    Bytes emitted by this function can be passed directly to qjl-cpu /
    Metal / Vulkan / CUDA kernel call sites with no transpose at the
    boundary. Sketch math is ``q_sketch = q @ pi`` where ``q`` has trailing
    dim ``head_dim`` and ``pi`` is the returned ``(head_dim, proj_dim)``
    matrix; the result has trailing dim ``proj_dim``.

    Deterministic in ``seed`` — torch's Mersenne-Twister stream over
    ``torch.randn(head_dim, proj_dim, ...)`` is invariant under the layout
    swap (the buffer is the same fp32 numbers, only the interpretation of
    rows-vs-columns differs). The legacy CUDA bridge that consumes
    ``(sketch_dim, head_dim)`` gets a transpose at the call site (see
    ``attach_qjl_to_cache``); the canonical training-side artifact stays
    in ``(head_dim, proj_dim)``.
    """
    projections: dict[int, torch.Tensor] = {}
    for layer_idx in full_attn_layer_indices:
        proj_dim = (
            proj_dim_initial if layer_idx < initial_layers_count else proj_dim_general
        )
        gen = torch.Generator(device="cpu").manual_seed(seed + int(layer_idx))
        proj = torch.randn(head_dim, proj_dim, generator=gen, dtype=torch.float32)
        projections[layer_idx] = proj.to(device=device, dtype=dtype)
    return projections


def _find_decoder_layers(model: nn.Module) -> nn.Module:
    """Locate the decoder layer list (Llama-style)."""
    candidate_paths = (
        ("model", "layers"),
        ("language_model", "model", "layers"),
        ("model", "model", "layers"),
        ("transformer", "layers"),
    )
    for path in candidate_paths:
        obj: object = model
        for attr in path:
            obj = getattr(obj, attr, None)
            if obj is None:
                break
        else:
            if hasattr(obj, "__getitem__"):
                return obj  # type: ignore[return-value]
    raise RuntimeError(
        f"could not find decoder layers on model of type {type(model).__name__}; "
        f"tried: {candidate_paths}"
    )


def attach_qjl_to_cache(model: nn.Module, cache: Cache, **qjl_cfg: object) -> Cache:
    """Wrap ``cache`` so K writes go through the QJL 1-bit JL sketch.

    Recognized ``qjl_cfg`` keys (defaults match the paper):
        head_dim, projection_dim_per_head (256), projection_dim_per_head_initial (512),
        initial_layers_count (15), outlier_count_general (8),
        outlier_count_initial_layers (8), group_size (32), buffer_size (128),
        projection_seed (42), calibration (dict with per_layer_outlier_count).
    """
    if cache is None:
        raise ValueError("attach_qjl_to_cache requires an existing cache; got None")

    text_cfg = get_text_config(model.config)
    head_dim = int(qjl_cfg.get("head_dim") or head_dim_of(text_cfg))

    proj_dim_general = int(qjl_cfg.get("projection_dim_per_head", 256))
    proj_dim_initial = int(qjl_cfg.get("projection_dim_per_head_initial", 512))
    initial_layers_count = int(qjl_cfg.get("initial_layers_count", 15))
    outlier_count_general = int(qjl_cfg.get("outlier_count_general", 8))
    outlier_count_initial = int(qjl_cfg.get("outlier_count_initial_layers", 8))
    group_size = int(qjl_cfg.get("group_size", 32))
    buffer_size = int(qjl_cfg.get("buffer_size", 128))
    seed = int(qjl_cfg.get("projection_seed", 42))

    per_layer_outlier_count: dict[int, int] = {}
    calib = qjl_cfg.get("calibration") or {}
    raw = calib.get("per_layer_outlier_count") or {}  # type: ignore[union-attr]
    for k, v in raw.items():
        per_layer_outlier_count[int(k)] = int(v)

    full_attn_layer_indices = full_attention_layer_indices(text_cfg)
    if not full_attn_layer_indices:
        raise RuntimeError(
            "attach_qjl_to_cache: no full-attention layers found; nothing to compress."
        )

    kernel_module = _qjl_kernel_module()
    try:
        kernel_module._load_kernel("cuda_qjl_quant")  # type: ignore[attr-defined]
        backend = "cuda"
    except (ImportError, OSError):
        backend = "pytorch"
        log.warning(
            "QJL CUDA extension not built -- using pure-PyTorch reference "
            "(correct but slow). Build for production: cd %s && ./build.sh",
            _HERE / "qjl",
        )

    device = next(model.parameters()).device
    proj_dtype = next(model.parameters()).dtype
    projections = _build_jl_projections(
        head_dim=head_dim,
        full_attn_layer_indices=full_attn_layer_indices,
        initial_layers_count=initial_layers_count,
        proj_dim_general=proj_dim_general,
        proj_dim_initial=proj_dim_initial,
        seed=seed,
        device=device,
        dtype=proj_dtype,
    )

    qjl_state: dict[int, dict[str, torch.Tensor | int]] = {}
    decoder_layers = _find_decoder_layers(model)

    def _make_k_hook(
        layer_idx: int,
    ) -> Callable[[nn.Module, object, object], object]:
        proj = projections[layer_idx]
        outlier_count = per_layer_outlier_count.get(
            layer_idx,
            outlier_count_initial
            if layer_idx < initial_layers_count
            else outlier_count_general,
        )
        outlier_sketch_dim = (
            _OUTLIER_DIM_INITIAL if layer_idx < initial_layers_count else _OUTLIER_DIM_GENERAL
        )

        def _hook(module: nn.Module, _inputs: object, output: object) -> object:
            k_flat = output[0] if isinstance(output, tuple) else output
            B, T, _ = k_flat.shape
            n_kv = k_flat.shape[-1] // head_dim
            k = k_flat.view(B, T, n_kv, head_dim).permute(0, 2, 1, 3).contiguous()

            num_full_groups = T // group_size
            if num_full_groups == 0:
                return output
            groupable = num_full_groups * group_size
            grouped = k[:, :, :groupable, :].view(
                B, n_kv, num_full_groups, group_size, head_dim,
            ).contiguous()

            group_norms = grouped.float().norm(dim=-2)
            _, outlier_idx = group_norms.topk(outlier_count, dim=-1)
            outlier_idx_u8 = outlier_idx.to(torch.uint8).contiguous()

            # The vendored CUDA / pure-PyTorch fallback in qjl/qjl_kernel.py
            # expects ``rand_prj`` shaped ``(sketch_dim, head_dim)`` (it
            # transposes internally). The training-side artifact is stored
            # in the canonical ``(head_dim, proj_dim)`` row-major layout so
            # the on-device qjl-cpu / Metal / Vulkan kernels can consume
            # it with no transpose. Bridge the layout difference at the
            # legacy-bridge boundary, not in the canonical store.
            proj_legacy = proj.transpose(0, 1).contiguous()

            if backend == "cuda":
                key_quant, key_outlier_quant, key_outliers_norm = (
                    kernel_module.qjl_quant(  # type: ignore[attr-defined]
                        grouped, outlier_idx_u8, proj_legacy, outlier_sketch_dim,
                    )
                )
            else:
                key_quant, key_outlier_quant, key_outliers_norm = (
                    kernel_module.qjl_quantize_pytorch(  # type: ignore[attr-defined]
                        grouped, outlier_idx_u8, proj_legacy, outlier_sketch_dim,
                    )
                )

            key_norms = grouped.float().norm(dim=-1)

            entry = {
                "packed": key_quant,
                "outlier_quant": key_outlier_quant,
                "outlier_indices": outlier_idx_u8,
                "outlier_norms": key_outliers_norm,
                "norms": key_norms,
                "rand_prj": proj,
                "head_dim": head_dim,
                "n_kv_heads": n_kv,
                "group_size": group_size,
            }
            prev = qjl_state.get(layer_idx)
            if prev is None:
                qjl_state[layer_idx] = entry
            else:
                qjl_state[layer_idx] = {
                    "packed": torch.cat([prev["packed"], entry["packed"]], dim=2),
                    "outlier_quant": torch.cat(
                        [prev["outlier_quant"], entry["outlier_quant"]], dim=2
                    ),
                    "outlier_indices": torch.cat(
                        [prev["outlier_indices"], entry["outlier_indices"]], dim=2
                    ),
                    "outlier_norms": torch.cat(
                        [prev["outlier_norms"], entry["outlier_norms"]], dim=2
                    ),
                    "norms": torch.cat([prev["norms"], entry["norms"]], dim=2),
                    "rand_prj": proj,
                    "head_dim": head_dim,
                    "n_kv_heads": n_kv,
                    "group_size": group_size,
                }
            return output

        return _hook

    handles: list[object] = []
    patched = 0
    for i in full_attn_layer_indices:
        if i >= len(decoder_layers):
            continue
        layer = decoder_layers[i]
        attn = getattr(layer, "self_attn", None)
        if attn is None:
            continue
        k_proj = getattr(attn, "k_proj", None)
        if k_proj is None:
            continue
        handles.append(k_proj.register_forward_hook(_make_k_hook(i)))
        patched += 1

    if patched == 0:
        raise RuntimeError(
            "attach_qjl_to_cache: zero full-attention layers patched. The "
            "model must expose model.model.layers[i].self_attn.k_proj on the "
            "full-attention slots."
        )

    cache._qjl_state = qjl_state  # type: ignore[attr-defined]
    cache._qjl_handles = handles  # type: ignore[attr-defined]
    cache._qjl_projections = projections  # type: ignore[attr-defined]
    cache._qjl_backend = backend  # type: ignore[attr-defined]

    def _qjl_get_compressed_key(layer_idx: int) -> dict[str, object] | None:
        return qjl_state.get(int(layer_idx))

    def _qjl_decode_keys(layer_idx: int) -> torch.Tensor:
        """Reconstruct K from the 1-bit JL sketch + per-token bf16 norms.

        Best-effort inverse for debugging only -- the JL sketch is lossy
        by construction (sign of a random projection).
        """
        entry = qjl_state.get(int(layer_idx))
        if entry is None:
            raise RuntimeError(
                f"decode_keys({layer_idx}) called but no compressed key exists yet."
            )
        packed = entry["packed"]
        proj = entry["rand_prj"]  # (head_dim, proj_dim) row-major canonical
        norms = entry["norms"]
        B, H, G, GS, packed_dim = packed.shape
        sketch_dim = packed_dim * 8
        bit_idx = torch.arange(8, device=packed.device, dtype=torch.uint8)
        unpacked = ((packed.unsqueeze(-1) >> bit_idx) & 1).to(torch.float32)
        signs = unpacked.view(B, H, G, GS, sketch_dim) * 2.0 - 1.0
        # Right pseudo-inverse of (head_dim, proj_dim) with head_dim < proj_dim:
        # pinv(P) = P.T @ inv(P @ P.T), shape (proj_dim, head_dim).
        # So k_hat = signs @ pinv(P), shape (..., head_dim).
        proj_f = proj.to(torch.float32)
        gram = proj_f @ proj_f.transpose(0, 1)  # (head_dim, head_dim)
        proj_dagger = proj_f.transpose(0, 1) @ torch.linalg.inv(gram)  # (proj_dim, head_dim)
        k_hat = signs @ proj_dagger
        k_hat_norms = k_hat.norm(dim=-1, keepdim=True).clamp_min(1e-8)
        k_hat = k_hat * (norms.unsqueeze(-1) / k_hat_norms)
        head_dim_out = proj.shape[0]
        return k_hat.view(B, H, G * GS, head_dim_out)

    cache.get_compressed_key = _qjl_get_compressed_key  # type: ignore[attr-defined]
    cache.decode_keys = _qjl_decode_keys  # type: ignore[attr-defined]

    log.info(
        "attach_qjl_to_cache: patched %d full-attention layers (backend=%s, "
        "head_dim=%d, group_size=%d, buffer_size=%d)",
        patched, backend, head_dim, group_size, buffer_size,
    )
    return cache


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    ap.add_argument(
        "--model",
        required=True,
        help="HF repo id or local path. LoRA adapter dirs are merged automatically.",
    )
    ap.add_argument("--output", required=True, type=Path)
    ap.add_argument("--calibration", type=Path, default=None)
    ap.add_argument("--calibration-samples", type=int, default=128)
    ap.add_argument("--key-bits", type=int, default=1, choices=(1,))
    ap.add_argument("--projection-dim-per-head", type=int, default=256)
    ap.add_argument("--projection-dim-per-head-initial", type=int, default=512)
    ap.add_argument("--initial-layers-count", type=int, default=15)
    ap.add_argument("--outlier-count-general", type=int, default=8)
    ap.add_argument("--outlier-count-initial-layers", type=int, default=8)
    ap.add_argument("--value-bits", type=int, default=4, choices=(2, 4))
    ap.add_argument("--group-size", type=int, default=32)
    ap.add_argument("--buffer-size", type=int, default=128)
    ap.add_argument("--projection-seed", type=int, default=42)
    ap.add_argument("--device", default="cuda")
    ap.add_argument("--dtype", default="bfloat16", choices=("float16", "bfloat16"))
    ap.add_argument("--no-calibration-pass", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)

    if not torch.cuda.is_available() and args.device == "cuda":
        raise RuntimeError("CUDA requested but not available")

    if args.dry_run:
        print(json.dumps(vars(args), indent=2, default=str))
        return 0

    dtype = torch.bfloat16 if args.dtype == "bfloat16" else torch.float16
    out_dir = Path(args.output)

    model, tok = load_model_and_tokenizer(args.model, device_map=args.device, dtype=dtype)
    text_cfg = get_text_config(model.config)
    head_dim = head_dim_of(text_cfg)
    full_idx = full_attention_layer_indices(text_cfg)

    if args.no_calibration_pass or not args.calibration:
        log.info("no calibration pass; using paper defaults")
        calibration_block: dict[str, object] = {
            "skipped": True,
            "reason": (
                "no --calibration provided"
                if not args.calibration
                else "--no-calibration-pass set"
            ),
            "per_layer_outlier_count": {
                str(i): (
                    args.outlier_count_initial_layers
                    if i < args.initial_layers_count
                    else args.outlier_count_general
                )
                for i in full_idx
            },
        }
    else:
        prompts = load_calibration_prompts(args.calibration, n=args.calibration_samples)
        log.info("calibrating key outliers on %d prompts", len(prompts))
        calibration_block = calibrate_key_outliers(
            model,
            tok,
            prompts,
            head_dim=head_dim,
            outlier_count_general=args.outlier_count_general,
            outlier_count_initial_layers=args.outlier_count_initial_layers,
            initial_layers_count=args.initial_layers_count,
            layer_indices=full_idx,
        )

    save_model(model, tok, out_dir)

    base_bpt, quant_bpt = kv_bytes_per_token_analytic(
        model.config,
        key_quantization_bits=args.projection_dim_per_head,
        key_quantization_bits_initial_layers=args.projection_dim_per_head_initial,
        initial_layers_count=args.initial_layers_count,
        outlier_count_general=args.outlier_count_general,
        outlier_count_initial_layers=args.outlier_count_initial_layers,
        value_bits=args.value_bits,
    )

    sidecar_payload = {
        "method": "qjl",
        "paper": "arXiv:2406.03482",
        "vendored_upstream": "https://github.com/amirzandieh/QJL",
        "vendored_commit": "648b3641f96b6e95e091217220b94e4739fd4d82",
        "source_model": args.model,
        "key_bits": args.key_bits,
        "projection_dim_per_head": args.projection_dim_per_head,
        "projection_dim_per_head_initial": args.projection_dim_per_head_initial,
        "initial_layers_count": args.initial_layers_count,
        "outlier_count_general": args.outlier_count_general,
        "outlier_count_initial_layers": args.outlier_count_initial_layers,
        "value_bits": args.value_bits,
        "group_size": args.group_size,
        "buffer_size": args.buffer_size,
        "projection_seed": args.projection_seed,
        "head_dim": head_dim,
        "num_hidden_layers": int(text_cfg.num_hidden_layers),
        "n_full_attention_layers": len(full_idx),
        "kv_bytes_per_token_baseline": base_bpt,
        "kv_bytes_per_token_qjl_plus_value": quant_bpt,
        "kv_reduction_factor_estimated": (
            base_bpt / quant_bpt if quant_bpt else 0.0
        ),
        "calibration_file": str(args.calibration) if args.calibration else None,
        "calibration": calibration_block,
        "kernel_manifest": kernel_manifest_fragment("qjl"),
        "build_required_command": (
            "cd scripts/quantization/qjl && python setup.py build_ext --inplace"
        ),
    }
    sidecar_path = write_sidecar(out_dir, "qjl_config.json", sidecar_payload)
    log.info("wrote %s", sidecar_path)
    log.info(
        "estimated KV reduction: %.2fx (baseline=%d, qjl+value=%d bytes/token)",
        sidecar_payload["kv_reduction_factor_estimated"],
        base_bpt,
        quant_bpt,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
