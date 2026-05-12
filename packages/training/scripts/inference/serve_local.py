"""Local long-context inference helper for fine-tuned + quantized Qwen models.

Loads the chosen model with PolarQuant weights (if available) and TurboQuant
KV cache (if available), then serves a single OpenAI-compatible chat
completion over a prompt+generation budget pulled from the registry.

The point of this script: confirm that the model actually does serve
128k input + 16k output on this hardware, not just that the math says
it should.

Usage:
    uv run --extra train python scripts/inference/serve_local.py \\
        --registry-key qwen3.5-2b \\
        --polarquant checkpoints/qwen35-2b-apollo-v1/final-polarquant \\
        --turboquant checkpoints/qwen35-2b-apollo-v1/final-turboquant/turboquant.json \\
        --prompt-file /tmp/long_prompt.txt \\
        --max-new-tokens 16384

If neither --polarquant nor --turboquant is provided, the bf16 weights
ship and the standard `DynamicCache` is used. The script always logs
peak VRAM, tokens/sec, and the actual context length used.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from training.model_registry import get as registry_get  # noqa: E402

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("serve")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--registry-key", required=True)
    ap.add_argument("--checkpoint", default=None,
                    help="Local checkpoint dir; defaults to the registry hf_id.")
    ap.add_argument("--polarquant", default=None,
                    help="Path to PolarQuant artifacts dir (sidecar safetensors).")
    ap.add_argument("--turboquant", default=None,
                    help="Path to turboquant.json sidecar (pure-PyTorch turbokv).")
    ap.add_argument("--fused-turboquant", default=None,
                    help="Path to fused_turboquant.json sidecar (Triton-fused, "
                         "preferred over --turboquant when both are available).")
    ap.add_argument("--qjl", default=None,
                    help="Path to qjl_config.json sidecar — applies 1-bit "
                         "QJL key compression on top of the V-side cache.")
    ap.add_argument("--bits", type=int, default=4,
                    help="KV value bits for fused-turboquant (3 or 4).")
    ap.add_argument("--prompt-file", required=True,
                    help="UTF-8 text file with the user prompt.")
    ap.add_argument("--system-prompt", default=None)
    ap.add_argument("--max-new-tokens", type=int, default=None,
                    help="Default: registry infer_max_out.")
    ap.add_argument("--max-prompt-tokens", type=int, default=None,
                    help="Default: registry infer_max_in. Truncates left.")
    ap.add_argument("--temperature", type=float, default=0.0)
    ap.add_argument("--out-file", default=None)
    ap.add_argument("--entropix", action="store_true",
                    help="Enable entropy/varentropy adaptive sampler (research). "
                         "Forces do_sample=True; clarifier-token id read from tokenizer.")
    ap.add_argument("--entropix-clarifier", default='"',
                    help='Token to insert in HELV (high-ent, low-varent) state.')
    args = ap.parse_args()

    entry = registry_get(args.registry_key)
    max_in = args.max_prompt_tokens or entry.infer_max_in
    max_out = args.max_new_tokens or entry.infer_max_out
    log.info("registry %s → context budget %d in + %d out (%d total)",
             entry.short_name, max_in, max_out, max_in + max_out)
    log.info("expected VRAM (PolarQuant + TurboQuant @ 144k): %.1f GB",
             entry.infer_mem_gb_quantized)

    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    model_path = args.checkpoint or entry.hf_id
    log.info("loading tokenizer from %s", model_path)
    tokenizer = AutoTokenizer.from_pretrained(model_path, trust_remote_code=True)
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token

    log.info("loading model from %s (bf16)", model_path)
    torch.cuda.reset_peak_memory_stats()
    model = AutoModelForCausalLM.from_pretrained(
        model_path, dtype=torch.bfloat16, trust_remote_code=True,
        device_map="auto",
    )
    model.eval()
    log.info("model loaded; baseline peak %.2f GB",
             torch.cuda.max_memory_allocated() / 1024**3)

    if args.polarquant:
        from quantization.polarquant_apply import apply_sidecar_to_model
        log.info("applying PolarQuant weights from %s", args.polarquant)
        apply_sidecar_to_model(model, Path(args.polarquant))

    # KV-cache backend selection. For hybrid linear+full-attention models
    # (Qwen3.5 / Qwen3.6) we MUST build a layer-type-aware cache or HF's
    # parent Cache.has_previous_state crashes when the linear-attention
    # layers index into a cache that only knows about full-attention slots.
    # ElizaHybridCache handles that and dispatches the full-attention
    # slots to bf16 / fused_turboquant / qjl_full as requested.
    from inference.hybrid_cache import has_hybrid_layer_types, make_hybrid_cache

    past_key_values = None
    is_hybrid = has_hybrid_layer_types(model)

    if is_hybrid:
        # Decide the full-attention backend from the CLI flags. fused_turboquant
        # wins over plain turboquant (Triton-fused vs pure-PyTorch). QJL
        # without fused_turboquant means QJL on K + bf16 V — we don't expose
        # that variant here; --qjl always implies qjl_full (K+V quantized).
        if args.qjl:
            backend = "qjl_full"
            ft_cfg = json.loads(Path(args.fused_turboquant).read_text()) \
                if args.fused_turboquant else {}
            qjl_cfg = json.loads(Path(args.qjl).read_text())
            past_key_values = make_hybrid_cache(
                model, full_attn_backend=backend,
                bits=ft_cfg.get("bits", args.bits),
                compress_v=ft_cfg.get("compress_v", True),
                qjl_value_bits=qjl_cfg.get("value_bits", 4),
            )
        elif args.fused_turboquant:
            ft_cfg = json.loads(Path(args.fused_turboquant).read_text())
            past_key_values = make_hybrid_cache(
                model, full_attn_backend="fused_turboquant",
                bits=ft_cfg.get("bits", args.bits),
                compress_v=ft_cfg.get("compress_v", True),
            )
        elif args.turboquant:
            log.warning(
                "--turboquant (pure-PyTorch) on a hybrid Qwen3.5/3.6 model "
                "is not supported because TurboQuantCache is layer-flat. "
                "Falling back to bf16 hybrid cache; pass --fused-turboquant "
                "for the Triton-fused path."
            )
            past_key_values = make_hybrid_cache(model, full_attn_backend="bf16")
        else:
            past_key_values = make_hybrid_cache(model, full_attn_backend="bf16")
        log.info("hybrid cache: backend=%s, %d total layers (%d full-attn)",
                 past_key_values.full_attn_backend,
                 len(past_key_values.layer_types),
                 sum(1 for t in past_key_values.layer_types if t == "full_attention"))
    else:
        # Legacy non-hybrid path: keep the existing flat-cache behavior.
        if args.fused_turboquant:
            from quantization.fused_turboquant_vendored.hf import (
                patch_model as _ft_patch,
            )
            log.info("loading fused-turboquant config from %s", args.fused_turboquant)
            cfg = json.loads(Path(args.fused_turboquant).read_text())
            past_key_values = _ft_patch(
                model, bits=cfg.get("bits", args.bits),
                head_dim=cfg.get("head_dim"),
                compress_v=cfg.get("compress_v", True),
            )
        elif args.turboquant:
            from turboquant import TurboQuantCache
            log.info("loading TurboQuant cache config from %s", args.turboquant)
            cfg = json.loads(Path(args.turboquant).read_text())
            past_key_values = TurboQuantCache(
                config=model.config.get_text_config(decoder=True),
                nbits=cfg.get("nbits", 4),
                base_seed=cfg.get("base_seed", 0),
                skip_layers=set(cfg.get("skip_layers", [])),
                residual_length=cfg.get("residual_length", 0),
            )
        if args.qjl and past_key_values is not None:
            log.info("applying QJL 1-bit key compression from %s", args.qjl)
            try:
                from quantization.qjl_apply import attach_qjl_to_cache
                qjl_cfg = json.loads(Path(args.qjl).read_text())
                past_key_values = attach_qjl_to_cache(
                    model=model, cache=past_key_values, **qjl_cfg,
                )
            except ImportError as e:
                log.error("QJL not available: %s", e)
                log.error("Continuing without QJL key compression")

    user_prompt = Path(args.prompt_file).read_text(encoding="utf-8")
    messages = []
    if args.system_prompt:
        messages.append({"role": "system", "content": args.system_prompt})
    messages.append({"role": "user", "content": user_prompt})

    prompt_text = tokenizer.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=True,
    )
    inputs = tokenizer(prompt_text, return_tensors="pt", truncation=True,
                       max_length=max_in).to(model.device)
    actual_in = inputs["input_ids"].shape[1]
    log.info("prompt tokens: %d (cap %d)", actual_in, max_in)

    gen_kwargs = {
        "max_new_tokens": max_out,
        "do_sample": args.temperature > 0,
        "temperature": max(args.temperature, 1e-5),
        "pad_token_id": tokenizer.pad_token_id,
        "eos_token_id": tokenizer.eos_token_id,
    }
    if past_key_values is not None:
        gen_kwargs["past_key_values"] = past_key_values

    if args.entropix:
        from transformers import LogitsProcessorList

        from scripts.inference.entropix_sampler import (
            EntropixLogitsProcessor,
            EntropixThresholds,
        )
        clarifier_id = tokenizer.convert_tokens_to_ids(args.entropix_clarifier)
        th = EntropixThresholds(clarifier_token_id=int(clarifier_id))
        gen_kwargs["logits_processor"] = LogitsProcessorList([
            EntropixLogitsProcessor(th)])
        gen_kwargs["do_sample"] = True
        gen_kwargs["temperature"] = 1.0   # entropix owns temperature

    log.info("generating up to %d new tokens...", max_out)
    t0 = time.perf_counter()
    with torch.inference_mode():
        out = model.generate(**inputs, **gen_kwargs)
    elapsed = time.perf_counter() - t0
    new_tokens = int(out.shape[1] - actual_in)
    text = tokenizer.decode(out[0, actual_in:], skip_special_tokens=True)

    peak_gb = torch.cuda.max_memory_allocated() / 1024**3
    print("\n" + "=" * 60)
    print(text)
    print("=" * 60)
    log.info("generated %d tokens in %.1fs (%.1f tok/s)",
             new_tokens, elapsed, new_tokens / elapsed)
    log.info("peak VRAM: %.2f GB (budget %.1f GB)",
             peak_gb, entry.infer_mem_gb_quantized)

    if args.out_file:
        Path(args.out_file).write_text(text, encoding="utf-8")
        log.info("output written to %s", args.out_file)
    return 0


if __name__ == "__main__":
    sys.exit(main())
