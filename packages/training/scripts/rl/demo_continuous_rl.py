#!/usr/bin/env python3
"""
End-to-end demo: Multi-agent continuous RL with APOLLO + Kondo gate.

Runs entirely locally with a mock SimulationBridge — no external services needed.
Demonstrates:
  1. Multiple agents each with their own model on GPU
  2. Action generation with TurboQuant KV cache
  3. Kondo gate filtering (only high-delight interactions train)
  4. APOLLO full-param optimizer updates
  5. Population-based training (replace worst agent with best)
  6. Eval improvement across training

Usage:
    python scripts/demo_continuous_rl.py
    python scripts/demo_continuous_rl.py --num-agents 2 --ticks 30 --model Qwen/Qwen3-0.6B
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import random
import sys
import time
from pathlib import Path
from typing import Any

import torch

SCRIPT_DIR = Path(__file__).resolve().parent
PYTHON_ROOT = SCRIPT_DIR.parent
sys.path.insert(0, str(PYTHON_ROOT))

from src.training.continuous_rl import (
    ContinuousRLAgent,
    ContinuousRLConfig,
    RewardTracker,
    _compute_reward,
)
from src.training.deterministic_eval import (
    ACTION_REASON_ASSISTANT_PREFIX,
    ACTION_REASON_PROMPTS,
    ACTION_REASON_SYSTEM_PROMPT,
    score_action_reason_response,
)
from src.training.simulation_bridge import (
    ActionOutcome,
    MarketState,
    NewsItem,
    PerpMarket,
    PredictionMarket,
    Scenario,
    SocialContext,
    TickResult,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("demo")


# ─── Mock Simulation Bridge ─────────────────────────────────────────────────


class MockSimulationBridge:
    """
    In-memory game simulation. No network, no database.
    Generates scenarios with varying market conditions and scores actions.
    """

    def __init__(self, num_npcs: int = 4, seed: int = 42):
        self.rng = random.Random(seed)
        self.tick_number = 0
        self.npc_ids: list[str] = [f"npc_{i:03d}" for i in range(num_npcs)]
        self.archetypes: dict[str, str] = {}
        self.balances: dict[str, float] = {}
        self.markets: list[dict[str, Any]] = []
        self._initialized = False

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass

    async def initialize(
        self,
        num_npcs: int = 4,
        seed: int = 42,
        archetypes: list[str] | None = None,
    ) -> dict[str, Any]:
        arch_pool = archetypes or ["trader", "analyst", "degen", "influencer"]
        for i, npc_id in enumerate(self.npc_ids):
            self.archetypes[npc_id] = arch_pool[i % len(arch_pool)]
            self.balances[npc_id] = 10000.0

        self.markets = self._generate_markets()
        self._initialized = True
        return {"status": "initialized", "npcIds": self.npc_ids}

    def _generate_markets(self) -> list[dict[str, Any]]:
        """Generate random prediction markets."""
        questions = [
            "Will BTC exceed $100K by end of month?",
            "Will ETH 2.0 staking yield exceed 5%?",
            "Will the Fed cut rates this quarter?",
            "Will AI regulation bill pass Senate?",
            "Will gold hit new ATH this week?",
        ]
        markets = []
        for i, q in enumerate(questions):
            yes_price = round(self.rng.uniform(0.2, 0.8), 2)
            markets.append(
                {
                    "id": f"market_{i}",
                    "question": q,
                    "yes_price": yes_price,
                    "no_price": round(1.0 - yes_price, 2),
                }
            )
        return markets

    async def get_scenario(self, npc_id: str) -> Scenario:
        """Build a scenario from current game state."""
        perps = [
            PerpMarket(
                ticker="BTC",
                current_price=round(60000 + self.rng.gauss(0, 2000), 2),
                change_percent_24h=round(self.rng.gauss(0, 3), 2),
                volume_24h=round(self.rng.uniform(1e6, 1e8), 0),
            ),
            PerpMarket(
                ticker="ETH",
                current_price=round(3000 + self.rng.gauss(0, 200), 2),
                change_percent_24h=round(self.rng.gauss(0, 4), 2),
                volume_24h=round(self.rng.uniform(5e5, 5e7), 0),
            ),
        ]
        predictions = [
            PredictionMarket(
                id=m["id"],
                question=m["question"],
                yes_price=m["yes_price"],
                no_price=m["no_price"],
            )
            for m in self.markets[:3]
        ]
        news = [
            NewsItem(
                content=self.rng.choice(
                    [
                        "Bitcoin ETF inflows hit record $1.2B",
                        "Federal Reserve signals cautious approach to rate changes",
                        "Major DeFi protocol reports security vulnerability",
                        "Institutional adoption of crypto accelerating",
                        "Regulatory clarity expected in coming weeks",
                    ]
                ),
                source=self.rng.choice(["CoinDesk", "Bloomberg", "Reuters"]),
                timestamp="2026-04-01T12:00:00Z",
            )
        ]

        return Scenario(
            npc_id=npc_id,
            archetype=self.archetypes.get(npc_id, "trader"),
            market_state=MarketState(
                perp_markets=perps,
                prediction_markets=predictions,
            ),
            positions=[],
            balance=self.balances.get(npc_id, 10000.0),
            recent_news=news,
            social_context=SocialContext(),
        )

    async def execute_action(
        self,
        npc_id: str,
        action_type: str,
        ticker: str | None = None,
        market_id: str | None = None,
        amount: float | None = None,
        side: str | None = None,
        position_id: str | None = None,
        reasoning: str | None = None,
    ) -> ActionOutcome:
        """Simulate action execution with varied rewards to drive Kondo gating."""
        if action_type == "wait":
            return ActionOutcome(
                success=False,
                pnl=0.0,
                new_balance=self.balances.get(npc_id, 10000),
                new_positions=[],
                social_impact={},
                events=[],
            )

        # Varied PnL: some actions are very profitable, most are mediocre
        roll = self.rng.random()
        if roll < 0.1:
            # Big win (rare, high delight when gated)
            pnl = round(self.rng.uniform(200, 500), 2)
        elif roll < 0.3:
            # Moderate win
            pnl = round(self.rng.uniform(20, 100), 2)
        elif roll < 0.7:
            # Mediocre (low delight, should be gated)
            pnl = round(self.rng.gauss(0, 10), 2)
        else:
            # Loss
            pnl = round(self.rng.uniform(-200, -20), 2)

        self.balances[npc_id] = self.balances.get(npc_id, 10000) + pnl
        social = {}
        if roll < 0.2:
            social = {"reputation_delta": 2, "likes_received": self.rng.randint(1, 5)}

        return ActionOutcome(
            success=True,
            pnl=pnl,
            new_balance=self.balances.get(npc_id, 10000),
            new_positions=[],
            social_impact=social,
            events=[],
        )

    async def tick(self) -> TickResult:
        """Advance simulation: shift market prices."""
        self.tick_number += 1
        for m in self.markets:
            shift = self.rng.gauss(0, 0.05)
            m["yes_price"] = max(0.05, min(0.95, m["yes_price"] + shift))
            m["no_price"] = round(1.0 - m["yes_price"], 2)
        return TickResult(
            tick_number=self.tick_number,
            events=[{"type": "market_update"}],
            market_changes=[],
        )


# ─── Eval (same as validation script) ───────────────────────────────────────


def run_eval(model, tokenizer, device: str) -> dict[str, Any]:
    """Score model on 12 trading prompts."""
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
        prompt_text += ACTION_REASON_ASSISTANT_PREFIX
        enc = tokenizer(prompt_text, return_tensors="pt", truncation=True, max_length=1024).to(
            device
        )
        with torch.no_grad():
            out = model.generate(
                enc["input_ids"],
                attention_mask=enc["attention_mask"],
                max_new_tokens=128,
                temperature=0.7,
                top_p=0.9,
                do_sample=True,
                pad_token_id=tokenizer.pad_token_id or tokenizer.eos_token_id,
            )
        resp = tokenizer.decode(
            out[0, enc["input_ids"].shape[1] :], skip_special_tokens=True
        ).strip()
        score_result = score_action_reason_response(ACTION_REASON_ASSISTANT_PREFIX + resp, spec)
        results.append(score_result)

    scores = [r["score"] for r in results]
    policy_aligned = [r["policy_alignment"] for r in results if r["policy_alignment"] is not None]
    return {
        "avg_score": round(sum(scores) / len(scores), 4),
        "policy_rate": round(sum(1 for a in policy_aligned if a) / max(len(policy_aligned), 1), 4),
        "format_rate": round(
            sum(1 for r in results if r["checks"].get("strict_two_lines")) / len(results), 4
        ),
    }


# ─── Main Demo ───────────────────────────────────────────────────────────────


async def run_demo(args: argparse.Namespace) -> dict[str, Any]:
    device = args.device
    num_agents = args.num_agents
    ticks = args.ticks

    logger.info("=" * 70)
    logger.info("CONTINUOUS RL DEMO — Multi-Agent with APOLLO + Kondo Gate")
    logger.info("=" * 70)
    logger.info(f"Model: {args.model} | Agents: {num_agents} | Ticks: {ticks}")
    logger.info(f"Optimizer: apollo | Kondo rate: {args.kondo_rate} | Device: {device}")
    logger.info("=" * 70)

    # ── Create agents ────────────────────────────────────────────────────
    agents: list[ContinuousRLAgent] = []
    archetypes = ["trader", "analyst", "degen", "influencer"]

    for i in range(num_agents):
        config = ContinuousRLConfig(
            model_name=args.model,
            device=device,
            optimizer="apollo",
            learning_rate=5e-5,
            apollo_rank=64,
            apollo_update_proj_gap=50,
            use_kondo=True,
            kondo_gate_rate=args.kondo_rate,
            kondo_hard=True,
            kondo_deterministic=True,
            use_turboquant=False,  # Skip for demo speed
            max_new_tokens=128,
            temperature=0.7,
            checkpoint_every=0,  # No checkpointing in demo
        )
        agent = ContinuousRLAgent(f"agent_{i}", config)
        agent.setup()
        agents.append(agent)
        logger.info(f"Agent {i} ({archetypes[i % len(archetypes)]}) ready")

    if device == "cuda":
        mem = torch.cuda.memory_allocated() / 1e9
        logger.info(f"GPU memory with {num_agents} agents: {mem:.2f} GB")

    # ── Baseline eval ────────────────────────────────────────────────────
    logger.info("\n--- BASELINE EVAL ---")
    baseline_scores = {}
    for agent in agents:
        score = run_eval(agent.model, agent.tokenizer, device)
        baseline_scores[agent.agent_id] = score
        logger.info(
            f"  [{agent.agent_id}] score={score['avg_score']} format={score['format_rate']} policy={score['policy_rate']}"
        )

    # ── SFT warmup: teach Action/Reason format before game play ──────────
    logger.info("\n--- SFT WARMUP (shared alignment data) ---")
    from src.training.deterministic_eval import ACTION_REASON_ALIGNMENT_SAMPLES

    for agent in agents:
        agent.model.train()
        for epoch in range(2):
            epoch_loss = 0.0
            for sample in ACTION_REASON_ALIGNMENT_SAMPLES:
                messages = [
                    {"role": "system", "content": ACTION_REASON_SYSTEM_PROMPT},
                    {"role": "user", "content": sample["prompt"]},
                ]
                prompt_text = agent.tokenizer.apply_chat_template(
                    messages,
                    tokenize=False,
                    add_generation_prompt=True,
                )
                full_text = prompt_text + sample["response"]
                enc = agent.tokenizer(
                    full_text,
                    return_tensors="pt",
                    truncation=True,
                    max_length=512,
                ).to(device)
                prompt_enc = agent.tokenizer(
                    prompt_text,
                    return_tensors="pt",
                    truncation=True,
                    max_length=512,
                )
                prompt_len = prompt_enc["input_ids"].shape[1]
                input_ids = enc["input_ids"][:, :-1]
                labels = enc["input_ids"][:, 1:].clone()
                labels[:, : prompt_len - 1] = -100
                outputs = agent.model(input_ids)
                loss = torch.nn.functional.cross_entropy(
                    outputs.logits.view(-1, outputs.logits.size(-1)),
                    labels.view(-1),
                    ignore_index=-100,
                )
                loss.backward()
                torch.nn.utils.clip_grad_norm_(agent.model.parameters(), 1.0)
                agent.optimizer.step()
                agent.optimizer.zero_grad()
                epoch_loss += loss.item()
            logger.info(
                f"  [{agent.agent_id}] SFT epoch {epoch + 1}/2: loss={epoch_loss / len(ACTION_REASON_ALIGNMENT_SAMPLES):.4f}"
            )

    logger.info("\n--- POST-SFT EVAL ---")
    post_sft_scores = {}
    for agent in agents:
        score = run_eval(agent.model, agent.tokenizer, device)
        post_sft_scores[agent.agent_id] = score
        delta = score["avg_score"] - baseline_scores[agent.agent_id]["avg_score"]
        logger.info(
            f"  [{agent.agent_id}] score={score['avg_score']} (delta={delta:+.4f}) format={score['format_rate']}"
        )

    # ── Create mock bridge ───────────────────────────────────────────────
    bridge = MockSimulationBridge(num_npcs=num_agents, seed=42)
    await bridge.initialize(num_npcs=num_agents, archetypes=archetypes[:num_agents])

    # Assign NPCs to agents
    npc_map = {agent.agent_id: bridge.npc_ids[i] for i, agent in enumerate(agents)}

    # ── Training loop ────────────────────────────────────────────────────
    logger.info(f"\n--- TRAINING: {ticks} ticks ---")
    all_metrics: list[dict[str, Any]] = []

    for tick in range(1, ticks + 1):
        tick_start = time.time()

        # Each agent acts and trains
        for agent in agents:
            npc_id = npc_map[agent.agent_id]
            scenario = await bridge.get_scenario(npc_id)
            response_text, input_ids, output_ids = agent.generate_action(scenario)

            action = agent.parse_action(response_text)
            if action is None:
                action = {"action": "wait", "reason": "parse_failed"}

            outcome = await bridge.execute_action(
                npc_id=npc_id,
                action_type=action.get("action", "wait"),
                ticker=action.get("ticker"),
                amount=action.get("amount"),
                side=action.get("side") or action.get("direction"),
            )

            reward = _compute_reward(action, outcome, scenario)
            metrics = agent.train_on_interaction(input_ids, output_ids, reward)
            metrics["agent"] = agent.agent_id
            metrics["tick"] = tick
            all_metrics.append(metrics)

        # Advance game
        await bridge.tick()

        # Log progress
        if tick % max(1, ticks // 5) == 0 or tick == 1:
            tick_time = time.time() - tick_start
            stats = [a.get_stats() for a in agents]
            total_backward = sum(s["total_backward_passes"] for s in stats)
            total_skipped = sum(s["total_backward_skipped"] for s in stats)
            bt = total_backward + total_skipped
            rate = total_backward / bt if bt > 0 else 0
            mean_reward = sum(s["mean_reward"] for s in stats) / len(stats)
            total_delight = sum(s["cumulative_delight"] for s in stats)
            logger.info(
                f"  tick {tick}/{ticks} | "
                f"backward={total_backward}/{bt} ({rate:.0%}) | "
                f"reward={mean_reward:.4f} | "
                f"delight={total_delight:.2f} | "
                f"{tick_time:.1f}s"
            )

        # ── PBT: replace weakest agent every pbt_interval ticks ──────
        if args.pbt and tick > 0 and tick % args.pbt_interval == 0 and num_agents >= 2:
            ranked = sorted(agents, key=lambda a: a.cumulative_delight, reverse=True)
            best = ranked[0]
            worst = ranked[-1]
            logger.info(
                f"  PBT: replacing {worst.agent_id} "
                f"(delight={worst.cumulative_delight:.2f}) "
                f"with {best.agent_id} (delight={best.cumulative_delight:.2f})"
            )
            if worst.model is not None and best.model is not None:
                worst.model.load_state_dict(best.model.state_dict())
            # Perturb LR
            import random as rng

            new_lr = best.config.learning_rate * rng.uniform(0.8, 1.2)
            worst.config.learning_rate = new_lr
            for pg in worst.optimizer.param_groups:
                pg["lr"] = new_lr
            worst.cumulative_delight = 0.0
            worst.reward_tracker = RewardTracker(ema_alpha=worst.config.reward_ema_alpha)
            worst.reward_tracker.mean = best.reward_tracker.mean

    # ── Post-training eval ───────────────────────────────────────────────
    logger.info("\n--- POST-TRAINING EVAL ---")
    post_scores = {}
    for agent in agents:
        score = run_eval(agent.model, agent.tokenizer, device)
        post_scores[agent.agent_id] = score
        b = baseline_scores[agent.agent_id]
        delta = score["avg_score"] - b["avg_score"]
        logger.info(
            f"  [{agent.agent_id}] score={score['avg_score']} "
            f"(delta={delta:+.4f}) format={score['format_rate']} policy={score['policy_rate']}"
        )

    # ── Summary ──────────────────────────────────────────────────────────
    print("\n" + "=" * 80)
    print("RESULTS")
    print("=" * 80)
    print(
        f"{'Agent':<12} {'Baseline':>10} {'Post-SFT':>10} {'Post-GRPO':>10} {'Delta':>10} {'Bkwd%':>8} {'Delight':>10}"
    )
    print("-" * 80)

    for agent in agents:
        b = baseline_scores[agent.agent_id]["avg_score"]
        s_sft = post_sft_scores[agent.agent_id]["avg_score"]
        p = post_scores[agent.agent_id]["avg_score"]
        s = agent.get_stats()
        bt = s["total_backward_passes"] + s["total_backward_skipped"]
        rate = s["total_backward_passes"] / bt if bt > 0 else 0
        print(
            f"{agent.agent_id:<12} {b:>10.4f} {s_sft:>10.4f} {p:>10.4f} {p - b:>+10.4f} "
            f"{rate:>7.0%} {s['cumulative_delight']:>10.2f}"
        )

    print("=" * 80)

    # Overall
    avg_baseline = sum(baseline_scores[a.agent_id]["avg_score"] for a in agents) / num_agents
    avg_post = sum(post_scores[a.agent_id]["avg_score"] for a in agents) / num_agents
    total_backward = sum(a.get_stats()["total_backward_passes"] for a in agents)
    total_skipped = sum(a.get_stats()["total_backward_skipped"] for a in agents)
    bt = total_backward + total_skipped

    print(f"\nOverall: {avg_baseline:.4f} -> {avg_post:.4f} ({avg_post - avg_baseline:+.4f})")
    print(
        f"Backward passes: {total_backward}/{bt} ({total_backward / bt:.0%} computed, {total_skipped}/{bt} skipped by Kondo gate)"
    )
    if device == "cuda":
        print(f"GPU memory: {torch.cuda.memory_allocated() / 1e9:.2f} GB")

    return {
        "baseline": {a.agent_id: baseline_scores[a.agent_id] for a in agents},
        "post_training": {a.agent_id: post_scores[a.agent_id] for a in agents},
        "stats": {a.agent_id: a.get_stats() for a in agents},
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Multi-agent continuous RL demo")
    parser.add_argument("--model", default="Qwen/Qwen3-0.6B")
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    parser.add_argument("--num-agents", type=int, default=2)
    parser.add_argument("--ticks", type=int, default=20)
    parser.add_argument("--kondo-rate", type=float, default=0.3)
    parser.add_argument("--pbt", action="store_true", default=True)
    parser.add_argument("--no-pbt", dest="pbt", action="store_false")
    parser.add_argument("--pbt-interval", type=int, default=10)
    parser.add_argument("--output", default="demo_results.json")
    args = parser.parse_args()

    result = asyncio.run(run_demo(args))

    Path(args.output).write_text(json.dumps(result, indent=2, default=str))
    logger.info(f"Results saved to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
