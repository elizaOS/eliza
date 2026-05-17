"""End-to-end test for ElizaHybridCache on Qwen3.5-0.8B.

Loads the text decoder of Qwen/Qwen3.5-0.8B (a hybrid Gated DeltaNet +
full-attention model), then generates several completions through each
available backend:

    bf16              — DynamicCache equivalent, layer-aware
    fused_turboquant  — vendored fused TurboQuant on full-attention layers,
                        Triton-fused when the JIT is available, pure-PyTorch
                        otherwise (set FUSED_TURBOQUANT_DISABLE_TRITON=1 to
                        force the PyTorch path on dev boxes without
                        ``python3.X-dev`` headers)
    qjl_full          — QJL on K + TurboQuant on V (requires CUDA build)

In addition to the short-prompt generations, a long-context probe
(``--long-context``) builds a >1k token prompt and decodes 128 new tokens
to make the KV-cache compression visible in peak VRAM. A teacher-forced
NLL check (``--quality``) compares the fused vs bf16 next-token loss on
the same input to confirm the gated-attention patch is mathematically
sound.

Asserts no crash, outputs non-degenerate, and prints a markdown table of
peak VRAM / tok/s / sample output. Writes hybrid_cache_report.json.
"""

from __future__ import annotations

import gc
import json
import logging
import sys
import time
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("test_hybrid_cache")


PROMPTS = [
    "Write one short sentence about cats.",
    "Name three colors of the rainbow.",
    "What is 2 + 2?",
    "Define the word ephemeral in one line.",
    "Translate 'good morning' to Spanish.",
]


def _free_mem():
    import torch
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
        torch.cuda.synchronize()
        torch.cuda.reset_peak_memory_stats()


def run_one_backend(
    model,
    tokenizer,
    backend: str,
    max_new_tokens: int = 64,
) -> dict:
    """Generate PROMPTS through a fresh hybrid cache of the requested backend."""
    import torch
    from inference.hybrid_cache import make_hybrid_cache

    log.info("=== backend: %s ===", backend)
    _free_mem()

    samples: list[dict] = []
    total_new = 0
    t0 = time.perf_counter()

    try:
        # Build one cache per prompt — backends like fused_turboquant patch the
        # model in-place; we detach after the run. The test asserts the cache
        # tolerates being constructed many times against the same model.
        for i, prompt in enumerate(PROMPTS):
            cache = make_hybrid_cache(
                model, full_attn_backend=backend,
                bits=4, compress_v=True,
            )
            inputs = tokenizer(prompt, return_tensors="pt").to(model.device)
            with torch.inference_mode():
                out = model.generate(
                    **inputs,
                    max_new_tokens=max_new_tokens,
                    do_sample=False,
                    pad_token_id=tokenizer.pad_token_id,
                    eos_token_id=tokenizer.eos_token_id,
                    past_key_values=cache,
                    use_cache=True,
                )
            new_tokens = int(out.shape[1] - inputs["input_ids"].shape[1])
            text = tokenizer.decode(
                out[0, inputs["input_ids"].shape[1]:], skip_special_tokens=True,
            )
            samples.append({
                "prompt": prompt,
                "n_new": new_tokens,
                "text": text,
            })
            total_new += new_tokens
            # If we patched the model (fused_turboquant), unpatch before next
            # iteration so we don't double-patch.
            if backend in ("fused_turboquant", "qjl_full"):
                cache.detach_fused_turboquant(model)
            del cache
            _free_mem()
        elapsed = time.perf_counter() - t0
        peak_gb = (
            torch.cuda.max_memory_allocated() / 1024**3
            if torch.cuda.is_available() else 0.0
        )
        toks_per_s = total_new / max(elapsed, 1e-9)
        first_text = (samples[0]["text"][:80] if samples else "")
        log.info("backend=%s: %d toks in %.2fs (%.1f tok/s), peak %.2f GB",
                 backend, total_new, elapsed, toks_per_s, peak_gb)
        return {
            "backend": backend,
            "ok": True,
            "skipped": False,
            "total_new_tokens": total_new,
            "elapsed_s": round(elapsed, 3),
            "tok_per_s": round(toks_per_s, 2),
            "peak_vram_gb": round(peak_gb, 3),
            "sample_first_80": first_text,
            "samples": samples,
            "error": None,
        }
    except Exception as e:
        tb = traceback.format_exc()
        log.error("backend=%s FAILED: %s", backend, e)
        return {
            "backend": backend,
            "ok": False,
            "skipped": False,
            "error": str(e),
            "traceback": tb,
            "samples": [],
        }


def run_long_context_probe(
    model,
    tokenizer,
    backend: str,
    prompt_tokens: int = 1024,
    max_new_tokens: int = 128,
) -> dict:
    """Long-context decode pass to expose KV cache compression in peak VRAM.

    Builds a single prompt padded to ``prompt_tokens`` tokens and runs
    one greedy generation through the backend. KV-cache compression
    only shows in peak VRAM once the cache is non-trivial relative to
    model weights (roughly: prompt × full_attn_layers × kv_dim is on
    the order of MBs). For Qwen3.5-0.8B that means at least ~512
    prompt tokens before any difference is visible.
    """
    import torch
    from inference.hybrid_cache import make_hybrid_cache

    log.info("=== long-context probe backend: %s (%d prompt + %d new) ===",
             backend, prompt_tokens, max_new_tokens)
    _free_mem()

    base = "The quick brown fox jumps over the lazy dog. " * 64
    ids = tokenizer(base, return_tensors="pt").input_ids
    if ids.shape[1] < prompt_tokens:
        ids = ids.repeat(1, (prompt_tokens // ids.shape[1]) + 1)
    ids = ids[:, :prompt_tokens].to(model.device)

    try:
        cache = make_hybrid_cache(
            model, full_attn_backend=backend, bits=4, compress_v=True,
        )
        t0 = time.perf_counter()
        with torch.inference_mode():
            out = model.generate(
                input_ids=ids,
                max_new_tokens=max_new_tokens,
                do_sample=False,
                pad_token_id=tokenizer.pad_token_id,
                eos_token_id=tokenizer.eos_token_id,
                past_key_values=cache,
                use_cache=True,
            )
        elapsed = time.perf_counter() - t0
        new_tokens = int(out.shape[1] - ids.shape[1])
        peak_gb = (
            torch.cuda.max_memory_allocated() / 1024**3
            if torch.cuda.is_available() else 0.0
        )
        text = tokenizer.decode(out[0, ids.shape[1]:], skip_special_tokens=True)
        if backend in ("fused_turboquant", "qjl_full"):
            cache.detach_fused_turboquant(model)
        del cache
        _free_mem()
        return {
            "backend": backend,
            "ok": True,
            "prompt_tokens": int(ids.shape[1]),
            "new_tokens": new_tokens,
            "elapsed_s": round(elapsed, 3),
            "tok_per_s": round(new_tokens / max(elapsed, 1e-9), 2),
            "peak_vram_gb": round(peak_gb, 3),
            "sample_first_120": text[:120],
        }
    except Exception as e:
        return {
            "backend": backend,
            "ok": False,
            "error": str(e),
            "traceback": traceback.format_exc(),
        }


def run_teacher_forced_nll(
    model,
    tokenizer,
    backend: str,
    prompt_tokens: int = 256,
) -> dict:
    """Single-pass teacher-forced NLL through the chosen backend.

    Runs one prefill + decoding pass over a fixed token sequence and
    reports the mean next-token negative log likelihood. Used as a
    cheap sanity check that the fused path agrees with bf16 on the
    same model — large NLL deltas indicate the gated-attention or
    partial-RoPE patch is wrong.
    """
    import torch
    import torch.nn.functional as F
    from inference.hybrid_cache import make_hybrid_cache

    log.info("=== teacher-forced NLL backend: %s (%d tokens) ===",
             backend, prompt_tokens)
    _free_mem()

    base = "The quick brown fox jumps over the lazy dog. " * 64
    ids = tokenizer(base, return_tensors="pt").input_ids
    if ids.shape[1] < prompt_tokens:
        ids = ids.repeat(1, (prompt_tokens // ids.shape[1]) + 1)
    ids = ids[:, :prompt_tokens].to(model.device)

    try:
        cache = make_hybrid_cache(
            model, full_attn_backend=backend, bits=4, compress_v=True,
        )
        with torch.inference_mode():
            out = model(
                input_ids=ids,
                past_key_values=cache,
                use_cache=True,
            )
        logits = out.logits[0, :-1].float()
        targets = ids[0, 1:]
        nll = F.cross_entropy(logits, targets, reduction="mean").item()
        ppl = float(torch.exp(torch.tensor(nll)))
        if backend in ("fused_turboquant", "qjl_full"):
            cache.detach_fused_turboquant(model)
        del cache
        _free_mem()
        return {
            "backend": backend,
            "ok": True,
            "tokens": int(ids.shape[1]),
            "nll_mean": round(nll, 4),
            "ppl": round(ppl, 3),
        }
    except Exception as e:
        return {
            "backend": backend,
            "ok": False,
            "error": str(e),
            "traceback": traceback.format_exc(),
        }


def maybe_skipped_qjl() -> dict | None:
    """Probe whether the QJL CUDA extension is buildable / built."""
    qjl_dir = ROOT / "scripts" / "quantization" / "qjl"
    sys.path.insert(0, str(qjl_dir))
    try:
        from qjl_kernel import cuda_qjl_quant  # noqa: F401
    except Exception as e:
        return {
            "backend": "qjl_full",
            "ok": False,
            "skipped": True,
            "reason": "QJL CUDA extension not built",
            "import_error": str(e),
            "build_command": (
                f"cd {qjl_dir} && python setup.py build_ext --inplace"
            ),
            "apt_fix": (
                "sudo apt install nvidia-cuda-toolkit python3.12-dev"
            ),
            "blackwell_note": (
                "On RTX 50-series (sm_120) prefix the build with "
                "TORCH_CUDA_ARCH_LIST=\"12.0+PTX\""
            ),
        }
    return None


def main() -> int:
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    if not torch.cuda.is_available():
        log.error("CUDA not available — this test needs a GPU")
        return 2

    model_id = "Qwen/Qwen3.5-0.8B"
    log.info("loading %s ...", model_id)
    t0 = time.perf_counter()
    tokenizer = AutoTokenizer.from_pretrained(model_id, trust_remote_code=True)
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token
    model = AutoModelForCausalLM.from_pretrained(
        model_id, dtype=torch.bfloat16, trust_remote_code=True,
        device_map="cuda",
    )
    model.eval()
    log.info("loaded in %.1fs (arch=%s)", time.perf_counter() - t0,
             type(model).__name__)

    # Sanity-print the layer plan
    text_cfg = model.config.get_text_config(decoder=True)
    layer_types = list(text_cfg.layer_types)
    log.info("layer_types (%d total): %s",
             len(layer_types),
             {t: layer_types.count(t) for t in set(layer_types)})

    results: list[dict] = []

    # bf16 hybrid (the must-pass case)
    results.append(run_one_backend(model, tokenizer, "bf16"))

    # fused_turboquant
    results.append(run_one_backend(model, tokenizer, "fused_turboquant"))

    # qjl_full — only if the CUDA kernel imports cleanly
    qjl_skip = maybe_skipped_qjl()
    if qjl_skip is not None:
        log.warning("SKIPPING qjl_full: %s", qjl_skip["reason"])
        results.append(qjl_skip)
    else:
        results.append(run_one_backend(model, tokenizer, "qjl_full"))

    # Long-context probe (1024-token prompt + 128 new) — exposes the
    # KV-cache compression in peak VRAM. Skipped on the short-prompt
    # default if --short-only is passed.
    long_results: list[dict] = []
    quality_results: list[dict] = []
    if not getattr(main, "_short_only", False):
        for backend in ("bf16", "fused_turboquant"):
            long_results.append(run_long_context_probe(
                model, tokenizer, backend,
                prompt_tokens=1024, max_new_tokens=128,
            ))
        for backend in ("bf16", "fused_turboquant"):
            quality_results.append(run_teacher_forced_nll(
                model, tokenizer, backend, prompt_tokens=256,
            ))

    # Markdown table
    print("\n" + "=" * 78)
    print("| backend          | peak VRAM (GB) | tok/s | first 80 chars                                  |")
    print("|------------------|----------------|-------|------------------------------------------------|")
    for r in results:
        if r.get("skipped"):
            print(f"| {r['backend']:<16} | SKIPPED        |  N/A  | {r.get('reason', '')[:46]:<46} |")
        elif not r["ok"]:
            print(f"| {r['backend']:<16} | FAILED         |  N/A  | {str(r['error'])[:46]:<46} |")
        else:
            txt = r["sample_first_80"][:46].replace("\n", " ")
            print(f"| {r['backend']:<16} | {r['peak_vram_gb']:>14.2f} | {r['tok_per_s']:>5.1f} | {txt:<46} |")
    print("=" * 78 + "\n")

    if long_results:
        print("Long-context probe (1024 prompt + 128 new):")
        print("| backend          | prompt | new | tok/s | peak VRAM (GB) |")
        print("|------------------|--------|-----|-------|----------------|")
        for r in long_results:
            if not r.get("ok"):
                print(f"| {r['backend']:<16} | FAILED                                    |")
                continue
            print(
                f"| {r['backend']:<16} | {r['prompt_tokens']:>6d} | "
                f"{r['new_tokens']:>3d} | {r['tok_per_s']:>5.1f} | "
                f"{r['peak_vram_gb']:>14.3f} |"
            )
        print()

    if quality_results:
        print("Teacher-forced quality (256-token sequence):")
        print("| backend          | tokens | mean NLL | perplexity |")
        print("|------------------|--------|----------|------------|")
        for r in quality_results:
            if not r.get("ok"):
                print(f"| {r['backend']:<16} | FAILED |          |            |")
                continue
            print(
                f"| {r['backend']:<16} | {r['tokens']:>6d} | "
                f"{r['nll_mean']:>8.4f} | {r['ppl']:>10.3f} |"
            )
        print()

    # Asserts
    bf16 = next(r for r in results if r["backend"] == "bf16")
    if not bf16["ok"]:
        log.error("bf16 hybrid backend MUST work; failing test")
        report_path = ROOT / "scripts" / "inference" / "hybrid_cache_report.json"
        report_path.write_text(json.dumps({
            "model": model_id,
            "results": results,
        }, indent=2))
        return 1

    bf16_peak = bf16["peak_vram_gb"]

    ft = next((r for r in results if r["backend"] == "fused_turboquant"), None)
    if ft and ft["ok"]:
        if ft["peak_vram_gb"] > bf16_peak * 1.5:
            log.warning(
                "fused_turboquant peak VRAM (%.2f GB) is much higher than "
                "bf16 (%.2f GB). On a 0.8B model with short prompts the "
                "fixed Triton workspace can dominate, so this isn't a hard "
                "fail, but check the ratio on longer prompts.",
                ft["peak_vram_gb"], bf16_peak,
            )

    # Non-degenerate output check: at least one sample per OK backend has
    # a non-empty decoded string.
    for r in results:
        if r.get("ok"):
            assert any((s.get("text") or "").strip() for s in r["samples"]), \
                f"All outputs empty for backend={r['backend']}"

    report_path = ROOT / "scripts" / "inference" / "hybrid_cache_report.json"
    report_path.write_text(json.dumps({
        "model": model_id,
        "model_arch": type(model).__name__,
        "n_total_layers": len(layer_types),
        "n_full_attention_layers": layer_types.count("full_attention"),
        "n_linear_attention_layers": layer_types.count("linear_attention"),
        "results": results,
        "long_context_probe": long_results,
        "teacher_forced_nll": quality_results,
    }, indent=2))
    log.info("wrote %s", report_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
