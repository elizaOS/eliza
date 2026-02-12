"""
RLAIF Environment for Atropos

This environment implements Reinforcement Learning from AI Feedback (RLAIF)
for training autonomous trading agents. It supports deterministic and optional
LLM-judge scoring modes for agent trajectory ranking.
trajectories and provides the scored data to the Atropos training loop.

Key features:
- Loads trajectories from PostgreSQL database
- Supports deterministic and LLM-judge scoring modes
- Supports multi-turn agent interactions
- Integrates with Atropos's async rollout system
- Optional Tinker integration for cloud-based training

Based on: https://github.com/NousResearch/atropos/blob/main/environments/rlaif_server.py
Tinker integration: https://tinker-docs.thinkingmachines.ai/
"""

import asyncpg
import aiohttp
import copy
import json
import logging
import os
import random
from datetime import timedelta
from typing import Dict, List, Literal, Optional, Tuple, TYPE_CHECKING

import wandb
from dotenv import load_dotenv
from pydantic import Field

# Atropos imports
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
from .rubric_loader import has_custom_rubric, normalize_archetype
from .tokenization_utils import tokenize_for_trainer
from .quality_scorer import score_response
from .format_validator import validate_response_format, FormatValidationResult
from .evaluation import EvaluationSuite, RolloutDumper
from ..models import Action

# Optional Tinker support
if TYPE_CHECKING:
    from .tinker_client import TinkerClient

logger = logging.getLogger("training_rlaif_env")

# Load environment variables
load_dotenv()


class RLAIFEnvConfig(BaseEnvConfig):
    """Configuration for RLAIF environment"""

    # Database settings
    database_url: str = Field(
        default_factory=lambda: os.getenv("DATABASE_URL", ""),
        description="PostgreSQL connection URL"
    )

    # Training window settings
    lookback_hours: int = Field(
        default=72,
        description="Hours to look back for trajectories"
    )
    min_agents_per_window: int = Field(
        default=2,
        description="Minimum agents required per window"
    )
    min_actions_per_trajectory: int = Field(
        default=3,
        description="Minimum actions required in a trajectory"
    )
    max_steps_per_trajectory: int = Field(
        default=20,
        description="Maximum steps to include from each trajectory"
    )

    # RLAIF Judge settings (Legacy - kept for config compatibility)
    judge_model: str = Field(
        default="gpt-4o-mini",
        description="Model to use for LLM judge scoring (Deprecated by Deterministic Judge)"
    )
    judge_temperature: float = Field(
        default=0.3,
        description="Temperature for judge model"
    )
    judge_max_tokens: int = Field(
        default=2000,
        description="Max tokens for judge response"
    )

    # Scoring preferences
    scoring_rubric: str = Field(
        default="""You are evaluating trading agent performance in a prediction market simulation.

SCORING CRITERIA (0.0 to 1.0):
- Profitability: Higher P&L should receive higher scores
- Risk Management: Balanced positions and avoiding excessive losses
- Efficiency: Achieving goals with fewer actions is better
- Decision Quality: Good reasoning and analysis before actions

SCORING GUIDELINES:
- 0.8-1.0: Excellent performance, consistent profits, good risk management
- 0.6-0.8: Good performance, positive P&L, reasonable decisions
- 0.4-0.6: Average performance, mixed results
- 0.2-0.4: Below average, some losses, questionable decisions
- 0.0-0.2: Poor performance, significant losses, poor decision making

Compare trajectories RELATIVE to each other within this group.
If one trajectory is significantly better, reflect that in score differences.""",
        description="Rubric for LLM judge scoring"
    )

    scoring_mode: Literal["deterministic", "llm_judge"] = Field(
        default="deterministic",
        description="Trajectory scoring mode: deterministic or llm_judge"
    )


class RLAIFEnv(BaseEnv):
    """
    RLAIF Environment for Atropos

    This environment:
    1. Loads trading agent trajectories from PostgreSQL
    2. Groups them by scenario/window for relative comparison
    3. Uses 'The Judge' (Deterministic Python) to score trajectories
    4. Sends scored trajectories to Atropos API for training

    Tinker Integration:
    When use_tinker=True, uses Tinker's SamplingClient for inference
    instead of local vLLM, enabling cloud-based training.
    """

    name = "training-rlaif"
    env_config_cls = RLAIFEnvConfig

    def __init__(
        self,
        config: RLAIFEnvConfig,
        server_configs: List[APIServerConfig],
        slurm: bool = False,
        testing: bool = False,
    ):
        super().__init__(config, server_configs, slurm, testing)
        self.config: RLAIFEnvConfig = config
        self._server_configs = server_configs  # Store for direct access
        self.db_pool: Optional[asyncpg.Pool] = None
        self.trajectory_cache: List[Dict] = []
        self.current_window_idx: int = 0
        self.windows_processed: int = 0
        self.eval_metrics: List[Dict] = []
        self.judgement_samples: List[Tuple[str, str, str]] = []
        
        # Track AI Judge scores for metrics
        self.judge_scores_buffer: List[float] = []
        self.judge_format_scores: List[float] = []
        self.judge_reasoning_scores: List[float] = []

        # Evaluation suite for tracking progress
        self.eval_suite: Optional[EvaluationSuite] = None
        self.rollout_dumper: Optional[RolloutDumper] = None

        # Optional Tinker client (set externally for Tinker-based training)
        self._tinker_client: Optional["TinkerClient"] = None

    @property
    def tinker_client(self) -> Optional["TinkerClient"]:
        """Get Tinker client if available"""
        return self._tinker_client

    @tinker_client.setter
    def tinker_client(self, client: "TinkerClient") -> None:
        """Set Tinker client for cloud-based inference"""
        self._tinker_client = client
        logger.info("Tinker client attached to environment")

    @property
    def use_tinker(self) -> bool:
        """Check if using Tinker for inference"""
        return self._tinker_client is not None and self._tinker_client.is_initialized

    @classmethod
    def config_init(cls) -> Tuple[RLAIFEnvConfig, List[APIServerConfig]]:
        """Initialize configuration with defaults"""
        env_config = RLAIFEnvConfig(
            tokenizer_name="Qwen/Qwen2.5-3B-Instruct",
            group_size=4,  # Match Atropos default for stable GRPO training
            use_wandb=True,
            max_num_workers=64,
            rollout_server_url="http://localhost:8000",
            total_steps=1000,
            batch_size=16,
            steps_per_eval=100,
            max_token_length=4096,
            wandb_name="training-rlaif",
            eval_handling=EvalHandlingEnum.LIMIT_TRAIN,
            eval_limit_ratio=0.1,
            database_url=os.getenv("DATABASE_URL", ""),
        )

        # Server config for the training model (will be updated by vLLM)
        server_configs = [
            APIServerConfig(
                model_name="Qwen/Qwen2.5-3B-Instruct",
                base_url="http://localhost:9001/v1",
                api_key="x",
                num_requests_for_eval=64,
            ),
        ]

        return env_config, server_configs

    async def setup(self):
        """Initialize database connection and load trajectories"""
        logger.info("=" * 60)
        logger.info("RLAIF ENVIRONMENT SETUP")
        logger.info("=" * 60)

        # Connect to database
        if not self.config.database_url:
            raise ValueError("DATABASE_URL not set in environment or config")

        self.db_pool = await asyncpg.create_pool(
            self.config.database_url,
            min_size=2,
            max_size=10,
            command_timeout=60
        )
        logger.info("Connected to PostgreSQL database")

        # Load available trajectories
        await self._load_trajectories()
        logger.info(f"Loaded {len(self.trajectory_cache)} trajectory groups")
        for group in self.trajectory_cache:
            logger.info(f"  Group '{group['group_key']}': {len(group['trajectories'])} trajectories")

        # Initialize evaluation suite and rollout dumper
        self.eval_suite = EvaluationSuite(
            generate_test_count=50,
            success_threshold=0.5,
        )
        self.rollout_dumper = RolloutDumper(
            output_dir="./rollout_dumps",
            success_threshold=0.7,
            save_rate=0.1,  # Save 10% of rollouts for debugging
        )
        logger.info("Initialized EvaluationSuite and RolloutDumper")

    async def _load_trajectories(self):
        """Load trajectories from database and group by scenario/window"""
        if not self.db_pool:
            raise RuntimeError("Database not connected")

        async with self.db_pool.acquire() as conn:
            # Get trajectories with valid steps from recent windows
            # Includes archetype for archetype-aware scoring
            rows = await conn.fetch("""
                SELECT 
                    t."trajectoryId",
                    t."agentId",
                    t."windowId",
                    t."scenarioId",
                    t."stepsJson",
                    t."finalPnL",
                    t."episodeLength",
                    t."totalReward",
                    t."archetype",
                    u.username as agent_name
                FROM trajectories t
                LEFT JOIN "User" u ON t."agentId" = u.id
                WHERE 
                    t."createdAt" > NOW() - $1::interval
                    AND t."stepsJson" IS NOT NULL
                    AND t."stepsJson"::text != 'null'
                    AND t."stepsJson"::text != '[]'
                    AND t."episodeLength" >= $2
                ORDER BY t."windowId", t."scenarioId", t."createdAt"
            """, timedelta(hours=self.config.lookback_hours), self.config.min_actions_per_trajectory)

        # Group trajectories by window/scenario
        groups: Dict[str, List[Dict]] = {}
        for row in rows:
            # Create group key from window and scenario
            group_key = f"{row['windowId']}_{row['scenarioId'] or 'default'}"

            if group_key not in groups:
                groups[group_key] = []

            # Parse steps JSON with error handling
            try:
                steps = json.loads(row['stepsJson'] or '[]')
            except json.JSONDecodeError as e:
                logger.warning(
                    f"Malformed stepsJson for trajectory {row['trajectoryId']}: {e}"
                )
                continue

            if len(steps) < self.config.min_actions_per_trajectory:
                continue

            # Get archetype with warning for NULL values
            archetype = row['archetype']
            if archetype is None:
                logger.debug(
                    f"Trajectory {row['trajectoryId']} has NULL archetype, using 'default'"
                )
                archetype = 'default'

            groups[group_key].append({
                'trajectory_id': row['trajectoryId'],
                'agent_id': row['agentId'],
                'agent_name': row['agent_name'] or row['agentId'][:8],
                'window_id': row['windowId'],
                'scenario_id': row['scenarioId'],
                'archetype': archetype,
                'steps': steps,
                'final_pnl': float(row['finalPnL'] or 0),
                'episode_length': row['episodeLength'] or len(steps),
                'total_reward': float(row['totalReward'] or 0),
            })

        # Filter groups with enough trajectories
        self.trajectory_cache = [
            {'group_key': k, 'trajectories': v}
            for k, v in groups.items()
            if len(v) >= self.config.min_agents_per_window
        ]

        # Shuffle for variety
        random.shuffle(self.trajectory_cache)

    async def wandb_log(self, wandb_metrics: Optional[Dict] = None):
        """Log metrics to wandb including judgement samples"""
        if wandb_metrics is None:
            wandb_metrics = {}

        # Add judgement samples table if available (only if wandb is active)
        if len(self.judgement_samples) > 0 and self.config.use_wandb and wandb.run is not None:
            table = wandb.Table(
                columns=["trajectory_a", "trajectory_b", "judge_reasoning"])
            for item in self.judgement_samples[-10:]:  # Keep last 10
                table.add_data(item[0][:500], item[1][:500], item[2][:500])
            wandb_metrics["train/judgement_samples"] = table

        # Add eval metrics
        if len(self.eval_metrics) > 0:
            wandb_metrics["eval/windows_processed"] = self.windows_processed
            wandb_metrics["eval/avg_pnl"] = sum(
                m.get('avg_pnl', 0) for m in self.eval_metrics
            ) / len(self.eval_metrics) if self.eval_metrics else 0
        
        # Add AI Judge reward metrics
        if len(self.judge_scores_buffer) > 0:
            wandb_metrics["train/aiJudgeReward"] = sum(self.judge_scores_buffer) / len(self.judge_scores_buffer)
            wandb_metrics["train/aiJudgeReward_min"] = min(self.judge_scores_buffer)
            wandb_metrics["train/aiJudgeReward_max"] = max(self.judge_scores_buffer)
            wandb_metrics["train/format_score"] = sum(self.judge_format_scores) / len(self.judge_format_scores)
            wandb_metrics["train/reasoning_score"] = sum(self.judge_reasoning_scores) / len(self.judge_reasoning_scores)
            
            # Clear after logging
            self.judge_scores_buffer = []
            self.judge_format_scores = []
            self.judge_reasoning_scores = []

        self.judgement_samples = []  # Clear after logging
        await super().wandb_log(wandb_metrics)

    async def get_next_item(self) -> Optional[Tuple]:
        """Get next trajectory group for scoring"""
        logger.debug(f"get_next_item called, cache size: {len(self.trajectory_cache)}")
        if not self.trajectory_cache:
            # Reload trajectories if cache is empty
            logger.info("Trajectory cache empty, reloading...")
            await self._load_trajectories()
            logger.info(f"After reload: {len(self.trajectory_cache)} groups")

        if not self.trajectory_cache:
            logger.warning("No trajectories available after reload")
            return None

        # Get next group (circular)
        group = self.trajectory_cache[self.current_window_idx % len(
            self.trajectory_cache)]
        self.current_window_idx += 1

        # Sample trajectories for this batch
        trajs = group['trajectories']
        if len(trajs) > self.config.group_size:
            sampled = random.sample(trajs, self.config.group_size)
        else:
            sampled = trajs

        return (group['group_key'], sampled)

    async def collect_trajectories(self, item: Tuple) -> Tuple[Optional[ScoredDataGroup], List]:
        """
        Collect and score trajectories using RLAIF.

        1. Convert trajectories to chat format
        2. Generate model completions
        3. Score using The Judge (Deterministic Python Logic)
        """
        group_key, trajectory_group = item
        logger.info(f"Collecting trajectories for group: {group_key}, count: {len(trajectory_group)}")

        if len(trajectory_group) < 2:
            logger.warning(f"Group {group_key} has insufficient trajectories")
            return None, []

        # Collect responses from the training model for each trajectory
        rollout_data = []

        # Get vLLM URL from server config (first config is the inference server)
        vllm_base_url = self._server_configs[0].base_url if self._server_configs else "http://localhost:9001/v1"
        model_name = self.config.tokenizer_name
        
        logger.debug(f"Using vLLM at {vllm_base_url}, model: {model_name}")
        
        async with aiohttp.ClientSession() as session:
            for traj in trajectory_group:
                # Build chat messages from trajectory
                messages = self._trajectory_to_messages(traj)

                if len(messages) < 2:
                    logger.debug(f"Skipping trajectory with {len(messages)} messages")
                    continue

                # Truncate to max length
                token_count = len(self.tokenizer.apply_chat_template(messages))
                if token_count > 2048:
                    logger.debug(f"Truncating from {len(messages)} messages ({token_count} tokens)")
                    # Keep system + last few messages
                    messages = [messages[0]] + messages[-4:]

                # Direct call to vLLM
                # Generate multiple completions per prompt for GRPO score variance
                # Temperature > 0 ensures different responses for same prompt
                max_tokens = min(512, self.config.max_token_length // 3)
                num_completions = self.config.group_size  # Generate group_size completions per prompt
                payload = {
                    "model": model_name,
                    "messages": messages,
                    "max_tokens": max_tokens,
                    "n": num_completions,  # Multiple completions for score variance
                    "temperature": 0.7,  # Ensure response diversity
                    "logprobs": True,  # Request logprobs for GRPO KL penalty
                    "top_logprobs": 1,  # Get top logprob per token
                }
                
                try:
                    async with session.post(
                        f"{vllm_base_url}/chat/completions",
                        json=payload,
                        headers={"Content-Type": "application/json"},
                        timeout=aiohttp.ClientTimeout(total=120),
                    ) as resp:
                        if resp.status != 200:
                            error_text = await resp.text()
                            logger.error(f"vLLM returned status {resp.status}: {error_text}")
                            continue
                        result = await resp.json()
                except Exception as e:
                    logger.error(f"Error calling vLLM: {e}")
                    continue

                # Process ALL completions from this prompt (not just the first one)
                choices = result.get("choices", [])
                if not choices:
                    logger.warning(f"No choices returned from vLLM for trajectory {traj.get('trajectory_id')}")
                    continue
                    
                for choice in choices:
                    response_content = choice.get("message", {}).get("content", "")
                    finish_reason = choice.get("finish_reason", "stop")

                    # Build full conversation with this response
                    full_messages = copy.deepcopy(messages)
                    full_messages.append({
                        "role": "assistant",
                        "content": response_content
                    })

                    # Tokenize with proper masking - only train on assistant completions
                    tokenization_result = tokenize_for_trainer(
                        self.tokenizer,
                        full_messages,
                        add_generation_prompt=False,
                    )
                    
                    # Extract logprobs from vLLM response for GRPO KL penalty
                    response_logprobs: List[float] = []
                    logprobs_data = choice.get("logprobs")
                    if logprobs_data and "content" in logprobs_data:
                        for token_info in logprobs_data["content"]:
                            if token_info is not None:
                                response_logprobs.append(token_info.get("logprob", 0.0))
                    
                    # Build full logprobs array: 0.0 for prompt, actual logprobs for completion
                    prompt_len = tokenization_result.prompt_length
                    full_logprobs = [0.0] * prompt_len + response_logprobs
                    
                    # Ensure logprobs match token length
                    if len(full_logprobs) < len(tokenization_result.tokens):
                        # Pad with 0.0 for any missing tokens
                        full_logprobs.extend([0.0] * (len(tokenization_result.tokens) - len(full_logprobs)))
                    elif len(full_logprobs) > len(tokenization_result.tokens):
                        full_logprobs = full_logprobs[:len(tokenization_result.tokens)]
                    
                    rollout_data.append({
                        "trajectory": traj,
                        "generated_response": response_content,
                        "messages": full_messages,
                        "tokens": tokenization_result.tokens,
                        "masks": tokenization_result.masks,  # Proper masking: -100 for prompt, token IDs for completion
                        "logprobs": full_logprobs,  # Logprobs for GRPO KL penalty
                        "finish_reason": finish_reason,
                    })
                
                # Only process one trajectory per group to get group_size completions
                # This is proper GRPO: same prompt, multiple completions, score variance
                if len(rollout_data) >= self.config.group_size:
                    break

        if len(rollout_data) < self.config.group_size:
            logger.warning(f"Insufficient rollouts for group {group_key}: got {len(rollout_data)}, need {self.config.group_size}")
            return None, []
        
        # Trim to exact group_size for consistent batch shapes
        rollout_data = rollout_data[:self.config.group_size]

        # Score using The Judge (Deterministic)
        scored_data = await self._score_with_judge(rollout_data)
        logger.info(f"Scored {len(rollout_data)} rollouts for group {group_key} (GRPO: multiple completions per prompt)")

        self.windows_processed += 1
        return scored_data, []

    def _trajectory_to_messages(self, traj: Dict) -> List[Dict[str, str]]:
        """
        Convert a trajectory to chat messages.

        IMPORTANT: This captures the FULL agent tick including:
        - All LLM calls (reasoning, planning, action)
        - Complete reasoning chains (not truncated)
        - Environment context

        For training, we want to capture exactly what the agent saw and thought.
        """
        messages = []

        # System message with full context
        system_content = f"""You are a trading agent in a prediction market simulation.

Agent: {traj.get('agent_name', 'Agent')}
Window: {traj.get('window_id', 'Unknown')}
Scenario: {traj.get('scenario_id', 'General Trading')}
Final P&L: ${traj.get('final_pnl', 0):.2f}
Episode Length: {traj.get('episode_length', 0)} steps

Your goal is to make profitable trading decisions based on market analysis.
You receive market updates and must analyze, reason, and then act."""

        messages.append({
            "role": "system",
            "content": system_content
        })

        # Convert steps to user/assistant exchanges
        steps = traj.get('steps', [])
        max_steps = self.config.max_steps_per_trajectory

        # Take most recent steps if too many
        if len(steps) > max_steps:
            steps = steps[-max_steps:]

        for step_idx, step in enumerate(steps):
            if not isinstance(step, dict):
                continue

            # PRIORITY 1: Use actual LLM calls if available
            # This captures the REAL prompts and responses the agent used
            llm_calls = step.get('llmCalls', step.get('llm_calls', []))

            if llm_calls:
                # Include ALL LLM calls from this step
                for call_idx, llm_call in enumerate(llm_calls):
                    purpose = llm_call.get('purpose', 'action')

                    # Build rich user content from the actual prompt
                    user_prompt = llm_call.get(
                        'userPrompt', llm_call.get('user_prompt', ''))

                    # Combine system context with user prompt for training
                    user_content = f"[Step {step_idx + 1}, {purpose.upper()}]\n"

                    # Add environment state context
                    env_state = step.get(
                        'environmentState', step.get('environment_state', {}))
                    if env_state:
                        balance = env_state.get(
                            'agentBalance', env_state.get('agent_balance', 0))
                        pnl = env_state.get(
                            'agentPnL', env_state.get('agent_pnl', 0))
                        positions = env_state.get(
                            'openPositions', env_state.get('open_positions', 0))
                        user_content += f"State: Balance=${balance:.2f}, P&L=${pnl:.2f}, Positions={positions}\n\n"

                    # Add the actual user prompt
                    if user_prompt:
                        user_content += user_prompt

                    messages.append({
                        "role": "user",
                        "content": user_content
                    })

                    # Assistant response - use FULL response, not truncated
                    response = llm_call.get('response', '')
                    reasoning = llm_call.get('reasoning', '')

                    # Build comprehensive assistant response
                    assistant_content = ""

                    # Include reasoning if available
                    if reasoning:
                        assistant_content += f"<thinking>\n{reasoning}\n</thinking>\n\n"

                    # Include the actual response
                    if response:
                        assistant_content += response

                    if assistant_content.strip():
                        messages.append({
                            "role": "assistant",
                            "content": assistant_content
                        })
            else:
                # FALLBACK: Build messages from environment state and action
                env_state = step.get('environmentState',
                                     step.get('environment_state', {}))
                balance = env_state.get(
                    'agentBalance', env_state.get('agent_balance', 0))
                pnl = env_state.get('agentPnL', env_state.get('agent_pnl', 0))
                positions = env_state.get(
                    'openPositions', env_state.get('open_positions', 0))

                user_content = f"[Step {step_idx + 1}]\nMarket Update:\n- Balance: ${balance:.2f}\n- P&L: ${pnl:.2f}\n- Open Positions: {positions}"

                # Add any observations
                if 'observation' in step:
                    obs = step['observation']
                    if isinstance(obs, dict):
                        user_content += f"\n- Markets: {len(obs.get('markets', []))}"
                        user_content += f"\n- News: {len(obs.get('news', []))}"

                messages.append({
                    "role": "user",
                    "content": user_content
                })

                # Agent action as assistant message
                action = step.get('action', {})
                action_type = action.get(
                    'actionType', action.get('action_type', 'wait'))
                params = action.get('parameters', {})
                reasoning = action.get('reasoning', '')

                # Build comprehensive assistant response
                assistant_content = ""

                # Include FULL reasoning (not truncated!)
                if reasoning:
                    assistant_content += f"<thinking>\n{reasoning}\n</thinking>\n\n"

                assistant_content += f"Action: {action_type}"
                if params:
                    assistant_content += f"\nParameters: {json.dumps(params, indent=2)}"

                messages.append({
                    "role": "assistant",
                    "content": assistant_content
                })

        return messages

    async def _score_with_judge(self, rollout_data: List[Dict]) -> Optional[ScoredDataGroup]:
        """
        Score rollouts using the configured scoring mode.
        """
        if self.config.scoring_mode == "llm_judge":
            return await self._score_with_llm_judge(rollout_data)
        return await self._score_with_deterministic_judge(rollout_data)

    async def _score_with_llm_judge(self, rollout_data: List[Dict]) -> Optional[ScoredDataGroup]:
        """
        Optional LLM-judge scoring mode.

        This mode is pluggable; when no external judge adapter is configured,
        it falls back to deterministic scoring.
        """
        logger.warning(
            "scoring_mode='llm_judge' requested but no external judge adapter is configured; "
            "falling back to deterministic scoring."
        )
        return await self._score_with_deterministic_judge(rollout_data)

    async def _score_with_deterministic_judge(
        self, rollout_data: List[Dict]
    ) -> Optional[ScoredDataGroup]:
        """
        Score rollouts using archetype-aware deterministic judge logic.
        """
        logger.debug(f"Scoring {len(rollout_data)} rollouts with deterministic judge")
        scores = []

        for item in rollout_data:
            traj = item["trajectory"]
            generated_response = item["generated_response"]

            # 1. Get archetype from trajectory with validation
            # First try trajectory-level archetype, then fall back to step-level
            archetype = traj.get("archetype")
            if archetype is None or archetype == "default":
                # Try to extract from first step's action parameters (batch recording mode)
                archetype = self._extract_archetype_from_steps(traj.get("steps", []))
            if archetype is None:
                archetype = "default"
            archetype_norm = normalize_archetype(archetype)

            # Validate archetype and warn for unknown values
            if not has_custom_rubric(archetype_norm) and archetype_norm != "default":
                logger.warning(
                    f"Unknown archetype '{archetype}' for trajectory, using default scoring"
                )
                archetype_norm = "default"
            elif has_custom_rubric(archetype_norm):
                logger.debug(f"Scoring with custom rubric for archetype: {archetype_norm}")

            # 2. Quality Scores using proper quality_scorer and format_validator
            quality_result = score_response(
                response=generated_response,
                archetype=archetype_norm,
                execute_action=False,  # Don't simulate action execution in offline mode
            )
            
            # Extract format and reasoning scores from quality scorer
            fmt_score = quality_result.combined_format_score
            rsn_score = quality_result.reasoning_score
            
            # Apply penalty for invalid format (missing think tags or action JSON)
            format_validation = validate_response_format(generated_response)
            if not format_validation.is_valid:
                # Reduce format score for invalid responses but don't zero it completely
                fmt_score = max(0.1, fmt_score * 0.5)
            
            # 3. CRITICAL: Score the action itself for variance between completions
            # When multiple completions are generated for the same prompt,
            # the action quality is the PRIMARY differentiator
            action_quality = self._score_action_quality(generated_response, format_validation)

            # 4. Extract behavior metrics for archetype-specific bonuses
            behavior_metrics = self._extract_behavior_metrics(traj)

            # 5. Build reward inputs
            final_pnl = traj.get("final_pnl", 0.0)
            reward_inputs = TrajectoryRewardInputs(
                final_pnl=final_pnl,
                starting_balance=10000.0,
                end_balance=10000.0 + final_pnl,
                format_score=fmt_score,
                reasoning_score=rsn_score,
                risky_actions_count=0,
                trades_executed=behavior_metrics.trades_executed,
                total_actions=behavior_metrics.episode_length,
            )

            # 6. Compute archetype-aware composite score
            base_score = archetype_composite_reward(
                inputs=reward_inputs,
                archetype=archetype_norm,
                behavior_metrics=behavior_metrics,
            )
            
            # 7. GRPO adjustment: Blend base score with action quality
            # For multiple completions per prompt, action quality provides variance
            # Base score comes 40% from trajectory data, so we need action quality to dominate
            final_score = base_score * 0.4 + action_quality * 0.6
            
            # 8. Add tiebreaker epsilon for score variance
            # CRITICAL: GRPO skips batches where all scores are identical (ensure_scores_are_not_same=True)
            # Add small deterministic tiebreakers based on response characteristics
            # NOTE: Using sum of bytes instead of hash() for determinism across Python sessions
            epsilon = 0.0
            epsilon += (len(generated_response) % 100) * 0.0001  # Response length variance
            # Deterministic content-based variance (sum of character codes)
            content_hash = sum(ord(c) for c in generated_response[:50]) % 1000
            epsilon += content_hash * 0.00001  # Content-based variance
            # Add more variance based on action type
            if format_validation.action.action_type:
                action_type_hash = sum(ord(c) for c in format_validation.action.action_type) % 100
                epsilon += action_type_hash * 0.0001
            final_score += epsilon
            
            scores.append(final_score)
            
            # Track for metrics
            self.judge_scores_buffer.append(final_score)
            self.judge_format_scores.append(fmt_score)
            self.judge_reasoning_scores.append(rsn_score)

            # Logging sample for WandB
            if len(self.judgement_samples) < 10:
                self.judgement_samples.append((
                    f"[{archetype_norm}] PnL: {final_pnl:.2f}",
                    generated_response[:100],
                    f"Score: {final_score:.2f} (Fmt: {fmt_score:.2f}, Rsn: {rsn_score:.2f})"
                ))

            # Save rollout for debugging and dataset generation
            if self.rollout_dumper is not None:
                self.rollout_dumper.save_rollout(
                    scenario_id=traj.get("trajectory_id", "unknown"),
                    archetype=archetype_norm,
                    response=generated_response,
                    messages=item["messages"],
                    score=final_score,
                    quality_metrics=quality_result.to_dict(),
                    step=self.windows_processed,
                )

        # Normalize scores to mean 0 for GRPO stability
        mean_score = sum(scores) / len(scores) if scores else 0
        centered_scores = [s - mean_score for s in scores]

        # Build ScoredDataGroup
        scored_group = ScoredDataGroup()
        scored_group["tokens"] = []
        scored_group["masks"] = []
        scored_group["scores"] = []
        scored_group["inference_logprobs"] = []

        for i, rollout in enumerate(rollout_data):
            scored_group["tokens"].append(rollout["tokens"])
            scored_group["masks"].append(rollout["masks"])
            scored_group["scores"].append(centered_scores[i])
            scored_group["inference_logprobs"].append(rollout["logprobs"])

        return scored_group

    def _extract_archetype_from_steps(self, steps: List[Dict]) -> Optional[str]:
        """
        Extract archetype from step action parameters.

        Used when trajectory-level archetype is not set (batch recording mode).
        Returns the first non-null archetype found in any step's action parameters.
        """
        for step in steps:
            action = step.get("action", {})
            params = action.get("parameters", {})
            archetype = params.get("archetype")
            if archetype:
                return str(archetype)
        return None

    def _extract_behavior_metrics(self, traj: Dict) -> BehaviorMetrics:
        """
        Extract behavior metrics from trajectory for archetype-aware scoring.

        Parses steps to count trades, social actions, predictions, etc.
        """
        steps = traj.get("steps", [])

        metrics = BehaviorMetrics(
            total_pnl=traj.get("final_pnl", 0.0),
            episode_length=traj.get("episode_length", len(steps)),
        )

        unique_users: set[str] = set()
        unique_markets: set[str] = set()
        pnl_history: list[float] = []
        social_actions = 0
        trade_actions = 0

        for step in steps:
            action = step.get("action", {})
            action_type = action.get("actionType", action.get("action_type", "")).lower()
            params = action.get("parameters", {})
            result = action.get("result", {})

            # Trading actions
            if action_type in (
                "buy", "sell", "buy_prediction", "sell_prediction",
                "open_perp", "close_perp", "trade"
            ):
                metrics.trades_executed += 1
                trade_actions += 1

                # Track P&L from result
                if "pnl" in result and result["pnl"] is not None:
                    pnl = float(result["pnl"])
                    pnl_history.append(pnl)
                    if pnl > 0:
                        metrics.profitable_trades += 1
                        if pnl > metrics.largest_win:
                            metrics.largest_win = pnl
                    elif pnl < metrics.largest_loss:
                        metrics.largest_loss = pnl

                # Track markets
                market_id = params.get("marketId") or params.get("market") or params.get("ticker")
                if market_id:
                    unique_markets.add(str(market_id))

                # Track position size
                size = params.get("amount") or params.get("size") or params.get("quantity")
                if size:
                    metrics.avg_position_size += float(size)

            # Prediction actions count as trades for archetype scoring (Degen rewards high trade volume)
            # These are tracked separately from buy/sell actions but contribute to trades_executed
            if action_type in ("predict", "bet", "forecast"):
                metrics.predictions_made += 1
                metrics.trades_executed += 1
                trade_actions += 1
                
                # Track accuracy
                if result.get("correct") or result.get("predictionCorrect"):
                    metrics.correct_predictions += 1
                
                # Track P&L from predictions
                if "pnl" in result and result["pnl"] is not None:
                    pnl = float(result["pnl"])
                    pnl_history.append(pnl)
                    if pnl > 0:
                        metrics.profitable_trades += 1
                        if pnl > metrics.largest_win:
                            metrics.largest_win = pnl
                    elif pnl < metrics.largest_loss:
                        metrics.largest_loss = pnl

            # Social actions
            elif action_type in ("send_dm", "direct_message", "dm"):
                metrics.dms_initiated += 1
                social_actions += 1
                target = params.get("targetUserId") or params.get("recipientId") or params.get("toUserId")
                if target:
                    unique_users.add(str(target))

            elif action_type in ("join_group", "join_group_chat", "create_group_chat"):
                metrics.group_chats_joined += 1
                social_actions += 1

            elif action_type in ("create_post", "post"):
                metrics.posts_created += 1
                social_actions += 1

            elif action_type in ("comment", "reply"):
                metrics.comments_made += 1
                social_actions += 1
                author = params.get("authorId") or params.get("targetUserId")
                if author:
                    unique_users.add(str(author))

            elif action_type == "mention":
                metrics.mentions_given += 1
                mentioned = params.get("mentionedUserId")
                if mentioned:
                    unique_users.add(str(mentioned))

            # Research/info actions
            elif action_type in ("research", "analyze", "query"):
                metrics.research_actions += 1

            elif action_type in ("request_info", "ask"):
                metrics.info_requests_sent += 1

            elif action_type in ("share_info", "share"):
                metrics.info_shared += 1

            # Track reputation/influence metrics from environment state
            # NOTE: We assume these are CUMULATIVE values (final totals) similar to
            # agentBalance/agentPnL, not per-step deltas. We take the last step's value
            # as the episode total. If these turn out to be per-step deltas, change = to +=
            env_state = step.get("environmentState", step.get("environment_state", {}))
            if "reputationDelta" in env_state and env_state["reputationDelta"] is not None:
                metrics.reputation_delta = int(env_state["reputationDelta"])
            elif "reputation_delta" in env_state and env_state["reputation_delta"] is not None:
                metrics.reputation_delta = int(env_state["reputation_delta"])
            if "followersGained" in env_state and env_state["followersGained"] is not None:
                metrics.followers_gained = int(env_state["followersGained"])
            elif "followers_gained" in env_state and env_state["followers_gained"] is not None:
                metrics.followers_gained = int(env_state["followers_gained"])
            if "positiveReactions" in env_state and env_state["positiveReactions"] is not None:
                metrics.positive_reactions = int(env_state["positiveReactions"])
            elif "positive_reactions" in env_state and env_state["positive_reactions"] is not None:
                metrics.positive_reactions = int(env_state["positive_reactions"])
            if "informationSpread" in env_state and env_state["informationSpread"] is not None:
                metrics.information_spread = int(env_state["informationSpread"])
            elif "information_spread" in env_state and env_state["information_spread"] is not None:
                metrics.information_spread = int(env_state["information_spread"])

        # Calculate derived metrics
        metrics.unique_users_interacted = len(unique_users)
        metrics.markets_traded = len(unique_markets)

        if metrics.trades_executed > 0:
            metrics.win_rate = metrics.profitable_trades / metrics.trades_executed
            if metrics.avg_position_size > 0:
                metrics.avg_position_size /= metrics.trades_executed

        if metrics.predictions_made > 0:
            metrics.prediction_accuracy = metrics.correct_predictions / metrics.predictions_made

        if trade_actions > 0:
            metrics.social_to_trade_ratio = social_actions / trade_actions
        elif social_actions > 0:
            metrics.social_to_trade_ratio = float(social_actions)

        if metrics.episode_length > 0:
            metrics.actions_per_tick = (trade_actions + social_actions) / metrics.episode_length

        # Calculate P&L variance
        if len(pnl_history) > 1:
            mean_pnl = sum(pnl_history) / len(pnl_history)
            metrics.pnl_variance = sum((p - mean_pnl) ** 2 for p in pnl_history) / len(pnl_history)

        return metrics

    def _score_action_quality(
        self, 
        response: str, 
        format_validation: FormatValidationResult
    ) -> float:
        """
        Score the quality of the action proposed in the response.
        
        This is the PRIMARY source of score variance when comparing multiple
        completions for the same prompt. Different actions = different scores.
        
        Scoring factors:
        - Action type appropriateness (0.3)
        - Parameter quality (0.25)
        - Reasoning-action alignment (0.25)
        - Completeness (0.2)
        
        Returns a score in range [0.0, 1.0]
        """
        score = 0.5  # Start neutral
        
        # Access correct attributes: action (not action_result), think_tags (not think_result)
        action_result = format_validation.action
        think_result = format_validation.think_tags
        
        # 1. Action validation from format validator (0.3 weight)
        if action_result.is_valid_json and action_result.has_action:
            score += 0.15  # Has valid action
            
            if action_result.is_known_action:
                score += 0.10  # Known action type
                
            if action_result.has_required_fields:
                score += 0.05  # Has required fields
        else:
            score -= 0.20  # Invalid or missing action
        
        # 2. Parameter quality (0.25 weight) - evaluate the action parameters
        if action_result.parsed_action:
            action = action_result.parsed_action
            action_type = action.get("action", "").lower()
            
            # Check for sensible parameter values
            if action_type in ("buy", "sell", "trade"):
                amount = action.get("amount") or action.get("size") or 0
                if isinstance(amount, (int, float)):
                    # Reasonable position sizing: not too extreme
                    if 10 <= amount <= 1000:
                        score += 0.10
                    elif 0 < amount < 10 or 1000 < amount <= 5000:
                        score += 0.05
                    # Extreme values reduce score
                    elif amount > 10000:
                        score -= 0.10
                        
                # Has market specified
                if action.get("market") or action.get("marketId") or action.get("ticker"):
                    score += 0.05
                    
            elif action_type in ("open_perp", "close_perp"):
                # Perp trading: check leverage and direction
                leverage = action.get("leverage") or 1
                if isinstance(leverage, (int, float)):
                    if 1 <= leverage <= 10:
                        score += 0.10
                    elif leverage > 20:
                        score -= 0.10  # Excessive leverage
                    else:
                        score += 0.05
                        
            elif action_type == "wait":
                # Wait is valid but less interesting - slight penalty
                score += 0.05
                
            elif action_type in ("post", "create_post", "send_dm", "dm"):
                # Social actions: check for content
                content = action.get("content") or action.get("message") or ""
                if len(str(content)) > 10:
                    score += 0.10
                else:
                    score -= 0.05
                    
            # Check for reasoning field in action
            if action.get("reasoning") or action.get("rationale"):
                score += 0.05
        
        # 3. Reasoning-action alignment (0.25 weight)
        if think_result.thinking_content and action_result.parsed_action:
            thinking = think_result.thinking_content.lower()
            action_type = action_result.action_type or ""
            
            # Check if reasoning mentions the action type
            action_mentioned = action_type in thinking or any(
                term in thinking for term in [action_type, "buy", "sell", "wait", "trade"]
            )
            if action_mentioned:
                score += 0.10
                
            # Check for market/analysis terms in reasoning
            analysis_terms = ["market", "price", "risk", "profit", "position", "trend"]
            analysis_count = sum(1 for term in analysis_terms if term in thinking)
            if analysis_count >= 3:
                score += 0.10
            elif analysis_count >= 1:
                score += 0.05
                
            # Longer, more detailed reasoning is better
            if len(think_result.thinking_content) > 200:
                score += 0.05
        
        # 4. Completeness (0.2 weight) - overall response structure
        if think_result.is_properly_paired and action_result.is_valid_json:
            score += 0.10  # Well-formed response
            
        # Check response isn't truncated/incomplete
        response_lower = response.lower()
        if response.strip().endswith("}") or "</think>" in response_lower:
            score += 0.05
        
        # Avoid very short responses
        if len(response) > 200:
            score += 0.05
        elif len(response) < 50:
            score -= 0.10
        
        # Clamp to valid range
        return max(0.0, min(1.0, score))

    async def evaluate(self, *args, **kwargs):
        """Evaluate current model performance using EvaluationSuite"""
        logger.info("Running evaluation...")

        # Collect evaluation results from trajectory data
        eval_results = []
        
        for _ in range(min(10, len(self.trajectory_cache))):
            if not self.trajectory_cache:
                break

            group = random.choice(self.trajectory_cache)
            trajs = group["trajectories"]

            avg_pnl = sum(t.get("final_pnl", 0) for t in trajs) / len(trajs)
            avg_length = sum(t.get("episode_length", 0)
                             for t in trajs) / len(trajs)

            eval_results.append({
                "group_key": group["group_key"],
                "trajectory_count": len(trajs),
                "avg_pnl": avg_pnl,
                "avg_length": avg_length,
            })

        self.eval_metrics = eval_results

        if eval_results:
            overall_pnl = sum(r["avg_pnl"]
                              for r in eval_results) / len(eval_results)
            logger.info(
                f"Evaluation complete: {len(eval_results)} groups, avg P&L: ${overall_pnl:.2f}")
        
        # Get evaluation suite summary if available
        if self.eval_suite is not None:
            summary = self.eval_suite.get_summary()
            logger.info(f"EvaluationSuite summary: {summary}")
        
        # Log rollout dumper stats if available
        if self.rollout_dumper is not None:
            stats = self.rollout_dumper.get_stats()
            logger.info(f"RolloutDumper stats: {stats}")

    def save_checkpoint(self, step, data=None):
        """Save environment checkpoint"""
        if data is None:
            data = {}
        data["current_window_idx"] = self.current_window_idx
        data["windows_processed"] = self.windows_processed
        super().save_checkpoint(step, data)

    async def cleanup(self):
        """Clean up resources"""
        if self.db_pool:
            logger.info("Closing database connection pool...")
            await self.db_pool.close()
            self.db_pool = None
        
        # Flush rollout dumper buffers
        if self.rollout_dumper is not None:
            logger.info("Flushing rollout dumper buffers...")
            self.rollout_dumper.flush_buffers()
            stats = self.rollout_dumper.get_stats()
            logger.info(f"Final RolloutDumper stats: {stats}")
        
        # Save evaluation results
        if self.eval_suite is not None and len(self.eval_suite.history) > 0:
            logger.info("Saving evaluation results...")
            import os
            os.makedirs("./eval_results", exist_ok=True)
            self.eval_suite.save_results("./eval_results/history.json")
        
        await super().cleanup() if hasattr(super(), 'cleanup') else None


# CLI entry point
if __name__ == "__main__":
    RLAIFEnv.cli()


# Backward compatibility aliases while downstream imports migrate.
BabylonEnvConfig = RLAIFEnvConfig
BabylonRLAIFEnv = RLAIFEnv
