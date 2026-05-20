"""
Multi-Agent Orchestrator for Distributed Online RL

Launches N ContinuousRLAgents, connects them to a shared Feed game,
and manages their lifecycle:

  - Each agent gets its own model on a separate GPU (or shares one with offloading)
  - All agents interact with the same Feed game via SimulationBridge
  - Population-based training: periodically evaluate agents, replace the weakest
    with mutated copies of the strongest (by cumulative delight)
  - Checkpoint sync to shared storage for distributed runs

Usage:
    orchestrator = MultiAgentOrchestrator(config)
    await orchestrator.run()
"""

from __future__ import annotations

import asyncio
import logging
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import torch

from .continuous_rl import ContinuousRLAgent, ContinuousRLConfig
from .simulation_bridge import SimulationBridge

logger = logging.getLogger(__name__)


# ─── Configuration ──────────────────────────────────────────────────────────


@dataclass
class OrchestratorConfig:
    """Configuration for the multi-agent orchestrator."""

    # Agent setup
    num_agents: int = 4
    model_name: str = "Qwen/Qwen3.5-4B"
    agent_archetypes: list[str] = field(
        default_factory=lambda: ["trader", "analyst", "degen", "influencer"]
    )

    # GPU assignment: "auto" distributes agents across available GPUs.
    # Can also be a list like ["cuda:0", "cuda:1", "cuda:0", "cuda:1"].
    device_map: str | list[str] = "auto"

    # Optimizer defaults (per agent)
    optimizer: str = "apollo"
    learning_rate: float = 5e-6
    apollo_rank: int = 128
    apollo_scale: float = 32.0
    apollo_update_proj_gap: int = 200

    # Kondo gate defaults
    use_kondo: bool = True
    kondo_gate_rate: float = 0.03

    # TurboQuant defaults
    use_turboquant: bool = True
    turboquant_key_bits: float = 3.5
    turboquant_value_bits: float = 3.5

    # Game connection
    bridge_url: str = "http://localhost:3001"
    num_npcs: int = 20
    game_seed: int = 42

    # Training
    ticks_per_epoch: int = 100
    num_epochs: int = 0  # 0 = unlimited
    log_every: int = 10

    # Population-based training
    pbt_enabled: bool = True
    pbt_interval: int = 50  # Evaluate and cull every N ticks
    pbt_replace_fraction: float = 0.25  # Replace bottom 25%
    pbt_lr_perturb_range: tuple[float, float] = (0.8, 1.2)

    # Checkpointing
    checkpoint_dir: str = "./multi_agent_checkpoints"
    checkpoint_every: int = 100
    shared_checkpoint_dir: str = ""  # For distributed: shared NFS/S3 path


# ─── Orchestrator ────────────────────────────────────────────────────────────


class MultiAgentOrchestrator:
    """Manages N agents playing in a shared Feed game."""

    def __init__(self, config: OrchestratorConfig):
        self.config = config
        self.agents: list[ContinuousRLAgent] = []
        self.npc_assignments: dict[str, str] = {}  # agent_id -> npc_id
        self.bridge: SimulationBridge | None = None
        self.epoch: int = 0
        self.global_tick: int = 0

    def _resolve_devices(self) -> list[str]:
        """Resolve device assignments for each agent."""
        if isinstance(self.config.device_map, list):
            devices = list(self.config.device_map)
            while len(devices) < self.config.num_agents:
                devices.append(devices[-1])
            return devices[: self.config.num_agents]

        # Auto: distribute across available GPUs
        if torch.cuda.is_available():
            num_gpus = torch.cuda.device_count()
            return [f"cuda:{i % num_gpus}" for i in range(self.config.num_agents)]
        return ["cpu"] * self.config.num_agents

    def _create_agent(self, agent_id: str, device: str, archetype: str) -> ContinuousRLAgent:
        """Create a single agent with its configuration."""
        agent_config = ContinuousRLConfig(
            model_name=self.config.model_name,
            device=device,
            optimizer=self.config.optimizer,
            learning_rate=self.config.learning_rate,
            apollo_rank=self.config.apollo_rank,
            apollo_scale=self.config.apollo_scale,
            apollo_update_proj_gap=self.config.apollo_update_proj_gap,
            use_kondo=self.config.use_kondo,
            kondo_gate_rate=self.config.kondo_gate_rate,
            use_turboquant=self.config.use_turboquant,
            turboquant_key_bits=self.config.turboquant_key_bits,
            turboquant_value_bits=self.config.turboquant_value_bits,
            checkpoint_dir=self.config.checkpoint_dir,
            checkpoint_every=self.config.checkpoint_every,
            bridge_url=self.config.bridge_url,
            agent_archetype=archetype,
        )
        return ContinuousRLAgent(agent_id, agent_config)

    async def setup(self) -> None:
        """Initialize all agents and connect to the game."""
        devices = self._resolve_devices()
        archetypes = self.config.agent_archetypes

        logger.info(
            f"Orchestrator: setting up {self.config.num_agents} agents on devices {devices}"
        )

        # Create and initialize agents
        for i in range(self.config.num_agents):
            agent_id = f"agent_{i:03d}"
            archetype = archetypes[i % len(archetypes)]
            agent = self._create_agent(agent_id, devices[i], archetype)
            agent.setup()
            self.agents.append(agent)
            logger.info(f"Agent {agent_id} ({archetype}) ready on {devices[i]}")

        # Connect to the shared Feed game
        self.bridge = SimulationBridge(
            base_url=self.config.bridge_url,
            timeout=60.0,
        )
        await self.bridge.__aenter__()

        # Initialize the game
        init_result = await self.bridge.initialize(
            num_npcs=self.config.num_npcs,
            seed=self.config.game_seed,
            archetypes=[a.config.agent_archetype for a in self.agents],
        )

        # Assign NPCs to agents
        npc_ids = self.bridge.npc_ids
        for i, agent in enumerate(self.agents):
            npc_id = npc_ids[i % len(npc_ids)]
            self.npc_assignments[agent.agent_id] = npc_id
            logger.info(f"Agent {agent.agent_id} -> NPC {npc_id}")

    async def run_tick(self) -> dict[str, Any]:
        """
        Run one game tick: all agents act, then the game advances.

        Returns per-agent metrics for this tick.
        """
        assert self.bridge is not None
        self.global_tick += 1
        tick_metrics: dict[str, Any] = {"tick": self.global_tick}

        # Each agent acts in the current game state (can be parallelized)
        tasks = []
        for agent in self.agents:
            npc_id = self.npc_assignments[agent.agent_id]
            tasks.append(self._agent_act(agent, npc_id))

        results = await asyncio.gather(*tasks, return_exceptions=True)

        for agent, result in zip(self.agents, results, strict=False):
            if isinstance(result, Exception):
                logger.error(f"[{agent.agent_id}] tick error: {result}")
                tick_metrics[agent.agent_id] = {"error": str(result)}
            else:
                tick_metrics[agent.agent_id] = result

        # Advance the game by one tick
        try:
            tick_result = await self.bridge.tick()
            tick_metrics["game_tick"] = tick_result.tick_number
            tick_metrics["game_events"] = len(tick_result.events)
        except Exception as e:
            logger.error(f"Game tick failed: {e}")
            tick_metrics["game_tick_error"] = str(e)

        return tick_metrics

    async def _agent_act(
        self,
        agent: ContinuousRLAgent,
        npc_id: str,
    ) -> dict[str, Any]:
        """Single agent generates an action, executes it, and trains."""
        assert self.bridge is not None

        scenario = await self.bridge.get_scenario(npc_id)
        response_text, input_ids, output_ids = agent.generate_action(scenario)

        action = agent.parse_action(response_text)
        if action is None:
            action = {"action": "wait", "reason": "parse_failed"}

        outcome = await self.bridge.execute_action(
            npc_id=npc_id,
            action_type=action.get("action", "wait"),
            ticker=action.get("ticker"),
            market_id=action.get("market"),
            amount=action.get("amount"),
            side=action.get("side") or action.get("direction"),
            reasoning=action.get("reason"),
        )

        # Compute reward
        from .continuous_rl import _compute_reward

        reward = _compute_reward(action, outcome, scenario)

        # Train (Kondo gate decides if backward pass happens)
        metrics = agent.train_on_interaction(input_ids, output_ids, reward)
        metrics["action"] = action.get("action", "unknown")
        metrics["outcome_success"] = outcome.success
        return metrics

    # ── Population-Based Training ────────────────────────────────────────────

    def run_pbt_selection(self) -> dict[str, Any]:
        """
        Population-based training: replace weakest agents with copies of strongest.

        Ranking metric: cumulative delight (high delight = agent is learning
        from surprising, high-value interactions).
        """
        if not self.config.pbt_enabled or len(self.agents) < 2:
            return {"pbt": "disabled"}

        # Rank by cumulative delight (learning signal quality)
        ranked = sorted(
            self.agents,
            key=lambda a: a.cumulative_delight,
            reverse=True,
        )

        n_replace = max(1, int(len(ranked) * self.config.pbt_replace_fraction))
        top_agents = ranked[:n_replace]
        bottom_agents = ranked[-n_replace:]

        pbt_report: dict[str, Any] = {
            "replaced": [],
            "source": [],
            "top_delight": [a.cumulative_delight for a in top_agents],
            "bottom_delight": [a.cumulative_delight for a in bottom_agents],
        }

        for weak, strong in zip(bottom_agents, top_agents, strict=False):
            logger.info(
                f"PBT: replacing {weak.agent_id} (delight={weak.cumulative_delight:.2f}) "
                f"with copy of {strong.agent_id} (delight={strong.cumulative_delight:.2f})"
            )

            # Save strong agent's checkpoint, then load it into weak agent
            ckpt_path = strong.save_checkpoint(tag=f"pbt_source_{self.global_tick}")

            # Copy weights
            if weak.model is not None and strong.model is not None:
                weak.model.load_state_dict(strong.model.state_dict())

            # Perturb learning rate for exploration
            import random

            lr_factor = random.uniform(*self.config.pbt_lr_perturb_range)
            new_lr = strong.config.learning_rate * lr_factor
            weak.config.learning_rate = new_lr
            for pg in weak.optimizer.param_groups:
                pg["lr"] = new_lr

            # Reset weak agent's reward tracker (fresh start)
            weak.reward_tracker.count = 0
            weak.reward_tracker.mean = strong.reward_tracker.mean
            weak.cumulative_delight = 0.0

            pbt_report["replaced"].append(weak.agent_id)
            pbt_report["source"].append(strong.agent_id)

        return pbt_report

    # ── Main loop ────────────────────────────────────────────────────────────

    async def run(self) -> dict[str, Any]:
        """
        Main orchestrator loop.

        Runs epochs of ticks. Within each epoch:
          1. Run ticks_per_epoch game ticks (all agents act + train each tick)
          2. Every pbt_interval ticks, run population-based selection
          3. Checkpoint agents at configured intervals
          4. Log aggregate statistics

        Returns final report.
        """
        await self.setup()

        report: dict[str, Any] = {
            "config": {
                "num_agents": self.config.num_agents,
                "model": self.config.model_name,
                "optimizer": self.config.optimizer,
                "kondo_gate_rate": self.config.kondo_gate_rate,
                "pbt_enabled": self.config.pbt_enabled,
            },
            "epochs": [],
        }

        epoch = 0
        try:
            while self.config.num_epochs == 0 or epoch < self.config.num_epochs:
                epoch += 1
                self.epoch = epoch
                epoch_start = time.time()
                epoch_metrics: dict[str, Any] = {"epoch": epoch, "ticks": []}

                for tick_in_epoch in range(self.config.ticks_per_epoch):
                    tick_metrics = await self.run_tick()
                    epoch_metrics["ticks"].append(tick_metrics)

                    # Population-based training
                    if (
                        self.config.pbt_enabled
                        and self.global_tick % self.config.pbt_interval == 0
                        and self.global_tick > 0
                    ):
                        pbt_report = self.run_pbt_selection()
                        tick_metrics["pbt"] = pbt_report

                    # Periodic logging
                    if self.global_tick % self.config.log_every == 0:
                        self._log_aggregate_stats()

                # End of epoch: checkpoint all agents
                for agent in self.agents:
                    agent.save_checkpoint(tag=f"epoch_{epoch}")

                # Sync to shared storage if configured
                if self.config.shared_checkpoint_dir:
                    self._sync_checkpoints()

                epoch_duration = time.time() - epoch_start
                epoch_metrics["duration_seconds"] = epoch_duration
                epoch_metrics["agent_stats"] = [a.get_stats() for a in self.agents]

                report["epochs"].append(epoch_metrics)
                logger.info(
                    f"Epoch {epoch} complete: {self.config.ticks_per_epoch} ticks "
                    f"in {epoch_duration:.1f}s"
                )

        except KeyboardInterrupt:
            logger.info("Training interrupted by user")
        finally:
            # Final checkpoints
            for agent in self.agents:
                agent.save_checkpoint(tag="final")

            if self.bridge is not None:
                await self.bridge.__aexit__(None, None, None)

            report["final_stats"] = [a.get_stats() for a in self.agents]

        return report

    def _log_aggregate_stats(self) -> None:
        """Log aggregate statistics across all agents."""
        stats = [a.get_stats() for a in self.agents]
        total_interactions = sum(s["total_interactions"] for s in stats)
        total_backward = sum(s["total_backward_passes"] for s in stats)
        total_skipped = sum(s["total_backward_skipped"] for s in stats)
        mean_reward = (
            sum(s["cumulative_reward"] for s in stats) / total_interactions
            if total_interactions > 0
            else 0.0
        )
        total_delight = sum(s["cumulative_delight"] for s in stats)

        backward_total = total_backward + total_skipped
        backward_rate = total_backward / backward_total if backward_total > 0 else 0.0

        logger.info(
            f"[Orchestrator] tick={self.global_tick} epoch={self.epoch} "
            f"interactions={total_interactions} backward_rate={backward_rate:.3f} "
            f"mean_reward={mean_reward:.4f} total_delight={total_delight:.2f}"
        )

    def _sync_checkpoints(self) -> None:
        """Copy local checkpoints to shared storage."""
        if not self.config.shared_checkpoint_dir:
            return
        src = Path(self.config.checkpoint_dir)
        dst = Path(self.config.shared_checkpoint_dir)
        dst.mkdir(parents=True, exist_ok=True)

        for agent in self.agents:
            agent_src = src / agent.agent_id
            agent_dst = dst / agent.agent_id
            if agent_src.exists():
                if agent_dst.exists():
                    shutil.rmtree(agent_dst)
                shutil.copytree(agent_src, agent_dst)

        logger.info(f"Checkpoints synced to {dst}")
