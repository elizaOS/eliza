"""End-to-end PolarQuant validation on a Qwen text-only causal LM.

What this asserts (per the AGENTS.md mandate that we don't LARP results):

1. The script downloads/loads the ``--model`` (default ``Qwen/Qwen3-0.6B``;
   see "Qwen3.5 caveat" in ``scripts/quantization/README.md`` for why we
   do **not** default to ``Qwen/Qwen3.5-0.8B`` — that checkpoint is a
   hybrid linear-attention VL model exported as
   ``Qwen3_5ForConditionalGeneration``, not a vanilla
   ``ForCausalLM``, and the vendored PolarQuant kernel only operates on
   ``nn.Linear`` weights), quantizes it via
   ``polarquant_apply.quantize_checkpoint``, and serializes the result.
2. On-disk size of the PolarQuant model is meaningfully smaller than the
   baseline (``> 30%`` reduction). Note: because we currently write back
   the *reconstructed fp16 weights* (so the model loads with vanilla HF
   ``from_pretrained`` and runs on the standard linear kernels), the
   primary win is the sidecar ``polarquant_artifacts.safetensors`` that
   stores the int8 codes + fp16 norms — that's the artifact a downstream
   INT4 inference kernel (torchao, llama.cpp, MLX) consumes. We measure
   *both* on-disk sizes (model dir alone, and codes-only) and report
   them. The assertion fires on the codes-only size to match how the
   paper reports its 2.75x VRAM reduction.
3. Generation still produces non-degenerate tokens (the quantized model
   responds to TOON-style prompts with text that contains at least one
   alphabetic word, and isn't just the EOS token or repeated punctuation).
4. We record peak inference VRAM and tokens/sec for both baseline and
   quantized.

This script will only run if a CUDA GPU is present. Falls back to CPU
with a loud warning otherwise (timing numbers are then meaningless but
the correctness assertions still fire).
"""

from __future__ import annotations

import argparse
import gc
import json
import logging
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import torch

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from polarquant_apply import (  # type: ignore  # noqa: E402
    PolarQuantRecipe,
    quantize_checkpoint,
)

logger = logging.getLogger("test_polarquant")

REPO_ROOT = _HERE.parent.parent
DEFAULT_VAL = REPO_ROOT / "data" / "final" / "val.jsonl"
DEFAULT_MODEL = "Qwen/Qwen3-0.6B"
DEFAULT_WORK = REPO_ROOT / "scripts" / "quantization" / ".test_polarquant_work"


# ---------------------------------------------------------------------------
# Sample selection
# ---------------------------------------------------------------------------


def _looks_like_toon(record: dict) -> bool:
    """A record we treat as a 'TOON message_handler-ish' sample.

    We don't have the literal task type ``message_handler`` in the on-disk
    val split, so we accept any record whose ``expectedResponse`` contains
    the canonical TOON keys ``thought:`` and either ``text:`` or
    ``actions:`` — that's the message_handler shape per
    ``scripts/format_for_training.py``'s ``REPLY_SYSTEM`` template.
    """

    expected = str(record.get("expectedResponse") or "")
    if "thought:" not in expected:
        return False
    return ("text:" in expected) or ("actions:" in expected)


def _load_toon_samples(path: Path, n: int) -> list[dict]:
    out: list[dict] = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if _looks_like_toon(rec):
                out.append(rec)
                if len(out) >= n:
                    break
    return out


def _build_messages(record: dict) -> list[dict]:
    """Reuse the training-time chat builder so we test on the real prompt
    surface, not a synthetic one."""

    # Local import so this script doesn't need format_for_training in the
    # path during unit-style tests.
    sys.path.insert(0, str(REPO_ROOT / "scripts"))
    from format_for_training import format_record  # type: ignore

    formatted = format_record(record)
    if not formatted:
        return []
    # Drop the assistant turn — we want the model to *generate* it.
    msgs = list(formatted["messages"])
    if msgs and msgs[-1].get("role") == "assistant":
        msgs = msgs[:-1]
    return msgs


# ---------------------------------------------------------------------------
# Measurement helpers
# ---------------------------------------------------------------------------


def _dir_size_bytes(path: Path, *, exclude: Optional[set[str]] = None) -> int:
    total = 0
    exclude = exclude or set()
    for p in path.rglob("*"):
        if not p.is_file():
            continue
        if p.name in exclude:
            continue
        total += p.stat().st_size
    return total


def _safetensors_size_bytes(path: Path) -> int:
    return path.stat().st_size if path.exists() else 0


@dataclass
class GenStats:
    label: str
    peak_vram_mb: float
    tokens_per_second: float
    total_new_tokens: int
    wall_seconds: float
    sample_outputs: list[str]


def _run_generation(
    model_path: Path,
    tokenizer_path: Path,
    samples: list[dict],
    *,
    label: str,
    max_new_tokens: int,
    device: str,
) -> GenStats:
    """Load a model from disk, run it on every sample, return timing stats."""

    from transformers import AutoModelForCausalLM, AutoTokenizer

    logger.info("[%s] loading model from %s", label, model_path)
    tokenizer = AutoTokenizer.from_pretrained(str(tokenizer_path), trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        str(model_path),
        torch_dtype=torch.float16,
        trust_remote_code=True,
        low_cpu_mem_usage=True,
    )
    model.to(device)
    model.eval()

    if device == "cuda":
        torch.cuda.reset_peak_memory_stats()
        torch.cuda.synchronize()

    outputs: list[str] = []
    n_new_tokens = 0
    t0 = time.perf_counter()

    for i, rec in enumerate(samples):
        msgs = _build_messages(rec)
        if not msgs:
            continue
        prompt = tokenizer.apply_chat_template(
            msgs, tokenize=False, add_generation_prompt=True,
        )
        inputs = tokenizer(prompt, return_tensors="pt", truncation=True, max_length=2048)
        inputs = {k: v.to(device) for k, v in inputs.items()}

        with torch.no_grad():
            out_ids = model.generate(
                **inputs,
                max_new_tokens=max_new_tokens,
                do_sample=False,
                pad_token_id=tokenizer.eos_token_id,
            )
        new_ids = out_ids[0, inputs["input_ids"].shape[1]:]
        n_new_tokens += int(new_ids.shape[0])
        text = tokenizer.decode(new_ids, skip_special_tokens=True)
        outputs.append(text)
        logger.info("[%s] sample %d: %d new tokens", label, i, int(new_ids.shape[0]))

    if device == "cuda":
        torch.cuda.synchronize()
    elapsed = time.perf_counter() - t0
    peak_vram = (
        torch.cuda.max_memory_allocated() / (1024 ** 2) if device == "cuda" else 0.0
    )

    del model
    gc.collect()
    if device == "cuda":
        torch.cuda.empty_cache()

    return GenStats(
        label=label,
        peak_vram_mb=peak_vram,
        tokens_per_second=(n_new_tokens / elapsed) if elapsed > 0 else 0.0,
        total_new_tokens=n_new_tokens,
        wall_seconds=elapsed,
        sample_outputs=outputs,
    )


def _is_non_degenerate(text: str) -> bool:
    """Cheap garbage-detector: at least one alphabetic word and not a
    pure-punctuation echo of the same character.

    PolarQuant's reconstruction error is supposed to be near-lossless, so
    if the quantized model emits ``!!!!!!`` or just an EOS token we want
    the test to fail loudly.
    """

    if not text:
        return False
    has_alpha_word = any(part.isalpha() and len(part) >= 3 for part in text.split())
    chars = set(text.strip())
    return has_alpha_word and len(chars) > 3


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def _build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Validate PolarQuant on Qwen3.5-0.8B")
    p.add_argument("--model", default=DEFAULT_MODEL)
    p.add_argument("--val", type=Path, default=DEFAULT_VAL)
    p.add_argument("--samples", type=int, default=5)
    p.add_argument("--calibration-samples", type=int, default=32)
    p.add_argument("--max-new-tokens", type=int, default=128)
    p.add_argument("--bits", type=int, default=4)
    p.add_argument("--block-size", type=int, default=128)
    p.add_argument(
        "--workdir",
        type=Path,
        default=DEFAULT_WORK,
        help="Where to stage the baseline + quantized checkpoint copies.",
    )
    p.add_argument(
        "--min-size-reduction",
        type=float,
        default=0.30,
        help="Required fractional reduction in codes-only size to PASS.",
    )
    p.add_argument(
        "--keep-workdir",
        action="store_true",
        help="Leave the staged checkpoints on disk after the run.",
    )
    return p


def main(argv: Optional[list[str]] = None) -> int:
    args = _build_arg_parser().parse_args(argv)

    logging.basicConfig(
        level=logging.INFO,
        format="[%(asctime)s] %(name)s %(levelname)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    if not torch.cuda.is_available():
        logger.warning(
            "CUDA not available; running on CPU. Timing numbers will be "
            "meaningless but correctness assertions still apply."
        )
        device = "cpu"
    else:
        device = "cuda"
        logger.info(
            "GPU: %s, %.0f MiB total",
            torch.cuda.get_device_name(0),
            torch.cuda.get_device_properties(0).total_memory / (1024 ** 2),
        )

    workdir: Path = args.workdir
    baseline_dir = workdir / "baseline"
    quant_dir = workdir / "polarquant"
    workdir.mkdir(parents=True, exist_ok=True)

    # ---- 1. Snapshot baseline by saving the source model to disk ------
    if not (baseline_dir / "config.json").exists():
        logger.info("Snapshotting baseline %s -> %s", args.model, baseline_dir)
        from transformers import AutoModelForCausalLM, AutoTokenizer

        m = AutoModelForCausalLM.from_pretrained(
            args.model, torch_dtype=torch.float16, trust_remote_code=True,
        )
        m.save_pretrained(str(baseline_dir), safe_serialization=True)
        AutoTokenizer.from_pretrained(args.model, trust_remote_code=True).save_pretrained(
            str(baseline_dir),
        )
        del m
        gc.collect()
        if device == "cuda":
            torch.cuda.empty_cache()

    # ---- 2. PolarQuant'd copy ------------------------------------------
    if not (quant_dir / "config.json").exists():
        logger.info("Quantizing %s -> %s", baseline_dir, quant_dir)
        recipe = PolarQuantRecipe(
            bits=args.bits, block_size=args.block_size, use_qjl=True,
        )
        quantize_checkpoint(
            model_id_or_path=str(baseline_dir),
            output_dir=quant_dir,
            recipe=recipe,
            device=device,
            save_artifacts=True,
        )
    else:
        logger.info("Reusing existing quantized checkpoint at %s", quant_dir)

    # ---- 3. Sample selection -------------------------------------------
    if not args.val.exists():
        raise FileNotFoundError(f"--val not found: {args.val}")
    samples = _load_toon_samples(args.val, args.samples)
    if len(samples) < args.samples:
        raise RuntimeError(
            f"Could not find {args.samples} TOON-shaped samples in {args.val}; "
            f"found {len(samples)}.",
        )
    logger.info("Loaded %d TOON samples for inference comparison", len(samples))

    # ---- 4. Sizes -------------------------------------------------------
    baseline_size = _dir_size_bytes(baseline_dir)
    quant_model_size = _dir_size_bytes(
        quant_dir, exclude={"polarquant_artifacts.safetensors"},
    )
    sidecar_size = _safetensors_size_bytes(
        quant_dir / "polarquant_artifacts.safetensors",
    )
    # The codes-only "compressed model" the paper measures: sidecar +
    # everything in the quantized dir EXCEPT the reconstructed
    # safetensors weights (config.json, tokenizer files, generation_config,
    # polarquant_config.json — all small but real).
    quant_meta_size = sum(
        p.stat().st_size for p in quant_dir.iterdir()
        if p.is_file() and not p.name.endswith(".safetensors")
    )
    codes_only_size = sidecar_size + quant_meta_size

    logger.info(
        "Sizes: baseline=%.1fMB, quant_model=%.1fMB, sidecar=%.1fMB, "
        "codes_only=%.1fMB",
        baseline_size / 1e6, quant_model_size / 1e6,
        sidecar_size / 1e6, codes_only_size / 1e6,
    )

    # ---- 5. Inference baseline + quantized -----------------------------
    baseline_stats = _run_generation(
        baseline_dir, baseline_dir, samples,
        label="baseline_fp16",
        max_new_tokens=args.max_new_tokens,
        device=device,
    )
    quant_stats = _run_generation(
        quant_dir, quant_dir, samples,
        label="polarquant_q{}".format(args.bits),
        max_new_tokens=args.max_new_tokens,
        device=device,
    )

    # ---- 6. Assertions -------------------------------------------------
    failures: list[str] = []

    # Size win — measured on codes-only payload (the actual paper claim).
    size_reduction = (
        1.0 - (codes_only_size / baseline_size) if baseline_size else 0.0
    )
    if size_reduction < args.min_size_reduction:
        failures.append(
            f"size reduction {size_reduction:.1%} below threshold "
            f"{args.min_size_reduction:.0%}",
        )

    # Output sanity — every quantized output has to be non-degenerate.
    for i, text in enumerate(quant_stats.sample_outputs):
        if not _is_non_degenerate(text):
            failures.append(f"sample {i} produced degenerate output: {text!r}")

    summary = {
        "model": args.model,
        "bits": args.bits,
        "block_size": args.block_size,
        "device": device,
        "n_samples": len(samples),
        "sizes_mb": {
            "baseline_dir": round(baseline_size / 1e6, 2),
            "quantized_dir_recon_only": round(quant_model_size / 1e6, 2),
            "polarquant_sidecar": round(sidecar_size / 1e6, 2),
            "codes_only_payload": round(codes_only_size / 1e6, 2),
        },
        "size_reduction_codes_only_pct": round(size_reduction * 100, 2),
        "inference": {
            "baseline_fp16": {
                "peak_vram_mb": round(baseline_stats.peak_vram_mb, 1),
                "tok_per_sec": round(baseline_stats.tokens_per_second, 2),
                "total_new_tokens": baseline_stats.total_new_tokens,
                "wall_seconds": round(baseline_stats.wall_seconds, 2),
            },
            f"polarquant_q{args.bits}": {
                "peak_vram_mb": round(quant_stats.peak_vram_mb, 1),
                "tok_per_sec": round(quant_stats.tokens_per_second, 2),
                "total_new_tokens": quant_stats.total_new_tokens,
                "wall_seconds": round(quant_stats.wall_seconds, 2),
            },
        },
        "sample_outputs": {
            "baseline_first": baseline_stats.sample_outputs[0][:400] if baseline_stats.sample_outputs else "",
            "polarquant_first": quant_stats.sample_outputs[0][:400] if quant_stats.sample_outputs else "",
        },
        "assertions": {
            "passed": not failures,
            "failures": failures,
        },
    }

    print(json.dumps(summary, indent=2))

    if not args.keep_workdir:
        # Leave directories so a re-run can reuse the snapshots; the user
        # explicitly opts in via --keep-workdir for the verbose case.
        pass

    if failures:
        logger.error("PolarQuant validation FAILED: %s", "; ".join(failures))
        return 1
    logger.info("PolarQuant validation PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
