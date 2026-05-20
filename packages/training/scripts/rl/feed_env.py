"""
Feed RLAIF Environment for Atropos

This environment implements Reinforcement Learning from AI Feedback (RLAIF)
for training Feed trading agents. It uses an LLM judge to score agent
trajectories and provides the scored data to the Atropos training loop.

Key features:
- Loads trajectories from PostgreSQL database
- Uses LLM-as-judge for RLAIF scoring (relative comparison within groups)
- Supports multi-turn agent interactions
- Integrates with Atropos's async rollout system
- Optional Tinker integration for cloud-based training

Based on: https://github.com/NousResearch/atropos/blob/main/environments/rlaif_server.py
Tinker integration: https://tinker-docs.thinkingmachines.ai/
"""

import copy
import json
import logging
import os
import random
from datetime import timedelta
from typing import TYPE_CHECKING, Optional

import aiohttp
import asyncpg
import wandb

# Atropos imports
from atroposlib.envs.base import (
    APIServerConfig,
    BaseEnv,
    BaseEnvConfig,
    EvalHandlingEnum,
    ScoredDataGroup,
)
from dotenv import load_dotenv
from pydantic import Field

from .evaluation import EvaluationSuite, RolloutDumper
from .format_validator import FormatValidationResult, validate_response_format
from .kl_controller import KLConfig, create_kl_controller
from .market_regime import (
    extract_regime_from_trajectory,
)
from .multi_turn import GAEConfig, MultiTurnEpisodeManager, shape_trading_rewards
from .quality_scorer import score_response
from .reward_config import get_regime_expected_return, get_temporal_decay_rate
from .rewards import (
    BehaviorMetrics,
    TrajectoryRewardInputs,
    compute_counterfactual,
    enhanced_composite_reward,
)
from .rubric_loader import has_custom_rubric, normalize_archetype
from .temporal_credit import attribute_temporal_credit
from .tokenization_utils import tokenize_for_trainer

# Optional Tinker support
if TYPE_CHECKING:
    from .tinker_client import FeedTinkerClient

logger = logging.getLogger("feed_env")

# Load environment variables
load_dotenv()


class FeedEnvConfig(BaseEnvConfig):
    """Configuration for Feed RLAIF environment"""

    # =========================================================================
    # Trajectory Source Configuration
    # =========================================================================
    trajectory_source: str = Field(
        default_factory=lambda: os.getenv("TRAJECTORY_SOURCE", "db"),
        description="Source for trajectories: 'db' (PostgreSQL), 'huggingface', or 'local_export'",
    )

    # Database settings (used when trajectory_source='db')
    database_url: str = Field(
        default_factory=lambda: os.getenv("DATABASE_URL", ""),
        description="PostgreSQL connection URL",
    )

    # HuggingFace settings (used when trajectory_source='huggingface')
    hf_trajectory_dataset: str = Field(
        default_factory=lambda: os.getenv("HF_TRAJECTORY_DATASET", ""),
        description="HuggingFace dataset ID (e.g., 'elizaos/feed-trajectories-v1')",
    )
    hf_trajectory_split: str = Field(
        default_factory=lambda: os.getenv("HF_TRAJECTORY_SPLIT", "raw"),
        description="HuggingFace dataset split to use: 'raw', 'preferences', 'sft'",
    )
    local_export_dir: str = Field(
        default_factory=lambda: os.getenv("LOCAL_EXPORT_DIR", ""),
        description="Local Feed trajectory export directory when trajectory_source='local_export'",
    )

    # Training window settings
    lookback_hours: int = Field(
        default=720,  # 30 days - increased from 72 for imported data
        description="Hours to look back for trajectories (only for database source)",
    )
    min_agents_per_window: int = Field(default=2, description="Minimum agents required per window")
    min_actions_per_trajectory: int = Field(
        default=3, description="Minimum actions required in a trajectory"
    )
    max_steps_per_trajectory: int = Field(
        default=20, description="Maximum steps to include from each trajectory"
    )
    max_trajectories: int = Field(
        default=1000, description="Maximum trajectories to load from database (prevents OOM)"
    )
    trajectory_batch_size: int = Field(
        default=100, description="Number of trajectories to fetch per batch"
    )

    reward_weight_profile: str = Field(
        default_factory=lambda: os.getenv("REWARD_WEIGHT_PROFILE", "default"),
        description="Reward weight profile name from packages/training/config/reward_weights.yaml",
    )

    # RLAIF Judge settings (Legacy - kept for config compatibility)
    judge_model: str = Field(
        default="gpt-4o-mini",
        description="Model to use for LLM judge scoring (Deprecated by Deterministic Judge)",
    )
    judge_temperature: float = Field(default=0.3, description="Temperature for judge model")
    judge_max_tokens: int = Field(default=2000, description="Max tokens for judge response")

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
        description="Rubric for LLM judge scoring",
    )


class FeedRLAIFEnv(BaseEnv):
    """
    Feed RLAIF Environment for Atropos

    This environment:
    1. Loads trading agent trajectories from PostgreSQL
    2. Groups them by scenario/window for relative comparison
    3. Uses 'The Judge' (Deterministic Python) to score trajectories
    4. Sends scored trajectories to Atropos API for training

    Tinker Integration:
    When use_tinker=True, uses Tinker's SamplingClient for inference
    instead of local vLLM, enabling cloud-based training.
    """

    name = "feed-rlaif"
    env_config_cls = FeedEnvConfig

    def __init__(
        self,
        config: FeedEnvConfig,
        server_configs: list[APIServerConfig],
        slurm: bool = False,
        testing: bool = False,
    ):
        super().__init__(config, server_configs, slurm, testing)
        self.config: FeedEnvConfig = config
        self._server_configs = server_configs  # Store for direct access
        self.db_pool: asyncpg.Pool | None = None
        self.trajectory_cache: list[dict] = []
        self.current_window_idx: int = 0
        self.windows_processed: int = 0
        self.eval_metrics: list[dict] = []
        self.judgement_samples: list[tuple[str, str, str]] = []

        # Track AI Judge scores for metrics
        self.judge_scores_buffer: list[float] = []
        self.judge_format_scores: list[float] = []
        self.judge_reasoning_scores: list[float] = []
        self.enhanced_reward_metrics = {
            "regime_counts": {"bull": 0, "bear": 0, "sideways": 0},
            "alphas": [],
            "volatilities": [],
            # Social reward metrics (BAB-71)
            "social_engagement": [],
            "social_spread": [],
            "social_network": [],
            "social_narrative": [],
            "social_total": [],
        }

        # Evaluation suite for tracking progress
        self.eval_suite: EvaluationSuite | None = None
        self.rollout_dumper: RolloutDumper | None = None

        # Optional Tinker client (set externally for Tinker-based training)
        self._tinker_client: FeedTinkerClient | None = None

        # KL controller: prevents reward hacking by penalizing divergence from
        # reference policy. Adaptive coefficient targets KL ≈ 3.0 nats.
        kl_coeff = float(os.getenv("KL_COEFF", "0.1"))
        try:
            self._kl_controller = create_kl_controller(
                KLConfig(
                    reference_model_name=config.tokenizer_name,
                    kl_coeff=kl_coeff,
                    kl_target=3.0,
                    adaptive=True,
                )
            )
            logger.info(f"KL controller initialized (coeff={kl_coeff})")
        except Exception as e:
            logger.warning(f"KL controller disabled: {e}")
            self._kl_controller = None

        # Multi-turn episode manager: applies GAE credit assignment for
        # multi-step trajectories so early good decisions get proper credit.
        self._episode_manager = MultiTurnEpisodeManager(
            GAEConfig(
                gamma=0.99,
                gae_lambda=0.95,
                normalize_advantages=True,
            )
        )

    @property
    def tinker_client(self) -> Optional["FeedTinkerClient"]:
        """Get Tinker client if available"""
        return self._tinker_client

    @tinker_client.setter
    def tinker_client(self, client: "FeedTinkerClient") -> None:
        """Set Tinker client for cloud-based inference"""
        self._tinker_client = client
        logger.info("Tinker client attached to environment")

    @property
    def use_tinker(self) -> bool:
        """Check if using Tinker for inference"""
        return self._tinker_client is not None and self._tinker_client.is_initialized

    @classmethod
    def config_init(cls) -> tuple[FeedEnvConfig, list[APIServerConfig]]:
        """Initialize configuration with defaults"""
        env_config = FeedEnvConfig(
            tokenizer_name="Qwen/Qwen2.5-3B-Instruct",
            group_size=4,  # Match Atropos default for stable GRPO training
            use_wandb=True,
            max_num_workers=64,
            rollout_server_url="http://localhost:8000",
            total_steps=1000,
            batch_size=16,
            steps_per_eval=100,
            max_token_length=4096,
            wandb_name="feed-rlaif",
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
        """Initialize data source connection and load trajectories"""
        logger.info("=" * 60)
        logger.info("FEED RLAIF ENVIRONMENT SETUP")
        logger.info("=" * 60)

        # Determine trajectory source
        source = self.config.trajectory_source.lower()
        logger.info(f"Trajectory source: {source}")

        valid_sources = ("db", "database", "huggingface", "hf", "local_export")
        if source not in valid_sources:
            raise ValueError(
                f"Invalid trajectory_source: '{source}'. Valid options: {', '.join(valid_sources)}"
            )

        if source in ("huggingface", "hf"):
            await self._setup_huggingface_source()
        elif source == "local_export":
            await self._setup_local_export_source()
        else:
            # db or database: use PostgreSQL source
            await self._setup_database_source()

        logger.info(f"Loaded {len(self.trajectory_cache)} trajectory groups")
        for group in self.trajectory_cache:
            logger.info(
                f"  Group '{group['group_key']}': {len(group['trajectories'])} trajectories"
            )

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

    async def _setup_database_source(self):
        """Initialize PostgreSQL database connection and load trajectories."""
        if not self.config.database_url:
            raise ValueError("DATABASE_URL not set in environment or config")

        # Parse connection URL to detect pooler vs direct connection
        db_url = self.config.database_url
        is_supabase_pooler = "pooler.supabase.com" in db_url or ":6543" in db_url

        if is_supabase_pooler:
            logger.warning(
                "⚠️  Detected Supabase pooler connection (port 6543). "
                "This may cause issues with asyncpg prepared statements. "
                "Consider using direct connection (port 5432) for best reliability."
            )

        # Create pool with settings optimized for connection poolers
        # statement_cache_size=0 disables prepared statement caching which breaks
        # with transaction poolers like Supabase's PgBouncer
        self.db_pool = await asyncpg.create_pool(
            db_url,
            min_size=1,
            max_size=5,
            command_timeout=120,  # 2 minute timeout for large queries
            statement_cache_size=0,  # Disable for pooler compatibility
            server_settings={
                "application_name": "feed-training",
            },
        )
        logger.info("Connected to PostgreSQL database")

        # Load trajectories from database
        await self._load_trajectories_from_db()

    async def _setup_huggingface_source(self):
        """Initialize HuggingFace dataset reader and load trajectories."""
        if not self.config.hf_trajectory_dataset:
            raise ValueError(
                "HF_TRAJECTORY_DATASET not set. Required when TRAJECTORY_SOURCE=huggingface"
            )

        from ..data_bridge.hf_reader import HFReaderConfig, HuggingFaceTrajectoryReader

        logger.info(f"Loading from HuggingFace: {self.config.hf_trajectory_dataset}")
        logger.info(f"  Split: {self.config.hf_trajectory_split}")

        config = HFReaderConfig(
            dataset_id=self.config.hf_trajectory_dataset,
            split=self.config.hf_trajectory_split,
            max_trajectories=self.config.max_trajectories,
            min_actions=self.config.min_actions_per_trajectory,
        )

        reader = HuggingFaceTrajectoryReader(config)
        await reader.connect()

        # Get trajectory groups in the same format as database loading
        # RL sampling generates multiple completions from a single prompt, so
        # export/HF corpora with mostly singleton windows remain usable here.
        self.trajectory_cache = reader.get_trajectory_groups(min_agents_per_window=1)

        # Log stats
        stats = reader.get_stats()
        logger.info("HuggingFace dataset stats:")
        logger.info(f"  Total trajectories: {stats['total_trajectories']}")
        logger.info(f"  Total windows: {stats['total_windows']}")
        logger.info(f"  Avg P&L: ${stats['avg_pnl']:.2f}")
        logger.info(f"  Archetypes: {stats['archetypes']}")

        # Shuffle for variety
        import random

        random.shuffle(self.trajectory_cache)

    async def _setup_local_export_source(self):
        """Load trajectories from a local Feed export directory."""
        source_dir = str(self.config.local_export_dir or "").strip()
        if not source_dir:
            raise ValueError(
                "LOCAL_EXPORT_DIR not set. Required when TRAJECTORY_SOURCE=local_export"
            )

        from ..data_bridge.reader import JsonTrajectoryReader, has_minimum_usable_action_steps

        reader = JsonTrajectoryReader(source_dir)
        groups: dict[str, list[dict]] = {}
        selected_trajectories = 0

        for window_id in sorted(reader.get_window_ids()):
            if (
                self.config.max_trajectories is not None
                and selected_trajectories >= self.config.max_trajectories
            ):
                break

            for trajectory_data in reader.get_trajectories_by_window(window_id):
                steps = trajectory_data.get("steps", trajectory_data.get("stepsJson", []))
                if isinstance(steps, str):
                    try:
                        steps = json.loads(steps or "[]")
                    except json.JSONDecodeError as exc:
                        logger.warning(
                            "Malformed local-export steps for trajectory %s: %s",
                            trajectory_data.get("trajectoryId")
                            or trajectory_data.get("trajectory_id")
                            or "unknown",
                            exc,
                        )
                        continue
                if not isinstance(steps, list):
                    continue

                has_enough_steps, valid_step_count = has_minimum_usable_action_steps(
                    steps,
                    min_actions=self.config.min_actions_per_trajectory,
                )
                if not has_enough_steps:
                    logger.debug(
                        "Skipping local-export trajectory %s: only %s usable action-bearing steps",
                        trajectory_data.get("trajectoryId")
                        or trajectory_data.get("trajectory_id")
                        or "unknown",
                        valid_step_count,
                    )
                    continue

                metadata = (
                    trajectory_data.get("metadata") or trajectory_data.get("metadataJson") or {}
                )
                if isinstance(metadata, str):
                    try:
                        metadata = json.loads(metadata) if metadata else {}
                    except json.JSONDecodeError:
                        metadata = {}
                if not isinstance(metadata, dict):
                    metadata = {}

                scenario_id = trajectory_data.get("scenarioId") or trajectory_data.get(
                    "scenario_id"
                )
                group_key = f"{window_id}_{scenario_id or 'default'}"
                final_pnl = float(
                    trajectory_data.get("finalPnL") or trajectory_data.get("final_pnl") or 0.0
                )
                raw_final_balance = trajectory_data.get("finalBalance") or trajectory_data.get(
                    "final_balance"
                )
                final_balance: float | None = None
                starting_balance: float | None = None
                if raw_final_balance is not None:
                    try:
                        final_balance = float(raw_final_balance)
                        starting_balance = final_balance - final_pnl
                    except (TypeError, ValueError):
                        final_balance = None
                        starting_balance = None

                agent_id = (
                    trajectory_data.get("agentId")
                    or trajectory_data.get("agent_id")
                    or trajectory_data.get("userId")
                    or f"{window_id}:{selected_trajectories}"
                )
                agent_name = (
                    metadata.get("username") or metadata.get("displayName") or str(agent_id)[:8]
                )
                archetype = (
                    trajectory_data.get("archetype") or metadata.get("archetype") or "default"
                )

                groups.setdefault(group_key, []).append(
                    {
                        "trajectory_id": trajectory_data.get("trajectoryId")
                        or trajectory_data.get("trajectory_id")
                        or trajectory_data.get("id")
                        or f"{window_id}:{selected_trajectories}",
                        "agent_id": agent_id,
                        "agent_name": agent_name,
                        "window_id": window_id,
                        "scenario_id": scenario_id,
                        "archetype": archetype,
                        "metadata": metadata,
                        "steps": steps,
                        "final_pnl": final_pnl,
                        "final_balance": final_balance,
                        "starting_balance": starting_balance,
                        "episode_length": int(
                            trajectory_data.get("episodeLength")
                            or trajectory_data.get("episode_length")
                            or len(steps)
                        ),
                        "total_reward": float(
                            trajectory_data.get("totalReward")
                            or trajectory_data.get("total_reward")
                            or 0.0
                        ),
                    }
                )
                selected_trajectories += 1
                if (
                    self.config.max_trajectories is not None
                    and selected_trajectories >= self.config.max_trajectories
                ):
                    break

        self.trajectory_cache = [
            {"group_key": key, "trajectories": trajectories}
            for key, trajectories in groups.items()
            if len(trajectories) >= 1
        ]

        random.shuffle(self.trajectory_cache)
        logger.info(
            "Loaded %s local-export trajectories across %s comparable groups",
            selected_trajectories,
            len(self.trajectory_cache),
        )

    async def _load_trajectories_from_db(self):
        """Load trajectories from database and group by scenario/window"""
        if not self.db_pool:
            raise RuntimeError("Database not connected")

        logger.info(
            f"Loading trajectories (lookback={self.config.lookback_hours}h, "
            f"max={self.config.max_trajectories}, min_actions={self.config.min_actions_per_trajectory})"
        )

        async with self.db_pool.acquire() as conn:
            # First, check total available trajectories for diagnostics
            try:
                count_row = await conn.fetchrow(
                    """
                    SELECT COUNT(*) as total,
                           COUNT(*) FILTER (WHERE "createdAt" > NOW() - $1::interval) as recent
                    FROM trajectories
                    WHERE "isTrainingData" = true
                """,
                    timedelta(hours=self.config.lookback_hours),
                )

                total_count = count_row["total"] if count_row else 0
                recent_count = count_row["recent"] if count_row else 0
                logger.info(
                    f"Database has {total_count} total trajectories, {recent_count} within lookback window"
                )

                if recent_count == 0 and total_count > 0:
                    logger.warning(
                        f"⚠️  No trajectories within {self.config.lookback_hours}h lookback, "
                        f"but {total_count} exist. Consider increasing --lookback-hours"
                    )
            except Exception as e:
                logger.warning(f"Could not get trajectory count: {e}")

            # Get trajectories with valid steps from recent windows
            # Includes archetype for archetype-aware scoring
            # LIMIT prevents OOM on large datasets
            # Note: LEFT JOIN on User is optional - we handle NULL agent_name
            rows = await conn.fetch(
                """
                SELECT
                    t."trajectoryId",
                    t."agentId",
                    t."windowId",
                    t."scenarioId",
                    t."stepsJson",
                    t."metadataJson",
                    t."finalPnL",
                    t."finalBalance",
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
                ORDER BY t."createdAt" DESC
                LIMIT $3
            """,
                timedelta(hours=self.config.lookback_hours),
                self.config.min_actions_per_trajectory,
                self.config.max_trajectories,
            )

        logger.info(f"Fetched {len(rows)} trajectories from database")

        # Group trajectories by window/scenario
        groups: dict[str, list[dict]] = {}
        for row in rows:
            # Create group key from window and scenario
            group_key = f"{row['windowId']}_{row['scenarioId'] or 'default'}"

            if group_key not in groups:
                groups[group_key] = []

            # Parse steps JSON with error handling
            try:
                steps = json.loads(row["stepsJson"] or "[]")
            except json.JSONDecodeError as e:
                logger.warning(f"Malformed stepsJson for trajectory {row['trajectoryId']}: {e}")
                continue

            if len(steps) < self.config.min_actions_per_trajectory:
                continue

            # Get archetype with warning for NULL values
            archetype = row["archetype"]
            if archetype is None:
                logger.debug(
                    f"Trajectory {row['trajectoryId']} has NULL archetype, using 'default'"
                )
                archetype = "default"

            metadata = row.get("metadataJson") or {}
            if isinstance(metadata, str):
                try:
                    metadata = json.loads(metadata) if metadata else {}
                except json.JSONDecodeError as e:
                    logger.warning(
                        f"Malformed metadataJson for trajectory {row['trajectoryId']}: {e}"
                    )
                    metadata = {}

            final_pnl = float(row["finalPnL"] or 0.0)

            final_balance: float | None = None
            starting_balance: float | None = None
            raw_final_balance = row.get("finalBalance")
            if raw_final_balance is not None:
                try:
                    final_balance = float(raw_final_balance)
                    starting_balance = final_balance - final_pnl
                except (TypeError, ValueError) as e:
                    logger.warning(
                        f"Malformed finalBalance for trajectory {row['trajectoryId']}: {e}"
                    )

            groups[group_key].append(
                {
                    "trajectory_id": row["trajectoryId"],
                    "agent_id": row["agentId"],
                    "agent_name": row["agent_name"] or row["agentId"][:8],
                    "window_id": row["windowId"],
                    "scenario_id": row["scenarioId"],
                    "archetype": archetype,
                    "metadata": metadata,
                    "steps": steps,
                    "final_pnl": final_pnl,
                    "final_balance": final_balance,
                    "starting_balance": starting_balance,
                    "episode_length": row["episodeLength"] or len(steps),
                    "total_reward": float(row["totalReward"] or 0),
                }
            )

        # Filter groups with enough trajectories
        self.trajectory_cache = [
            {"group_key": k, "trajectories": v}
            for k, v in groups.items()
            if len(v) >= self.config.min_agents_per_window
        ]

        # Shuffle for variety
        random.shuffle(self.trajectory_cache)

    async def wandb_log(self, wandb_metrics: dict | None = None):
        """Log metrics to wandb including judgement samples"""
        if wandb_metrics is None:
            wandb_metrics = {}

        # Add judgement samples table if available (only if wandb is active)
        if len(self.judgement_samples) > 0 and self.config.use_wandb and wandb.run is not None:
            table = wandb.Table(columns=["trajectory_a", "trajectory_b", "judge_reasoning"])
            for item in self.judgement_samples[-10:]:  # Keep last 10
                table.add_data(item[0][:500], item[1][:500], item[2][:500])
            wandb_metrics["train/judgement_samples"] = table

        # Add eval metrics
        if len(self.eval_metrics) > 0:
            wandb_metrics["eval/windows_processed"] = self.windows_processed
            wandb_metrics["eval/avg_pnl"] = (
                sum(m.get("avg_pnl", 0) for m in self.eval_metrics) / len(self.eval_metrics)
                if self.eval_metrics
                else 0
            )

        # Add AI Judge reward metrics
        if len(self.judge_scores_buffer) > 0:
            wandb_metrics["train/aiJudgeReward"] = sum(self.judge_scores_buffer) / len(
                self.judge_scores_buffer
            )
            wandb_metrics["train/aiJudgeReward_min"] = min(self.judge_scores_buffer)
            wandb_metrics["train/aiJudgeReward_max"] = max(self.judge_scores_buffer)
            wandb_metrics["train/format_score"] = sum(self.judge_format_scores) / len(
                self.judge_format_scores
            )
            wandb_metrics["train/reasoning_score"] = sum(self.judge_reasoning_scores) / len(
                self.judge_reasoning_scores
            )

            # Clear after logging
            self.judge_scores_buffer = []
            self.judge_format_scores = []
            self.judge_reasoning_scores = []

        # Add enhanced reward metrics (regime, alpha, temporal)
        m = self.enhanced_reward_metrics
        counts = m["regime_counts"]
        total = sum(counts.values())
        has_enhanced_metrics = total > 0 or bool(m["alphas"]) or bool(m["volatilities"])

        if has_enhanced_metrics:
            if total > 0:
                for regime in ("bull", "bear", "sideways"):
                    wandb_metrics[f"train/regime_{regime}_pct"] = counts[regime] / total

            if m["alphas"]:
                wandb_metrics["train/counterfactual_alpha_mean"] = sum(m["alphas"]) / len(
                    m["alphas"]
                )
                wandb_metrics["train/counterfactual_alpha_min"] = min(m["alphas"])
                wandb_metrics["train/counterfactual_alpha_max"] = max(m["alphas"])

            if m["volatilities"]:
                wandb_metrics["train/market_volatility_mean"] = sum(m["volatilities"]) / len(
                    m["volatilities"]
                )

            # Social reward metrics (BAB-71)
            if m["social_total"]:
                wandb_metrics["train/social_reward_mean"] = sum(m["social_total"]) / len(
                    m["social_total"]
                )
                wandb_metrics["train/social_engagement_mean"] = sum(m["social_engagement"]) / len(
                    m["social_engagement"]
                )
                wandb_metrics["train/social_spread_mean"] = sum(m["social_spread"]) / len(
                    m["social_spread"]
                )
                wandb_metrics["train/social_network_mean"] = sum(m["social_network"]) / len(
                    m["social_network"]
                )
                wandb_metrics["train/social_narrative_mean"] = sum(m["social_narrative"]) / len(
                    m["social_narrative"]
                )

            # Reset for next logging interval
            self.enhanced_reward_metrics = {
                "regime_counts": {"bull": 0, "bear": 0, "sideways": 0},
                "alphas": [],
                "volatilities": [],
                "social_engagement": [],
                "social_spread": [],
                "social_network": [],
                "social_narrative": [],
                "social_total": [],
            }

        self.judgement_samples = []  # Clear after logging
        await super().wandb_log(wandb_metrics)

    async def _reload_trajectories(self):
        """Reload trajectories from the configured source."""
        source = self.config.trajectory_source.lower()
        # Accept both "huggingface" and "hf" aliases (same as setup())
        if source in ("huggingface", "hf"):
            await self._setup_huggingface_source()
        elif source == "local_export":
            await self._setup_local_export_source()
        else:
            await self._load_trajectories_from_db()

    async def get_next_item(self) -> tuple | None:
        """Get next trajectory group for scoring"""
        logger.debug(f"get_next_item called, cache size: {len(self.trajectory_cache)}")
        if not self.trajectory_cache:
            # Reload trajectories if cache is empty
            logger.info("Trajectory cache empty, reloading...")
            await self._reload_trajectories()
            logger.info(f"After reload: {len(self.trajectory_cache)} groups")

        if not self.trajectory_cache:
            logger.warning("No trajectories available after reload")
            return None

        # Get next group (circular)
        group = self.trajectory_cache[self.current_window_idx % len(self.trajectory_cache)]
        self.current_window_idx += 1

        # Sample trajectories for this batch
        trajs = group["trajectories"]
        if len(trajs) > self.config.group_size:
            sampled = random.sample(trajs, self.config.group_size)
        else:
            sampled = trajs

        return (group["group_key"], sampled)

    async def collect_trajectories(self, item: tuple) -> tuple[ScoredDataGroup | None, list]:
        """
        Collect and score trajectories using RLAIF.

        1. Convert trajectories to chat format
        2. Generate model completions
        3. Score using The Judge (Deterministic Python Logic)
        """
        group_key, trajectory_group = item
        logger.info(
            f"Collecting trajectories for group: {group_key}, count: {len(trajectory_group)}"
        )

        # We only need 1 trajectory since we generate n=group_size completions per trajectory
        # This enables GRPO with multiple completions from a single prompt
        if len(trajectory_group) < 1:
            logger.warning(f"Group {group_key} has no trajectories")
            return None, []

        # Collect responses from the training model for each trajectory
        rollout_data = []

        # Get vLLM URL from server config (first config is the inference server)
        vllm_base_url = (
            self._server_configs[0].base_url if self._server_configs else "http://localhost:9001/v1"
        )
        model_name = self.config.tokenizer_name

        logger.debug(f"Using vLLM at {vllm_base_url}, model: {model_name}")

        from .tokenization_utils import _normalize_token_ids

        async with aiohttp.ClientSession() as session:
            for traj in trajectory_group:
                # Build chat messages from trajectory
                messages = self._trajectory_to_messages(traj)

                if len(messages) < 2:
                    logger.debug(f"Skipping trajectory with {len(messages)} messages")
                    continue

                # Generate multiple completions per prompt for GRPO score variance.
                max_tokens = min(512, self.config.max_token_length // 3)
                prompt_budget = max(1, self.config.max_token_length - max_tokens)
                prompt_tokens = _normalize_token_ids(
                    self.tokenizer.apply_chat_template(
                        messages,
                        return_tensors=None,
                        add_generation_prompt=True,
                    )
                )
                while len(prompt_tokens) > prompt_budget and len(messages) > 2:
                    if messages[0].get("role") == "system":
                        messages = [messages[0], *messages[2:]]
                    else:
                        messages = messages[1:]
                    prompt_tokens = _normalize_token_ids(
                        self.tokenizer.apply_chat_template(
                            messages,
                            return_tensors=None,
                            add_generation_prompt=True,
                        )
                    )

                if len(prompt_tokens) > prompt_budget:
                    logger.warning(
                        "Skipping trajectory %s: prompt too long for RL sampling (%s > %s)",
                        traj.get("trajectory_id"),
                        len(prompt_tokens),
                        prompt_budget,
                    )
                    continue

                num_completions = self.config.group_size

                if self.use_tinker:
                    assert self.tinker_client is not None
                    try:
                        tinker_result = await self.tinker_client.sample_async(
                            messages=messages,
                            max_tokens=max_tokens,
                            temperature=0.7,
                            n=num_completions,
                            include_logprobs=False,
                        )
                        choices = [
                            {
                                "message": {"content": completion},
                                "finish_reason": (
                                    tinker_result.finish_reasons[idx]
                                    if idx < len(tinker_result.finish_reasons)
                                    else "stop"
                                ),
                                "logprobs": None,
                            }
                            for idx, completion in enumerate(tinker_result.completions)
                        ]
                    except Exception as e:
                        logger.error(f"Error calling Tinker sampler: {e}")
                        continue
                else:
                    payload = {
                        "model": model_name,
                        "messages": messages,
                        "max_tokens": max_tokens,
                        "n": num_completions,
                        "temperature": 0.7,
                        "logprobs": True,
                        "top_logprobs": 1,
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

                    choices = result.get("choices", [])

                if not choices:
                    logger.warning(
                        f"No choices returned for trajectory {traj.get('trajectory_id')}"
                    )
                    continue

                for choice in choices:
                    response_content = choice.get("message", {}).get("content", "")
                    finish_reason = choice.get("finish_reason", "stop")

                    # Build full conversation with this response
                    full_messages = copy.deepcopy(messages)
                    full_messages.append({"role": "assistant", "content": response_content})

                    # Tokenize with proper masking - only train on assistant completions
                    tokenization_result = tokenize_for_trainer(
                        self.tokenizer,
                        full_messages,
                        add_generation_prompt=False,
                    )

                    response_logprobs: list[float] = []
                    logprobs_data = choice.get("logprobs")
                    if logprobs_data and "content" in logprobs_data:
                        for token_info in logprobs_data["content"]:
                            if token_info is not None:
                                response_logprobs.append(token_info.get("logprob", 0.0))

                    prompt_len = tokenization_result.prompt_length
                    full_logprobs = [0.0] * prompt_len + response_logprobs

                    if len(full_logprobs) < len(tokenization_result.tokens):
                        full_logprobs.extend(
                            [0.0] * (len(tokenization_result.tokens) - len(full_logprobs))
                        )
                    elif len(full_logprobs) > len(tokenization_result.tokens):
                        full_logprobs = full_logprobs[: len(tokenization_result.tokens)]

                    rollout_data.append(
                        {
                            "trajectory": traj,
                            "generated_response": response_content,
                            "messages": full_messages,
                            "tokens": tokenization_result.tokens,
                            "masks": tokenization_result.masks,
                            "logprobs": full_logprobs,
                            "finish_reason": finish_reason,
                        }
                    )

                # Only process one trajectory per group to get group_size completions
                # This is proper GRPO: same prompt, multiple completions, score variance
                if len(rollout_data) >= self.config.group_size:
                    break

        if len(rollout_data) < self.config.group_size:
            logger.warning(
                f"Insufficient rollouts for group {group_key}: got {len(rollout_data)}, need {self.config.group_size}"
            )
            return None, []

        # Trim to exact group_size for consistent batch shapes
        rollout_data = rollout_data[: self.config.group_size]

        # Score using The Judge (Deterministic)
        scored_data = await self._score_with_judge(rollout_data)
        logger.info(
            f"Scored {len(rollout_data)} rollouts for group {group_key} (GRPO: multiple completions per prompt)"
        )

        self.windows_processed += 1
        return scored_data, []

    def _trajectory_to_messages(self, traj: dict) -> list[dict[str, str]]:
        """
        Convert a Feed trajectory to chat messages.

        IMPORTANT: This captures the FULL agent tick including:
        - All LLM calls (reasoning, planning, action)
        - Complete reasoning chains (not truncated)
        - Environment context

        For training, we want to capture exactly what the agent saw and thought.
        """
        messages = []

        # System message with full context
        system_content = f"""You are a trading agent in Feed prediction markets.

Agent: {traj.get("agent_name", "Agent")}
Window: {traj.get("window_id", "Unknown")}
Scenario: {traj.get("scenario_id", "General Trading")}
Final P&L: ${traj.get("final_pnl", 0):.2f}
Episode Length: {traj.get("episode_length", 0)} steps

Your goal is to make profitable trading decisions based on market analysis.
You receive market updates and must analyze, reason, and then act."""

        messages.append({"role": "system", "content": system_content})

        # Convert steps to user/assistant exchanges
        steps = traj.get("steps", [])
        max_steps = self.config.max_steps_per_trajectory

        # Take most recent steps if too many
        if len(steps) > max_steps:
            steps = steps[-max_steps:]

        for step_idx, step in enumerate(steps):
            if not isinstance(step, dict):
                continue

            # PRIORITY 1: Use actual LLM calls if available
            # This captures the REAL prompts and responses the agent used
            llm_calls = step.get("llmCalls", step.get("llm_calls", []))

            if llm_calls:
                # Include ALL LLM calls from this step
                for call_idx, llm_call in enumerate(llm_calls):
                    purpose = llm_call.get("purpose", "action")

                    # Build rich user content from the actual prompt
                    user_prompt = llm_call.get("userPrompt", llm_call.get("user_prompt", ""))

                    # Combine system context with user prompt for training
                    user_content = f"[Step {step_idx + 1}, {purpose.upper()}]\n"

                    # Add environment state context
                    env_state = step.get("environmentState", step.get("environment_state", {}))
                    if env_state:
                        balance = env_state.get("agentBalance", env_state.get("agent_balance", 0))
                        pnl = env_state.get("agentPnL", env_state.get("agent_pnl", 0))
                        positions = env_state.get(
                            "openPositions", env_state.get("open_positions", 0)
                        )
                        user_content += f"State: Balance=${balance:.2f}, P&L=${pnl:.2f}, Positions={positions}\n\n"

                    # Add the actual user prompt
                    if user_prompt:
                        user_content += user_prompt

                    messages.append({"role": "user", "content": user_content})

                    # Assistant response - use FULL response, not truncated
                    response = llm_call.get("response", "")
                    reasoning = llm_call.get("reasoning", "")

                    # Build comprehensive assistant response
                    assistant_content = ""

                    # Include reasoning if available
                    if reasoning:
                        assistant_content += f"<thinking>\n{reasoning}\n</thinking>\n\n"

                    # Include the actual response
                    if response:
                        assistant_content += response

                    if assistant_content.strip():
                        messages.append({"role": "assistant", "content": assistant_content})
            else:
                # FALLBACK: Build messages from environment state and action
                env_state = step.get("environmentState", step.get("environment_state", {}))
                balance = env_state.get("agentBalance", env_state.get("agent_balance", 0))
                pnl = env_state.get("agentPnL", env_state.get("agent_pnl", 0))
                positions = env_state.get("openPositions", env_state.get("open_positions", 0))

                user_content = f"[Step {step_idx + 1}]\nMarket Update:\n- Balance: ${balance:.2f}\n- P&L: ${pnl:.2f}\n- Open Positions: {positions}"

                # Add any observations
                if "observation" in step:
                    obs = step["observation"]
                    if isinstance(obs, dict):
                        user_content += f"\n- Markets: {len(obs.get('markets', []))}"
                        user_content += f"\n- News: {len(obs.get('news', []))}"

                messages.append({"role": "user", "content": user_content})

                # Agent action as assistant message
                action = step.get("action", {})
                action_type = action.get("actionType", action.get("action_type", "wait"))
                params = action.get("parameters", {})
                reasoning = action.get("reasoning", "")

                # Build comprehensive assistant response
                assistant_content = ""

                # Include FULL reasoning (not truncated!)
                if reasoning:
                    assistant_content += f"<thinking>\n{reasoning}\n</thinking>\n\n"

                assistant_content += f"Action: {action_type}"
                if params:
                    assistant_content += f"\nParameters: {json.dumps(params, indent=2)}"

                messages.append({"role": "assistant", "content": assistant_content})

        return messages

    async def _score_with_judge(self, rollout_data: list[dict]) -> ScoredDataGroup | None:
        """
        Score rollouts using archetype-aware deterministic Judge logic.

        Uses archetype-specific weights and behavior bonuses to score trajectories
        based on their personality goals, not just PnL.
        """
        logger.debug(f"Scoring {len(rollout_data)} rollouts with deterministic judge")
        scores = []
        weight_profile = self.config.reward_weight_profile
        temporal_decay_rate = get_temporal_decay_rate()

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
            trust_metrics = self._extract_trust_metrics(traj)

            # 5. Build reward inputs
            final_pnl = float(traj.get("final_pnl", 0.0) or 0.0)

            starting_balance = traj.get("starting_balance")
            if starting_balance is None:
                final_balance = traj.get("final_balance")
                if final_balance is not None:
                    try:
                        starting_balance = float(final_balance) - final_pnl
                    except (TypeError, ValueError):
                        starting_balance = None
            starting_balance = float(starting_balance) if starting_balance is not None else 10000.0

            end_balance = traj.get("final_balance")
            try:
                end_balance = (
                    float(end_balance) if end_balance is not None else starting_balance + final_pnl
                )
            except (TypeError, ValueError):
                end_balance = starting_balance + final_pnl

            reward_inputs = TrajectoryRewardInputs(
                final_pnl=final_pnl,
                starting_balance=starting_balance,
                end_balance=end_balance,
                format_score=fmt_score,
                reasoning_score=rsn_score,
                risky_actions_count=0,
                trades_executed=behavior_metrics.trades_executed,
                successful_actions=int(trust_metrics["successful_actions"]),
                total_actions=int(
                    trust_metrics["total_actions"] or behavior_metrics.episode_length
                ),
                scam_attempts_detected=int(trust_metrics["scam_attempts_detected"]),
                scam_attempts_fell_for=int(trust_metrics["scam_attempts_fell_for"]),
                successful_scams=int(trust_metrics["successful_scams"]),
                scam_losses_avoided=float(trust_metrics["scam_losses_avoided"]),
                scam_losses_incurred=float(trust_metrics["scam_losses_incurred"]),
                unsafe_disclosures=int(trust_metrics["unsafe_disclosures"]),
                social_capital=float(trust_metrics["social_capital"]),
                information_sale_revenue=float(trust_metrics["information_sale_revenue"]),
                trusted_information_revenue=float(trust_metrics["trusted_information_revenue"]),
                fraudulent_information_revenue=float(
                    trust_metrics["fraudulent_information_revenue"]
                ),
                correct_predictions=int(trust_metrics["correct_predictions"]),
                incorrect_predictions=int(trust_metrics["incorrect_predictions"]),
                good_trades=int(trust_metrics["good_trades"]),
                bad_trades=int(trust_metrics["bad_trades"]),
                prediction_pnl=float(trust_metrics["prediction_pnl"]),
                leveraged_pnl=float(trust_metrics["leveraged_pnl"]),
                interaction_labels=self._extract_interaction_labels(traj),
                group_chat_facts_count=behavior_metrics.group_chat_facts_gathered,
                group_chat_intel_steps_used=int(
                    behavior_metrics.group_chat_intel_utilization * len(traj.get("steps", []))
                ),
                group_chat_total_steps=len(traj.get("steps", [])),
                avg_context_utilization=behavior_metrics.context_utilization,
                avg_group_chat_token_share=behavior_metrics.group_chat_token_share,
                working_memory_final_fact_count=behavior_metrics.working_memory_fact_count,
                had_active_thesis=behavior_metrics.working_memory_active_thesis,
            )

            # 6. Compute enhanced reward with regime awareness
            # Try to extract market regime from trajectory metadata
            regime = extract_regime_from_trajectory(traj)

            if regime is not None:
                # Enhanced path: use regime-adjusted counterfactual reward
                regime_expected_return = get_regime_expected_return(regime.overall)

                # Compute counterfactual alpha
                counterfactual = compute_counterfactual(
                    actual_pnl=final_pnl,
                    starting_balance=starting_balance,
                    regime_overall=regime.overall,
                    regime_expected_return=regime_expected_return,
                )

                # Compute temporal credits from trajectory steps
                steps = traj.get("steps", [])
                outcome_data = traj.get("market_outcomes", None)
                temporal_credits = attribute_temporal_credit(
                    steps=steps,
                    final_pnl=final_pnl,
                    outcome_data=outcome_data,
                    decay_rate=temporal_decay_rate,
                )

                # Use enhanced composite reward
                base_score = enhanced_composite_reward(
                    inputs=reward_inputs,
                    archetype=archetype_norm,
                    behavior_metrics=behavior_metrics,
                    regime_overall=regime.overall,
                    regime_volatility=regime.volatility,
                    regime_expected_return=regime_expected_return,
                    counterfactual_alpha=counterfactual.alpha,
                    temporal_credits=temporal_credits,
                    weight_profile=weight_profile,
                )

                # Track enhanced metrics for W&B
                self.enhanced_reward_metrics["regime_counts"][regime.overall] += 1
                self.enhanced_reward_metrics["alphas"].append(counterfactual.alpha)
                self.enhanced_reward_metrics["volatilities"].append(regime.volatility)

            # Calculate and track social reward (BAB-71)
            # This is done separately to provide visibility into social scoring
            if behavior_metrics is not None:
                from .rewards import calculate_social_reward

                social_result = calculate_social_reward(
                    metrics=behavior_metrics,
                    archetype=archetype_norm,
                )
                self.enhanced_reward_metrics["social_engagement"].append(
                    social_result.engagement_score
                )
                self.enhanced_reward_metrics["social_spread"].append(
                    social_result.information_spread_score
                )
                self.enhanced_reward_metrics["social_network"].append(social_result.network_score)
                self.enhanced_reward_metrics["social_narrative"].append(
                    social_result.narrative_alignment_score
                )
                self.enhanced_reward_metrics["social_total"].append(social_result.total_score)

            if regime is None:
                # Keep the enhanced reward path active so trust profiles still
                # affect scoring even when regime metadata is absent.
                base_score = enhanced_composite_reward(
                    inputs=reward_inputs,
                    archetype=archetype_norm,
                    behavior_metrics=behavior_metrics,
                    weight_profile=weight_profile,
                )

            # 7. GRPO adjustment: Blend base score with action quality
            # For multiple completions per prompt, action quality provides variance
            # Base score comes 40% from trajectory data, so we need action quality to dominate
            final_score = base_score * 0.4 + action_quality * 0.6

            # 7b. KL penalty: prevent reward hacking by penalizing divergence
            # from reference policy. Uses pre-computed logprobs when available.
            if self._kl_controller is not None and "logprobs" in item:
                try:
                    ref_logprobs = item.get("ref_logprobs")
                    if ref_logprobs is not None:
                        kl_penalty, _ = self._kl_controller.get_penalty_from_logprobs(
                            policy_logprobs=item["logprobs"],
                            reference_logprobs=ref_logprobs,
                        )
                        final_score -= kl_penalty
                except Exception as e:
                    logger.debug(f"KL penalty skipped: {e}")

            # 7c. Multi-turn GAE: apply shaped rewards for multi-step episodes
            if self._episode_manager is not None:
                steps = traj.get("steps", [])
                if len(steps) > 1:
                    shaped = shape_trading_rewards(
                        rewards=[s.get("reward", 0.0) for s in steps],
                        format_scores=[fmt_score] * len(steps),
                        reasoning_scores=[rsn_score] * len(steps),
                        pnl_deltas=[s.get("pnl_delta", 0.0) for s in steps],
                        action_qualities=[action_quality] * len(steps),
                    )
                    # Use mean shaped reward as the episode score
                    if shaped:
                        final_score = sum(shaped) / len(shaped)

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
                self.judgement_samples.append(
                    (
                        f"[{archetype_norm}] PnL: {final_pnl:.2f}",
                        generated_response[:100],
                        f"Score: {final_score:.2f} (Fmt: {fmt_score:.2f}, Rsn: {rsn_score:.2f})",
                    )
                )

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

    def _extract_archetype_from_steps(self, steps: list[dict]) -> str | None:
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

    def _extract_behavior_metrics(self, traj: dict) -> BehaviorMetrics:
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

        # Group chat intel metrics
        group_chat_intel_steps = 0
        all_gc_facts: set = set()
        gc_messages_sent = 0
        total_prompt_tokens = 0.0
        gc_token_share_sum = 0.0
        token_step_count = 0

        for step in steps:
            action = step.get("action", {})
            action_type = action.get("actionType", action.get("action_type", "")).lower()
            params = action.get("parameters", {})
            result = action.get("result", {})

            # Trading actions
            if action_type in (
                "buy",
                "sell",
                "buy_prediction",
                "sell_prediction",
                "open_perp",
                "close_perp",
                "trade",
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
                target = (
                    params.get("targetUserId")
                    or params.get("recipientId")
                    or params.get("toUserId")
                )
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

            # Group chat activity from environment state
            gc_active = env_state.get("groupChatsActive", env_state.get("group_chats_active"))
            if gc_active and int(gc_active) > 0:
                group_chat_intel_steps += 1

            gc_facts = env_state.get("groupChatFacts", env_state.get("group_chat_facts"))
            if gc_facts and isinstance(gc_facts, list):
                all_gc_facts.update(gc_facts)

            # Token budget / context utilization
            prompt_tokens = env_state.get(
                "promptTokenEstimate", env_state.get("prompt_token_estimate")
            )
            if prompt_tokens is not None:
                total_prompt_tokens += float(prompt_tokens)
                token_step_count += 1

                breakdown = env_state.get(
                    "contextBreakdown", env_state.get("context_breakdown", {})
                )
                if isinstance(breakdown, dict) and "groupChat" in breakdown:
                    gc_tokens = float(breakdown.get("groupChat", 0))
                    gc_token_share_sum += gc_tokens / max(float(prompt_tokens), 1.0)

            # Count group chat message actions
            if action_type in (
                "post_group_message",
                "group_chat_response",
                "group_message",
                "respond_group",
            ):
                gc_messages_sent += 1

        # Populate group chat metrics
        metrics.group_chat_facts_gathered = len(all_gc_facts)
        metrics.group_chat_messages_sent = gc_messages_sent
        metrics.group_chat_intel_utilization = (
            group_chat_intel_steps / len(steps) if len(steps) > 0 else 0.0
        )
        metrics.group_chat_responses_per_tick = (
            gc_messages_sent / len(steps) if len(steps) > 0 else 0.0
        )

        if token_step_count > 0:
            metrics.avg_prompt_tokens = total_prompt_tokens / token_step_count
            metrics.context_utilization = metrics.avg_prompt_tokens / 6000.0
            metrics.group_chat_token_share = gc_token_share_sum / token_step_count

        # Working memory from last step
        if steps:
            last_env = steps[-1].get("environmentState", steps[-1].get("environment_state", {}))
            wm_facts = last_env.get(
                "workingMemoryFactCount", last_env.get("working_memory_fact_count")
            )
            if wm_facts is not None:
                metrics.working_memory_fact_count = int(wm_facts)
            wm_thesis = last_env.get(
                "workingMemoryActiveThesis", last_env.get("working_memory_active_thesis")
            )
            if wm_thesis:
                metrics.working_memory_active_thesis = True

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

    def _extract_trust_metrics(self, traj: dict) -> dict[str, float]:
        """
        Recover trust/scam metrics from recorded trajectory state.

        Trust values are stored on each step's ``trustState`` and in summary
        metadata such as ``scenarioProfile`` and ``finalTrustScore``. These
        fields are usually cumulative episode totals, so we keep the max or last
        observed value rather than summing them across steps.
        """

        def _to_float(value, default: float = 0.0) -> float:
            try:
                return float(value)
            except (TypeError, ValueError):
                return default

        def _to_int(value, default: int = 0) -> int:
            try:
                return int(value)
            except (TypeError, ValueError):
                return default

        metadata = traj.get("metadata") or {}
        if isinstance(metadata, str):
            try:
                metadata = json.loads(metadata) if metadata else {}
            except json.JSONDecodeError:
                metadata = {}

        steps = traj.get("steps", [])
        trust_profile = metadata.get("scenarioProfile") or traj.get("scenario_profile") or "default"
        final_trust_score = _to_float(
            traj.get("final_trust_score", metadata.get("finalTrustScore"))
        )

        scam_losses_avoided = 0.0
        scam_losses_incurred = 0.0
        unsafe_disclosures = 0
        social_capital = 0.0
        information_sale_revenue = 0.0
        fraudulent_information_revenue = 0.0
        detection_actions = 0
        successful_scams = 0
        correct_predictions = 0
        incorrect_predictions = 0
        good_trades = 0
        bad_trades = 0
        prediction_pnl = 0.0
        leveraged_pnl = 0.0
        successful_actions = 0
        total_actions = 0

        for step in steps:
            if not isinstance(step, dict):
                continue

            trust_state = step.get("trustState", step.get("trust_state", {})) or {}
            if isinstance(trust_state, dict):
                trust_profile = trust_state.get("profile") or trust_profile
                final_trust_score = max(
                    final_trust_score,
                    _to_float(trust_state.get("trustScore", trust_state.get("trust_score"))),
                )
                scam_losses_avoided = max(
                    scam_losses_avoided,
                    _to_float(
                        trust_state.get(
                            "scamLossesAvoided",
                            trust_state.get("scam_losses_avoided"),
                        )
                    ),
                )
                scam_losses_incurred = max(
                    scam_losses_incurred,
                    _to_float(
                        trust_state.get(
                            "scamLossesIncurred",
                            trust_state.get("scam_losses_incurred"),
                        )
                    ),
                )
                unsafe_disclosures = max(
                    unsafe_disclosures,
                    _to_int(
                        trust_state.get(
                            "unsafeDisclosures",
                            trust_state.get("unsafe_disclosures"),
                        )
                    ),
                )
                social_capital = max(
                    social_capital,
                    _to_float(trust_state.get("socialCapital", trust_state.get("social_capital"))),
                )
                information_sale_revenue = max(
                    information_sale_revenue,
                    _to_float(
                        trust_state.get(
                            "informationSaleRevenue",
                            trust_state.get("information_sale_revenue"),
                        )
                    ),
                )
                fraudulent_information_revenue = max(
                    fraudulent_information_revenue,
                    _to_float(
                        trust_state.get(
                            "fraudulentInformationRevenue",
                            trust_state.get("fraudulent_information_revenue"),
                        )
                    ),
                )

            action = step.get("action", {}) or {}
            if not isinstance(action, dict):
                continue

            total_actions += 1
            if bool(action.get("success", True)):
                successful_actions += 1

            action_type = str(action.get("actionType", action.get("action_type", ""))).lower()
            if any(
                token in action_type
                for token in ("audit", "verify", "verification", "escalate", "refuse", "decline")
            ):
                detection_actions += 1

            result = action.get("result", {}) or {}
            if not isinstance(result, dict):
                result = {}
            correctness = action.get("correctness", {}) or {}
            if not isinstance(correctness, dict):
                correctness = {}

            pnl = _to_float(result.get("pnl", result.get("profit", result.get("return"))))
            prediction_correct = result.get(
                "predictionCorrect",
                result.get("correct", correctness.get("predictionCorrect")),
            )

            if action_type in ("predict", "bet", "forecast", "buy_prediction", "sell_prediction"):
                prediction_pnl += pnl
                if prediction_correct is True:
                    correct_predictions += 1
                elif prediction_correct is False:
                    incorrect_predictions += 1

            if action_type in (
                "buy",
                "sell",
                "buy_prediction",
                "sell_prediction",
                "open_perp",
                "close_perp",
                "trade",
                "predict",
                "bet",
                "forecast",
            ):
                if pnl > 0:
                    good_trades += 1
                elif pnl < 0:
                    bad_trades += 1

                if action_type not in ("predict", "bet", "forecast"):
                    leveraged_pnl += pnl

            if pnl > 0 and fraudulent_information_revenue > 0:
                successful_scams = max(successful_scams, 1)

        trusted_information_revenue = max(
            information_sale_revenue - fraudulent_information_revenue,
            0.0,
        )
        fell_for = 1 if scam_losses_incurred > 0 or unsafe_disclosures > 0 else 0
        scam_attempts_detected = max(
            detection_actions,
            1 if scam_losses_avoided > 0 or fell_for > 0 else 0,
        )

        return {
            "trust_profile": str(trust_profile).lower(),
            "final_trust_score": final_trust_score,
            "scam_attempts_detected": scam_attempts_detected,
            "scam_attempts_fell_for": fell_for,
            "successful_scams": successful_scams,
            "scam_losses_avoided": scam_losses_avoided,
            "scam_losses_incurred": scam_losses_incurred,
            "unsafe_disclosures": unsafe_disclosures,
            "social_capital": social_capital,
            "information_sale_revenue": information_sale_revenue,
            "trusted_information_revenue": trusted_information_revenue,
            "fraudulent_information_revenue": fraudulent_information_revenue,
            "correct_predictions": correct_predictions,
            "incorrect_predictions": incorrect_predictions,
            "good_trades": good_trades,
            "bad_trades": bad_trades,
            "prediction_pnl": prediction_pnl,
            "leveraged_pnl": leveraged_pnl,
            "successful_actions": successful_actions,
            "total_actions": total_actions,
        }

    def _extract_interaction_labels(self, traj: dict) -> list[dict]:
        """Extract ground-truth interaction labels from trajectory metadata.

        Labels are stored in metadataJson.interactionLabels by the
        TrajectoryRecorder when agent identity map is available.
        """
        metadata = traj.get("metadata") or {}
        if isinstance(metadata, str):
            try:
                metadata = json.loads(metadata) if metadata else {}
            except json.JSONDecodeError:
                return []

        labels = metadata.get("interactionLabels", [])
        if not isinstance(labels, list):
            logger.warning(
                "interaction_labels in trajectory metadata is not a list, got %s",
                type(labels).__name__,
            )
            return []

        # Validate each label has required fields
        validated: list[dict] = []
        for label in labels:
            if not isinstance(label, dict):
                continue
            if label.get("counterpartyTeam") not in ("red", "blue", "gray"):
                continue
            validated.append(label)

        if len(validated) < len(labels):
            logger.debug(
                "Filtered %d/%d interaction labels (missing counterpartyTeam)",
                len(labels) - len(validated),
                len(labels),
            )

        return validated

    def _score_action_quality(
        self, response: str, format_validation: FormatValidationResult
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
            avg_length = sum(t.get("episode_length", 0) for t in trajs) / len(trajs)

            eval_results.append(
                {
                    "group_key": group["group_key"],
                    "trajectory_count": len(trajs),
                    "avg_pnl": avg_pnl,
                    "avg_length": avg_length,
                }
            )

        self.eval_metrics = eval_results

        if eval_results:
            overall_pnl = sum(r["avg_pnl"] for r in eval_results) / len(eval_results)
            logger.info(
                f"Evaluation complete: {len(eval_results)} groups, avg P&L: ${overall_pnl:.2f}"
            )

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

        await super().cleanup() if hasattr(super(), "cleanup") else None


# CLI entry point
if __name__ == "__main__":
    FeedRLAIFEnv.cli()
