#!/usr/bin/env python3
"""
End-to-end validation: train with APOLLO + Kondo + TurboQuant, measure eval improvement.

Runs on a single GPU (RTX 3060+ / 16GB+). Uses Qwen3-0.6B for speed.

Steps:
  1. Baseline eval: score untrained model on 12 trading + 6 security prompts
  2. SFT warm-up: train on alignment samples (few-shot examples)
  3. GRPO training: train on eval prompts with REINFORCE + Kondo gate
  4. Post-training eval: score trained model on same prompts
  5. Print comparison table

Usage:
    python scripts/validate_training_pipeline.py
    python scripts/validate_training_pipeline.py --model Qwen/Qwen3.5-4B --steps 30
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from pathlib import Path

import torch
import torch.nn.functional as F
from transformers import AutoModelForCausalLM, AutoTokenizer

SCRIPT_DIR = Path(__file__).resolve().parent
PYTHON_ROOT = SCRIPT_DIR.parent
sys.path.insert(0, str(PYTHON_ROOT))

from src.training.deterministic_eval import (
    ACTION_REASON_ALIGNMENT_SAMPLES,
    ACTION_REASON_ASSISTANT_PREFIX,
    ACTION_REASON_PROMPTS,
    ACTION_REASON_SYSTEM_PROMPT,
    score_action_reason_response,
)
from src.training.turboquant import TurboQuantSettings

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("validate")


# ─── Eval ────────────────────────────────────────────────────────────────────


def run_eval(
    model: AutoModelForCausalLM,
    tokenizer: AutoTokenizer,
    device: str,
    tag: str = "",
) -> dict:
    """Run deterministic eval on ACTION_REASON_PROMPTS. Returns summary dict."""
    model.eval()
    results = []

    for spec in ACTION_REASON_PROMPTS:
        messages = [
            {"role": "system", "content": ACTION_REASON_SYSTEM_PROMPT},
            {"role": "user", "content": spec["prompt"]},
        ]
        prompt_text = tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True,
        )
        # Append the assistant prefix to steer format
        prompt_text += ACTION_REASON_ASSISTANT_PREFIX

        enc = tokenizer(prompt_text, return_tensors="pt", truncation=True, max_length=1024).to(
            device
        )

        gen_kwargs = {
            "max_new_tokens": 128,
            "temperature": 0.7,
            "top_p": 0.9,
            "do_sample": True,
            "pad_token_id": tokenizer.pad_token_id or tokenizer.eos_token_id,
        }

        with torch.no_grad():
            out = model.generate(
                enc["input_ids"], attention_mask=enc["attention_mask"], **gen_kwargs
            )

        prompt_len = enc["input_ids"].shape[1]
        response_text = tokenizer.decode(out[0, prompt_len:], skip_special_tokens=True).strip()

        # Prepend the assistant prefix back for scoring
        full_response = ACTION_REASON_ASSISTANT_PREFIX + response_text

        score_result = score_action_reason_response(full_response, spec)
        results.append(
            {
                "id": spec["id"],
                "slice": spec.get("slice", ""),
                "response": full_response[:200],
                "score": score_result,
            }
        )

    # Aggregate
    scores = [r["score"]["score"] for r in results]
    policy_aligned = [
        r["score"]["policy_alignment"]
        for r in results
        if r["score"]["policy_alignment"] is not None
    ]

    summary = {
        "tag": tag,
        "prompt_count": len(results),
        "avg_score": round(sum(scores) / len(scores), 4) if scores else 0.0,
        "policy_alignment_rate": (
            round(sum(1 for a in policy_aligned if a) / len(policy_aligned), 4)
            if policy_aligned
            else 0.0
        ),
        "format_rate": round(
            sum(1 for r in results if r["score"]["checks"].get("strict_two_lines")) / len(results),
            4,
        )
        if results
        else 0.0,
        "action_rate": round(
            sum(1 for r in results if r["score"]["checks"].get("has_action_verb")) / len(results), 4
        )
        if results
        else 0.0,
        "concrete_cue_rate": round(
            sum(1 for r in results if r["score"]["checks"].get("has_concrete_cue")) / len(results),
            4,
        )
        if results
        else 0.0,
        "results": results,
    }

    return summary


# ─── SFT warm-up ────────────────────────────────────────────────────────────


def sft_warmup(
    model: AutoModelForCausalLM,
    tokenizer: AutoTokenizer,
    optimizer: torch.optim.Optimizer,
    device: str,
    epochs: int = 3,
) -> list[float]:
    """Fine-tune on alignment samples to teach the Action/Reason format."""
    model.train()
    losses = []

    samples = ACTION_REASON_ALIGNMENT_SAMPLES
    logger.info(f"SFT warm-up: {len(samples)} samples x {epochs} epochs")

    for epoch in range(epochs):
        epoch_loss = 0.0
        for sample in samples:
            messages = [
                {"role": "system", "content": ACTION_REASON_SYSTEM_PROMPT},
                {"role": "user", "content": sample["prompt"]},
            ]
            prompt_text = tokenizer.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=True,
            )
            full_text = prompt_text + sample["response"]

            enc = tokenizer(
                full_text,
                return_tensors="pt",
                truncation=True,
                max_length=512,
            ).to(device)
            prompt_enc = tokenizer(
                prompt_text,
                return_tensors="pt",
                truncation=True,
                max_length=512,
            )
            prompt_len = prompt_enc["input_ids"].shape[1]

            input_ids = enc["input_ids"][:, :-1]
            labels = enc["input_ids"][:, 1:].clone()
            # Mask out prompt tokens
            labels[:, : prompt_len - 1] = -100

            outputs = model(input_ids, attention_mask=enc["attention_mask"][:, :-1])
            loss = F.cross_entropy(
                outputs.logits.view(-1, outputs.logits.size(-1)),
                labels.view(-1),
                ignore_index=-100,
            )

            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            optimizer.zero_grad()
            epoch_loss += loss.item()

        avg = epoch_loss / max(len(samples), 1)
        losses.append(avg)
        logger.info(f"  SFT epoch {epoch + 1}/{epochs}: loss={avg:.4f}")

    return losses


# ─── GRPO training with Kondo gate ──────────────────────────────────────────


def grpo_with_kondo(
    model: AutoModelForCausalLM,
    tokenizer: AutoTokenizer,
    optimizer: torch.optim.Optimizer,
    device: str,
    steps: int = 20,
    group_size: int = 4,
    kondo_gate_rate: float = 0.3,
) -> dict:
    """
    GRPO training on the eval prompts.

    For each prompt:
      1. Generate `group_size` rollouts
      2. Score each
      3. Normalize scores as advantages
      4. Kondo gate: only train on high-delight rollouts
      5. REINFORCE update
    """
    model.train()

    # Init Kondo gate
    kondo_gate = None
    try:
        from kondo_gate import KondoGate, KondoGateConfig

        kondo_gate = KondoGate(
            KondoGateConfig(
                gate_rate=kondo_gate_rate,
                hard=True,
                deterministic=True,
            )
        )
        logger.info(f"Kondo gate enabled: rate={kondo_gate_rate}")
    except ImportError:
        logger.warning("kondo-gate not installed, running without gating")

    prompts = ACTION_REASON_PROMPTS
    metrics = {
        "steps": 0,
        "total_rollouts": 0,
        "backward_passes": 0,
        "backward_skipped": 0,
        "losses": [],
        "mean_delights": [],
    }

    for step in range(steps):
        spec = prompts[step % len(prompts)]
        messages = [
            {"role": "system", "content": ACTION_REASON_SYSTEM_PROMPT},
            {"role": "user", "content": spec["prompt"]},
        ]
        prompt_text = tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True,
        )
        prompt_text += ACTION_REASON_ASSISTANT_PREFIX

        enc = tokenizer(prompt_text, return_tensors="pt", truncation=True, max_length=512).to(
            device
        )
        prompt_len = enc["input_ids"].shape[1]

        # Generate group of rollouts
        gen_kwargs = {
            "max_new_tokens": 128,
            "temperature": 0.7,
            "top_p": 0.9,
            "do_sample": True,
            "num_return_sequences": group_size,
            "pad_token_id": tokenizer.pad_token_id or tokenizer.eos_token_id,
        }

        model.eval()
        with torch.no_grad():
            input_expanded = enc["input_ids"].expand(group_size, -1)
            out = model.generate(input_expanded, **gen_kwargs)

        # Score each rollout
        scores = []
        responses = []
        for i in range(group_size):
            resp = tokenizer.decode(out[i, prompt_len:], skip_special_tokens=True).strip()
            full_resp = ACTION_REASON_ASSISTANT_PREFIX + resp
            score_result = score_action_reason_response(full_resp, spec)
            scores.append(score_result["score"])
            responses.append(resp)

        metrics["total_rollouts"] += group_size

        # Normalize as advantages
        scores_t = torch.tensor(scores, device=device)
        if scores_t.std() > 1e-8:
            advantages = (scores_t - scores_t.mean()) / scores_t.std()
        else:
            advantages = torch.zeros_like(scores_t)

        # Forward pass to get log-probs for each rollout
        model.train()
        step_loss = 0.0
        step_backward = 0
        step_skipped = 0
        delights = []

        for i in range(group_size):
            full_text = prompt_text + responses[i]
            full_enc = tokenizer(
                full_text,
                return_tensors="pt",
                truncation=True,
                max_length=512,
            ).to(device)

            resp_len = full_enc["input_ids"].shape[1] - prompt_len
            if resp_len < 1:
                continue

            outputs = model(full_enc["input_ids"][:, :-1])
            logits = outputs.logits[0, prompt_len - 1 : prompt_len - 1 + resp_len, :]
            targets = full_enc["input_ids"][0, prompt_len : prompt_len + resp_len]
            log_probs = F.log_softmax(logits, dim=-1)
            token_lps = log_probs.gather(1, targets.unsqueeze(1)).squeeze(1)
            mean_lp = token_lps.mean()

            advantage = advantages[i].item()
            surprisal = -mean_lp.detach().item()
            delight = advantage * surprisal
            delights.append(delight)

            # Kondo gate decision
            if kondo_gate is not None:
                gate_out = kondo_gate.compute_gate(
                    torch.tensor([mean_lp.item()], device=device),
                    torch.tensor([advantage], device=device),
                )
                if gate_out.gate_weights[0].item() < 0.5:
                    step_skipped += 1
                    continue

            # Backward pass
            loss = -advantage * mean_lp
            loss.backward()
            step_loss += loss.item()
            step_backward += 1

        if step_backward > 0:
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
        optimizer.zero_grad()

        metrics["steps"] += 1
        metrics["backward_passes"] += step_backward
        metrics["backward_skipped"] += step_skipped
        metrics["losses"].append(step_loss)
        if delights:
            metrics["mean_delights"].append(sum(abs(d) for d in delights) / len(delights))

        if (step + 1) % 5 == 0 or step == 0:
            backward_total = step_backward + step_skipped
            rate = step_backward / backward_total if backward_total > 0 else 0
            logger.info(
                f"  GRPO step {step + 1}/{steps}: loss={step_loss:.4f} "
                f"backward={step_backward}/{backward_total} ({rate:.0%}) "
                f"scores={[f'{s:.2f}' for s in scores]}"
            )

    return metrics


# ─── Main ────────────────────────────────────────────────────────────────────


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate training pipeline end-to-end")
    parser.add_argument("--model", default="Qwen/Qwen3-0.6B")
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    parser.add_argument("--sft-epochs", type=int, default=3)
    parser.add_argument(
        "--grpo-steps", type=int, default=24, help="GRPO steps (2 full passes over 12 prompts)"
    )
    parser.add_argument("--grpo-group-size", type=int, default=4)
    parser.add_argument("--optimizer", choices=["adamw", "apollo"], default="apollo")
    parser.add_argument("--apollo-rank", type=int, default=128)
    parser.add_argument("--kondo-gate-rate", type=float, default=0.3)
    parser.add_argument("--turboquant", action="store_true", default=True)
    parser.add_argument("--no-turboquant", action="store_true")
    parser.add_argument("--output", default="./validation_results.json")
    args = parser.parse_args()

    use_turboquant = args.turboquant and not args.no_turboquant
    device = args.device

    logger.info("=" * 70)
    logger.info("TRAINING PIPELINE VALIDATION")
    logger.info("=" * 70)
    logger.info(f"Model: {args.model}")
    logger.info(f"Device: {device}")
    logger.info(f"Optimizer: {args.optimizer}")
    logger.info(f"Kondo gate rate: {args.kondo_gate_rate}")
    logger.info(f"TurboQuant: {use_turboquant}")
    logger.info("=" * 70)

    # Load model
    logger.info("Loading model...")
    t0 = time.time()
    tokenizer = AutoTokenizer.from_pretrained(args.model, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    model = AutoModelForCausalLM.from_pretrained(
        args.model,
        torch_dtype=torch.bfloat16,
        trust_remote_code=True,
    ).to(device)
    model.gradient_checkpointing_enable()

    load_time = time.time() - t0
    logger.info(f"Model loaded in {load_time:.1f}s")

    # GPU memory
    if device == "cuda":
        mem = torch.cuda.memory_allocated() / 1e9
        logger.info(f"GPU memory after model load: {mem:.1f} GB")

    # TurboQuant settings
    tq_settings = None
    if use_turboquant:
        tq_settings = TurboQuantSettings(key_bits=3.5, value_bits=3.5, residual_length=128)

    # ── Phase 1: Baseline eval ──────────────────────────────────────────
    logger.info("\n" + "=" * 70)
    logger.info("PHASE 1: BASELINE EVAL")
    logger.info("=" * 70)
    t0 = time.time()
    baseline = run_eval(model, tokenizer, device, tag="baseline")
    baseline_time = time.time() - t0
    logger.info(
        f"Baseline: score={baseline['avg_score']:.4f} "
        f"policy={baseline['policy_alignment_rate']:.4f} "
        f"format={baseline['format_rate']:.4f} "
        f"action={baseline['action_rate']:.4f} "
        f"cue={baseline['concrete_cue_rate']:.4f} "
        f"({baseline_time:.1f}s)"
    )

    # ── Phase 2: Create optimizer ────────────────────────────────────────
    if args.optimizer == "apollo":
        try:
            from apollo_torch import APOLLOAdamW

            _LOW_RANK_HINTS = (
                "q_proj",
                "k_proj",
                "v_proj",
                "o_proj",
                "gate_proj",
                "up_proj",
                "down_proj",
                "c_attn",
                "c_proj",
                "c_fc",
                "w1",
                "w2",
                "w3",
            )
            lowrank, regular = [], []
            for name, param in model.named_parameters():
                if not param.requires_grad:
                    continue
                if param.ndim >= 2 and any(h in name for h in _LOW_RANK_HINTS):
                    lowrank.append(param)
                else:
                    regular.append(param)
            groups = []
            if regular:
                groups.append({"params": regular})
            if lowrank:
                groups.append(
                    {
                        "params": lowrank,
                        "rank": args.apollo_rank,
                        "proj": "random",
                        "scale_type": "channel",
                        "scale": 32.0,
                        "update_proj_gap": 200,
                        "proj_type": "std",
                    }
                )
            optimizer = APOLLOAdamW(groups, lr=5e-5, weight_decay=0.0)
            logger.info(f"APOLLO optimizer: {len(lowrank)} low-rank, {len(regular)} regular")
        except ImportError:
            logger.warning("apollo-torch not available, falling back to AdamW")
            optimizer = torch.optim.AdamW(model.parameters(), lr=5e-5)
    else:
        optimizer = torch.optim.AdamW(model.parameters(), lr=5e-5)

    if device == "cuda":
        mem = torch.cuda.memory_allocated() / 1e9
        logger.info(f"GPU memory after optimizer: {mem:.1f} GB")

    # ── Phase 3: SFT warm-up ────────────────────────────────────────────
    logger.info("\n" + "=" * 70)
    logger.info("PHASE 3: SFT WARM-UP")
    logger.info("=" * 70)
    t0 = time.time()
    sft_losses = sft_warmup(model, tokenizer, optimizer, device, epochs=args.sft_epochs)
    sft_time = time.time() - t0
    logger.info(f"SFT complete in {sft_time:.1f}s, final loss={sft_losses[-1]:.4f}")

    # ── Phase 3b: Post-SFT eval ─────────────────────────────────────────
    logger.info("\n" + "=" * 70)
    logger.info("PHASE 3b: POST-SFT EVAL")
    logger.info("=" * 70)
    t0 = time.time()
    post_sft = run_eval(model, tokenizer, device, tag="post_sft")
    post_sft_time = time.time() - t0
    logger.info(
        f"Post-SFT: score={post_sft['avg_score']:.4f} "
        f"policy={post_sft['policy_alignment_rate']:.4f} "
        f"format={post_sft['format_rate']:.4f} "
        f"({post_sft_time:.1f}s)"
    )

    # ── Phase 4: GRPO + Kondo ────────────────────────────────────────────
    logger.info("\n" + "=" * 70)
    logger.info("PHASE 4: GRPO + KONDO GATE")
    logger.info("=" * 70)
    t0 = time.time()
    grpo_metrics = grpo_with_kondo(
        model,
        tokenizer,
        optimizer,
        device,
        steps=args.grpo_steps,
        group_size=args.grpo_group_size,
        kondo_gate_rate=args.kondo_gate_rate,
    )
    grpo_time = time.time() - t0
    backward_total = grpo_metrics["backward_passes"] + grpo_metrics["backward_skipped"]
    backward_rate = grpo_metrics["backward_passes"] / backward_total if backward_total > 0 else 0
    logger.info(
        f"GRPO complete in {grpo_time:.1f}s: "
        f"{grpo_metrics['steps']} steps, "
        f"backward={grpo_metrics['backward_passes']}/{backward_total} ({backward_rate:.0%})"
    )

    # ── Phase 5: Post-training eval ──────────────────────────────────────
    logger.info("\n" + "=" * 70)
    logger.info("PHASE 5: POST-TRAINING EVAL")
    logger.info("=" * 70)
    t0 = time.time()
    post_train = run_eval(model, tokenizer, device, tag="post_training")
    post_train_time = time.time() - t0
    logger.info(
        f"Post-train: score={post_train['avg_score']:.4f} "
        f"policy={post_train['policy_alignment_rate']:.4f} "
        f"format={post_train['format_rate']:.4f} "
        f"({post_train_time:.1f}s)"
    )

    # ── Results ──────────────────────────────────────────────────────────
    print("\n" + "=" * 70)
    print("RESULTS COMPARISON")
    print("=" * 70)
    print(f"{'Metric':<30} {'Baseline':>10} {'Post-SFT':>10} {'Post-GRPO':>10} {'Delta':>10}")
    print("-" * 70)

    def delta_str(before: float, after: float) -> str:
        d = after - before
        sign = "+" if d >= 0 else ""
        return f"{sign}{d:.4f}"

    metrics_to_compare = [
        ("Avg Score", "avg_score"),
        ("Policy Alignment", "policy_alignment_rate"),
        ("Strict Format Rate", "format_rate"),
        ("Action Verb Rate", "action_rate"),
        ("Concrete Cue Rate", "concrete_cue_rate"),
    ]

    for label, key in metrics_to_compare:
        b = baseline[key]
        s = post_sft[key]
        p = post_train[key]
        print(f"{label:<30} {b:>10.4f} {s:>10.4f} {p:>10.4f} {delta_str(b, p):>10}")

    print("-" * 70)
    print(f"{'GRPO backward rate':<30} {'':>10} {'':>10} {backward_rate:>10.2%}")
    print(f"{'Total rollouts':<30} {'':>10} {'':>10} {grpo_metrics['total_rollouts']:>10}")
    print(f"{'Backward passes':<30} {'':>10} {'':>10} {grpo_metrics['backward_passes']:>10}")
    print(f"{'Backward skipped':<30} {'':>10} {'':>10} {grpo_metrics['backward_skipped']:>10}")
    if grpo_metrics["mean_delights"]:
        avg_delight = sum(grpo_metrics["mean_delights"]) / len(grpo_metrics["mean_delights"])
        print(f"{'Avg |delight|':<30} {'':>10} {'':>10} {avg_delight:>10.4f}")

    print("=" * 70)

    # Check if there's improvement
    improved = post_train["avg_score"] > baseline["avg_score"]
    if improved:
        print(
            f"\nIMPROVEMENT: {delta_str(baseline['avg_score'], post_train['avg_score'])} on avg score"
        )
    else:
        print(
            f"\nNO IMPROVEMENT: {delta_str(baseline['avg_score'], post_train['avg_score'])} on avg score"
        )

    # Save results
    report = {
        "model": args.model,
        "device": device,
        "optimizer": args.optimizer,
        "kondo_gate_rate": args.kondo_gate_rate,
        "turboquant": use_turboquant,
        "baseline": {k: v for k, v in baseline.items() if k != "results"},
        "post_sft": {k: v for k, v in post_sft.items() if k != "results"},
        "post_training": {k: v for k, v in post_train.items() if k != "results"},
        "grpo_metrics": {k: v for k, v in grpo_metrics.items() if k != "losses"},
        "sft_losses": sft_losses,
        "timing": {
            "model_load": load_time,
            "baseline_eval": baseline_time,
            "sft": sft_time,
            "post_sft_eval": post_sft_time,
            "grpo": grpo_time,
            "post_train_eval": post_train_time,
        },
        "improved": improved,
    }

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, indent=2))
    logger.info(f"\nFull report: {output_path}")

    return 0 if improved else 1


if __name__ == "__main__":
    raise SystemExit(main())
