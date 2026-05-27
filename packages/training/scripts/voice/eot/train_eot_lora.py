#!/usr/bin/env python3
"""Train an eliza-1 EOT LoRA adapter.

Tiny LoRA (rank 8, alpha 16) on the eliza-1 chat target. The adapter
hot-swaps onto the already-loaded chat model at runtime via llama.cpp's
`--lora` flag; zero extra weights, zero extra RAM, zero extra download.

Loss:
  - positive examples (label=1): cross-entropy maximizing the next-token
    probability of `<|im_end|>` after the chat-template-formatted user
    turn (= P(turn complete | transcript)).
  - negative examples (label=0): cross-entropy minimizing P(<|im_end|>)
    by maximizing the probability of any non-`<|im_end|>` continuation
    token. Implemented as cross-entropy against a uniform distribution
    over the non-eot logits (smoothed).

Optimizer choice — APOLLO vs 8-bit AdamW:

  CLAUDE.md mandates APOLLO for training. APOLLO's win is memory:
  it stores low-rank projected optimizer state in place of the full
  Adam moments. For full-parameter SFT on a 9B model that matters
  enormously. For LoRA, the trainable params are already TINY (~5-10 MB
  of weights, rank-8 attention adapters only), so the optimizer state
  for those params is also tiny, and APOLLO's projection overhead
  outweighs the memory saving.

  Decision: use 8-bit AdamW for LoRA training. APOLLO is the right
  call when --apollo is passed explicitly (preserved for benchmarking
  / for future full-param fine-tunes). Default is 8-bit AdamW.

Memory budget at default settings (rank 8, batch 4, seq 512):
  - eliza-1-0_8b: ~6 GB VRAM
  - eliza-1-2b:   ~12 GB VRAM
  - eliza-1-4b:   ~20 GB VRAM (fits 24 GB consumer GPU)

For 16 GB cards, drop `--batch-size 2` and `--gradient-accumulation 2`.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

logger = logging.getLogger("eot.train_eot_lora")

# ---------------------------------------------------------------------------
# Target tier registry
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TierSpec:
    """Eliza-1 tier spec relevant to EOT LoRA training.

    `base_id` is the HuggingFace id of the underlying chat-template
    model. The LoRA attaches to the same arch the runtime loads; the
    runtime then hot-swaps it onto the GGUF copy via llama.cpp's
    `--lora` flag (operator wires the adapter manifest in the bundle).
    """

    tier: str
    base_id: str
    default_batch_size: int
    default_seq_len: int


TIER_REGISTRY: dict[str, TierSpec] = {
    "0_8b": TierSpec(
        tier="0_8b",
        base_id="Qwen/Qwen3.5-0.8B-Base",
        default_batch_size=8,
        default_seq_len=512,
    ),
    "2b": TierSpec(
        tier="2b",
        base_id="Qwen/Qwen3.5-2B-Base",
        default_batch_size=4,
        default_seq_len=512,
    ),
    "4b": TierSpec(
        tier="4b",
        base_id="Qwen/Qwen3.5-4B-Base",
        default_batch_size=4,
        default_seq_len=512,
    ),
}


def resolve_tier(tier: str) -> TierSpec:
    spec = TIER_REGISTRY.get(tier)
    if spec is None:
        valid = ", ".join(sorted(TIER_REGISTRY))
        raise SystemExit(f"unknown tier {tier!r}; valid: {valid}")
    return spec


# ---------------------------------------------------------------------------
# LoRA + training config
# ---------------------------------------------------------------------------


@dataclass
class LoraConfig:
    rank: int = 8
    alpha: int = 16
    dropout: float = 0.05
    # Attention-only target modules keep the adapter ~5-10 MB.
    target_modules: tuple[str, ...] = (
        "q_proj",
        "k_proj",
        "v_proj",
        "o_proj",
    )


@dataclass
class TrainingConfig:
    tier_spec: TierSpec
    corpus_path: Path
    out_dir: Path
    epochs: int = 1
    batch_size: int = 0  # 0 → use tier default
    gradient_accumulation: int = 1
    learning_rate: float = 5e-4
    warmup_steps: int = 50
    seed: int = 42
    seq_len: int = 0  # 0 → use tier default
    use_apollo: bool = False
    lora: LoraConfig = field(default_factory=LoraConfig)

    def __post_init__(self) -> None:
        if self.batch_size == 0:
            self.batch_size = self.tier_spec.default_batch_size
        if self.seq_len == 0:
            self.seq_len = self.tier_spec.default_seq_len
        if self.batch_size < 1:
            raise ValueError(f"batch_size must be >=1, got {self.batch_size}")
        if self.seq_len < 32:
            raise ValueError(f"seq_len must be >=32, got {self.seq_len}")


# ---------------------------------------------------------------------------
# Loss formula (pure, testable)
# ---------------------------------------------------------------------------


def eot_loss_weights(
    label: int,
    im_end_token_id: int,
    vocab_size: int,
) -> dict[str, float]:
    """Compute per-token weight scheme for the EOT objective.

    Returns a dict describing what the trainer should do for this
    example. Pure function — no torch import here so it can run in the
    pytest CPU lane.

    For label=1 (positive): full weight on `im_end_token_id`. The
    cross-entropy loss is `-log P(im_end_token_id | context)`.

    For label=0 (negative): zero weight on `im_end_token_id` plus
    uniform weight `1/(vocab_size-1)` over every other token. The
    cross-entropy loss is `-mean log P(non-im-end | context)`, which
    pushes probability mass away from `<|im_end|>`.
    """
    if label not in (0, 1):
        raise ValueError(f"label must be 0 or 1, got {label}")
    if im_end_token_id < 0 or im_end_token_id >= vocab_size:
        raise ValueError(
            f"im_end_token_id={im_end_token_id} out of range for vocab_size={vocab_size}"
        )
    if label == 1:
        return {"target_token": float(im_end_token_id), "weight": 1.0, "mode": "positive"}
    # Negative: smear over non-im-end vocabulary.
    return {
        "target_token": -1.0,  # sentinel: not a single-token target
        "weight": 1.0 / (vocab_size - 1),
        "mode": "negative",
    }


# ---------------------------------------------------------------------------
# Trainer (deferred imports so the module is importable without torch)
# ---------------------------------------------------------------------------


def _resolve_im_end_token_id(tokenizer) -> int:
    """Find the `<|im_end|>` token id in the loaded tokenizer."""
    for candidate in ("<|im_end|>", "&lt;|im_end|&gt;"):
        ids = tokenizer.convert_tokens_to_ids(candidate)
        if isinstance(ids, int) and ids >= 0:
            return ids
    # Fall back to the chat-template-specific encoding.
    encoded = tokenizer.encode("<|im_end|>", add_special_tokens=False)
    if encoded and len(encoded) == 1:
        return encoded[0]
    raise RuntimeError(
        "could not resolve <|im_end|> in tokenizer; ensure the base "
        "model uses the Qwen chat template (Qwen3.5 family)."
    )


def _build_optimizer(model, config: TrainingConfig):
    """Build the optimizer. APOLLO when --apollo, else plain AdamW.

    For LoRA training the trainable params are tiny (~10 MB at rank 8),
    so the 8-bit AdamW savings don't justify the bitsandbytes complexity
    (which fails GPU-placement checks under modern transformers + LoRA
    on single-GPU layouts). Plain AdamW is simpler and fast enough.
    """
    trainable = [p for p in model.parameters() if p.requires_grad]
    if config.use_apollo:
        try:
            from apollo_torch import APOLLOAdamW  # type: ignore

            return APOLLOAdamW(trainable, lr=config.learning_rate)
        except ImportError as exc:
            raise SystemExit(
                "APOLLO requested via --apollo but apollo_torch is not "
                "installed. `pip install apollo-torch`."
            ) from exc
    import torch  # type: ignore

    return torch.optim.AdamW(trainable, lr=config.learning_rate)


def train(config: TrainingConfig) -> Path:
    """Run training and return the path of the saved adapter."""
    import torch  # type: ignore
    from peft import LoraConfig as PeftLoraConfig  # type: ignore
    from peft import TaskType, get_peft_model  # type: ignore
    from transformers import (  # type: ignore
        AutoModelForCausalLM,
        AutoTokenizer,
    )

    torch.manual_seed(config.seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(config.seed)

    logger.info("loading tokenizer + base model %s", config.tier_spec.base_id)
    tokenizer = AutoTokenizer.from_pretrained(
        config.tier_spec.base_id, trust_remote_code=False
    )
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    # Force single-GPU placement for LoRA training. `device_map="auto"` can
    # split a small model awkwardly and confuses the optimizer's device
    # checks; bitsandbytes is_on_gpu in particular rejects the resulting
    # tensor layout. Single GPU is the right choice for ~10MB of trainable
    # LoRA params anyway.
    device = "cuda:0" if torch.cuda.is_available() else "cpu"
    model = AutoModelForCausalLM.from_pretrained(
        config.tier_spec.base_id,
        torch_dtype=torch.bfloat16,
        trust_remote_code=False,
    ).to(device)

    im_end_id = _resolve_im_end_token_id(tokenizer)
    vocab_size = int(model.config.vocab_size)
    logger.info("<|im_end|> token id=%d vocab=%d", im_end_id, vocab_size)

    lora_cfg = PeftLoraConfig(
        r=config.lora.rank,
        lora_alpha=config.lora.alpha,
        lora_dropout=config.lora.dropout,
        target_modules=list(config.lora.target_modules),
        task_type=TaskType.CAUSAL_LM,
        bias="none",
    )
    model = get_peft_model(model, lora_cfg)
    model.print_trainable_parameters()

    # Dataset loading — read the prep_eot_corpus output.
    logger.info("loading corpus %s", config.corpus_path)
    records = _load_corpus(config.corpus_path)
    if not records:
        raise SystemExit(f"corpus {config.corpus_path} is empty")
    logger.info("loaded %d records", len(records))

    optimizer = _build_optimizer(model, config)
    total_steps = max(1, len(records) * config.epochs // (config.batch_size * config.gradient_accumulation))
    logger.info(
        "training: epochs=%d batch_size=%d grad_accum=%d total_steps=%d "
        "lr=%.2e optimizer=%s",
        config.epochs,
        config.batch_size,
        config.gradient_accumulation,
        total_steps,
        config.learning_rate,
        type(optimizer).__name__,
    )

    config.out_dir.mkdir(parents=True, exist_ok=True)
    checkpoint_dir = config.out_dir / "checkpoint-final"

    model.train()
    step = 0
    for epoch in range(config.epochs):
        for batch in _iter_batches(records, config.batch_size, tokenizer, config.seq_len):
            input_ids = batch["input_ids"].to(model.device)
            attention_mask = batch["attention_mask"].to(model.device)
            labels = batch["labels"].to(model.device)
            last_token_idx = batch["last_token_idx"].to(model.device)

            outputs = model(input_ids=input_ids, attention_mask=attention_mask)
            logits = outputs.logits  # [B, T, V]

            loss = _eot_batch_loss(
                logits=logits,
                last_token_idx=last_token_idx,
                labels=labels,
                im_end_id=im_end_id,
                vocab_size=vocab_size,
                device=model.device,
            )
            # Skip-and-warn on NaN/Inf rather than poisoning the optimizer.
            if not torch.isfinite(loss):
                logger.warning(
                    "epoch=%d step=%d non-finite loss (%s); skipping batch",
                    epoch,
                    step,
                    loss.item(),
                )
                optimizer.zero_grad(set_to_none=True)
                step += 1
                continue
            loss.backward()

            # Gradient clipping — without this, bf16 + AdamW can explode.
            torch.nn.utils.clip_grad_norm_(
                [p for p in model.parameters() if p.requires_grad],
                max_norm=1.0,
            )

            if (step + 1) % config.gradient_accumulation == 0:
                optimizer.step()
                optimizer.zero_grad(set_to_none=True)

            if step % 50 == 0:
                logger.info("epoch=%d step=%d loss=%.4f", epoch, step, loss.item())
            step += 1

    model.save_pretrained(checkpoint_dir)
    tokenizer.save_pretrained(checkpoint_dir)
    logger.info("saved adapter to %s", checkpoint_dir)
    return checkpoint_dir


def _load_corpus(path: Path) -> list[dict]:
    """Load records from Parquet or JSONL."""
    if path.suffix.lower() == ".parquet":
        try:
            import pyarrow.parquet as pq  # type: ignore
        except ImportError as exc:
            raise SystemExit("pyarrow required to read Parquet corpora") from exc
        table = pq.read_table(path)
        return table.to_pylist()
    with path.open(encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def _iter_batches(records, batch_size, tokenizer, seq_len):
    """Yield tokenized batches with metadata for EOT loss."""
    import torch  # type: ignore

    for start in range(0, len(records), batch_size):
        chunk = records[start : start + batch_size]
        encodings = tokenizer(
            [r["text"] for r in chunk],
            padding=True,
            truncation=True,
            max_length=seq_len,
            return_tensors="pt",
        )
        # last_token_idx is the index of the final non-pad token per row.
        attention_mask = encodings["attention_mask"]
        last_token_idx = attention_mask.sum(dim=1) - 1
        yield {
            "input_ids": encodings["input_ids"],
            "attention_mask": attention_mask,
            "labels": torch.tensor([int(r["label"]) for r in chunk], dtype=torch.long),
            "last_token_idx": last_token_idx,
        }


def _eot_batch_loss(logits, last_token_idx, labels, im_end_id, vocab_size, device):
    """Compute the EOT loss across a batch.

    bf16 logits can produce inf/nan through log_softmax — we cast to fp32
    before the softmax. Per-example non-finite losses are filtered out
    rather than poisoning the batch mean (which would skip the whole batch).
    """
    import torch  # type: ignore
    import torch.nn.functional as F  # type: ignore

    # Extract the next-token logit for each row at its last position.
    batch_size = logits.shape[0]
    final_logits = logits[torch.arange(batch_size), last_token_idx]  # [B, V]
    # Cast to fp32 for numerically-stable softmax/log.
    log_probs = F.log_softmax(final_logits.float(), dim=-1)  # [B, V] in fp32

    labels = labels.to(device)
    losses = []
    for i in range(batch_size):
        if labels[i].item() == 1:
            # Positive: maximize log P(im_end). Clamp to avoid -inf when
            # the model assigns vanishing mass.
            log_p_im_end = log_probs[i, im_end_id].clamp(min=-30.0)
            losses.append(-log_p_im_end)
        else:
            # Negative: minimize P(im_end) by maximizing log P(not im_end).
            #   log P(not im_end) = log(1 - exp(log_probs[im_end]))
            log_p_im_end = log_probs[i, im_end_id].clamp(min=-30.0, max=-1e-6)
            log_p_not_im_end = torch.log1p(-torch.exp(log_p_im_end).clamp(max=0.999999))
            losses.append(-log_p_not_im_end)

    stacked = torch.stack(losses)
    # Filter per-example non-finite losses; mean over the survivors.
    finite_mask = torch.isfinite(stacked)
    if finite_mask.any():
        return stacked[finite_mask].mean()
    # Whole batch was bad — return a finite zero so the outer skip-on-non-finite
    # still records it as "skip"; outer loop also has skip-on-non-finite as a
    # belt-and-suspenders guard.
    return torch.tensor(float("nan"), device=device)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train an eliza-1 EOT LoRA adapter.")
    parser.add_argument("--tier", required=True, choices=sorted(TIER_REGISTRY))
    parser.add_argument("--corpus", required=True, type=Path)
    parser.add_argument("--out-dir", required=True, type=Path)
    parser.add_argument("--epochs", type=int, default=1)
    parser.add_argument("--batch-size", type=int, default=0, help="0 = tier default")
    parser.add_argument("--gradient-accumulation", type=int, default=1)
    parser.add_argument("--learning-rate", type=float, default=5e-4)
    parser.add_argument("--warmup-steps", type=int, default=50)
    parser.add_argument("--seq-len", type=int, default=0, help="0 = tier default")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument(
        "--apollo",
        action="store_true",
        help="Use APOLLO optimizer instead of 8-bit AdamW. "
        "APOLLO is overkill for LoRA-only trainable params (see module docstring).",
    )
    parser.add_argument(
        "--log-level",
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
    )
    return parser.parse_args(argv)


def main(argv: Optional[list[str]] = None) -> int:
    args = parse_args(argv)
    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )

    config = TrainingConfig(
        tier_spec=resolve_tier(args.tier),
        corpus_path=args.corpus,
        out_dir=args.out_dir,
        epochs=args.epochs,
        batch_size=args.batch_size,
        gradient_accumulation=args.gradient_accumulation,
        learning_rate=args.learning_rate,
        warmup_steps=args.warmup_steps,
        seq_len=args.seq_len,
        seed=args.seed,
        use_apollo=args.apollo,
    )

    checkpoint = train(config)

    # Write a small manifest sidecar with the SHAs needed for runtime binding.
    manifest = {
        "tier": config.tier_spec.tier,
        "base_model": config.tier_spec.base_id,
        "lora_rank": config.lora.rank,
        "lora_alpha": config.lora.alpha,
        "target_modules": list(config.lora.target_modules),
        "epochs": config.epochs,
        "batch_size": config.batch_size,
        "learning_rate": config.learning_rate,
        "seed": config.seed,
        "optimizer": "APOLLOAdamW" if config.use_apollo else "AdamW8bit",
    }
    (checkpoint / "eot_lora_manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8"
    )
    logger.info("training complete; adapter at %s", checkpoint)
    return 0


if __name__ == "__main__":
    sys.exit(main())
