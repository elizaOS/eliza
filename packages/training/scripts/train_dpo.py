"""Stage-1 DPO warmup on a finished SFT checkpoint.

Uses TRL's `DPOTrainer` against synthesized preference pairs from
`data/synthesized/action_pairs/`. The synthesized files ship as flat eliza
records (one per row) — we treat the `expectedResponse` as `chosen` and
generate a corrupted `rejected` per record (perturbed action / broken TOON)
so DPO has signal without needing a separate teacher pass.

Mirrors `train_local.py`'s style: APOLLO + Liger + FA-2/3 selection,
`instrumentation.jsonl` written in the same schema so the dashboard plot is
uniform across SFT and DPO.

Usage:
    # Smoke
    uv run --extra train python scripts/train_dpo.py \
        --registry-key qwen3.5-2b \
        --sft-checkpoint checkpoints/qwen3-06b-eliza-toon-v3/final \
        --output-dir checkpoints/qwen3-06b-dpo-smoke \
        --max-steps 5

    # Real run
    uv run --extra train python scripts/train_dpo.py \
        --registry-key qwen3.5-9b \
        --sft-checkpoint checkpoints/eliza-1-9b-sft/final \
        --output-dir checkpoints/eliza-1-9b-dpo
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import random
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from format_for_training import format_record  # noqa: E402
from lib.attn import select_attn_impl  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("train-dpo")


# ───────────────────────────── pair construction ─────────────────────────────

# Action labels we'll perturb on the should_respond bucket; flipping the
# action from RESPOND→IGNORE (or vice versa) is the cleanest "rejected"
# variant — the format check still passes, only the content is wrong, which
# is exactly the kind of error we want DPO to discriminate against.
_ROUTING_FLIP = {"RESPOND": "IGNORE", "IGNORE": "RESPOND", "STOP": "RESPOND"}


def _corrupt_response(expected: str, task_type: str, rng: random.Random) -> str:
    """Return a plausibly-bad TOON response derived from `expected`.

    Strategy depends on the bucket:
      should_respond → flip the action label.
      message_handler/tool_call → rename the first action to a fake one.
      reply → strip the `text:` line so the format check fails.
      everything else → mutate any `name: X` line to `name: WRONG_ACTION`.
    """

    lines = expected.splitlines()

    if task_type in ("should_respond", "should_respond_with_context",
                     "dialogue_routing", "dataset-generator.should_respond"):
        for i, line in enumerate(lines):
            if line.strip().lower().startswith("action:"):
                _, _, val = line.partition(":")
                cur = val.strip().upper()
                flipped = _ROUTING_FLIP.get(cur, "IGNORE")
                lines[i] = f"action: {flipped}"
                return "\n".join(lines)

    if task_type in ("message_handler", "tool_call", "agent_trace"):
        for i, line in enumerate(lines):
            if "name:" in line and "actions" not in line.lower():
                indent = line[: len(line) - len(line.lstrip())]
                lines[i] = f"{indent}name: WRONG_ACTION_{rng.randint(100, 999)}"
                return "\n".join(lines)

    if task_type == "reply":
        # Drop the `text:` line so format check fails; this teaches DPO that
        # missing required fields is a defect.
        kept = [L for L in lines if not L.strip().lower().startswith("text:")]
        return "\n".join(kept) if kept else "thought: nothing to say"

    # Generic fallback: corrupt any `name:` line.
    for i, line in enumerate(lines):
        if line.strip().lower().startswith("name:"):
            indent = line[: len(line) - len(line.lstrip())]
            lines[i] = f"{indent}name: WRONG_{rng.randint(100, 999)}"
            return "\n".join(lines)

    # Last resort — append junk to break format.
    return expected + "\n\nUNEXPECTED PROSE TAIL"


def build_preference_dataset(
    pair_dirs: list[Path],
    tokenizer: Any,
    *,
    max_n: int | None = None,
    seed: int = 42,
) -> Any:
    """Walk `pair_dirs/*.jsonl`, build {prompt, chosen, rejected} rows.

    Returns a `datasets.Dataset` keyed exactly the way TRL's DPOTrainer
    expects when `processing_class` is the tokenizer (string columns; the
    trainer applies the chat template internally). We pre-render the
    *prompt* portion via `tokenizer.apply_chat_template(..., add_generation_prompt=True)`
    so the chosen/rejected continuations are pure assistant text.
    """

    from datasets import Dataset

    rng = random.Random(seed)
    rows: list[dict[str, str]] = []
    for d in pair_dirs:
        for fp in sorted(d.glob("*.jsonl")):
            with fp.open("r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        rec = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    formatted = format_record(rec)
                    if not formatted:
                        continue
                    msgs = formatted["messages"]
                    if not msgs or msgs[-1]["role"] != "assistant":
                        continue
                    chosen = msgs[-1]["content"]
                    prompt_msgs = msgs[:-1]
                    prompt_text = tokenizer.apply_chat_template(
                        prompt_msgs,
                        tokenize=False,
                        add_generation_prompt=True,
                    )
                    task_type = (rec.get("metadata") or {}).get("task_type", "")
                    rejected = _corrupt_response(chosen, task_type, rng)
                    if rejected.strip() == chosen.strip():
                        continue
                    rows.append({
                        "prompt": prompt_text,
                        "chosen": chosen,
                        "rejected": rejected,
                    })
                    if max_n and len(rows) >= max_n:
                        break
            if max_n and len(rows) >= max_n:
                break
        if max_n and len(rows) >= max_n:
            break

    log.info("built %d preference pairs from %d dirs", len(rows), len(pair_dirs))
    return Dataset.from_list(rows)


# ───────────────────────────── main ─────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--registry-key", required=True,
                    help="Pull defaults from training/model_registry.py "
                         "(e.g. qwen3.5-2b).")
    ap.add_argument("--sft-checkpoint", required=True,
                    help="Path to the SFT checkpoint (final/ subdir).")
    ap.add_argument("--pairs-dir", default=str(ROOT / "data" / "synthesized" / "action_pairs"))
    ap.add_argument("--output-dir", required=True)
    ap.add_argument("--epochs", type=float, default=1.0)
    ap.add_argument("--beta", type=float, default=0.1,
                    help="DPO temperature. 0.1 is TRL's default; raise to "
                         "0.5 if the policy drifts too far from ref.")
    ap.add_argument("--batch-size", type=int, default=1)
    ap.add_argument("--grad-accum", type=int, default=16)
    ap.add_argument("--lr", type=float, default=5e-6,
                    help="DPO LR — typically 1/10 of SFT LR. Higher LR "
                         "destabilizes the implicit-RM objective.")
    ap.add_argument("--max-seq-len", type=int, default=4096)
    ap.add_argument("--max-samples", type=int, default=0)
    ap.add_argument("--max-steps", type=int, default=-1,
                    help="Smoke-test cap. -1 = use --epochs.")
    ap.add_argument("--apollo-rank", type=int, default=256)
    ap.add_argument("--apollo-scale", type=float, default=1.0)
    ap.add_argument("--apollo-update-proj-gap", type=int, default=200)
    ap.add_argument(
        "--optimizer",
        choices=["apollo", "apollo_mini"],
        default="apollo",
    )
    ap.add_argument(
        "--use-liger", default="auto", choices=("auto", "on", "off"),
    )
    args = ap.parse_args()

    from training.model_registry import get as _registry_get
    entry = _registry_get(args.registry_key)
    log.info("registry %s → hf=%s seq_len=%d optimizer=%s",
             entry.short_name, entry.hf_id, entry.seq_len, entry.optimizer)
    if args.max_seq_len == ap.get_default("max_seq_len"):
        args.max_seq_len = entry.seq_len
    if args.optimizer == ap.get_default("optimizer"):
        args.optimizer = entry.optimizer

    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from trl import DPOConfig, DPOTrainer

    device = "cuda" if torch.cuda.is_available() else "cpu"
    log.info("device=%s torch=%s sft_ckpt=%s", device, torch.__version__,
             args.sft_checkpoint)
    if device == "cpu":
        log.warning("no GPU detected — DPO will be very slow")

    tokenizer = AutoTokenizer.from_pretrained(
        args.sft_checkpoint, trust_remote_code=True,
    )
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token
    tokenizer.truncation_side = "left"

    pairs_dir = Path(args.pairs_dir)
    if not pairs_dir.exists():
        log.error("pairs dir does not exist: %s", pairs_dir)
        return 1
    train_ds = build_preference_dataset(
        [pairs_dir], tokenizer,
        max_n=args.max_samples or None,
    )
    if len(train_ds) == 0:
        log.error("no preference pairs constructed — check pairs-dir layout")
        return 1

    attn_impl = select_attn_impl(device)

    in_distributed = "RANK" in os.environ
    use_device_map = device == "cuda" and not in_distributed
    model_kwargs: dict[str, Any] = dict(
        torch_dtype=torch.bfloat16 if device == "cuda" else torch.float32,
        trust_remote_code=True,
        low_cpu_mem_usage=True,
        attn_implementation=attn_impl,
    )
    if use_device_map:
        model_kwargs["device_map"] = "auto"

    log.info("loading policy + ref from %s", args.sft_checkpoint)
    policy = AutoModelForCausalLM.from_pretrained(args.sft_checkpoint, **model_kwargs)
    # Frozen reference. We deliberately keep a separate copy in memory rather
    # than passing `ref_model=None` (which would have TRL re-create one with
    # peft adapter-disable tricks) — at our model sizes that's both clearer
    # and faster.
    ref_model = AutoModelForCausalLM.from_pretrained(args.sft_checkpoint, **model_kwargs)
    for p in ref_model.parameters():
        p.requires_grad_(False)

    use_liger = args.use_liger == "on" or (
        args.use_liger == "auto" and getattr(entry, "use_liger", True)
    )
    if use_liger and device == "cuda":
        try:
            from liger_kernel.transformers import _apply_liger_kernel_to_instance
        except ImportError:
            if args.use_liger == "on":
                raise SystemExit(
                    "--use-liger=on requested but liger-kernel is not installed."
                )
            log.warning("liger-kernel not installed — skipping Liger patch")
        else:
            _apply_liger_kernel_to_instance(model=policy)
            _apply_liger_kernel_to_instance(model=ref_model)
            log.info("Liger kernel applied to policy + ref")

    policy.config.use_cache = False
    ref_model.config.use_cache = False
    if hasattr(policy, "gradient_checkpointing_enable"):
        policy.gradient_checkpointing_enable(
            gradient_checkpointing_kwargs={"use_reentrant": False},
        )

    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    if os.environ.get("ELIZA_TRAINER_OPTIM"):
        raise SystemExit(
            "ELIZA_TRAINER_OPTIM is disabled. DPO always builds "
            "APOLLO/APOLLO-Mini through the trainer create_optimizer hook."
        )
    trainer_optim = "adafactor"
    dpo_cfg = DPOConfig(
        output_dir=str(out_dir),
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch_size,
        gradient_accumulation_steps=args.grad_accum,
        learning_rate=args.lr,
        lr_scheduler_type="cosine",
        warmup_ratio=0.03,
        weight_decay=0.0,
        optim=trainer_optim,
        bf16=device == "cuda",
        beta=args.beta,
        max_length=args.max_seq_len,
        logging_steps=10,
        save_steps=500,
        save_total_limit=3,
        max_steps=args.max_steps,
        report_to=os.environ.get("WANDB_PROJECT", "none") if os.environ.get("WANDB_PROJECT") else "none",
        run_name=out_dir.name,
    )

    from training.optimizer import (
        _NON_LOWRANK_NAME_HINTS,
        build_apollo_mini_optimizer_from_groups,
        build_apollo_optimizer_from_groups,
    )
    lowrank_names: set[str] = set()
    for name, p in policy.named_parameters():
        if not p.requires_grad:
            continue
        lname = name.lower()
        if any(h in lname for h in _NON_LOWRANK_NAME_HINTS):
            continue
        if p.dim() == 2:
            lowrank_names.add(name)
    log.info("APOLLO classification: %d lowrank names of %d total",
             len(lowrank_names),
             sum(1 for _ in policy.named_parameters()))

    def _split(model: Any) -> tuple[list[Any], list[Any]]:
        lr_, other_ = [], []
        for name, p in model.named_parameters():
            if not p.requires_grad:
                continue
            clean = name.replace("_fsdp_wrapped_module.", "")
            (lr_ if clean in lowrank_names else other_).append(p)
        return lr_, other_

    if args.optimizer == "apollo":
        def apollo_builder(m):
            lr_, other_ = _split(m)
            return build_apollo_optimizer_from_groups(
                lr_, other_, lr=args.lr,
                weight_decay=dpo_cfg.weight_decay,
                rank=args.apollo_rank, scale=args.apollo_scale,
                update_proj_gap=args.apollo_update_proj_gap,
            )
    else:
        def apollo_builder(m):
            lr_, other_ = _split(m)
            return build_apollo_mini_optimizer_from_groups(
                lr_, other_, lr=args.lr,
                weight_decay=dpo_cfg.weight_decay,
            )

    class _ElizaDPOTrainer(DPOTrainer):
        def create_optimizer(self, model=None):
            if self.optimizer is None:
                target = model or self.model
                self.optimizer = apollo_builder(target)
                return self.optimizer
            return self.optimizer

    trainer = _ElizaDPOTrainer(
        model=policy,
        ref_model=ref_model,
        args=dpo_cfg,
        train_dataset=train_ds,
        processing_class=tokenizer,
    )

    from training.instrumentation import (
        InstrumentationConfig, log_environment, make_hf_callback,
    )
    log_environment(
        out_dir,
        run_meta={
            "stage": "dpo",
            "sft_checkpoint": args.sft_checkpoint,
            "registry_key": args.registry_key,
            "beta": args.beta,
            "batch_size": args.batch_size,
            "grad_accum": args.grad_accum,
            "max_seq_len": args.max_seq_len,
            "lr": args.lr,
        },
    )
    if entry.train_mem_gb_budget:
        trainer.add_callback(make_hf_callback(InstrumentationConfig(
            out_dir=str(out_dir),
            seq_len=args.max_seq_len,
            effective_batch_size=args.batch_size * args.grad_accum,
            memory_budget_gb=float(entry.train_mem_gb_budget),
            log_every_steps=dpo_cfg.logging_steps,
        )))
        log.info("instrumentation enabled, budget=%.0fGB",
                 entry.train_mem_gb_budget)

    trainer.train()
    final_dir = out_dir / "final"
    trainer.save_model(str(final_dir))
    tokenizer.save_pretrained(str(final_dir))
    log.info("done. dpo checkpoint at %s", final_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
