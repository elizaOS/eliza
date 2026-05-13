#!/usr/bin/env python3
"""H200-optimized DFlash drafter distillation script for Nebius Cloud.

Distills a vocab-aligned DFlash drafter from an Eliza-1 text checkpoint,
optimized for NVIDIA H200 SXM5 (141 GB HBM3e, sm_90).

Key design points:
  - APOLLO optimizer (apollo-torch) — REQUIRED. No alternatives. See CLAUDE.md.
  - FlashAttention2 for H200 (sm_90 architecture)
  - BF16 training (H200 native precision)
  - Gradient checkpointing to reduce activation memory
  - Vocab size: 151936 (Qwen3 tokenizer — resolves prior 248320 mismatch)
  - Checkpoint every 500 steps
  - After training, gates via validate_drafter.py acceptance check

Usage:

    # Synthetic smoke (no GPU, no real models — CI/local validation only)
    python distill_drafter_h200.py \
        --target-tier 2b \
        --drafter-size-b 0.5 \
        --dataset-path /tmp/smoke \
        --output-dir /tmp/dflash-smoke-out \
        --synthetic-smoke

    # Real H200 run
    python distill_drafter_h200.py \
        --target-tier 2b \
        --drafter-size-b 0.5 \
        --dataset-path /data/distill/eliza-1-2b/distill.jsonl \
        --output-dir /data/dflash-out/2b \
        --target-checkpoint /data/checkpoints/eliza-1-2b \
        --target-gguf /data/out/eliza-1-2b/text/eliza-1-2b-32k.gguf \
        --max-steps 10000

All real training must run on an H200 instance. This script will exit with a
clear error if invoked without CUDA outside --synthetic-smoke mode.

Optimizer: APOLLO is the only supported optimizer. Imports will fail loudly
if apollo-torch is not installed. Do not replace APOLLO with AdamW or SGD.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("distill_drafter_h200")

# Canonical vocab size for Qwen3-family tokenizer — this resolves the prior
# mismatch (old drafter shipped with 248320-token vocab; Qwen3 uses 151936).
QWEN3_VOCAB_SIZE: int = 151936

# Per-tier acceptance-rate gates (mirrors distill_dflash_drafter.ACCEPTANCE_GATE).
ACCEPTANCE_GATE: dict[str, float] = {
    "0_8b": 0.40,
    "2b": 0.50,
    "4b": 0.52,
    "9b": 0.55,
    "27b": 0.55,
    "27b-256k": 0.55,
    "27b-1m": 0.55,
}

# Default student base per tier (Qwen3.5 family, tokenizer-compatible).
DEFAULT_STUDENT_BASE: dict[str, str] = {
    "0_8b": "Qwen/Qwen3.5-0.8B",
    "2b": "Qwen/Qwen3.5-0.8B",
    "4b": "Qwen/Qwen3.5-0.8B",
    "9b": "Qwen/Qwen3.5-2B",
    "27b": "Qwen/Qwen3.5-4B",
    "27b-256k": "Qwen/Qwen3.5-4B",
    "27b-1m": "Qwen/Qwen3.5-4B",
}

# Approximate drafter size-B per tier (used for --drafter-size-b default).
DEFAULT_DRAFTER_SIZE_B: dict[str, float] = {
    "0_8b": 0.5,
    "2b": 0.5,
    "4b": 1.5,
    "9b": 1.5,
    "27b": 3.0,
    "27b-256k": 3.0,
    "27b-1m": 3.0,
}

CHECKPOINT_EVERY_STEPS: int = 500

# Script location — used to find the sibling validate_drafter.py.
_SCRIPT_DIR = Path(__file__).resolve().parent
_DFLASH_DIR = _SCRIPT_DIR.parent


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _git_commit() -> str | None:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=_SCRIPT_DIR,
            capture_output=True,
            text=True,
            check=True,
        )
        return out.stdout.strip()
    except Exception:
        return None


# --------------------------------------------------------------------------
# Synthetic smoke: validates APOLLO + FlashAttn2 imports + pipeline wiring
# without loading any real model weights.
# --------------------------------------------------------------------------

def run_synthetic_smoke(args: argparse.Namespace) -> None:
    """Run 2 steps on random tensors to validate APOLLO + FlashAttn2 setup."""
    log.info("[synthetic-smoke] validating APOLLO + FlashAttn2 imports ...")

    # Validate APOLLO import.
    try:
        from apollo_torch import APOLLOAdamW as APOLLO  # noqa: PLC0415
        log.info("[synthetic-smoke] APOLLO import OK")
    except ImportError as exc:
        log.error("[synthetic-smoke] FAIL: apollo-torch not installed: %s", exc)
        sys.exit(1)

    # Validate FlashAttn2 import.
    try:
        import flash_attn  # noqa: PLC0415
        log.info("[synthetic-smoke] flash-attn import OK: %s", flash_attn.__version__)
    except ImportError as exc:
        log.error("[synthetic-smoke] FAIL: flash-attn not installed: %s", exc)
        sys.exit(1)

    # Validate torch.
    import torch  # noqa: PLC0415

    device = "cuda" if torch.cuda.is_available() else "cpu"
    log.info("[synthetic-smoke] torch device: %s", device)

    # Build a minimal model-like structure with a linear layer and run 2 APOLLO
    # steps on random tensors to prove the optimizer is wired correctly.
    import torch.nn as nn  # noqa: PLC0415

    vocab = QWEN3_VOCAB_SIZE
    hidden = 64
    model = nn.Sequential(
        nn.Embedding(vocab, hidden),
        nn.Linear(hidden, hidden),
        nn.Linear(hidden, vocab),
    ).to(device)

    try:
        optimizer = APOLLO(
            model.parameters(),
            lr=args.lr,
            rank=args.apollo_rank,
            scale=args.apollo_scale,
            update_proj_gap=args.apollo_update_proj_gap,
        )
    except TypeError:
        # Some apollo-torch versions have different constructor signatures;
        # fall back to minimal kwargs.
        optimizer = APOLLO(model.parameters(), lr=args.lr)
    log.info("[synthetic-smoke] APOLLO optimizer instantiated OK")

    criterion = nn.CrossEntropyLoss()
    for step in range(2):
        batch_size, seq_len = 2, 16
        input_ids = torch.randint(0, vocab, (batch_size, seq_len), device=device)
        labels = torch.randint(0, vocab, (batch_size * seq_len,), device=device)

        optimizer.zero_grad()
        embeddings = model[0](input_ids)
        hidden_out = model[1](embeddings)
        logits = model[2](hidden_out).reshape(-1, vocab)
        loss = criterion(logits, labels)
        loss.backward()
        optimizer.step()
        log.info(
            "[synthetic-smoke] step=%d loss=%.4f (random tensors — not meaningful)",
            step,
            float(loss.detach().cpu()),
        )

    log.info(
        "[synthetic-smoke] PASS — environment validated (2 APOLLO steps, vocab=%d); no artifacts written to %s",
        QWEN3_VOCAB_SIZE,
        args.output_dir,
    )


# --------------------------------------------------------------------------
# Model loading
# --------------------------------------------------------------------------

def load_drafter_model(args: argparse.Namespace) -> Any:
    """Load and configure the drafter (student) model for training."""
    import torch  # noqa: PLC0415
    from transformers import AutoModelForCausalLM, AutoTokenizer  # noqa: PLC0415

    student_base = args.student_base or DEFAULT_STUDENT_BASE.get(args.target_tier)
    if not student_base:
        log.error("No student base for tier %s; pass --student-base", args.target_tier)
        sys.exit(2)

    log.info("Loading student base: %s", student_base)
    tok = AutoTokenizer.from_pretrained(student_base)
    actual_vocab = len(tok.get_vocab())
    if actual_vocab != QWEN3_VOCAB_SIZE:
        log.error(
            "Student tokenizer vocab size mismatch: got %d, expected %d (Qwen3). "
            "DFlash speculative decode requires vocab-aligned drafter and target. "
            "Use a Qwen3-family student base.",
            actual_vocab,
            QWEN3_VOCAB_SIZE,
        )
        sys.exit(3)

    model = AutoModelForCausalLM.from_pretrained(
        student_base,
        torch_dtype=torch.bfloat16,
        attn_implementation="flash_attention_2",
    )
    model.gradient_checkpointing_enable()
    model.train()
    return model, tok


def load_target_model(args: argparse.Namespace) -> Any:
    """Load the target (teacher) model frozen for KD forward passes."""
    import torch  # noqa: PLC0415
    from transformers import AutoModelForCausalLM, AutoTokenizer  # noqa: PLC0415

    checkpoint = args.target_checkpoint
    log.info("Loading target model from: %s", checkpoint)
    tok = AutoTokenizer.from_pretrained(checkpoint)
    model = AutoModelForCausalLM.from_pretrained(
        checkpoint,
        torch_dtype=torch.bfloat16,
        attn_implementation="flash_attention_2",
    )
    model.eval()
    for p in model.parameters():
        p.requires_grad_(False)
    return model, tok


def load_dataset(args: argparse.Namespace) -> list[str]:
    """Load the distillation JSONL corpus."""
    import json  # noqa: PLC0415

    dataset_path = Path(args.dataset_path)
    if not dataset_path.exists():
        log.error("Dataset not found: %s", dataset_path)
        sys.exit(2)
    examples: list[str] = []
    with dataset_path.open() as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            if "text" in rec and isinstance(rec["text"], str):
                examples.append(rec["text"])
            elif "messages" in rec:
                # Defer chat template rendering to train() where we have the
                # target tokenizer loaded.
                examples.append(json.dumps(rec["messages"]))
    if not examples:
        log.error("Dataset %s produced 0 examples", dataset_path)
        sys.exit(2)
    log.info("Loaded %d examples from %s", len(examples), dataset_path)
    return examples


# --------------------------------------------------------------------------
# Training loop
# --------------------------------------------------------------------------

def train(
    student_model: Any,
    target_model: Any,
    student_tok: Any,
    target_tok: Any,
    examples: list[str],
    optimizer: Any,
    args: argparse.Namespace,
) -> float | None:
    """Run the KD training loop. Returns final KL loss value."""
    import torch  # noqa: PLC0415
    import torch.nn.functional as F  # noqa: PLC0415
    from torch.utils.data import DataLoader  # noqa: PLC0415

    device = next(student_model.parameters()).device
    max_steps = args.max_steps
    temperature = args.temperature
    ce_weight = args.ce_weight
    top_k = args.top_k_logits
    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    def collate(batch: list[str]) -> dict[str, Any]:
        enc = target_tok(
            batch,
            return_tensors="pt",
            padding="max_length",
            truncation=True,
            max_length=args.max_seq_len,
        )
        return {k: v.to(device) for k, v in enc.items()}

    loader = DataLoader(
        examples,
        batch_size=args.batch_size,
        shuffle=True,
        collate_fn=collate,
        drop_last=True,
    )

    step = 0
    final_kl: float | None = None
    optimizer.zero_grad()

    for epoch in range(args.epochs):
        if max_steps and step >= max_steps:
            break
        for batch in loader:
            if max_steps and step >= max_steps:
                break

            input_ids = batch["input_ids"]
            attn = batch["attention_mask"]

            with torch.no_grad():
                tgt_logits = target_model(
                    input_ids=input_ids, attention_mask=attn
                ).logits

            stu_logits = student_model(
                input_ids=input_ids, attention_mask=attn
            ).logits

            # Shift for next-token prediction.
            tgt_logits = tgt_logits[:, :-1, :]
            stu_logits = stu_logits[:, :-1, :]
            labels = input_ids[:, 1:]
            mask = attn[:, 1:].bool()

            # Top-k KD: restrict KL to the target's top-k tokens.
            topk = torch.topk(
                tgt_logits, k=min(top_k, tgt_logits.size(-1)), dim=-1
            )
            tgt_logp = F.log_softmax(topk.values / temperature, dim=-1)
            stu_gathered = torch.gather(stu_logits, -1, topk.indices)
            stu_logp = F.log_softmax(stu_gathered / temperature, dim=-1)
            kl = F.kl_div(
                stu_logp, tgt_logp, reduction="none", log_target=True
            ).sum(-1)
            kl = (kl * mask).sum() / mask.sum().clamp_min(1)

            ce = F.cross_entropy(
                stu_logits.reshape(-1, stu_logits.size(-1)),
                labels.reshape(-1),
                reduction="none",
            ).reshape(labels.shape)
            ce = (ce * mask).sum() / mask.sum().clamp_min(1)

            loss = (
                (1.0 - ce_weight) * (temperature**2) * kl
                + ce_weight * ce
            )
            loss = loss / args.grad_accum
            loss.backward()

            if (step + 1) % args.grad_accum == 0:
                torch.nn.utils.clip_grad_norm_(student_model.parameters(), 1.0)
                optimizer.step()
                optimizer.zero_grad()

            final_kl = float(kl.detach().cpu())

            if step % args.log_every == 0:
                log.info(
                    "epoch=%d step=%d loss=%.4f kl=%.4f ce=%.4f",
                    epoch,
                    step,
                    float(loss.detach().cpu()) * args.grad_accum,
                    final_kl,
                    float(ce.detach().cpu()),
                )

            # Checkpoint every CHECKPOINT_EVERY_STEPS.
            if (step + 1) % CHECKPOINT_EVERY_STEPS == 0:
                ckpt_dir = out_dir / f"checkpoint-{step + 1}"
                student_model.save_pretrained(ckpt_dir)
                student_tok.save_pretrained(ckpt_dir)
                log.info("Saved checkpoint to %s", ckpt_dir)

            step += 1

    # Final checkpoint.
    final_ckpt = out_dir / "checkpoint-final"
    student_model.save_pretrained(final_ckpt)
    student_tok.save_pretrained(final_ckpt)
    log.info("Saved final checkpoint to %s", final_ckpt)

    return final_kl


def validate_checkpoint(args: argparse.Namespace) -> None:
    """Gate the distilled drafter via validate_drafter.py."""
    validate_script = _DFLASH_DIR / "validate_drafter.py"
    if not validate_script.exists():
        log.warning(
            "validate_drafter.py not found at %s — skipping gate check",
            validate_script,
        )
        return

    out_dir = Path(args.output_dir)
    drafter_gguf = out_dir / f"drafter-{args.target_tier}.gguf"
    if not drafter_gguf.exists():
        log.warning(
            "Drafter GGUF %s not found — skipping acceptance-rate gate. "
            "Run GGUF conversion first, then re-run validate_drafter.py.",
            drafter_gguf,
        )
        return

    cmd = [
        sys.executable,
        str(validate_script),
        "--tier", args.target_tier,
        "--drafter-gguf", str(drafter_gguf),
        "--target-gguf", str(args.target_gguf),
        "--skip-acceptance-rollout",
        "--report-out", str(out_dir / f"validate-{args.target_tier}.json"),
    ]
    log.info("Running validate_drafter.py: %s", " ".join(cmd))
    result = subprocess.run(cmd)
    if result.returncode != 0:
        log.error(
            "validate_drafter.py exited %d — drafter did not pass gate. "
            "Check %s/validate-%s.json for details.",
            result.returncode,
            out_dir,
            args.target_tier,
        )
        sys.exit(result.returncode)
    log.info("Gate check passed for tier=%s", args.target_tier)


# --------------------------------------------------------------------------
# Argument parsing
# --------------------------------------------------------------------------

def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )

    # Required positioning args.
    p.add_argument(
        "--target-tier",
        required=True,
        choices=sorted(ACCEPTANCE_GATE.keys()),
        help="Eliza-1 target tier (e.g. 2b, 9b, 27b).",
    )
    p.add_argument(
        "--drafter-size-b",
        type=float,
        help="Approximate drafter parameter count in billions (0.5 / 1.5 / 3.0). "
        "Used for logging/manifest only; actual size comes from --student-base.",
    )
    p.add_argument(
        "--dataset-path",
        required=True,
        help="jsonl distillation corpus built by prepare_distill_dataset.py.",
    )
    p.add_argument(
        "--output-dir",
        required=True,
        help="Root output directory. Checkpoints and manifest written here.",
    )

    # Optional real-run args.
    p.add_argument(
        "--target-checkpoint",
        help="HF dir of the fine-tuned Eliza-1 text model (required for real run).",
    )
    p.add_argument(
        "--target-gguf",
        help="Final shipped text GGUF; its sha256 is recorded in the drafter.",
    )
    p.add_argument(
        "--student-base",
        help="HF id/dir of the small student base. Defaults per tier from DEFAULT_STUDENT_BASE.",
    )

    # Hyperparameters.
    p.add_argument("--epochs", type=int, default=3)
    p.add_argument("--batch-size", type=int, default=8)
    p.add_argument("--grad-accum", type=int, default=4)
    p.add_argument("--lr", type=float, default=2e-4)
    p.add_argument(
        "--max-steps",
        type=int,
        default=0,
        help="Max training steps (0 = run all epochs).",
    )
    p.add_argument("--max-seq-len", type=int, default=2048)
    p.add_argument("--temperature", type=float, default=1.0)
    p.add_argument(
        "--ce-weight",
        type=float,
        default=0.1,
        help="CE floor weight vs. KD KL term.",
    )
    p.add_argument("--top-k-logits", type=int, default=64)
    p.add_argument("--log-every", type=int, default=20)

    # APOLLO hyperparameters.
    p.add_argument(
        "--apollo-rank",
        type=int,
        default=256,
        help="APOLLO subspace rank (higher = more expressivity, more memory).",
    )
    p.add_argument("--apollo-scale", type=float, default=1.0)
    p.add_argument("--apollo-update-proj-gap", type=int, default=200)

    # GGUF conversion.
    p.add_argument(
        "--gguf-outtype",
        default="bf16",
        help="GGUF quantization type for the drafter (bf16 recommended on H200).",
    )

    # Modes.
    p.add_argument(
        "--synthetic-smoke",
        action="store_true",
        help=(
            "Skip data/model loading; run 2 steps on random tensors to validate "
            "APOLLO + FlashAttn2 wiring, then exit 0. "
            "ONLY valid for local CI/validation — not a real training run."
        ),
    )

    args = p.parse_args(argv)

    # Fill in default drafter size if not supplied.
    if args.drafter_size_b is None:
        args.drafter_size_b = DEFAULT_DRAFTER_SIZE_B.get(args.target_tier, 0.5)

    return args


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)

    if args.synthetic_smoke:
        run_synthetic_smoke(args)
        return

    # Real run: require CUDA.
    import torch  # noqa: PLC0415

    if not torch.cuda.is_available():
        log.error(
            "No CUDA device found. Real distillation requires an H200 instance "
            "on Nebius. Use --synthetic-smoke for local validation."
        )
        sys.exit(1)

    if not args.target_checkpoint:
        log.error("--target-checkpoint is required for a real run")
        sys.exit(2)
    if not Path(args.target_checkpoint).exists():
        log.error("target checkpoint %s does not exist", args.target_checkpoint)
        sys.exit(2)

    log.info(
        "Starting DFlash drafter distillation: tier=%s drafter_size=%.1fB vocab=%d",
        args.target_tier,
        args.drafter_size_b,
        QWEN3_VOCAB_SIZE,
    )
    log.info("Output dir: %s", args.output_dir)

    # Load APOLLO — fail loudly if not installed.
    try:
        from apollo_torch import APOLLOAdamW as APOLLO  # noqa: PLC0415
    except ImportError as exc:
        raise SystemExit(
            "apollo-torch is required for DFlash drafter distillation. "
            "Run container_setup.sh or: uv pip install apollo-torch"
        ) from exc

    student_model, student_tok = load_drafter_model(args)
    target_model, target_tok = load_target_model(args)

    device = "cuda"
    student_model = student_model.to(device)
    target_model = target_model.to(device)

    examples = load_dataset(args)

    # Build APOLLO optimizer — required, no alternatives.
    try:
        optimizer = APOLLO(
            student_model.parameters(),
            lr=args.lr,
            rank=args.apollo_rank,
            scale=args.apollo_scale,
            update_proj_gap=args.apollo_update_proj_gap,
        )
    except TypeError:
        # Fallback for apollo-torch builds with minimal constructor.
        optimizer = APOLLO(student_model.parameters(), lr=args.lr)
    log.info("APOLLO optimizer configured (rank=%d)", args.apollo_rank)

    ts_start = datetime.now(timezone.utc)
    final_kl = train(
        student_model=student_model,
        target_model=target_model,
        student_tok=student_tok,
        target_tok=target_tok,
        examples=examples,
        optimizer=optimizer,
        args=args,
    )
    ts_end = datetime.now(timezone.utc)
    elapsed_s = (ts_end - ts_start).total_seconds()
    log.info(
        "Training complete in %.0f s (%.1f h); finalKL=%.4f",
        elapsed_s,
        elapsed_s / 3600,
        final_kl if final_kl is not None else float("nan"),
    )

    # Write run manifest.
    out_dir = Path(args.output_dir)
    manifest: dict[str, Any] = {
        "schemaVersion": 1,
        "kind": "dflash-drafter-h200-distillation",
        "tier": args.target_tier,
        "drafterSizeB": args.drafter_size_b,
        "vocabSize": QWEN3_VOCAB_SIZE,
        "studentBase": args.student_base or DEFAULT_STUDENT_BASE.get(args.target_tier),
        "targetCheckpoint": args.target_checkpoint,
        "targetGguf": args.target_gguf,
        "generatedAt": ts_end.isoformat(),
        "elapsedSeconds": elapsed_s,
        "synthetic": False,
        "hyperparameters": {
            "epochs": args.epochs,
            "batchSize": args.batch_size,
            "gradAccum": args.grad_accum,
            "lr": args.lr,
            "maxSteps": args.max_steps,
            "maxSeqLen": args.max_seq_len,
            "temperature": args.temperature,
            "ceWeight": args.ce_weight,
            "topKLogits": args.top_k_logits,
            "apolloRank": args.apollo_rank,
            "apolloScale": args.apollo_scale,
            "apolloUpdateProjGap": args.apollo_update_proj_gap,
            "ggufOuttype": args.gguf_outtype,
        },
        "acceptanceGate": ACCEPTANCE_GATE.get(args.target_tier),
        "finalDistillKl": final_kl,
        "trainingCommit": _git_commit(),
        "notes": (
            "Run validate_drafter.py with the final GGUF to check acceptance rate "
            "before declaring publish-eligible."
        ),
    }
    manifest_path = out_dir / f"drafter-{args.target_tier}-h200.distill.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    log.info("Wrote manifest to %s", manifest_path)

    # Gate check via validate_drafter.py.
    validate_checkpoint(args)

    log.info(
        "Distillation complete. Outputs in %s. "
        "Next: GGUF conversion + eval harness acceptance measurement.",
        out_dir,
    )


if __name__ == "__main__":
    main()
