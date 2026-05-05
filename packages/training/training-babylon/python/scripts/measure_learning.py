#!/usr/bin/env python3
"""
Measure actual learning: does the model improve over training ticks?

Runs team RL with periodic eval checkpoints to produce a learning curve.
Evals on the deterministic trading prompts (same as validate_training_pipeline).

This is the science: baseline eval → SFT warmup → online RL ticks with
periodic eval → plot improvement trajectory.

Usage:
    python scripts/measure_learning.py --mock --model Qwen/Qwen3-4B --ticks 40
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
import time
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
logger = logging.getLogger("learning")


def eval_team(team: TeamModel, device: str) -> dict:
    """Evaluate a team model on the 12 trading prompts."""
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
                temperature=0.7,
                top_p=0.9,
                do_sample=True,
                pad_token_id=team.tokenizer.pad_token_id or team.tokenizer.eos_token_id,
            )
        resp = team.tokenizer.decode(
            out[0, enc["input_ids"].shape[1] :], skip_special_tokens=True
        ).strip()
        score_result = score_action_reason_response(ACTION_REASON_ASSISTANT_PREFIX + resp, spec)
        results.append(score_result)
    team.model.train()

    scores = [r["score"] for r in results]
    policy = [r["policy_alignment"] for r in results if r["policy_alignment"] is not None]
    return {
        "avg_score": round(sum(scores) / len(scores), 4),
        "policy_rate": round(sum(1 for a in policy if a) / max(len(policy), 1), 4),
        "format_rate": round(
            sum(1 for r in results if r["checks"].get("strict_two_lines")) / len(results), 4
        ),
        "action_rate": round(
            sum(1 for r in results if r["checks"].get("has_action_verb")) / len(results), 4
        ),
        "cue_rate": round(
            sum(1 for r in results if r["checks"].get("has_concrete_cue")) / len(results), 4
        ),
    }


def sft_warmup(team: TeamModel, device: str, epochs: int = 2) -> list[float]:
    """SFT warmup on alignment samples."""
    team.model.train()
    losses = []
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
            input_ids = enc["input_ids"][:, :-1]
            labels = enc["input_ids"][:, 1:].clone()
            labels[:, : prompt_len - 1] = -100
            outputs = team.model(input_ids)
            loss = F.cross_entropy(
                outputs.logits.view(-1, outputs.logits.size(-1)),
                labels.view(-1),
                ignore_index=-100,
            )
            loss.backward()
            torch.nn.utils.clip_grad_norm_(team.model.parameters(), 1.0)
            team.optimizer.step()
            team.optimizer.zero_grad()
            epoch_loss += loss.item()
        avg = epoch_loss / max(len(ACTION_REASON_ALIGNMENT_SAMPLES), 1)
        losses.append(avg)
        logger.info(f"  SFT epoch {epoch + 1}/{epochs}: loss={avg:.4f}")
    return losses


async def main_async(args):
    device = args.device
    kondo_rate = args.kondo_rate

    logger.info("=" * 70)
    logger.info("MEASURING LEARNING: SFT warmup + Online RL with Kondo gate")
    logger.info(f"Model: {args.model} | Kondo: {kondo_rate} | Ticks: {args.ticks}")
    logger.info(f"Eval every: {args.eval_every} ticks | SFT epochs: {args.sft_epochs}")
    logger.info("=" * 70)

    # Use gray team for eval (neutral trader, matches eval prompts)
    config = TeamRLConfig(
        model_name=args.model,
        device=device,
        teams=[
            TeamConfig("red", num_agents=args.agents_per_team, learning_rate=5e-6),
            TeamConfig("blue", num_agents=args.agents_per_team, learning_rate=5e-6),
            TeamConfig("gray", num_agents=args.agents_per_team, learning_rate=5e-6),
        ],
        kondo_gate_rate=kondo_rate,
        kondo_hard=True,
        apollo_rank=128,
        ticks=args.ticks,
    )

    teams = {}
    for tc in config.teams:
        team = TeamModel(tc, config)
        team.setup()
        teams[tc.name] = team

    if device == "cuda":
        logger.info(f"GPU memory: {torch.cuda.memory_allocated() / 1e9:.2f} GB")

    learning_curve = []

    # ── Phase 1: Baseline eval ───────────────────────────────────────
    logger.info("\n--- BASELINE EVAL ---")
    baseline = {}
    for tn, tm in teams.items():
        baseline[tn] = eval_team(tm, device)
        logger.info(
            f"  {tn}: score={baseline[tn]['avg_score']} format={baseline[tn]['format_rate']} policy={baseline[tn]['policy_rate']}"
        )
    learning_curve.append({"tick": 0, "phase": "baseline", "evals": baseline})

    # ── Phase 2: SFT warmup ─────────────────────────────────────────
    if args.sft_epochs > 0:
        logger.info(f"\n--- SFT WARMUP ({args.sft_epochs} epochs) ---")
        for tn, tm in teams.items():
            sft_warmup(tm, device, epochs=args.sft_epochs)

        logger.info("\n--- POST-SFT EVAL ---")
        post_sft = {}
        for tn, tm in teams.items():
            post_sft[tn] = eval_team(tm, device)
            d = post_sft[tn]["avg_score"] - baseline[tn]["avg_score"]
            logger.info(
                f"  {tn}: score={post_sft[tn]['avg_score']} ({d:+.4f}) format={post_sft[tn]['format_rate']}"
            )
        learning_curve.append({"tick": 0, "phase": "post_sft", "evals": post_sft})

    # ── Phase 3: Online RL with periodic eval ────────────────────────
    logger.info(f"\n--- ONLINE RL: {args.ticks} ticks, eval every {args.eval_every} ---")

    bridge = VerifiableGameBridge(num_npcs=args.agents_per_team * 3, seed=args.seed)
    total_agents = args.agents_per_team * 3
    archetypes = (
        ["red"] * args.agents_per_team
        + ["blue"] * args.agents_per_team
        + ["gray"] * args.agents_per_team
    )
    await bridge.initialize(num_npcs=total_agents, archetypes=archetypes)

    assignments = {}
    idx = 0
    for tc in config.teams:
        names = AGENT_NAMES[tc.name]
        for i in range(tc.num_agents):
            assignments[bridge.npc_ids[idx]] = (tc.name, names[i % len(names)])
            idx += 1

    for tick in range(1, args.ticks + 1):
        tick_start = time.time()
        experiences = {tn: [] for tn in teams}

        for npc_id, (team_name, agent_name) in assignments.items():
            team = teams[team_name]
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
                experiences[team_name].append(
                    {
                        "input_ids": input_ids,
                        "output_ids": output_ids,
                        "reward": reward,
                        "agent_name": agent_name,
                    }
                )
            except Exception as e:
                pass

        for tn, tm in teams.items():
            if experiences[tn]:
                tm.train_on_batch(experiences[tn])

        await bridge.tick()
        tick_time = time.time() - tick_start

        # Log
        if tick % 5 == 0 or tick == 1:
            parts = [f"tick {tick}/{args.ticks} ({tick_time:.1f}s)"]
            for tn, tm in teams.items():
                s = tm.get_stats()
                bt = s["backward"] + s["skipped"]
                rate = s["backward"] / bt if bt > 0 else 0
                parts.append(f"{tn}: bk={rate:.0%} r={s['mean_reward']:.3f}")
            logger.info("  " + " | ".join(parts))

        # Periodic eval
        if tick % args.eval_every == 0:
            logger.info(f"\n  --- EVAL at tick {tick} ---")
            tick_eval = {}
            for tn, tm in teams.items():
                tick_eval[tn] = eval_team(tm, device)
                d = tick_eval[tn]["avg_score"] - baseline[tn]["avg_score"]
                logger.info(f"    {tn}: score={tick_eval[tn]['avg_score']} ({d:+.4f} vs baseline)")
            learning_curve.append({"tick": tick, "phase": f"tick_{tick}", "evals": tick_eval})
            logger.info("")

    # ── Final eval ───────────────────────────────────────────────────
    logger.info("\n--- FINAL EVAL ---")
    final = {}
    for tn, tm in teams.items():
        final[tn] = eval_team(tm, device)
        d = final[tn]["avg_score"] - baseline[tn]["avg_score"]
        logger.info(
            f"  {tn}: score={final[tn]['avg_score']} ({d:+.4f} vs baseline) format={final[tn]['format_rate']} policy={final[tn]['policy_rate']}"
        )
    learning_curve.append({"tick": args.ticks, "phase": "final", "evals": final})

    # ── Learning curve summary ───────────────────────────────────────
    print("\n" + "=" * 80)
    print("LEARNING CURVE")
    print("=" * 80)
    print(f"{'Phase':<15} {'Tick':>5} |", end="")
    for tn in teams:
        print(f" {tn + ' score':>12} {tn + ' fmt':>10} {tn + ' pol':>10} |", end="")
    print()
    print("-" * 80)

    for point in learning_curve:
        print(f"{point['phase']:<15} {point['tick']:>5} |", end="")
        for tn in teams:
            e = point["evals"].get(tn, {})
            print(
                f" {e.get('avg_score', 0):>12.4f} {e.get('format_rate', 0):>10.4f} {e.get('policy_rate', 0):>10.4f} |",
                end="",
            )
        print()

    print("=" * 80)

    # Delta summary
    print("\nIMPROVEMENT (baseline → final):")
    for tn in teams:
        b = baseline[tn]["avg_score"]
        f = final[tn]["avg_score"]
        bf = baseline[tn]["format_rate"]
        ff = final[tn]["format_rate"]
        bp = baseline[tn]["policy_rate"]
        fp = final[tn]["policy_rate"]
        print(
            f"  {tn}: score {b:.4f} → {f:.4f} ({f - b:+.4f}) | format {bf:.0%} → {ff:.0%} | policy {bp:.0%} → {fp:.0%}"
        )

    # Team training stats
    print("\nTRAINING STATS:")
    for tn, tm in teams.items():
        s = tm.get_stats()
        bt = s["backward"] + s["skipped"]
        rate = s["backward"] / bt if bt > 0 else 0
        print(
            f"  {tn}: {s['experiences']} exp, {rate:.0%} backward, reward={s['mean_reward']:.4f}, delight={s['cumulative_delight']:.1f}"
        )

    if device == "cuda":
        print(f"\nGPU memory: {torch.cuda.memory_allocated() / 1e9:.2f} GB")

    # Save
    result = {
        "config": {
            "model": args.model,
            "kondo_rate": kondo_rate,
            "ticks": args.ticks,
            "sft_epochs": args.sft_epochs,
            "agents_per_team": args.agents_per_team,
        },
        "learning_curve": learning_curve,
        "team_stats": {tn: tm.get_stats() for tn, tm in teams.items()},
    }
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, indent=2, default=str))
    logger.info(f"\nResults: {out}")


def main():
    parser = argparse.ArgumentParser(description="Measure learning with periodic eval")
    parser.add_argument("--model", default="Qwen/Qwen3-4B")
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    parser.add_argument("--agents-per-team", type=int, default=5)
    parser.add_argument("--ticks", type=int, default=40)
    parser.add_argument("--eval-every", type=int, default=10)
    parser.add_argument("--sft-epochs", type=int, default=3)
    parser.add_argument("--kondo-rate", type=float, default=0.03)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--mock", action="store_true", default=True)
    parser.add_argument("--output", default="learning_curve.json")
    args = parser.parse_args()
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
