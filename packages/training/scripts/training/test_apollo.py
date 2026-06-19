"""APOLLO validation harness.

Loads a real Qwen model on the local GPU, runs ONE full training step with
both APOLLO and APOLLO-Mini on a real batch from `data/final/train.jsonl`,
and asserts that the APOLLO optimizer path is actually wired.

Run:
    uv run --extra train python3 scripts/training/test_apollo.py

Default model is `Qwen/Qwen3.5-0.8B`, which fits comfortably on a 16 GB
RTX 5080 Laptop in bf16 + activation checkpointing.

This is the load-bearing check that says we are actually calling APOLLO and
not LARPing. If the assertion fails, the integration is broken.
"""

from __future__ import annotations

import argparse
import gc
import json
import logging
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

import torch  # noqa: E402
from transformers import AutoModelForCausalLM, AutoTokenizer  # noqa: E402

from format_for_training import format_record  # type: ignore  # noqa: E402
from training.optimizer import (  # noqa: E402
    build_apollo_mini_optimizer,
    build_apollo_optimizer,
    optimizer_state_bytes,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("test_apollo")


def _load_batch(tokenizer, train_file: Path, n: int, max_len: int) -> dict:
    records = []
    with train_file.open() as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            fr = format_record(rec)
            if not fr:
                continue
            records.append(fr)
            if len(records) >= n:
                break
    if not records:
        raise RuntimeError(f"no usable records in {train_file}")

    texts = [
        tokenizer.apply_chat_template(
            r["messages"], tokenize=False, add_generation_prompt=False
        )
        for r in records
    ]
    enc = tokenizer(
        texts,
        return_tensors="pt",
        padding=True,
        truncation=True,
        max_length=max_len,
    )
    enc["labels"] = enc["input_ids"].clone()
    enc["labels"][enc["attention_mask"] == 0] = -100
    return {k: v.to("cuda") for k, v in enc.items()}


def _fresh_model(model_id: str) -> torch.nn.Module:
    import os
    os.environ.setdefault(
        "PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True"
    )
    gc.collect()
    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()
    m = AutoModelForCausalLM.from_pretrained(
        model_id,
        dtype=torch.bfloat16,
        trust_remote_code=True,
    ).to("cuda")
    m.config.use_cache = False
    if hasattr(m, "gradient_checkpointing_enable"):
        m.gradient_checkpointing_enable()
        # gradient checkpointing requires inputs that need grad on the embedding
        if hasattr(m, "enable_input_require_grads"):
            m.enable_input_require_grads()
    return m


def _run_one_step(
    model: torch.nn.Module,
    optimizer: torch.optim.Optimizer,
    batch: dict,
) -> tuple[float, float, int]:
    """Returns (peak_mb, step_time_s, opt_state_bytes_after_step)."""

    torch.cuda.reset_peak_memory_stats()
    torch.cuda.synchronize()
    t0 = time.perf_counter()

    out = model(**batch)
    loss = out.loss
    loss.backward()
    optimizer.step()
    optimizer.zero_grad(set_to_none=True)

    torch.cuda.synchronize()
    dt = time.perf_counter() - t0
    peak_mb = torch.cuda.max_memory_allocated() / (1024 ** 2)
    state_bytes = optimizer_state_bytes(optimizer)
    return peak_mb, dt, state_bytes


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="Qwen/Qwen3.5-0.8B")
    ap.add_argument(
        "--train-file",
        default=str(ROOT / "data" / "final" / "train.jsonl"),
    )
    ap.add_argument("--batch-size", type=int, default=1)
    ap.add_argument("--max-seq-len", type=int, default=128)
    ap.add_argument("--lr", type=float, default=1e-5)
    args = ap.parse_args()

    if not torch.cuda.is_available():
        raise SystemExit("CUDA is required to validate APOLLO memory footprint.")
    log.info("device=%s torch=%s", torch.cuda.get_device_name(0), torch.__version__)

    tokenizer = AutoTokenizer.from_pretrained(args.model, trust_remote_code=True)
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token

    train_file = Path(args.train_file)
    log.info("loading %d records from %s (max_len=%d)",
             args.batch_size, train_file, args.max_seq_len)

    results: dict[str, dict] = {}

    for label, build_fn in [
        ("apollo", lambda m: build_apollo_optimizer(
            m, lr=args.lr, weight_decay=0.0)),
        ("apollo_mini", lambda m: build_apollo_mini_optimizer(
            m, lr=args.lr, weight_decay=0.0)),
    ]:
        log.info("=== %s ===", label)
        model = _fresh_model(args.model)
        # Build batch fresh per run so input tensors live in the right pool.
        batch = _load_batch(
            tokenizer, train_file, args.batch_size, args.max_seq_len
        )
        opt = build_fn(model)
        peak_mb, dt, state_bytes = _run_one_step(model, opt, batch)
        n_trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
        results[label] = {
            "peak_mb": peak_mb,
            "step_time_s": dt,
            "opt_state_bytes": state_bytes,
            "n_trainable": n_trainable,
        }
        log.info(
            "%s: peak=%.1f MiB step=%.3fs opt_state=%.2f MiB (%.2f bytes/param)",
            label, peak_mb, dt,
            state_bytes / 1024 / 1024,
            state_bytes / max(1, n_trainable),
        )
        # Drop refs before next iteration so peak memory is meaningful.
        del opt, model, batch
        gc.collect()
        torch.cuda.empty_cache()

    print("\n========== SUMMARY ==========")
    print(f"{'optimizer':<14}{'peak_MiB':>12}{'step_s':>10}"
          f"{'opt_state_MiB':>16}{'bytes/param':>14}")
    for label, r in results.items():
        print(
            f"{label:<14}"
            f"{r['peak_mb']:>12.1f}"
            f"{r['step_time_s']:>10.3f}"
            f"{r['opt_state_bytes']/1024/1024:>16.2f}"
            f"{r['opt_state_bytes']/max(1, r['n_trainable']):>14.2f}"
        )

    apollo_state = results["apollo"]["opt_state_bytes"]
    apollo_mini_state = results["apollo_mini"]["opt_state_bytes"]
    print(f"\nAPOLLO       optimizer-state: {apollo_state / 1024 / 1024:.2f} MiB")
    print(f"APOLLO-Mini  optimizer-state: {apollo_mini_state / 1024 / 1024:.2f} MiB")

    # Load-bearing assertions. For sub-1B models the embedding + lm_head
    # dominate parameter count, so this harness checks the APOLLO projector is
    # engaged and APOLLO-Mini reduces state versus full APOLLO.
    assert apollo_state > 0, "APOLLO optimizer state was empty."
    assert apollo_mini_state < apollo_state, (
        f"APOLLO-Mini state {apollo_mini_state} not smaller than APOLLO "
        f"{apollo_state}. Rank-1 projector not engaged."
    )
    print("\nOK — APOLLO and APOLLO-Mini are wired and active.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
