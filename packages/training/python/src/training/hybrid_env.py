"""
Babylon Hybrid Environment for GRPO Training

Combines offline (database) and online (simulation bridge) rollouts.
This provides the best of both worlds:
- Offline: Large, diverse dataset from historical trajectories
- Online: Fresh rollouts from current policy interacting with simulation

Usage:
    make train-hybrid  # 80% offline, 20% online by default
    
    # Or with custom ratio
    python scripts/run_training.py --mode hybrid --hybrid-online-ratio 0.3

The online ratio determines what fraction of rollouts come from the
simulation bridge vs the database.
"""

import asyncio
import copy
import logging
import os
import random
from typing import Any, Dict, List, Optional, Tuple

from pydantic import Field

from atroposlib.envs.base import APIServerConfig, BaseEnv, ScoredDataGroup

from .babylon_env import BabylonEnvConfig, BabylonRLAIFEnv
from .online_env import BabylonOnlineEnv, BabylonOnlineEnvConfig, Scenario
from .simulation_bridge import SimulationBridge

logger = logging.getLogger(__name__)


class BabylonHybridEnvConfig(BabylonOnlineEnvConfig):
    """
    Configuration for hybrid environment.
    
    Inherits from BabylonOnlineEnvConfig and adds offline ratio control.
    """
    
    online_ratio: float = Field(
        default=0.2,
        description="Ratio of rollouts from online simulation (0.0 = all offline, 1.0 = all online)"
    )
    
    # Database settings for offline mode (same as BabylonEnvConfig)
    db_url: Optional[str] = Field(
        default=None,
        description="PostgreSQL connection URL for offline trajectories"
    )
    trajectory_window_size: int = Field(
        default=1000,
        description="Number of trajectories to cache in memory"
    )
    min_trajectories: int = Field(
        default=10,
        description="Minimum trajectories required to start offline training"
    )


class BabylonHybridEnv(BaseEnv):
    """
    Hybrid environment that mixes offline and online rollouts.
    
    Architecture:
    - Maintains both an offline trajectory cache and online bridge connection
    - For each get_next_item() call, randomly selects offline vs online
    - Collects trajectories using the appropriate mode
    - Scores and returns consistent ScoredDataGroup format
    
    Benefits:
    - Stability from large offline dataset
    - Adaptability from on-policy online rollouts
    - Smooth transition from offline to online training
    """
    
    name = "babylon_hybrid_env"
    
    def __init__(
        self,
        config: BabylonHybridEnvConfig,
        server_configs: List[APIServerConfig],
        slurm: bool = False,
        testing: bool = False,
    ):
        super().__init__(config, server_configs, slurm, testing)
        self.config: BabylonHybridEnvConfig = config
        self._server_configs = server_configs
        
        # Offline components (from BabylonRLAIFEnv)
        self.db_pool = None
        self.trajectory_cache: List[Dict] = []
        self.current_cache_idx: int = 0
        
        # Online components (from BabylonOnlineEnv)
        self.simulation_bridge: Optional[SimulationBridge] = None
        self.scenario_pool = None
        self._bridge_npc_index: int = 0
        
        # Hybrid control
        self.online_ratio = config.online_ratio
        self.iter = 0
        self.online_count = 0
        self.offline_count = 0
        
        # Tokenizer (set in setup)
        self.tokenizer = None
        
        logger.info(f"HybridEnv initialized with online_ratio={self.online_ratio:.0%}")
    
    @classmethod
    def config_init(cls) -> Tuple[BabylonHybridEnvConfig, List[APIServerConfig]]:
        """Create default config"""
        env_config = BabylonHybridEnvConfig(
            tokenizer_name="Qwen/Qwen2.5-3B-Instruct",
            rollout_server_url="http://localhost:8000",
            total_steps=1000,
            batch_size=16,
            online_ratio=float(os.getenv("HYBRID_ONLINE_RATIO", "0.2")),
            use_simulation_bridge=True,
            simulation_bridge_url=os.getenv("SIMULATION_BRIDGE_URL", "http://localhost:3001"),
            db_url=os.getenv("DATABASE_URL"),
        )
        
        server_configs = [
            APIServerConfig(
                model_name="Qwen/Qwen2.5-3B-Instruct",
                base_url="http://localhost:9001/v1",
            )
        ]
        
        return env_config, server_configs
    
    async def setup(self):
        """Initialize both offline and online components"""
        from transformers import AutoTokenizer
        
        logger.info("Setting up hybrid environment...")
        
        # Load tokenizer
        self.tokenizer = AutoTokenizer.from_pretrained(self.config.tokenizer_name)
        
        # Setup offline component (database)
        if self.config.db_url:
            await self._setup_offline()
        else:
            logger.warning("No DATABASE_URL set, hybrid will only use online rollouts")
            self.online_ratio = 1.0
        
        # Setup online component (simulation bridge)
        if self.config.use_simulation_bridge:
            await self._setup_online()
        else:
            logger.warning("Simulation bridge disabled, hybrid will only use offline rollouts")
            self.online_ratio = 0.0
        
        logger.info(f"Hybrid setup complete: online_ratio={self.online_ratio:.0%}, "
                   f"offline_trajectories={len(self.trajectory_cache)}, "
                   f"bridge_npcs={len(self.simulation_bridge.npc_ids) if self.simulation_bridge else 0}")
    
    async def _setup_offline(self):
        """Setup database connection and load trajectories"""
        import asyncpg
        
        logger.info("Connecting to database for offline trajectories...")
        
        self.db_pool = await asyncpg.create_pool(
            self.config.db_url,
            min_size=2,
            max_size=10,
        )
        
        # Load initial trajectory window
        await self._load_trajectory_window()
        
        if len(self.trajectory_cache) < self.config.min_trajectories:
            logger.warning(f"Only {len(self.trajectory_cache)} trajectories in DB, "
                          f"need {self.config.min_trajectories}")
    
    async def _load_trajectory_window(self):
        """Load a window of trajectories from database"""
        if not self.db_pool:
            return
        
        async with self.db_pool.acquire() as conn:
            # Load trajectories with reasoning
            rows = await conn.fetch("""
                SELECT 
                    id, archetype, scenario_context, model_response,
                    reasoning, metrics, created_at
                FROM trajectories
                WHERE model_response IS NOT NULL
                ORDER BY created_at DESC
                LIMIT $1
            """, self.config.trajectory_window_size)
            
            self.trajectory_cache = [dict(row) for row in rows]
            self.current_cache_idx = 0
            
            logger.info(f"Loaded {len(self.trajectory_cache)} trajectories from database")
    
    async def _setup_online(self):
        """Setup simulation bridge connection"""
        logger.info(f"Connecting to simulation bridge at {self.config.simulation_bridge_url}...")
        
        self.simulation_bridge = SimulationBridge(
            base_url=self.config.simulation_bridge_url,
        )
        await self.simulation_bridge.__aenter__()
        
        # Initialize with archetypes
        archetypes = list(self.config.archetype_distribution.keys())
        await self.simulation_bridge.initialize(
            num_npcs=self.config.bridge_num_npcs,
            archetypes=archetypes,
        )
        
        logger.info(f"Simulation bridge connected with {len(self.simulation_bridge.npc_ids)} NPCs")
    
    async def get_next_item(self) -> Tuple[Any, str]:
        """
        Get next item for training.
        
        Randomly decides between offline and online based on online_ratio.
        """
        self.iter += 1
        
        # Decide online vs offline based on ratio
        use_online = random.random() < self.online_ratio
        
        # If online selected but not available, fall back to offline
        if use_online and (not self.simulation_bridge or not self.simulation_bridge.is_initialized):
            use_online = False
        
        # If offline selected but no trajectories, use online
        if not use_online and len(self.trajectory_cache) == 0:
            use_online = True
        
        if use_online:
            self.online_count += 1
            return await self._get_online_item()
        else:
            self.offline_count += 1
            return self._get_offline_item()
    
    async def _get_online_item(self) -> Tuple["PoolScenario", str]:
        """Get a scenario from simulation bridge"""
        from .scenario_pool import Scenario as PoolScenario, PortfolioState
        
        npc_ids = self.simulation_bridge.npc_ids
        npc_id = npc_ids[self._bridge_npc_index % len(npc_ids)]
        self._bridge_npc_index += 1
        
        bridge_scenario = await self.simulation_bridge.get_scenario(npc_id)
        archetype = bridge_scenario.archetype
        
        # Convert to Scenario format used by scoring
        scenario = PoolScenario(
            id=f"bridge-{npc_id}-{self.iter}",
            source="production",
            archetype_focus=archetype,
            difficulty="medium",
            portfolio=PortfolioState(
                balance=bridge_scenario.balance,
                positions=[],
            ),
        )
        
        # Add market data from bridge
        for m in bridge_scenario.market_state.prediction_markets:
            scenario.add_market({
                "id": m.id,
                "question": m.question,
                "yesPrice": m.yes_price,
                "noPrice": m.no_price,
            })
        
        for m in bridge_scenario.market_state.perp_markets:
            scenario.add_perpetual({
                "ticker": m.ticker,
                "markPrice": m.current_price,
                "change24h": m.change_percent_24h,
            })
        
        # Store bridge scenario for action execution
        scenario.metadata["bridge_scenario"] = bridge_scenario
        scenario.metadata["npc_id"] = npc_id
        scenario.metadata["mode"] = "online"
        
        return (scenario, archetype)
    
    def _get_offline_item(self) -> Tuple[Dict, str]:
        """Get a trajectory from cached database trajectories"""
        if not self.trajectory_cache:
            raise RuntimeError("No trajectories in cache")
        
        # Round-robin through cache
        traj = self.trajectory_cache[self.current_cache_idx]
        self.current_cache_idx = (self.current_cache_idx + 1) % len(self.trajectory_cache)
        
        archetype = traj.get("archetype", "trader")
        
        # Add source metadata
        traj_copy = copy.deepcopy(traj)
        traj_copy["source"] = "offline"
        
        return (traj_copy, archetype)
    
    async def collect_trajectories(self, item: Tuple[Any, str]) -> Tuple[Optional[ScoredDataGroup], List]:
        """
        Collect and score trajectories.
        
        Delegates to appropriate handler based on item source.
        """
        data, archetype = item
        
        # Check if it's a Scenario (online) or Dict (offline)
        if hasattr(data, "metadata") and data.metadata.get("source") == "online":
            return await self._collect_online(data, archetype)
        else:
            return await self._collect_offline(data, archetype)
    
    async def _collect_online(self, scenario: "Scenario", archetype: str) -> Tuple[Optional[ScoredDataGroup], List]:
        """Collect online rollouts via simulation bridge"""
        from .online_env import build_trading_system_prompt, build_observation_prompt
        from .quality_scorer import score_response
        from .format_validator import validate_response_format
        
        # Build messages
        system_prompt = build_trading_system_prompt(archetype)
        user_prompt = build_observation_prompt(scenario)
        
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ]
        
        # Generate completions using managed_server
        async with self.server.managed_server(tokenizer=self.tokenizer) as managed:
            chat_completions = await managed.chat_completion(
                messages=messages,
                n=self.config.group_size,
                max_tokens=self.config.max_response_tokens,
                temperature=self.config.temperature,
            )
            
            state = managed.get_state()
            nodes = state["nodes"]
        
        if not nodes or len(nodes) < 2:
            logger.warning("Insufficient nodes from managed_server")
            return None, []
        
        # Process and score completions
        rollout_data = []
        for i, choice in enumerate(chat_completions.choices):
            if i >= len(nodes):
                break
            
            node = nodes[i]
            response_content = choice.message.content or ""
            
            # Score the response
            quality = score_response(
                response=response_content,
                archetype=archetype,
                execute_action=False,
            )
            
            format_result = validate_response_format(response_content)
            
            # Calculate final score
            base_score = quality.combined_format_score * 0.4 + quality.reasoning_score * 0.3
            action_bonus = 0.3 if format_result.is_valid else 0.0
            final_score = base_score + action_bonus
            
            rollout_data.append({
                "tokens": node.tokens,
                "masks": node.masked_tokens,
                "score": final_score,
            })
        
        # Center scores
        scores = [r["score"] for r in rollout_data]
        mean_score = sum(scores) / len(scores)
        
        # Build ScoredDataGroup
        scored_group = ScoredDataGroup(
            tokens=[r["tokens"] for r in rollout_data],
            masks=[r["masks"] for r in rollout_data],
            scores=[s - mean_score for s in scores],
        )
        
        return scored_group, []
    
    async def _collect_offline(self, traj: Dict, archetype: str) -> Tuple[Optional[ScoredDataGroup], List]:
        """Collect offline rollouts from database trajectory"""
        from .rewards import archetype_composite_reward, BehaviorMetrics
        from .quality_scorer import score_response
        from .format_validator import validate_response_format
        from .tokenization_utils import tokenize_for_trainer
        
        # Build messages from trajectory
        scenario_context = traj.get("scenario_context", {})
        model_response = traj.get("model_response", "")
        
        if not model_response:
            return None, []
        
        # Build chat messages
        messages = [
            {"role": "system", "content": f"You are a {archetype} trading agent."},
            {"role": "user", "content": str(scenario_context)},
            {"role": "assistant", "content": model_response},
        ]
        
        # Get vLLM URL for generation
        vllm_base_url = self._server_configs[0].base_url if self._server_configs else "http://localhost:9001/v1"
        model_name = self.config.tokenizer_name
        
        # Generate N completions for the same prompt
        import aiohttp
        
        prompt_messages = messages[:-1]  # Exclude assistant response
        
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{vllm_base_url}/chat/completions",
                json={
                    "model": model_name,
                    "messages": prompt_messages,
                    "max_tokens": 512,
                    "n": self.config.group_size,
                    "temperature": 0.7,
                },
            ) as resp:
                if resp.status != 200:
                    logger.warning(f"vLLM request failed: {resp.status}")
                    return None, []
                result = await resp.json()
        
        choices = result.get("choices", [])
        if len(choices) < 2:
            return None, []
        
        # Score each completion
        rollout_data = []
        for choice in choices:
            response_content = choice.get("message", {}).get("content", "")
            
            # Build full messages
            full_messages = copy.deepcopy(prompt_messages)
            full_messages.append({"role": "assistant", "content": response_content})
            
            # Tokenize with proper masking
            token_result = tokenize_for_trainer(
                self.tokenizer,
                full_messages,
                train_on_all_assistant_turns=True,
            )
            
            # Score
            quality = score_response(
                response=response_content,
                archetype=archetype,
                execute_action=False,
            )
            
            format_result = validate_response_format(response_content)
            
            base_score = quality.combined_format_score * 0.4 + quality.reasoning_score * 0.3
            action_bonus = 0.3 if format_result.is_valid else 0.0
            final_score = base_score + action_bonus
            
            rollout_data.append({
                "tokens": token_result["input_ids"],
                "masks": token_result["masks"],
                "score": final_score,
            })
        
        # Center scores and add small noise to prevent identical scores
        scores = [r["score"] + random.uniform(-0.01, 0.01) for r in rollout_data]
        mean_score = sum(scores) / len(scores)
        
        scored_group = ScoredDataGroup(
            tokens=[r["tokens"] for r in rollout_data],
            masks=[r["masks"] for r in rollout_data],
            scores=[s - mean_score for s in scores],
        )
        
        return scored_group, []
    
    async def cleanup(self):
        """Clean up resources"""
        if self.simulation_bridge:
            logger.info("Cleaning up simulation bridge...")
            await self.simulation_bridge.reset()
            await self.simulation_bridge.__aexit__(None, None, None)
            self.simulation_bridge = None
        
        if self.db_pool:
            logger.info("Closing database pool...")
            await self.db_pool.close()
            self.db_pool = None
        
        logger.info(f"Hybrid stats: online={self.online_count}, offline={self.offline_count}")
    
    async def evaluate(self):
        """Periodic evaluation logging"""
        total = self.online_count + self.offline_count
        if total > 0:
            actual_online_ratio = self.online_count / total
            logger.info(f"Hybrid stats: total={total}, online={self.online_count} ({actual_online_ratio:.1%}), "
                       f"offline={self.offline_count} ({1-actual_online_ratio:.1%})")


if __name__ == "__main__":
    BabylonHybridEnv.cli()

