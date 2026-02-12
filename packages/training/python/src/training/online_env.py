"""
Babylon Online Environment for GRPO Training

⚠️ STATUS: PHASE 3 - NOT YET IN PRODUCTION
This module is ready to use but the current pipeline uses BabylonRLAIFEnv (offline).
To use online training, run: make train-online (requires: make bridge-server)
See TRAINING_ROADMAP.md Phase 3.

This environment generates ON-POLICY rollouts for GRPO training.
Unlike the offline BabylonRLAIFEnv which uses historical trajectories,
this environment:

1. Samples scenarios from ScenarioPool (production snapshots + synthetic)
2. Generates fresh completions from the CURRENT model via vLLM
3. Parses and optionally executes actions
4. Scores using deterministic reward functions
5. Returns properly masked token sequences for training

Key differences from BabylonRLAIFEnv:
- ON-POLICY: Uses current model for completions (fresh rollouts)
- PROPER MASKING: Uses managed_server for correct token/mask alignment
- SCENARIO-BASED: Uses ScenarioPool instead of database trajectories
- CURRICULUM LEARNING: Tracks scenario difficulty and adapts sampling

References:
- Atropos rlaif_server.py: Demonstrates managed_server usage
- Atropos base.py: ScoredDataGroup structure
"""

import asyncio
import atexit
import copy
import logging
import os
from typing import Dict, List, Optional, Tuple

import wandb
from pydantic import Field

from atroposlib.envs.base import (
    APIServerConfig,
    BaseEnv,
    BaseEnvConfig,
    EvalHandlingEnum,
    ScoredDataGroup,
)

from .rewards import (
    TrajectoryRewardInputs,
    BehaviorMetrics,
    archetype_composite_reward,
)
from .scenario_pool import (
    ScenarioPool,
    ScenarioPoolConfig,
    Scenario,
)
from .simulation_bridge import (
    SimulationBridge,
    Scenario as BridgeScenario,
    ActionOutcome,
)

logger = logging.getLogger(__name__)


# =============================================================================
# System Prompts
# =============================================================================


def build_trading_system_prompt(archetype: str = "trader") -> str:
    """
    Build system prompt for trading agent.
    
    The prompt instructs the model on response format and trading context.
    """
    archetype_instructions = {
        "trader": "You are a focused trader who prioritizes profit and risk management.",
        "degen": "You are a high-frequency trader who seeks maximum volume and action.",
        "influencer": "You are a social trader who builds influence while trading.",
        "analyst": "You are a research-driven trader who values thorough analysis.",
        "whale": "You are a large position trader who moves markets carefully.",
    }
    
    base_instruction = archetype_instructions.get(archetype, archetype_instructions["trader"])
    
    return f"""You are a trading agent in Babylon prediction markets.

{base_instruction}

RESPONSE FORMAT:
1. First, reason about the current market state inside <think>...</think> tags
2. Then, provide your action in JSON format

Available actions:
- {{"action": "buy", "market": "<id>", "amount": <number>, "side": "yes"|"no"}}
- {{"action": "sell", "market": "<id>", "amount": <number>, "side": "yes"|"no"}}
- {{"action": "open_perp", "ticker": "<symbol>", "size": <number>, "direction": "long"|"short"}}
- {{"action": "close_perp", "ticker": "<symbol>", "size": <number>}}
- {{"action": "wait", "reason": "<string>"}}

Example response:
<think>
BTC is showing bullish momentum with positive funding. The prediction market for $100K has 65% YES probability which seems underpriced given current momentum. I'll take a small long position.
</think>

{{"action": "open_perp", "ticker": "BTC", "size": 0.1, "direction": "long"}}

Always provide exactly ONE action per response. Be decisive."""


def build_observation_prompt(scenario: Scenario) -> str:
    """
    Build user prompt from scenario observation.
    
    Presents market state in a clear, actionable format.
    """
    obs = scenario.to_observation()
    portfolio = obs["portfolio"]
    
    lines = [
        "=== MARKET UPDATE ===",
        f"Time: {obs['timestamp']}",
        f"Balance: ${portfolio['balance']:.2f}",
        f"Total P&L: ${portfolio.get('totalPnL', 0):.2f}",
        "",
    ]
    
    # Prediction Markets
    if obs["markets"]:
        lines.append("PREDICTION MARKETS:")
        for market in obs["markets"][:5]:  # Limit to 5
            lines.append(f"  [{market['id']}] {market['question']}")
            lines.append(f"      YES: {market['yesPrice']:.2f} | NO: {market['noPrice']:.2f} | Vol: ${market['volume24h']:,.0f}")
        lines.append("")
    
    # Perpetuals
    if obs["perpetuals"]:
        lines.append("PERPETUAL MARKETS:")
        for perp in obs["perpetuals"]:
            change_str = f"+{perp['change24h']*100:.1f}%" if perp['change24h'] >= 0 else f"{perp['change24h']*100:.1f}%"
            lines.append(f"  {perp['ticker']}: ${perp['markPrice']:,.2f} ({change_str}) | Funding: {perp['fundingRate']*100:.3f}%")
        lines.append("")
    
    # News
    if obs["news"]:
        lines.append("RECENT NEWS:")
        for news in obs["news"][:3]:  # Limit to 3
            sentiment_icon = {"bullish": "📈", "bearish": "📉", "neutral": "➡️"}.get(news['sentiment'], "")
            lines.append(f"  {sentiment_icon} [{news['source']}] {news['headline']}")
        lines.append("")
    
    # Social
    if obs["socialFeed"]:
        lines.append("SOCIAL FEED:")
        for post in obs["socialFeed"][:3]:  # Limit to 3
            verified = "✓" if post.get('verified') else ""
            lines.append(f"  @{post['author']}{verified}: {post['content'][:80]}...")
        lines.append("")
    
    lines.append("What is your next action?")
    
    return "\n".join(lines)


# =============================================================================
# Action Parsing
# =============================================================================


def parse_action_from_response(response: str) -> Optional[Dict]:
    """
    Parse action JSON from model response.
    
    Handles responses with or without think tags.
    Returns None if parsing fails.
    """
    import json
    import re
    
    # Try to extract JSON after </think> tag first
    if "</think>" in response:
        parts = response.split("</think>")
        if len(parts) >= 2:
            json_part = parts[-1].strip()
        else:
            json_part = response
    else:
        json_part = response
    
    # Try to find JSON object using simple regex
    # NOTE: This regex r'\{[^{}]*\}' only matches flat (non-nested) JSON objects.
    # This is acceptable for our current action schema which is always flat:
    #   {"action": "buy_yes", "market_id": "...", "amount": 100}
    # If the action schema evolves to include nested objects, consider:
    #   - Using json.JSONDecoder().raw_decode() for proper JSON boundary detection
    #   - Implementing a balanced-brace parser/stack
    #   - Using a more sophisticated regex with recursion (if supported)
    json_match = re.search(r'\{[^{}]*\}', json_part)
    if json_match:
        try:
            action = json.loads(json_match.group())
            if "action" in action:
                return action
        except json.JSONDecodeError:
            pass
    
    # Try the entire remaining text (handles nested JSON if present)
    try:
        action = json.loads(json_part.strip())
        if "action" in action:
            return action
    except json.JSONDecodeError:
        pass
    
    return None


def extract_thinking(response: str) -> str:
    """Extract content from <think>...</think> tags"""
    import re
    match = re.search(r'<think>(.*?)</think>', response, re.DOTALL)
    if match:
        return match.group(1).strip()
    return ""


# =============================================================================
# Scoring
# =============================================================================


def score_trading_response(
    response: str,
    scenario: Scenario,
    archetype: str = "trader",
) -> Tuple[float, Dict]:
    """
    Score a trading model response based on format and content quality.
    
    Note: This is distinct from quality_scorer.score_response which provides
    lower-level scoring utilities. This function is specific to trading scenarios.
    
    Returns:
        (score, metrics_dict)
    """
    metrics = {
        "has_thinking": False,
        "thinking_length": 0,
        "has_valid_action": False,
        "action_type": None,
        "format_score": 0.0,
        "reasoning_score": 0.0,
    }
    
    # Check thinking tags
    thinking = extract_thinking(response)
    metrics["has_thinking"] = len(thinking) > 0
    metrics["thinking_length"] = len(thinking)
    
    # Check action parsing
    action = parse_action_from_response(response)
    metrics["has_valid_action"] = action is not None
    if action:
        metrics["action_type"] = action.get("action")
    
    # Format scoring
    format_score = 0.0
    if metrics["has_thinking"]:
        format_score += 0.3
        # Bonus for substantial thinking
        if metrics["thinking_length"] > 100:
            format_score += 0.1
        if metrics["thinking_length"] > 300:
            format_score += 0.1
    
    if metrics["has_valid_action"]:
        format_score += 0.3
        # Bonus for non-wait actions (encourages activity)
        if metrics["action_type"] not in [None, "wait"]:
            format_score += 0.1
    
    # Penalty for overly short or long responses
    response_len = len(response)
    if response_len < 50:
        format_score -= 0.2
    elif response_len > 2000:
        format_score -= 0.1
    
    format_score = max(0.0, min(1.0, format_score))
    metrics["format_score"] = format_score
    
    # Reasoning scoring - check for trading-relevant analysis
    reasoning_score = 0.0
    thinking_lower = thinking.lower()
    
    # Check for market analysis terms
    analysis_terms = ["price", "volume", "trend", "momentum", "bullish", "bearish", 
                      "risk", "position", "market", "funding", "probability"]
    term_count = sum(1 for term in analysis_terms if term in thinking_lower)
    reasoning_score += min(0.4, term_count * 0.04)
    
    # Check for decision justification
    decision_terms = ["because", "therefore", "since", "given that", "considering"]
    if any(term in thinking_lower for term in decision_terms):
        reasoning_score += 0.2
    
    # Check for risk consideration
    risk_terms = ["risk", "downside", "stop", "loss", "careful", "conservative"]
    if any(term in thinking_lower for term in risk_terms):
        reasoning_score += 0.2
    
    # Check for numerical analysis
    import re
    numbers_in_thinking = len(re.findall(r'\d+\.?\d*', thinking))
    if numbers_in_thinking > 2:
        reasoning_score += 0.2
    
    reasoning_score = max(0.0, min(1.0, reasoning_score))
    metrics["reasoning_score"] = reasoning_score
    
    # Composite score using archetype-aware weights
    behavior_metrics = BehaviorMetrics(
        trades_executed=1 if metrics["action_type"] not in [None, "wait"] else 0,
        episode_length=1,
    )
    
    reward_inputs = TrajectoryRewardInputs(
        final_pnl=0.0,  # No actual PnL for single-step
        starting_balance=scenario.portfolio.balance,
        end_balance=scenario.portfolio.balance,
        format_score=format_score,
        reasoning_score=reasoning_score,
        risky_actions_count=0,
        trades_executed=behavior_metrics.trades_executed,
        total_actions=1,
    )
    
    final_score = archetype_composite_reward(
        inputs=reward_inputs,
        archetype=archetype,
        behavior_metrics=behavior_metrics,
    )
    
    return final_score, metrics


# =============================================================================
# Environment Configuration
# =============================================================================


class BabylonOnlineEnvConfig(BaseEnvConfig):
    """Configuration for Babylon Online GRPO Environment"""
    
    # Scenario settings
    scenario_pool_config: ScenarioPoolConfig = Field(
        default_factory=ScenarioPoolConfig,
        description="Configuration for scenario pool"
    )
    
    database_url: str = Field(
        default_factory=lambda: os.getenv("DATABASE_URL", ""),
        description="PostgreSQL connection URL for production snapshots"
    )
    
    # Simulation Bridge settings
    use_simulation_bridge: bool = Field(
        default=False,
        description="Use TypeScript simulation bridge for scenarios"
    )
    simulation_bridge_url: str = Field(
        default="http://localhost:3001",
        description="URL of the TypeScript simulation bridge server"
    )
    bridge_num_npcs: int = Field(
        default=20,
        description="Number of NPCs to create in simulation bridge"
    )
    
    # Generation settings
    max_response_tokens: int = Field(
        default=512,
        description="Maximum tokens for model response"
    )
    
    temperature: float = Field(
        default=0.8,
        description="Temperature for generation"
    )
    
    # Archetype settings
    default_archetype: str = Field(
        default="trader",
        description="Default archetype for scoring"
    )
    
    archetype_distribution: Dict[str, float] = Field(
        default_factory=lambda: {
            "trader": 0.4,
            "degen": 0.2,
            "influencer": 0.15,
            "analyst": 0.15,
            "whale": 0.1,
        },
        description="Distribution of archetypes for training"
    )
    
    include_messages: bool = Field(
        default=False,
        description="Include messages in scored data groups for debugging"
    )
    
    ensure_scores_are_not_same: bool = Field(
        default=True,
        description="Add small noise to break ties when all scores are identical (required for GRPO)"
    )


# =============================================================================
# Online Environment
# =============================================================================


class BabylonOnlineEnv(BaseEnv):
    """
    Babylon Online Environment for GRPO Training.
    
    This environment generates ON-POLICY rollouts:
    1. Samples scenarios from ScenarioPool
    2. Builds prompts from scenario observations
    3. Gets completions from current model via managed_server
    4. Scores responses using deterministic reward functions
    5. Returns properly masked data for GRPO training
    
    Key features:
    - On-policy rollouts (current model, not historical data)
    - Proper token masking via Atropos managed_server
    - Curriculum learning via ScenarioPool
    - Archetype-aware scoring
    """
    
    name = "babylon-online"
    env_config_cls = BabylonOnlineEnvConfig
    
    def __init__(
        self,
        config: BabylonOnlineEnvConfig,
        server_configs: List[APIServerConfig],
        slurm: bool = False,
        testing: bool = False,
    ):
        super().__init__(config, server_configs, slurm, testing)
        self.config: BabylonOnlineEnvConfig = config
        self._server_configs = server_configs  # Store for direct access
        
        # Scenario pool (initialized in setup)
        self.scenario_pool: Optional[ScenarioPool] = None
        
        # Simulation bridge (optional, for TypeScript integration)
        self.simulation_bridge: Optional[SimulationBridge] = None
        self._bridge_npc_index: int = 0
        
        # Metrics tracking
        self.format_scores_buffer: List[float] = []
        self.reasoning_scores_buffer: List[float] = []
        self.action_type_counts: Dict[str, int] = {}
        self.thinking_length_buffer: List[int] = []
        
        # Sample logging for wandb
        self.sample_responses: List[Tuple[str, str, str, float]] = []  # (scenario, response, action, score)
        
        # Iteration counter
        self.iter: int = 0
    
    @classmethod
    def config_init(cls) -> Tuple[BabylonOnlineEnvConfig, List[APIServerConfig]]:
        """Initialize configuration with defaults"""
        env_config = BabylonOnlineEnvConfig(
            tokenizer_name="Qwen/Qwen2.5-3B-Instruct",
            group_size=4,  # Generate 4 responses per scenario for GRPO
            use_wandb=True,
            max_num_workers=64,
            rollout_server_url="http://localhost:8000",
            total_steps=1000,
            batch_size=16,
            steps_per_eval=100,
            max_token_length=4096,
            wandb_name="babylon-online",
            eval_handling=EvalHandlingEnum.LIMIT_TRAIN,
            eval_limit_ratio=0.1,
            database_url=os.getenv("DATABASE_URL", ""),
        )
        
        server_configs = [
            APIServerConfig(
                model_name="Qwen/Qwen2.5-3B-Instruct",
                base_url="http://localhost:9001/v1",
                api_key="x",
                num_requests_for_eval=64,
                server_type="vllm",  # vLLM required for tokens_and_logprobs
            ),
        ]
        
        return env_config, server_configs
    
    async def setup(self):
        """Initialize scenario pool and load scenarios"""
        logger.info("=" * 60)
        logger.info("BABYLON ONLINE ENVIRONMENT SETUP")
        logger.info("=" * 60)
        
        # Initialize simulation bridge if enabled
        if self.config.use_simulation_bridge:
            logger.info("Initializing TypeScript simulation bridge...")
            self.simulation_bridge = SimulationBridge(
                base_url=self.config.simulation_bridge_url,
            )
            await self.simulation_bridge.__aenter__()
            
            # Initialize with archetypes from distribution
            archetypes = list(self.config.archetype_distribution.keys())
            await self.simulation_bridge.initialize(
                num_npcs=self.config.bridge_num_npcs,
                archetypes=archetypes,
            )
            
            logger.info(f"Simulation bridge connected with {len(self.simulation_bridge.npc_ids)} NPCs")
            
            # Register shutdown handler for clean exit
            def _shutdown_bridge_sync():
                """Synchronous wrapper for async shutdown"""
                if self.simulation_bridge is not None:
                    try:
                        # Try to get the running loop (Python 3.10+ compatible)
                        try:
                            loop = asyncio.get_running_loop()
                            # Loop is running, schedule the shutdown task
                            loop.create_task(self.shutdown())
                        except RuntimeError:
                            # No running loop, create a new one
                            asyncio.run(self.shutdown())
                    except Exception as e:
                        logger.warning(f"Error in atexit shutdown: {e}")
            
            atexit.register(_shutdown_bridge_sync)
        
        # Initialize scenario pool (used as fallback or in parallel)
        pool_config = self.config.scenario_pool_config
        self.scenario_pool = ScenarioPool(
            config=pool_config,
            database_url=self.config.database_url or None,
        )
        
        await self.scenario_pool.initialize()
        
        stats = self.scenario_pool.get_stats()
        logger.info(f"Scenario pool initialized:")
        logger.info(f"  Total scenarios: {stats['total_scenarios']}")
        logger.info(f"  Production: {stats['production_scenarios']}")
        logger.info(f"  Synthetic: {stats['synthetic_scenarios']}")
    
    def save_checkpoint(self, step, data=None):
        """Save environment checkpoint"""
        if data is None:
            data = {}
        data["iter"] = self.iter
        # Save curriculum state if available
        if self.scenario_pool and self.scenario_pool.curriculum:
            data["curriculum_stats"] = self.scenario_pool.curriculum.get_stats()
        super().save_checkpoint(step, data)
    
    async def wandb_log(self, wandb_metrics: Optional[Dict] = None):
        """Log metrics to wandb"""
        if wandb_metrics is None:
            wandb_metrics = {}
        
        # Format and reasoning scores
        if self.format_scores_buffer:
            wandb_metrics["train/format_score"] = sum(self.format_scores_buffer) / len(self.format_scores_buffer)
            wandb_metrics["train/format_score_min"] = min(self.format_scores_buffer)
            wandb_metrics["train/format_score_max"] = max(self.format_scores_buffer)
            self.format_scores_buffer.clear()
        
        if self.reasoning_scores_buffer:
            wandb_metrics["train/reasoning_score"] = sum(self.reasoning_scores_buffer) / len(self.reasoning_scores_buffer)
            self.reasoning_scores_buffer.clear()
        
        if self.thinking_length_buffer:
            wandb_metrics["train/avg_thinking_length"] = sum(self.thinking_length_buffer) / len(self.thinking_length_buffer)
            self.thinking_length_buffer.clear()
        
        # Action type distribution
        if self.action_type_counts:
            total = sum(self.action_type_counts.values())
            for action_type, count in self.action_type_counts.items():
                wandb_metrics[f"train/action_{action_type}"] = count / total if total > 0 else 0
            self.action_type_counts.clear()
        
        # Sample responses table
        if self.sample_responses and self.config.use_wandb and wandb.run is not None:
            table = wandb.Table(columns=["scenario", "response", "action", "score"])
            for scenario, response, action, score in self.sample_responses[-10:]:
                table.add_data(scenario[:200], response[:500], action, score)
            wandb_metrics["train/sample_responses"] = table
            self.sample_responses.clear()
        
        # Scenario pool stats
        if self.scenario_pool:
            pool_stats = self.scenario_pool.get_stats()
            wandb_metrics["env/scenarios_total"] = pool_stats["total_scenarios"]
            wandb_metrics["env/samples_since_refresh"] = pool_stats["samples_since_refresh"]
            if "curriculum" in pool_stats:
                wandb_metrics["env/curriculum_solved"] = pool_stats["curriculum"]["solved_scenarios"]
                wandb_metrics["env/curriculum_solve_rate"] = pool_stats["curriculum"]["solve_rate"]
        
        await super().wandb_log(wandb_metrics)
    
    async def get_next_item(self) -> Optional[Tuple[Scenario, str]]:
        """
        Get next scenario for rollout.
        
        Returns:
            Tuple of (scenario, archetype) or None if no scenarios available
        """
        if not self.scenario_pool:
            logger.error("Scenario pool not initialized")
            return None
        
        scenarios = self.scenario_pool.sample(count=1)
        if not scenarios:
            logger.warning("No scenarios available from pool")
            return None
        
        scenario = scenarios[0]
        
        # Select archetype for this rollout
        import random
        archetype = random.choices(
            list(self.config.archetype_distribution.keys()),
            weights=list(self.config.archetype_distribution.values()),
            k=1
        )[0]
        
        self.iter += 1
        
        return (scenario, archetype)
    
    async def collect_trajectories(self, item: Tuple[Scenario, str]) -> Tuple[Optional[ScoredDataGroup], List]:
        """
        Generate on-policy rollouts for a scenario.
        
        This is the core method that:
        1. Builds prompts from the scenario
        2. Gets N completions from the current model
        3. Scores each completion
        4. Returns properly masked data for GRPO
        """
        scenario, archetype = item
        logger.debug(f"collect_trajectories: {scenario.id}, archetype={archetype}")
        
        # Build messages
        system_prompt = build_trading_system_prompt(archetype)
        user_prompt = build_observation_prompt(scenario)
        
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ]
        
        # Check length before generation
        prompt_tokens = len(self.tokenizer.apply_chat_template(messages, add_generation_prompt=True))
        if prompt_tokens > self.config.max_token_length - self.config.max_response_tokens:
            logger.warning(f"Prompt too long ({prompt_tokens} tokens), skipping")
            return None, []
        
        # Generate completions using direct HTTP API (OpenAI-compatible)
        # This mirrors babylon_env's approach for maximum vLLM compatibility
        import aiohttp
        from .tokenization_utils import tokenize_for_trainer
        
        # Get vLLM URL from server config (first config is the inference server)
        vllm_base_url = self._server_configs[0].base_url if self._server_configs else "http://localhost:9001/v1"
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    f"{vllm_base_url}/chat/completions",
                    json={
                        "model": self.config.tokenizer_name,
                        "messages": messages,
                        "n": self.config.group_size,
                        "max_tokens": self.config.max_response_tokens,
                        "temperature": self.config.temperature,
                    },
                    timeout=aiohttp.ClientTimeout(total=120),
                ) as resp:
                    if resp.status != 200:
                        error_text = await resp.text()
                        logger.warning(f"vLLM error {resp.status}: {error_text}")
                        return None, []
                    result = await resp.json()
            
            logger.debug(f"Got {len(result['choices'])} completions for {scenario.id}")
        except asyncio.TimeoutError:
            logger.warning(f"Timeout waiting for vLLM completion")
            return None, []
        except Exception as e:
            logger.error(f"Error calling vLLM: {type(e).__name__}: {e}")
            return None, []
        
        # Build nodes manually by tokenizing each completion
        nodes = []
        for choice in result["choices"]:
            response_content = choice["message"]["content"] or ""
            finish_reason = choice.get("finish_reason", "stop")
            
            # Build full messages for tokenization
            full_messages = copy.deepcopy(messages)
            full_messages.append({
                "role": "assistant",
                "content": response_content,
            })
            
            # Tokenize with proper masking
            tokenization_result = tokenize_for_trainer(
                tokenizer=self.tokenizer,
                messages=full_messages,
            )
            
            nodes.append({
                "response": response_content,
                "tokens": tokenization_result.tokens,
                "masks": tokenization_result.masks,
                "finish_reason": finish_reason,
            })
        
        logger.debug(f"Built {len(nodes)} nodes with tokenization")
        
        if not nodes:
            logger.warning("No nodes returned from completion")
            return None, []
        
        # Process each completion
        rollout_data = []
        for i, node in enumerate(nodes):
            response_content = node["response"]
            finish_reason = node["finish_reason"]
            
            # Build full messages for logging
            full_messages = copy.deepcopy(messages)
            full_messages.append({
                "role": "assistant",
                "content": response_content,
            })
            
            rollout_data.append({
                "scenario": scenario,
                "archetype": archetype,
                "response": response_content,
                "messages": full_messages,
                "tokens": node["tokens"],
                "masks": node["masks"],  # Properly masked by tokenization
                "logprobs": None,  # Not available from OpenAI-compatible API
                "finish_reason": finish_reason,
            })
        
        if len(rollout_data) < 2:
            logger.warning(f"Insufficient rollouts ({len(rollout_data)}), need at least 2")
            return None, []
        
        # Score rollouts
        scored_data = await self._score_rollouts(rollout_data, scenario)
        
        return scored_data, []
    
    async def _score_rollouts(
        self,
        rollout_data: List[Dict],
        scenario: Scenario,
    ) -> Optional[ScoredDataGroup]:
        """
        Score rollouts and build ScoredDataGroup.
        
        Uses deterministic scoring based on:
        - Response format (think tags, valid JSON)
        - Reasoning quality (analysis depth)
        - Action validity
        - Archetype-specific bonuses
        """
        scores = []
        
        for rollout in rollout_data:
            response = rollout["response"]
            archetype = rollout["archetype"]
            
            # Score the response
            score, metrics = score_trading_response(
                response=response,
                scenario=scenario,
                archetype=archetype,
            )
            scores.append(score)
            
            # Track metrics
            self.format_scores_buffer.append(metrics["format_score"])
            self.reasoning_scores_buffer.append(metrics["reasoning_score"])
            self.thinking_length_buffer.append(metrics["thinking_length"])
            
            action_type = metrics["action_type"] or "invalid"
            self.action_type_counts[action_type] = self.action_type_counts.get(action_type, 0) + 1
            
            # Log sample for wandb
            if len(self.sample_responses) < 50:
                self.sample_responses.append((
                    f"[{scenario.difficulty}] {scenario.id}",
                    response[:500],
                    str(metrics.get("action_type")),
                    score,
                ))
        
        # Handle all same scores (bad for GRPO)
        if self.config.ensure_scores_are_not_same:
            if len(set(scores)) == 1:
                # Add small noise to break ties
                import random
                scores = [s + random.uniform(-0.01, 0.01) for s in scores]
        
        # Center scores (important for GRPO stability)
        mean_score = sum(scores) / len(scores)
        centered_scores = [s - mean_score for s in scores]
        
        # Record results for curriculum
        if self.scenario_pool and self.scenario_pool.curriculum:
            max_score = max(scores)
            self.scenario_pool.record_results([scenario.id], [max_score])
        
        # Build ScoredDataGroup
        scored_group = ScoredDataGroup()
        scored_group["tokens"] = []
        scored_group["masks"] = []
        scored_group["scores"] = []
        # Don't include inference_logprobs if not available (causes 422 errors)
        # scored_group["inference_logprobs"] is Optional, so we just don't set it
        scored_group["messages"] = []
        
        for i, rollout in enumerate(rollout_data):
            scored_group["tokens"].append(rollout["tokens"])
            scored_group["masks"].append(rollout["masks"])
            scored_group["scores"].append(centered_scores[i])
            
            if self.config.include_messages:
                scored_group["messages"].append(rollout["messages"])
        
        return scored_group
    
    async def evaluate(self, *args, **kwargs):
        """
        Evaluate current model performance.
        
        Runs evaluation scenarios and logs metrics.
        """
        logger.info("Running evaluation...")
        
        if not self.scenario_pool:
            return
        
        eval_scores = []
        eval_format_scores = []
        eval_action_valid = []
        
        # Sample evaluation scenarios
        eval_scenarios = self.scenario_pool.sample(count=min(20, len(self.scenario_pool.scenarios)))
        
        for scenario in eval_scenarios:
            archetype = self.config.default_archetype
            
            system_prompt = build_trading_system_prompt(archetype)
            user_prompt = build_observation_prompt(scenario)
            
            messages = [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ]
            
            # Single completion for evaluation
            async with self.server.managed_server(tokenizer=self.tokenizer) as managed:
                chat_completion = await managed.chat_completion(
                    messages=messages,
                    n=1,
                    max_tokens=self.config.max_response_tokens,
                    temperature=0.3,  # Lower temperature for eval
                )
            
            if chat_completion.choices:
                response = chat_completion.choices[0].message.content or ""
                score, metrics = score_trading_response(response, scenario, archetype)
                
                eval_scores.append(score)
                eval_format_scores.append(metrics["format_score"])
                eval_action_valid.append(1.0 if metrics["has_valid_action"] else 0.0)
        
        # Log evaluation metrics
        if eval_scores:
            logger.info("Evaluation complete:")
            logger.info(f"  Avg score: {sum(eval_scores) / len(eval_scores):.3f}")
            logger.info(f"  Avg format: {sum(eval_format_scores) / len(eval_format_scores):.3f}")
            logger.info(f"  Valid actions: {sum(eval_action_valid) / len(eval_action_valid):.1%}")


    async def cleanup(self):
        """
        Per-trajectory cleanup - called after EVERY handle_env() call.
        
        NOTE: In atropos, cleanup() is called after each trajectory collection,
        NOT just at shutdown. Do NOT close persistent resources here.
        The simulation bridge should remain open for the next trajectory.
        """
        # Only do lightweight per-trajectory cleanup here
        # The bridge stays open for efficiency
        pass
    
    async def shutdown(self):
        """
        Final shutdown - close all persistent resources.
        Called only when the environment is being destroyed.
        """
        if self.simulation_bridge is not None:
            logger.info("Shutting down simulation bridge...")
            try:
                await self.simulation_bridge.reset()
                await self.simulation_bridge.__aexit__(None, None, None)
            except Exception as e:
                logger.warning(f"Error during bridge shutdown: {e}")
            finally:
                self.simulation_bridge = None
    
    async def _get_bridge_scenario(self) -> Optional[Tuple[Scenario, str]]:
        """
        Get scenario from TypeScript simulation bridge.
        
        Converts bridge scenario format to ScenarioPool format.
        """
        if not self.simulation_bridge or not self.simulation_bridge.is_initialized:
            return None
        
        # Cycle through NPCs
        npc_ids = self.simulation_bridge.npc_ids
        if not npc_ids:
            return None
        
        npc_id = npc_ids[self._bridge_npc_index % len(npc_ids)]
        self._bridge_npc_index += 1
        
        # Get scenario from bridge
        bridge_scenario = await self.simulation_bridge.get_scenario(npc_id)
        archetype = bridge_scenario.archetype
        
        # Convert to ScenarioPool Scenario format
        # This allows reusing existing scoring infrastructure
        scenario = Scenario(
            id=f"bridge-{npc_id}",
            source="production",  # Bridge scenarios count as production data
            difficulty="medium",
        )
        
        # Store bridge scenario data in metadata for later action execution
        scenario.metadata["bridge_scenario"] = bridge_scenario
        scenario.metadata["npc_id"] = npc_id
        
        # Populate scenario fields from bridge data
        scenario.portfolio.balance = bridge_scenario.balance
        scenario.portfolio.positions = [
            {
                "id": p.id,
                "type": p.market_type,
                "ticker": p.ticker,
                "side": p.side,
                "size": p.size,
                "unrealizedPnL": p.unrealized_pnl,
            }
            for p in bridge_scenario.positions
        ]
        
        # Convert bridge market data
        for perp in bridge_scenario.market_state.perp_markets:
            scenario.add_perpetual({
                "ticker": perp.ticker,
                "markPrice": perp.current_price,
                "fundingRate": 0.0001,  # Default
                "volume24h": perp.volume_24h,
                "change24h": perp.change_percent_24h / 100,
            })
        
        for pred in bridge_scenario.market_state.prediction_markets:
            scenario.add_market({
                "id": pred.id,
                "question": pred.question,
                "yesPrice": pred.yes_price,
                "noPrice": pred.no_price,
                "volume24h": 0,
            })
        
        # Convert news
        for news in bridge_scenario.recent_news:
            scenario.add_news({
                "headline": news.content[:100],
                "content": news.content,
                "source": news.source,
                "sentiment": "neutral" if news.sentiment is None else (
                    "bullish" if news.sentiment > 0 else "bearish"
                ),
                "tickers": [],
            })
        
        return (scenario, archetype)
    
    async def execute_action_via_bridge(
        self,
        npc_id: str,
        action: Dict,
        reasoning: str = "",
    ) -> Optional[ActionOutcome]:
        """
        Execute an action via the TypeScript simulation bridge.
        
        This enables true online training where actions affect the simulation state.
        """
        if not self.simulation_bridge or not self.simulation_bridge.is_initialized:
            return None
        
        action_type = action.get("action", "wait")
        
        # Map action format to bridge format
        if action_type == "open_perp":
            direction = action.get("direction", "long")
            bridge_action_type = "open_long" if direction == "long" else "open_short"
            return await self.simulation_bridge.execute_action(
                npc_id=npc_id,
                action_type=bridge_action_type,
                ticker=action.get("ticker"),
                amount=action.get("size"),
                reasoning=reasoning,
            )
        elif action_type == "close_perp":
            return await self.simulation_bridge.execute_action(
                npc_id=npc_id,
                action_type="close_position",
                ticker=action.get("ticker"),
                amount=action.get("size"),
                reasoning=reasoning,
            )
        elif action_type in ("buy", "sell"):
            side = action.get("side", "yes")
            bridge_action_type = f"buy_{side}" if action_type == "buy" else f"sell_{side}"
            return await self.simulation_bridge.execute_action(
                npc_id=npc_id,
                action_type=bridge_action_type,
                market_id=action.get("market"),
                amount=action.get("amount"),
                reasoning=reasoning,
            )
        elif action_type == "wait":
            # No action needed - balance unchanged
            # NOTE: new_balance=0.0 is a placeholder since "wait" doesn't modify state.
            # The caller should use the previous balance from the scenario if needed.
            # We avoid an extra get_scenario() call here for performance.
            return ActionOutcome(
                success=True,
                pnl=0.0,
                new_balance=0.0,  # Placeholder - balance unchanged on wait
                new_positions=[],
                social_impact={},
                events=[],
            )
        
        return None


# CLI entry point
if __name__ == "__main__":
    BabylonOnlineEnv.cli()

