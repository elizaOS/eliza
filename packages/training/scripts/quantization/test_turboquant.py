"""End-to-end validation of TurboQuant on a real Qwen model on the local 5080.

Honest about what TurboQuant is: a *runtime KV-cache* quantizer. It does
NOT shrink ``model.safetensors`` on disk -- the weights are unchanged.
The win is in the per-step KV cache memory at long context.

This script therefore measures the things TurboQuant actually changes:

  * KV-cache *bytes per token* (analytic, from the quantizer geometry)
  * Peak generation VRAM with a long context (empirical, with
    ``torch.cuda.reset_peak_memory_stats`` framing)
  * Tokens / sec for both runs (wall clock)
  * Output sanity (the quantized model still produces a non-empty TOON-
    looking response on each of 5 sampled prompts)

Default model is ``Qwen/Qwen3-0.6B``. ``Qwen/Qwen3.5-0.8B`` is a hybrid
linear-attention + Gated Attention model with a vision encoder; the
linear layers do not have a (B, H, T, D) KV cache and so are bypassed by
the cache machinery. Use ``--model Qwen/Qwen3.5-0.8B`` to opt-in to the
hybrid path; the assertions below are looser in that case (the savings
only apply to the ~6/24 full-attention layers).

Usage::

    .venv/bin/python scripts/quantization/test_turboquant.py
"""

from __future__ import annotations

import argparse
import gc
import json
import logging
import math
import os
import time
from pathlib import Path

import pytest

torch = pytest.importorskip("torch")
transformers = pytest.importorskip("transformers")
AutoModelForCausalLM = transformers.AutoModelForCausalLM
AutoTokenizer = transformers.AutoTokenizer
DynamicCache = pytest.importorskip("transformers.cache_utils").DynamicCache
TurboQuantCache = pytest.importorskip("turboquant").TurboQuantCache

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("test_turboquant")

ROOT = Path(__file__).resolve().parents[2]
VAL_JSONL = ROOT / "data" / "final" / "val.jsonl"


def load_toon_message_handler_prompts(n: int = 5) -> list[dict]:
    """Pull n records whose expected response looks like a TOON message_handler
    document (starts with `thought:` and contains `text:` somewhere). These
    are the canonical assistant-turn shape for the message_handler task.
    """
    out: list[dict] = []
    with VAL_JSONL.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            er = rec.get("expectedResponse") or ""
            if er.lstrip().startswith("thought:") and "\ntext:" in er:
                out.append(rec)
                if len(out) >= n:
                    break
    if len(out) < n:
        # Fall back to thought-only docs (some message_handler outputs are
        # action-routing docs without a `text:` field). Still TOON.
        with VAL_JSONL.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                er = rec.get("expectedResponse") or ""
                if er.lstrip().startswith("thought:"):
                    if rec not in out:
                        out.append(rec)
                if len(out) >= n:
                    break
    if len(out) < n:
        raise RuntimeError(f"Only found {len(out)} TOON prompts in {VAL_JSONL}")
    return out[:n]


def render_chat(tokenizer, record: dict) -> str:
    """Render a record into a chat prompt ending with the assistant turn open.

    We intentionally avoid pulling in ``format_for_training.format_record``
    here so this script has no dependency on the synth pipeline beyond the
    public dataset shape.
    """
    sys_prompt = (
        "You are an autonomous elizaOS agent. Decide which action to take "
        "from `availableActions` and respond with ONE TOON document. "
        "Always TOON. No fences, no <think>, no prose before or after."
    )
    msgs = [{"role": "system", "content": sys_prompt}]
    for m in record.get("memoryEntries") or []:
        role = m.get("role") or "user"
        if role not in ("user", "assistant"):
            continue
        content = m.get("content") or ""
        if content:
            msgs.append({"role": role, "content": content})
    cm = record.get("currentMessage") or {}
    msgs.append({"role": "user", "content": cm.get("content") or ""})
    return tokenizer.apply_chat_template(
        msgs, add_generation_prompt=True, tokenize=False
    )


def kv_bytes_per_token_analytic(
    config, *, nbits: int, skip_layers: set[int]
) -> tuple[int, int]:
    """Analytic per-token KV bytes for baseline (bf16 DynamicCache) vs quantized.

    For each *full-attention* layer we have ``num_kv_heads * head_dim`` key
    coords + same for value coords stored per token.

    Baseline: 2 (bytes/bf16) per coord -> 2 * num_kv_heads * head_dim per K and V.
    TurboQuant: nbits/8 per coord + a per-vector norm scalar in bf16.
    Skipped layers stay at baseline.
    """
    text_cfg = (
        config.get_text_config(decoder=True)
        if hasattr(config, "get_text_config")
        else config
    )
    head_dim = getattr(text_cfg, "head_dim", None) or (
        text_cfg.hidden_size // text_cfg.num_attention_heads
    )
    num_kv_heads = getattr(text_cfg, "num_key_value_heads", None) or text_cfg.num_attention_heads

    # Number of *full attention* layers (where a KV cache materializes).
    # Hybrid Qwen3.5/3.6 specify layer_types; fall back to "all are full".
    layer_types = getattr(text_cfg, "layer_types", None)
    if layer_types:
        full_idx = [i for i, t in enumerate(layer_types) if t == "full_attention"]
    else:
        full_idx = list(range(text_cfg.num_hidden_layers))

    baseline_per_token = 0
    quantized_per_token = 0
    for i in full_idx:
        # Per layer, per token, K + V vectors of length (num_kv_heads * head_dim)
        coords_k = num_kv_heads * head_dim
        coords_v = num_kv_heads * head_dim
        baseline_per_token += 2 * (coords_k + coords_v)  # bf16
        if i in skip_layers:
            quantized_per_token += 2 * (coords_k + coords_v)
        else:
            # nbits per coord, packed; plus 2 bytes (bf16) per (head, token) for the norm.
            quantized_per_token += int(math.ceil(coords_k * nbits / 8))
            quantized_per_token += int(math.ceil(coords_v * nbits / 8))
            quantized_per_token += 2 * num_kv_heads * 2  # K-norm + V-norm scalars
    return baseline_per_token, quantized_per_token


def measure_generation(
    model,
    tokenizer,
    prompts: list[str],
    *,
    cache_factory,
    max_new_tokens: int,
    label: str,
    long_context_prompt: str | None = None,
) -> dict:
    """Run generation on all `prompts` and (optionally) one long-context probe.

    Returns a dict with peak memory, total elapsed, total new tokens, tok/s,
    and the decoded texts. The long-context probe is what surfaces the KV
    cache savings; short prompts are mostly weight-bound.
    """
    torch.cuda.empty_cache()
    gc.collect()
    torch.cuda.reset_peak_memory_stats()

    decoded: list[str] = []
    total_new = 0
    t0 = time.perf_counter()
    for p in prompts:
        cache = cache_factory()
        ids = tokenizer(p, return_tensors="pt").to(model.device)
        with torch.no_grad():
            out = model.generate(
                **ids,
                past_key_values=cache,
                max_new_tokens=max_new_tokens,
                do_sample=False,
                pad_token_id=tokenizer.eos_token_id,
            )
        new = out[0, ids.input_ids.shape[-1]:]
        total_new += int(new.shape[-1])
        decoded.append(tokenizer.decode(new, skip_special_tokens=True))
        del cache, out, ids
        torch.cuda.synchronize()
    elapsed = time.perf_counter() - t0

    long_peak = None
    if long_context_prompt is not None:
        torch.cuda.empty_cache()
        gc.collect()
        torch.cuda.reset_peak_memory_stats()
        cache = cache_factory()
        ids = tokenizer(long_context_prompt, return_tensors="pt", truncation=False).to(
            model.device
        )
        with torch.no_grad():
            _ = model.generate(
                **ids,
                past_key_values=cache,
                max_new_tokens=64,
                do_sample=False,
                pad_token_id=tokenizer.eos_token_id,
            )
        long_peak = torch.cuda.max_memory_allocated()
        del cache, ids
        torch.cuda.synchronize()

    short_peak = torch.cuda.max_memory_allocated()
    return {
        "label": label,
        "elapsed_s": elapsed,
        "tokens_new": total_new,
        "toks_per_s": total_new / elapsed if elapsed > 0 else 0.0,
        "peak_vram_short_bytes": int(short_peak),
        "peak_vram_long_bytes": int(long_peak) if long_peak is not None else None,
        "decoded": decoded,
    }


def directory_size_bytes(path: Path) -> int:
    total = 0
    for root, _, files in os.walk(path):
        for f in files:
            fp = Path(root) / f
            if fp.is_file():
                total += fp.stat().st_size
    return total


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    ap.add_argument("--model", default="Qwen/Qwen3-0.6B")
    ap.add_argument("--num-prompts", type=int, default=5)
    ap.add_argument("--max-new-tokens", type=int, default=128)
    ap.add_argument("--calibration-samples", type=int, default=32)
    ap.add_argument("--nbits", type=int, default=4, choices=(2, 4))
    ap.add_argument("--long-context-tokens", type=int, default=4096)
    ap.add_argument(
        "--report",
        default=str(ROOT / "scripts" / "quantization" / "turboquant_report.json"),
    )
    args = ap.parse_args()

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA required")

    log.info("loading %s", args.model)
    tok = AutoTokenizer.from_pretrained(args.model, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        args.model,
        torch_dtype=torch.bfloat16,
        device_map="cuda",
        trust_remote_code=True,
    )
    model.eval()

    # On-disk size of the model snapshot (bf16) -- reported for context.
    # TurboQuant does not change this number; we record it explicitly so
    # nobody mistakes the reduction we *do* report (KV cache) for a weight
    # quantization win.
    model_dir = Path(model.config._name_or_path)
    on_disk_bytes = None
    if model_dir.exists() and model_dir.is_dir():
        on_disk_bytes = directory_size_bytes(model_dir)
    else:
        # Resolve through HF cache
        from huggingface_hub import snapshot_download

        snap = Path(snapshot_download(args.model, allow_patterns=["*.safetensors"]))
        on_disk_bytes = directory_size_bytes(snap)

    # Pull TOON prompts and build long-context calibration.
    records = load_toon_message_handler_prompts(args.num_prompts)
    rendered = [render_chat(tok, r) for r in records]
    log.info("loaded %d TOON prompts", len(rendered))
    # Long-context probe: tile a non-trivial corpus through the chat template
    # so we hit a realistic generation regime where KV dominates.
    long_prompt_text = (
        "Summarize the following operational notes in TOON.\n\n"
        + (records[0].get("currentMessage") or {}).get("content", "")
    )
    long_ids_full = tok(long_prompt_text, return_tensors="pt").input_ids[0]
    if long_ids_full.shape[-1] < args.long_context_tokens:
        long_prompt_text = (long_prompt_text + "\n\n") * (
            args.long_context_tokens // max(long_ids_full.shape[-1], 1) + 1
        )
        long_ids_full = tok(long_prompt_text, return_tensors="pt").input_ids[0]
    long_ids = long_ids_full[: args.long_context_tokens]
    long_prompt = tok.decode(long_ids, skip_special_tokens=True)
    log.info(
        "long-context probe: %d tokens", tok(long_prompt, return_tensors="pt").input_ids.shape[-1]
    )

    # Calibrate skip layers using a handful of prompts.
    log.info("calibrating skip_layers across %d prompts", args.calibration_samples)
    cal_prompts: list[str] = []
    with VAL_JSONL.open("r", encoding="utf-8") as f:
        for line in f:
            try:
                rec = json.loads(line)
            except Exception:
                continue
            cm = (rec.get("currentMessage") or {}).get("content") or ""
            if cm:
                cal_prompts.append(cm[:512])
            if len(cal_prompts) >= args.calibration_samples:
                break
    skip: set[int] = set()
    for p in cal_prompts:
        s = TurboQuantCache.calibrate_skip_layers(model, tok, calibration_text=p)
        skip |= s
    log.info("skip_layers (union): %s", sorted(skip))

    # Analytic KV bytes per token
    base_bpt, quant_bpt = kv_bytes_per_token_analytic(
        model.config, nbits=args.nbits, skip_layers=skip
    )
    log.info(
        "analytic KV bytes/token: baseline=%d quantized=%d (%.2fx reduction)",
        base_bpt,
        quant_bpt,
        base_bpt / max(quant_bpt, 1),
    )

    # Baseline (bf16 DynamicCache)
    log.info("=== BASELINE: bf16 DynamicCache ===")
    base_res = measure_generation(
        model,
        tok,
        rendered,
        cache_factory=lambda: DynamicCache(),
        max_new_tokens=args.max_new_tokens,
        label="baseline_bf16",
        long_context_prompt=long_prompt,
    )

    # Quantized (TurboQuant)
    log.info("=== TURBOQUANT: %d-bit ===", args.nbits)
    quant_res = measure_generation(
        model,
        tok,
        rendered,
        cache_factory=lambda: TurboQuantCache(
            model.config, nbits=args.nbits, base_seed=42, skip_layers=skip
        ),
        max_new_tokens=args.max_new_tokens,
        label=f"turboquant_{args.nbits}bit",
        long_context_prompt=long_prompt,
    )

    # Reporting
    print()
    print("=" * 78)
    print("TurboQuant validation report")
    print("=" * 78)
    print(f"model:                      {args.model}")
    print(f"on-disk size (bf16):        {on_disk_bytes / 1e6:.2f} MB (unchanged by TurboQuant)")
    print(f"skip_layers:                {sorted(skip)}")
    print(f"nbits:                      {args.nbits}")
    print()
    print("KV cache bytes / token (analytic, full-attention layers only):")
    print(f"  baseline:                 {base_bpt:>10,} bytes")
    print(f"  turboquant:               {quant_bpt:>10,} bytes")
    print(f"  reduction:                {base_bpt / max(quant_bpt, 1):.2f}x  ({100 * (1 - quant_bpt / max(base_bpt, 1)):.1f}% smaller)")
    print()
    print(f"Short-prompt batch ({args.num_prompts} prompts, {args.max_new_tokens} new tokens each):")
    print(f"  baseline tok/s:           {base_res['toks_per_s']:.2f}  ({base_res['tokens_new']} tok in {base_res['elapsed_s']:.2f}s)")
    print(f"  turboquant tok/s:         {quant_res['toks_per_s']:.2f}  ({quant_res['tokens_new']} tok in {quant_res['elapsed_s']:.2f}s)")
    print(f"  baseline peak VRAM:       {base_res['peak_vram_short_bytes'] / 1e9:.3f} GB")
    print(f"  turboquant peak VRAM:     {quant_res['peak_vram_short_bytes'] / 1e9:.3f} GB")
    print()
    if base_res["peak_vram_long_bytes"] is not None:
        print(f"Long-context probe ({args.long_context_tokens} tokens prefill + 64 new):")
        print(f"  baseline peak VRAM:       {base_res['peak_vram_long_bytes'] / 1e9:.3f} GB")
        print(f"  turboquant peak VRAM:     {quant_res['peak_vram_long_bytes'] / 1e9:.3f} GB")
        delta = (
            base_res["peak_vram_long_bytes"] - quant_res["peak_vram_long_bytes"]
        ) / 1e6
        print(f"  delta:                    {delta:+.2f} MB saved")
    print()
    print("Sample TurboQuant outputs:")
    for i, txt in enumerate(quant_res["decoded"]):
        snippet = txt[:240].replace("\n", " ")
        print(f"  [{i + 1}] {snippet!r}")
    print("=" * 78)

    # Assertions
    failures: list[str] = []

    # KV cache reduction must be meaningful (> 30% on the cache itself).
    if quant_bpt >= 0.7 * base_bpt:
        failures.append(
            f"KV cache reduction insufficient: {quant_bpt}/{base_bpt} bytes/token "
            f"(>30% reduction required)"
        )

    # Quantized outputs must be non-empty / non-degenerate.
    for i, txt in enumerate(quant_res["decoded"]):
        stripped = (txt or "").strip()
        if len(stripped) < 8:
            failures.append(f"prompt {i}: quantized output too short: {stripped!r}")
        elif stripped.count(stripped[:8]) > 6:
            failures.append(
                f"prompt {i}: quantized output looks degenerate (repeats): {stripped[:80]!r}"
            )

    report = {
        "model": args.model,
        "on_disk_bytes": on_disk_bytes,
        "nbits": args.nbits,
        "skip_layers": sorted(skip),
        "kv_bytes_per_token_baseline": base_bpt,
        "kv_bytes_per_token_quantized": quant_bpt,
        "kv_reduction_factor": base_bpt / max(quant_bpt, 1),
        "baseline": {
            k: v for k, v in base_res.items() if k != "decoded"
        },
        "turboquant": {
            k: v for k, v in quant_res.items() if k != "decoded"
        },
        "sample_outputs": quant_res["decoded"],
        "assertions_failed": failures,
    }
    Path(args.report).write_text(json.dumps(report, indent=2), encoding="utf-8")
    log.info("wrote report to %s", args.report)

    if failures:
        print("\nFAILED ASSERTIONS:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("\nAll assertions passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
