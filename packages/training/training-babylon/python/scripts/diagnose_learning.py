#!/usr/bin/env python3
"""
Deep diagnostic: show actual model outputs at baseline vs trained.

Trains a single gray team model (simplest case) and captures every
eval prompt response at baseline, post-SFT, and post-RL. Then analyzes:
  - Which prompts improved vs regressed
  - Format compliance per prompt
  - Policy alignment per prompt
  - Concrete cue quality
  - Signs of overfitting (repetitive/templated responses)
  - Signs of underfitting (still ignoring format)

Usage:
    python scripts/diagnose_learning.py --model Qwen/Qwen3-4B --ticks 30
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from pathlib import Path

import torch
import torch.nn.functional as F

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
from src.training.team_rl import (
    AGENT_NAMES,
    TeamConfig,
    TeamModel,
    TeamRLConfig,
    compute_reward,
    parse_action,
)
from src.training.verifiable_game import VerifiableGameBridge

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("diagnose")


def generate_eval_responses(team: TeamModel, device: str) -> list[dict]:
    """Generate and score responses for all 12 eval prompts."""
    team.model.eval()
    results = []
    for spec in ACTION_REASON_PROMPTS:
        messages = [
            {"role": "system", "content": ACTION_REASON_SYSTEM_PROMPT},
            {"role": "user", "content": spec["prompt"]},
        ]
        prompt_text = team.tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True,
        )
        prompt_text += ACTION_REASON_ASSISTANT_PREFIX
        enc = team.tokenizer(prompt_text, return_tensors="pt", truncation=True, max_length=1024).to(
            device
        )
        with torch.no_grad():
            out = team.model.generate(
                enc["input_ids"],
                attention_mask=enc["attention_mask"],
                max_new_tokens=128,
                temperature=0.3,
                top_p=0.9,
                do_sample=True,
                pad_token_id=team.tokenizer.pad_token_id or team.tokenizer.eos_token_id,
            )
        resp = team.tokenizer.decode(
            out[0, enc["input_ids"].shape[1] :], skip_special_tokens=True
        ).strip()
        full_resp = ACTION_REASON_ASSISTANT_PREFIX + resp
        score_result = score_action_reason_response(full_resp, spec)
        results.append(
            {
                "id": spec["id"],
                "slice": spec.get("slice", ""),
                "preferred": spec.get("preferred_actions", []),
                "rejected": spec.get("rejected_actions", []),
                "response": full_resp,
                "score": score_result["score"],
                "checks": score_result["checks"],
                "action_verb": score_result.get("action_verb"),
                "policy_ok": score_result.get("policy_alignment"),
            }
        )
    team.model.train()
    return results


def sft_warmup(team: TeamModel, device: str, epochs: int):
    team.model.train()
    for epoch in range(epochs):
        epoch_loss = 0.0
        for sample in ACTION_REASON_ALIGNMENT_SAMPLES:
            messages = [
                {"role": "system", "content": ACTION_REASON_SYSTEM_PROMPT},
                {"role": "user", "content": sample["prompt"]},
            ]
            prompt_text = team.tokenizer.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=True,
            )
            full_text = prompt_text + sample["response"]
            enc = team.tokenizer(
                full_text, return_tensors="pt", truncation=True, max_length=512
            ).to(device)
            prompt_enc = team.tokenizer(
                prompt_text, return_tensors="pt", truncation=True, max_length=512
            )
            prompt_len = prompt_enc["input_ids"].shape[1]
            labels = enc["input_ids"][:, 1:].clone()
            labels[:, : prompt_len - 1] = -100
            outputs = team.model(enc["input_ids"][:, :-1])
            loss = F.cross_entropy(
                outputs.logits.view(-1, outputs.logits.size(-1)), labels.view(-1), ignore_index=-100
            )
            loss.backward()
            torch.nn.utils.clip_grad_norm_(team.model.parameters(), 1.0)
            team.optimizer.step()
            team.optimizer.zero_grad()
            epoch_loss += loss.item()
        logger.info(
            f"  SFT epoch {epoch + 1}/{epochs}: loss={epoch_loss / len(ACTION_REASON_ALIGNMENT_SAMPLES):.4f}"
        )


def print_comparison(phase_a: str, results_a: list, phase_b: str, results_b: list):
    """Print side-by-side comparison of two eval phases."""
    print(f"\n{'=' * 100}")
    print(f"COMPARISON: {phase_a} → {phase_b}")
    print(f"{'=' * 100}")

    improved = 0
    regressed = 0
    same = 0

    for a, b in zip(results_a, results_b, strict=False):
        delta = b["score"] - a["score"]
        if delta > 0.01:
            symbol = "+"
            improved += 1
        elif delta < -0.01:
            symbol = "-"
            regressed += 1
        else:
            symbol = "="
            same += 1

        # Only show interesting cases (improved, regressed, or policy-relevant)
        interesting = abs(delta) > 0.01 or a.get("policy_ok") != b.get("policy_ok")
        if not interesting:
            continue

        print(
            f"\n[{symbol}] {a['id']} ({a['slice']}) score: {a['score']:.2f} → {b['score']:.2f} ({delta:+.2f})"
        )
        print(f"    preferred={a['preferred']} rejected={a['rejected']}")
        print(f"    {phase_a}: verb={a['action_verb']} policy={a['policy_ok']}")
        print(f'      "{a["response"][:120]}"')
        print(f"    {phase_b}: verb={b['action_verb']} policy={b['policy_ok']}")
        print(f'      "{b["response"][:120]}"')

        # Flag issues
        if b["score"] < a["score"]:
            if not b["checks"].get("strict_two_lines") and a["checks"].get("strict_two_lines"):
                print("    !! FORMAT REGRESSION: lost strict two-line format")
            if b.get("policy_ok") is False and a.get("policy_ok") is True:
                print("    !! POLICY REGRESSION: was correct, now wrong action")
        if b.get("policy_ok") is True and a.get("policy_ok") is False:
            print("    ** POLICY IMPROVEMENT: learned correct action")

    print(f"\nSummary: {improved} improved, {same} same, {regressed} regressed")


def analyze_overfitting(results: list[dict]):
    """Check for signs of overfitting: repetitive/templated responses."""
    responses = [r["response"] for r in results]
    # Check for exact duplicates
    unique = set(responses)
    if len(unique) < len(responses):
        print(
            f"  !! OVERFITTING SIGNAL: {len(responses) - len(unique)} duplicate responses out of {len(responses)}"
        )

    # Check for template repetition (same first 30 chars)
    prefixes = [r[:30] for r in responses]
    unique_prefixes = set(prefixes)
    if len(unique_prefixes) < len(responses) * 0.5:
        print(
            f"  !! OVERFITTING SIGNAL: only {len(unique_prefixes)} unique response prefixes out of {len(responses)}"
        )
        from collections import Counter

        for prefix, count in Counter(prefixes).most_common(3):
            if count > 1:
                print(f'     repeated {count}x: "{prefix}..."')

    # Check response length variance
    lengths = [len(r) for r in responses]
    avg_len = sum(lengths) / len(lengths)
    len_std = (sum((l - avg_len) ** 2 for l in lengths) / len(lengths)) ** 0.5
    cv = len_std / max(avg_len, 1)
    if cv < 0.1:
        print(
            f"  !! OVERFITTING SIGNAL: very low length variance (CV={cv:.3f}), responses may be templated"
        )
    else:
        print(
            f"  OK: response length variance is healthy (CV={cv:.3f}, mean={avg_len:.0f}, std={len_std:.0f})"
        )

    # Check verb diversity
    verbs = [r["action_verb"] for r in results if r["action_verb"]]
    from collections import Counter

    verb_dist = Counter(verbs)
    print(f"  Action verb distribution: {dict(verb_dist)}")
    if len(verb_dist) <= 1:
        print("  !! UNDERFITTING SIGNAL: only using one action verb")


async def main_async(args):
    device = args.device
    logger.info("=" * 70)
    logger.info("DEEP LEARNING DIAGNOSTIC")
    logger.info(f"Model: {args.model} | Ticks: {args.ticks} | Kondo: {args.kondo_rate}")
    logger.info("=" * 70)

    config = TeamRLConfig(
        model_name=args.model,
        device=device,
        teams=[TeamConfig("gray", num_agents=args.agents, learning_rate=5e-6)],
        kondo_gate_rate=args.kondo_rate,
        kondo_hard=True,
        apollo_rank=128,
    )

    team = TeamModel(config.teams[0], config)
    team.setup()
    if device == "cuda":
        logger.info(f"GPU: {torch.cuda.memory_allocated() / 1e9:.2f} GB")

    snapshots = {}

    # ── Baseline ─────────────────────────────────────────────────────
    logger.info("\n--- PHASE: BASELINE ---")
    snapshots["baseline"] = generate_eval_responses(team, device)
    avg = sum(r["score"] for r in snapshots["baseline"]) / len(snapshots["baseline"])
    logger.info(f"Baseline avg score: {avg:.4f}")
    print("\nBASELINE RESPONSES:")
    for r in snapshots["baseline"]:
        print(
            f"  [{r['id']}] score={r['score']:.2f} verb={r['action_verb']} policy={r['policy_ok']}"
        )
        print(f'    "{r["response"][:100]}"')
    print("\nBASELINE ANALYSIS:")
    analyze_overfitting(snapshots["baseline"])

    # ── SFT ──────────────────────────────────────────────────────────
    logger.info("\n--- PHASE: SFT WARMUP ---")
    sft_warmup(team, device, epochs=args.sft_epochs)
    snapshots["post_sft"] = generate_eval_responses(team, device)
    avg = sum(r["score"] for r in snapshots["post_sft"]) / len(snapshots["post_sft"])
    logger.info(f"Post-SFT avg score: {avg:.4f}")
    print_comparison("baseline", snapshots["baseline"], "post_sft", snapshots["post_sft"])
    print("\nPOST-SFT ANALYSIS:")
    analyze_overfitting(snapshots["post_sft"])

    # ── Online RL ────────────────────────────────────────────────────
    logger.info(f"\n--- PHASE: ONLINE RL ({args.ticks} ticks) ---")
    bridge = VerifiableGameBridge(num_npcs=args.agents, seed=42)
    await bridge.initialize(num_npcs=args.agents, archetypes=["gray"] * args.agents)
    assignments = {}
    names = AGENT_NAMES["gray"]
    for i, npc_id in enumerate(bridge.npc_ids[: args.agents]):
        assignments[npc_id] = names[i % len(names)]

    tick_rewards = []
    for tick in range(1, args.ticks + 1):
        experiences = []
        tick_r = []
        for npc_id, agent_name in assignments.items():
            try:
                scenario = await bridge.get_scenario(npc_id)
                resp, input_ids, output_ids = team.generate_action(agent_name, scenario)
                action = parse_action(resp) or {"action": "wait"}
                outcome = await bridge.execute_action(
                    npc_id=npc_id,
                    action_type=action.get("action", "wait"),
                    ticker=action.get("ticker"),
                    amount=action.get("amount"),
                    side=action.get("side") or action.get("direction"),
                )
                reward = compute_reward(action, outcome, scenario)
                tick_r.append(reward)
                experiences.append(
                    {
                        "input_ids": input_ids,
                        "output_ids": output_ids,
                        "reward": reward,
                        "agent_name": agent_name,
                    }
                )
            except Exception as e:
                pass
        if experiences:
            team.train_on_batch(experiences)
        await bridge.tick()
        tick_rewards.append(sum(tick_r) / max(len(tick_r), 1))

        if tick % 10 == 0:
            s = team.get_stats()
            bt = s["backward"] + s["skipped"]
            rate = s["backward"] / bt if bt > 0 else 0
            logger.info(f"  tick {tick}: bk={rate:.0%} r={s['mean_reward']:.3f}")

            # Mid-training eval
            mid = generate_eval_responses(team, device)
            avg = sum(r["score"] for r in mid) / len(mid)
            logger.info(f"  tick {tick} eval: avg_score={avg:.4f}")
            snapshots[f"tick_{tick}"] = mid

    # ── Final ────────────────────────────────────────────────────────
    logger.info("\n--- PHASE: FINAL ---")
    snapshots["final"] = generate_eval_responses(team, device)

    print_comparison("post_sft", snapshots["post_sft"], "final", snapshots["final"])
    print_comparison("baseline", snapshots["baseline"], "final", snapshots["final"])

    print("\nFINAL RESPONSES:")
    for r in snapshots["final"]:
        print(
            f"  [{r['id']}] score={r['score']:.2f} verb={r['action_verb']} policy={r['policy_ok']}"
        )
        print(f'    "{r["response"][:120]}"')

    print("\nFINAL ANALYSIS:")
    analyze_overfitting(snapshots["final"])

    # ── Reward trajectory ────────────────────────────────────────────
    print(f"\n{'=' * 60}")
    print("REWARD TRAJECTORY (per-tick mean)")
    print(f"{'=' * 60}")
    for i, r in enumerate(tick_rewards):
        bar = "#" * int(r * 50) if r > 0 else "-" * int(abs(r) * 50)
        print(f"  tick {i + 1:>3}: {r:>7.4f} {bar}")

    # ── Per-prompt learning trajectory ───────────────────────────────
    print(f"\n{'=' * 80}")
    print("PER-PROMPT SCORE TRAJECTORY")
    print(f"{'=' * 80}")
    phases = (
        ["baseline", "post_sft"]
        + [f"tick_{t}" for t in range(10, args.ticks + 1, 10) if f"tick_{t}" in snapshots]
        + ["final"]
    )
    print(f"{'Prompt':<40}", end="")
    for phase in phases:
        print(f" {phase:>10}", end="")
    print()
    print("-" * (40 + 11 * len(phases)))

    for i, spec in enumerate(ACTION_REASON_PROMPTS):
        print(f"{spec['id'][:38]:<40}", end="")
        for phase in phases:
            if phase in snapshots and i < len(snapshots[phase]):
                s = snapshots[phase][i]["score"]
                print(f" {s:>10.2f}", end="")
            else:
                print(f" {'':>10}", end="")
        print()

    # Save
    result = {
        "config": {"model": args.model, "ticks": args.ticks, "kondo": args.kondo_rate},
        "snapshots": {
            phase: [
                {
                    "id": r["id"],
                    "response": r["response"],
                    "score": r["score"],
                    "action_verb": r["action_verb"],
                    "policy_ok": r["policy_ok"],
                    "checks": r["checks"],
                }
                for r in results
            ]
            for phase, results in snapshots.items()
        },
        "tick_rewards": tick_rewards,
        "team_stats": team.get_stats(),
    }
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, indent=2, default=str))
    logger.info(f"\nFull diagnostic: {out}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="Qwen/Qwen3-4B")
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    parser.add_argument("--agents", type=int, default=5)
    parser.add_argument("--ticks", type=int, default=30)
    parser.add_argument("--sft-epochs", type=int, default=3)
    parser.add_argument("--kondo-rate", type=float, default=0.03)
    parser.add_argument("--output", default="diagnostic.json")
    args = parser.parse_args()
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
