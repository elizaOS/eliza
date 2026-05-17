"""End-to-end validation of fused-TurboQuant on a real Qwen model on the local 5080.

Three measurements on identical prompts, identical lengths:

  1. Baseline: bf16 model + ``DynamicCache`` (the upstream HF default).
  2. Pure-PyTorch turbokv 0.1.0: bf16 model + ``TurboQuantCache`` from the
     ``turboquant`` import (the slow path).
  3. Fused-turboquant 0.1.0 (vendored): bf16 model + ``CompressedKVCache``
     produced by
     ``quantization.fused_turboquant_vendored.hf.patch_model``. This
     rewrites every full-attention ``forward`` to route through Triton
     kernels for encode / Q@K^T / decode and includes the gated-attention
     patch for Qwen3.5/3.6.

Per path we record peak VRAM (``torch.cuda.max_memory_allocated``), tokens/sec
(wall clock), and decode the first generation as a sanity sample. The
assertions at the end verify the *whole point* of the Triton kernel:

  - fused-turboquant peak VRAM ≤ pure-PyTorch peak VRAM, and
  - fused-turboquant tokens/sec ≥ 1.5x pure-PyTorch tokens/sec.

Default model is ``Qwen/Qwen3.5-0.8B``. It is a hybrid linear
attention + Gated Attention multimodal checkpoint, so compatibility with
the fused path is a release requirement rather than an optional bonus.

Usage::

    .venv/bin/python scripts/quantization/test_fused_turboquant.py
"""

from __future__ import annotations

import argparse
import gc
import json
import logging
import sys
import time
import traceback
from pathlib import Path

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from transformers.cache_utils import DynamicCache

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("test_fused_turboquant")

ROOT = Path(__file__).resolve().parents[2]
VAL_JSONL = ROOT / "data" / "final" / "val.jsonl"

# Make the vendored fused_turboquant importable as
# ``quantization.fused_turboquant_vendored`` regardless of the caller's CWD.
sys.path.insert(0, str(ROOT / "scripts"))


def load_payload_message_handler_prompts(n: int) -> list[dict]:
    """Pull n records whose expected response looks like a native JSON message_handler doc."""
    if not VAL_JSONL.exists():
        # Fall back to a synthetic prompt if the dataset isn't checked in. The
        # test still runs; only the realism of the prompt distribution suffers.
        log.warning("%s not found, falling back to synthetic prompts", VAL_JSONL)
        return [
            {
                "currentMessage": {
                    "content": (
                        "Summarize the following operational native JSON document in "
                        "native JSON format. Keep the field order exact."
                    )
                },
                "memoryEntries": [],
                "expectedResponse": "thought: ...\ntext: ...",
            }
            for _ in range(n)
        ]
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
            if er.lstrip().startswith("thought:"):
                out.append(rec)
                if len(out) >= n:
                    break
    if len(out) < n:
        raise RuntimeError(f"Only found {len(out)} native JSON prompts in {VAL_JSONL}")
    return out[:n]


def render_chat(tokenizer, record: dict) -> str:
    sys_prompt = (
        "You are an autonomous elizaOS agent. Decide which action to take "
        "from `availableActions` and respond with ONE native JSON document. "
        "Always native JSON. No fences, no <think>, no prose before or after."
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


def pad_prompt_to_length(
    tokenizer, base_prompt: str, target_tokens: int, filler: str
) -> str:
    """Tile `filler` after `base_prompt` until the tokenized length hits
    `target_tokens` (then truncate exactly).

    The padding text is appended *before* the assistant generation marker so we
    never break the chat template's open-assistant turn. We re-render through
    the tokenizer and slice on token IDs to land precisely.
    """
    ids = tokenizer(base_prompt, return_tensors="pt").input_ids[0]
    if ids.shape[-1] >= target_tokens:
        return tokenizer.decode(ids[:target_tokens], skip_special_tokens=False)
    pad_text = (filler + "\n") * 200
    while ids.shape[-1] < target_tokens:
        base_prompt = base_prompt + "\n" + pad_text
        ids = tokenizer(base_prompt, return_tensors="pt").input_ids[0]
    truncated = ids[:target_tokens]
    return tokenizer.decode(truncated, skip_special_tokens=False)


def _free():
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
        torch.cuda.synchronize()


def measure_path(
    *,
    label: str,
    model,
    tokenizer,
    prompts: list[str],
    max_new_tokens: int,
    cache_factory,
    pre_generate=None,
    post_generate=None,
) -> dict:
    """Generate over `prompts` and return wall-clock + memory + decoded samples.

    `pre_generate` / `post_generate` run once per prompt (e.g., to patch /
    unpatch the model around each call when the kernel needs that).
    """
    _free()
    if torch.cuda.is_available():
        torch.cuda.reset_peak_memory_stats()

    decoded: list[str] = []
    total_new = 0
    t0 = time.perf_counter()
    for p in prompts:
        ids = tokenizer(p, return_tensors="pt").to(model.device)
        if pre_generate is not None:
            cache = pre_generate()
        else:
            cache = cache_factory()
        with torch.inference_mode():
            out = model.generate(
                **ids,
                past_key_values=cache,
                max_new_tokens=max_new_tokens,
                do_sample=False,
                use_cache=True,
                pad_token_id=tokenizer.eos_token_id,
            )
        new = out[0, ids.input_ids.shape[-1]:]
        total_new += int(new.shape[-1])
        decoded.append(tokenizer.decode(new, skip_special_tokens=True))
        if post_generate is not None:
            post_generate()
        else:
            del cache
        del ids, out
        if torch.cuda.is_available():
            torch.cuda.synchronize()
    elapsed = time.perf_counter() - t0
    peak = (
        int(torch.cuda.max_memory_allocated())
        if torch.cuda.is_available()
        else 0
    )
    return {
        "label": label,
        "elapsed_s": elapsed,
        "tokens_new": total_new,
        "toks_per_s": total_new / elapsed if elapsed > 0 else 0.0,
        "peak_vram_bytes": peak,
        "decoded_first": decoded[0] if decoded else "",
    }


def _try_fused(
    *,
    model,
    bits: int,
):
    """Import-and-patch wrapper that surfaces Triton/JIT failures cleanly.

    Returns ``(cache, error_str)`` — if the kernel can't compile we return
    ``(None, "error message")`` so the caller can log the blocker and skip
    the fused path without crashing the whole test.
    """
    try:
        from quantization.fused_turboquant_vendored.hf import patch_model
    except Exception as exc:
        return None, (
            "import quantization.fused_turboquant_vendored.hf failed: "
            f"{exc!r}"
        )
    try:
        cache = patch_model(model, bits=bits, compress_v=True, verify=True)
        return cache, None
    except Exception as exc:
        return None, "".join(
            traceback.format_exception_only(type(exc), exc)
        ).strip() + "\n" + traceback.format_exc(limit=3)


def run_one_model(
    *,
    model_id: str,
    num_prompts: int,
    max_new_tokens: int,
    prompt_tokens: int,
    bits: int,
) -> dict:
    log.info("=" * 78)
    log.info("MODEL: %s", model_id)
    log.info("=" * 78)
    log.info("loading tokenizer + model in bf16 on cuda")
    tok = AutoTokenizer.from_pretrained(model_id, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        model_id,
        torch_dtype=torch.bfloat16,
        device_map="cuda",
        trust_remote_code=True,
    )
    model.eval()

    # Build prompts at the requested token length.
    records = load_payload_message_handler_prompts(num_prompts)
    base_prompts = [render_chat(tok, r) for r in records]
    filler = (records[0].get("currentMessage") or {}).get(
        "content", "Continue the operational notes."
    )
    prompts = [
        pad_prompt_to_length(tok, p, target_tokens=prompt_tokens, filler=filler)
        for p in base_prompts
    ]
    real_lens = [tok(p, return_tensors="pt").input_ids.shape[-1] for p in prompts]
    log.info(
        "built %d prompts at target=%d tokens (actual range %d..%d)",
        len(prompts),
        prompt_tokens,
        min(real_lens),
        max(real_lens),
    )

    # 0. Compatibility check (always run; tells us whether the fused path
    #    even applies before we sink time into the runs).
    from quantization.fused_turboquant_vendored.hf import (
        check_model_compatibility,
    )

    compat = check_model_compatibility(model)
    log.info(
        "fused-turboquant compatibility: compatible=%s eligible=%d/%d "
        "head_dim=%d known=%s issues=%s",
        compat["compatible"],
        compat["eligible_layers"],
        compat["total_layers"],
        compat["head_dim"],
        compat["known_compatible"],
        compat["issues"],
    )

    # 1. Baseline
    log.info("--- path 1/3: baseline bf16 + DynamicCache ---")
    base_res = measure_path(
        label="baseline_bf16",
        model=model,
        tokenizer=tok,
        prompts=prompts,
        max_new_tokens=max_new_tokens,
        cache_factory=lambda: DynamicCache(),
    )
    log.info(
        "baseline: peak=%.3f GB toks/s=%.2f new=%d elapsed=%.2fs",
        base_res["peak_vram_bytes"] / 1e9,
        base_res["toks_per_s"],
        base_res["tokens_new"],
        base_res["elapsed_s"],
    )

    # 2. Pure-PyTorch turbokv (turboquant import name)
    log.info("--- path 2/3: pure-PyTorch turbokv (TurboQuantCache) ---")
    try:
        from turboquant import TurboQuantCache
    except Exception as exc:
        log.warning("turbokv import failed: %r — skipping pure-PyTorch path", exc)
        turbokv_res = {"label": "turbokv_pyt", "error": repr(exc)}
    else:
        turbokv_res = measure_path(
            label=f"turbokv_pyt_{bits}bit",
            model=model,
            tokenizer=tok,
            prompts=prompts,
            max_new_tokens=max_new_tokens,
            cache_factory=lambda: TurboQuantCache(
                model.config, nbits=bits, base_seed=42, skip_layers=set()  # noqa: F821
            ),
        )
        log.info(
            "turbokv: peak=%.3f GB toks/s=%.2f new=%d elapsed=%.2fs",
            turbokv_res["peak_vram_bytes"] / 1e9,
            turbokv_res["toks_per_s"],
            turbokv_res["tokens_new"],
            turbokv_res["elapsed_s"],
        )

    # 3. Fused-turboquant
    log.info("--- path 3/3: fused-turboquant (Triton kernels) ---")
    if not compat["compatible"]:
        fused_res = {
            "label": "fused_skipped_incompatible",
            "error": f"check_model_compatibility returned compatible=False: {compat['issues']}",
        }
        log.warning("skipping fused path: %s", fused_res["error"])
    else:
        from quantization.fused_turboquant_vendored.hf import (
            patch_model,
            unpatch_model,
        )

        # patch_model pre-flights via verify=True; failures bubble up.
        try:
            # Per-prompt patch+unpatch so the cache starts clean each call,
            # mirroring the cache_factory pattern used for the other paths.
            def factory():
                return patch_model(model, bits=bits, compress_v=True, verify=False)  # noqa: F821

            def cleanup():
                unpatch_model(model)  # noqa: F821

            # Sanity-check the patch once with verify=True before benchmarking.
            verify_cache = patch_model(model, bits=bits, compress_v=True, verify=True)
            unpatch_model(model)
            del verify_cache
            _free()

            fused_res = measure_path(
                label=f"fused_turboquant_{bits}bit",
                model=model,
                tokenizer=tok,
                prompts=prompts,
                max_new_tokens=max_new_tokens,
                cache_factory=factory,
                pre_generate=factory,
                post_generate=cleanup,
            )
            log.info(
                "fused: peak=%.3f GB toks/s=%.2f new=%d elapsed=%.2fs",
                fused_res["peak_vram_bytes"] / 1e9,
                fused_res["toks_per_s"],
                fused_res["tokens_new"],
                fused_res["elapsed_s"],
            )
        except Exception as exc:
            tb = traceback.format_exc()
            fused_res = {
                "label": f"fused_turboquant_{bits}bit",
                "error": "".join(traceback.format_exception_only(type(exc), exc)).strip(),
                "traceback_tail": "\n".join(tb.splitlines()[-12:]),
            }
            log.error("fused path failed: %s", fused_res["error"])
            log.error("tail:\n%s", fused_res["traceback_tail"])

    # Free the model before the next one.
    del model, tok
    _free()

    return {
        "model_id": model_id,
        "num_prompts": num_prompts,
        "prompt_tokens_target": prompt_tokens,
        "prompt_tokens_actual_range": [min(real_lens), max(real_lens)],
        "max_new_tokens": max_new_tokens,
        "bits": bits,
        "compatibility": compat,
        "baseline": base_res,
        "turbokv_pyt": turbokv_res,
        "fused_turboquant": fused_res,
    }


def _print_table(result: dict) -> None:
    print()
    print("=" * 78)
    print(f"fused-TurboQuant validation report: {result['model_id']}")
    print("=" * 78)
    print(
        f"prompts: {result['num_prompts']} x ~{result['prompt_tokens_target']} tokens, "
        f"{result['max_new_tokens']} new each, {result['bits']}-bit"
    )
    print()
    rows = [
        ("baseline (bf16 DynamicCache)", result["baseline"]),
        ("pure-PyTorch turbokv 0.1.0", result["turbokv_pyt"]),
        ("fused-turboquant 0.1.0", result["fused_turboquant"]),
    ]
    print(f"{'path':40s}  {'peak VRAM':>12s}  {'tokens/sec':>12s}")
    print("-" * 70)
    for name, r in rows:
        if "error" in r:
            print(f"{name:40s}  {'SKIP':>12s}  {'SKIP':>12s}  ({r['error'][:80]})")
            continue
        print(
            f"{name:40s}  {r['peak_vram_bytes']/1e9:>9.3f} GB  {r['toks_per_s']:>9.2f} tok/s"
        )
    print()
    if "error" not in result["turbokv_pyt"] and "error" not in result["fused_turboquant"]:
        speedup = (
            result["fused_turboquant"]["toks_per_s"]
            / max(result["turbokv_pyt"]["toks_per_s"], 1e-9)
        )
        print(f"fused vs turbokv-pyt speedup: {speedup:.2f}x")
    if "error" not in result["fused_turboquant"]:
        sample = result["fused_turboquant"]["decoded_first"]
        sample = sample[:240].replace("\n", " ")
        print(f"fused sample[0]: {sample!r}")
    print("=" * 78)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    ap.add_argument("--model", default="Qwen/Qwen3.5-0.8B")
    ap.add_argument(
        "--bonus-model",
        default="Qwen/Qwen3.5-0.8B",
        help="Optional bonus model. Skipped if check_model_compatibility "
        "returns compatible=False (e.g., hybrid attention).",
    )
    ap.add_argument("--num-prompts", type=int, default=5)
    ap.add_argument("--max-new-tokens", type=int, default=128)
    ap.add_argument("--prompt-tokens", type=int, default=4096)
    ap.add_argument("--bits", type=int, default=4, choices=(3, 4))
    ap.add_argument(
        "--report",
        default=str(
            ROOT / "scripts" / "quantization" / "fused_turboquant_report.json"
        ),
    )
    ap.add_argument(
        "--enforce-speedup",
        type=float,
        default=1.5,
        help="Required fused tok/s / turbokv tok/s ratio. Set 0 to disable.",
    )
    args = ap.parse_args()

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA required")

    results: list[dict] = []
    primary = run_one_model(
        model_id=args.model,
        num_prompts=args.num_prompts,
        max_new_tokens=args.max_new_tokens,
        prompt_tokens=args.prompt_tokens,
        bits=args.bits,
    )
    results.append(primary)
    _print_table(primary)

    # Bonus model: only attempt if user named one and we can probe it.
    if args.bonus_model:
        log.info("attempting bonus model %s", args.bonus_model)
        try:
            bonus_tok = AutoTokenizer.from_pretrained(
                args.bonus_model, trust_remote_code=True
            )
            bonus_model = AutoModelForCausalLM.from_pretrained(
                args.bonus_model,
                torch_dtype=torch.bfloat16,
                device_map="cuda",
                trust_remote_code=True,
            )
            from quantization.fused_turboquant_vendored.hf import (
                check_model_compatibility,
            )

            compat = check_model_compatibility(bonus_model)
            log.info(
                "bonus compatibility: compatible=%s known=%s issues=%s",
                compat["compatible"],
                compat["known_compatible"],
                compat["issues"],
            )
            del bonus_model, bonus_tok
            _free()
            if compat["compatible"]:
                bonus = run_one_model(
                    model_id=args.bonus_model,
                    num_prompts=args.num_prompts,
                    max_new_tokens=args.max_new_tokens,
                    prompt_tokens=args.prompt_tokens,
                    bits=args.bits,
                )
                results.append(bonus)
                _print_table(bonus)
            else:
                log.warning(
                    "bonus model %s skipped: not compatible (%s)",
                    args.bonus_model,
                    compat["issues"],
                )
        except Exception as exc:
            log.warning(
                "bonus model %s failed to load (%r) — skipping",
                args.bonus_model,
                exc,
            )

    Path(args.report).write_text(json.dumps(results, indent=2), encoding="utf-8")
    log.info("wrote report to %s", args.report)

    # Assertions (only on primary). Skip the speedup check entirely if the
    # fused path was unable to run — the test still records the blocker.
    failures: list[str] = []
    fused = primary["fused_turboquant"]
    turbokv = primary["turbokv_pyt"]
    if "error" in fused:
        failures.append(
            f"fused-turboquant did not run on {primary['model_id']}: {fused['error']}"
        )
    elif "error" not in turbokv:
        if fused["peak_vram_bytes"] > turbokv["peak_vram_bytes"]:
            failures.append(
                f"fused peak VRAM ({fused['peak_vram_bytes']/1e9:.3f} GB) > "
                f"turbokv peak ({turbokv['peak_vram_bytes']/1e9:.3f} GB)"
            )
        if args.enforce_speedup > 0:
            ratio = fused["toks_per_s"] / max(turbokv["toks_per_s"], 1e-9)
            if ratio < args.enforce_speedup:
                failures.append(
                    f"fused/turbokv tok/s ratio {ratio:.2f} < required "
                    f"{args.enforce_speedup}"
                )

    if failures:
        print("\nFAILED ASSERTIONS:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("\nAll assertions passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
