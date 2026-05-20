"""
RL Training orchestration for Babylon

This package provides training infrastructure:

1. **Atropos-based Trainer** (RECOMMENDED)
   - `atropos_trainer.py` - GRPO trainer consuming from Atropos API
   - `babylon_env.py` - RLAIF environment with LLM-as-judge scoring

2. **Fast Rollout Generation**
   - `rollout_generator.py` - High-speed rollout generation with full agent tick capture
   - `fast_simulator.py` - Unified simulator for benchmark + data generation
   - `multi_prompt_dataset.py` - Dataset preparation for each LLM call type

3. **Supporting Modules**
   - `rewards.py` - Reward functions and normalization
   - `quality_utils.py` - Trajectory quality scoring
   - `tick_reward_attribution.py` - Granular reward attribution for multi-call ticks

See README.md for usage instructions.
"""

# Import non-torch modules directly
# Phase 4: A/B Testing & Production Evaluation
from .ab_testing import (
    EVAL_SCENARIOS,
    ABTestResult,
    ABTestRunner,
    ModelResult,
    run_ab_test,
)
from .action_executor import (
    ActionExecutor,
    ActionResult,
    calculate_action_quality_bonus,
    execute_action_for_training,
    reset_simulation_rng,
    set_simulation_seed,
    validate_action,
)
from .action_executor import (
    PortfolioState as ExecutorPortfolioState,
)

# Archetype training configuration (no torch dependency)
from .archetype_trainer import (
    ArchetypeTrainer,
    ArchetypeTrainingConfig,
    ArchetypeTrainingResult,
)

# Adversarial co-training
from .attacker_trainer import (
    AttackEpisode,
    AttackerConfig,
    AttackerTrainer,
    AttackReward,
    compute_attacker_reward,
)

# Error recovery and graceful degradation
from .error_recovery import (
    DatabaseConnectionManager,
    ErrorCategory,
    GracefulShutdown,
    RecoveryResult,
    TrainingError,
    TrainingProgress,
    clamp,
    classify_error,
    filter_valid_trajectories,
    get_env_or_default,
    is_recoverable,
    recover_json_parse,
    recover_trajectory_archetype,
    require_env,
    safe_divide,
    with_retry,
    with_retry_async,
)

# Phase 3: Evaluation & Monitoring
from .evaluation import (
    EVAL_METRICS,
    STEP_METRICS,
    ArchetypeMetrics,
    BaselineManager,
    BaselineResult,
    EvalResult,
    EvaluationSuite,
    RolloutDumper,
    RolloutRecord,
    TestScenario,
    TestScenarioManager,
    get_wandb_config,
)
from .format_validator import (
    ActionValidationResult,
    FormatValidationResult,
    LengthAnalysisResult,
    ReasoningQualityResult,
    ThinkTagResult,
    get_format_and_reasoning_scores,
    validate_action_json,
    validate_for_training,
    validate_response_format,
    validate_think_tags,
)

# Phase 4: KL control & multi-turn GAE (integrated into babylon_env and online_env)
from .kl_controller import (
    KLConfig,
    KLControllerBase,
    KLStats,
    compute_kl_divergence,
    create_kl_controller,
    estimate_kl_from_samples,
)

# Hidden dependencies: used by core modules but not previously exported
from .market_regime import extract_regime_from_trajectory

# Multi-prompt dataset (no torch dependency)
from .multi_prompt_dataset import (
    MultiPromptDatasetBuilder,
    PromptDataset,
    PromptSample,
    PromptTypeAnalyzer,
    prepare_multi_prompt_training_data,
    validate_training_sample,
    validate_trajectory_for_training,
)
from .multi_turn import (
    EpisodeBuffer,
    EpisodeCollector,
    GAEConfig,
    MultiTurnEpisodeManager,
    TurnData,
    compute_episode_return,
    normalize_episode_rewards,
    shape_trading_rewards,
)
from .quality_scorer import (
    QualityScore,
    calculate_combined_length_penalty,
    calculate_response_length_penalty,
    calculate_thinking_length_penalty,
    get_quality_bonus_for_archetype,
    get_relative_quality_scores,
    score_response,
    score_response_batch,
    score_response_for_reward,
)

# Quality utilities (no torch dependency)
from .quality_utils import (
    ValidationResult,
    build_trajectory_from_ticks,
    calculate_tick_quality_score,
    calculate_trajectory_quality_score,
    state_to_env_state,
    state_to_observation,
    validate_trajectory_quality,
)
from .reward_config import get_regime_expected_return, get_temporal_decay_rate
from .rewards import (
    ARCHETYPE_REWARD_WEIGHTS,
    # Archetype-aware scoring
    BehaviorMetrics,
    RewardNormalizer,
    action_quality_reward,
    archetype_composite_reward,
    calculate_archetype_behavior_bonus,
    composite_reward,
    efficiency_reward,
    get_archetype_weights,
    pairwise_preferences_to_scores,
    pnl_reward,
    ranking_to_scores,
    relative_scores,
    risk_adjusted_reward,
)

# Rubric loading from config/rubrics.json (single source of truth)
from .rubric_loader import (
    DEFAULT_RUBRIC,
    RUBRICS_VERSION,
    get_all_rubrics_hash,
    get_available_archetypes,
    get_priority_metrics,
    get_rubric,
    get_rubric_hash,
    get_rubrics_version,
    has_custom_rubric,
    normalize_archetype,
    reload_rubrics,
)

# Phase 1 & 2: Online GRPO Training Infrastructure
from .scenario_pool import (
    CurriculumManager,
    MarketState,
    NewsItem,
    PerpetualState,
    Scenario,
    ScenarioPool,
    ScenarioPoolConfig,
    SocialPost,
)
from .scenario_pool import (
    PortfolioState as ScenarioPortfolioState,
)

# Schema validation for data integrity
from .schemas import (
    ActionSchema,
    EnvironmentStateSchema,
    LLMCallSchema,
    StepSchema,
    TrajectorySchema,
    compare_trajectory_formats,
    validate_llm_call,
    validate_step,
    validate_trajectory,
    validate_trajectory_file,
)
from .schemas import (
    ValidationResult as SchemaValidationResult,
)

# Phase 5: Simulation Bridge for online training
from .simulation_bridge import (
    ActionOutcome,
    PerpMarket,
    Position,
    PredictionMarket,
    Relationship,
    SimulationBridge,
    SocialContext,
    TickResult,
    create_bridge,
)
from .simulation_bridge import (
    MarketState as BridgeMarketState,
)
from .simulation_bridge import (
    NewsItem as BridgeNewsItem,
)
from .simulation_bridge import (
    Scenario as BridgeScenario,
)
from .temporal_credit import attribute_temporal_credit

# Tick reward attribution (no torch dependency)
from .tick_reward_attribution import (
    CallPurpose,
    LLMCallRecord,
    TickData,
    TickOutcome,
    TickRewardAttributor,
    build_training_samples_from_tick,
    group_samples_for_grpo,
)
from .tokenization_utils import (
    TokenizationResult,
    create_masks_from_response_start,
    fix_historical_masks,
    tokenize_conversation_for_trainer,
    tokenize_for_trainer,
    validate_masks,
)


# Lazy imports for torch-dependent modules
# These imports are dynamically returned via __getattr__ - not unused
def __getattr__(name: str):
    """Lazy import for torch-dependent modules."""
    if name in (
        "BabylonAtroposTrainer",
        "AtroposTrainingConfig",
    ):
        from .atropos_trainer import (
            AtroposTrainingConfig,
            BabylonAtroposTrainer,
        )

        return locals()[name]

    if name in (
        "BabylonRLAIFEnv",
        "BabylonEnvConfig",
    ):
        from .babylon_env import (
            BabylonEnvConfig,
            BabylonRLAIFEnv,
        )

        return locals()[name]

    if name in (
        "BabylonOnlineEnv",
        "BabylonOnlineEnvConfig",
    ):
        from .online_env import (
            BabylonOnlineEnv,
            BabylonOnlineEnvConfig,
        )

        return locals()[name]

    if name in (
        "BabylonHybridEnv",
        "BabylonHybridEnvConfig",
    ):
        from .hybrid_env import (
            BabylonHybridEnv,
            BabylonHybridEnvConfig,
        )

        return locals()[name]

    if name in (
        "FastRolloutGenerator",
        "RolloutConfig",
        "RolloutResult",
        "AgentTickData",
        "RolloutQualityValidator",
        "AgentRunner",
    ):
        from .rollout_generator import (
            AgentRunner,
            AgentTickData,
            FastRolloutGenerator,
            RolloutConfig,
            RolloutQualityValidator,
            RolloutResult,
        )

        return locals()[name]

    if name in (
        "FastSimulator",
        "SimulatorConfig",
        "SimulatorMetrics",
        "GameState",
    ):
        from .fast_simulator import (
            FastSimulator,
            GameState,
            SimulatorConfig,
            SimulatorMetrics,
        )

        return locals()[name]

    # Tinker integration (lazy - requires tinker package)
    if name in (
        "BabylonTinkerClient",
        "TinkerConfig",
        "TinkerDatum",
        "TrainStepResult",
        "SampleResult",
        "TINKER_AVAILABLE",
    ):
        from .tinker_client import (
            TINKER_AVAILABLE,
            BabylonTinkerClient,
            SampleResult,
            TinkerConfig,
            TinkerDatum,
            TrainStepResult,
        )

        return locals()[name]

    if name in (
        "BabylonTinkerTrainer",
        "TinkerTrainingConfig",
        "TrainingMetrics",
    ):
        from .tinker_trainer import (
            BabylonTinkerTrainer,
            TinkerTrainingConfig,
            TrainingMetrics,
        )

        return locals()[name]

    # Service manager (lazy - requires requests)
    if name in (
        "ServiceManager",
        "ServiceConfig",
        "ServiceStatus",
        "check_prerequisites",
    ):
        from .service_manager import (
            ServiceConfig,
            ServiceManager,
            ServiceStatus,
            check_prerequisites,
        )

        return locals()[name]

    # Continuous RL (lazy - requires torch + aiohttp)
    if name in (
        "ContinuousRLAgent",
        "ContinuousRLConfig",
        "RewardTracker",
        "run_online_training",
    ):
        from .continuous_rl import (
            ContinuousRLAgent,
            ContinuousRLConfig,
            RewardTracker,
            run_online_training,
        )

        return locals()[name]

    if name in (
        "MultiAgentOrchestrator",
        "OrchestratorConfig",
    ):
        from .multi_agent_orchestrator import (
            MultiAgentOrchestrator,
            OrchestratorConfig,
        )

        return locals()[name]

    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = [
    "ARCHETYPE_REWARD_WEIGHTS",
    "DEFAULT_RUBRIC",
    "EVAL_METRICS",
    "EVAL_SCENARIOS",
    "RUBRICS_VERSION",
    "STEP_METRICS",
    "TINKER_AVAILABLE",
    "ABTestResult",
    # Phase 4: A/B Testing
    "ABTestRunner",
    "ActionExecutor",
    "ActionOutcome",
    "ActionResult",
    "ActionSchema",
    "ActionValidationResult",
    "AgentRunner",
    "AgentTickData",
    "ArchetypeMetrics",
    # Archetype training
    "ArchetypeTrainer",
    "ArchetypeTrainingConfig",
    "ArchetypeTrainingResult",
    "AtroposTrainingConfig",
    "AttackEpisode",
    "AttackReward",
    "AttackerConfig",
    # Adversarial co-training
    "AttackerTrainer",
    # Atropos trainer (lazy - requires torch)
    "BabylonAtroposTrainer",
    "BabylonEnvConfig",
    "BabylonHybridEnv",
    "BabylonHybridEnvConfig",
    "BabylonOnlineEnv",
    "BabylonOnlineEnvConfig",
    "BabylonRLAIFEnv",
    # Tinker trainer (lazy - requires tinker)
    "BabylonTinkerClient",
    "BabylonTinkerTrainer",
    "BaselineManager",
    "BaselineResult",
    # Archetype-aware scoring
    "BehaviorMetrics",
    "BridgeMarketState",
    "BridgeNewsItem",
    "BridgeScenario",
    "CallPurpose",
    # Continuous RL & Multi-Agent Orchestration (lazy - requires torch)
    "ContinuousRLAgent",
    "ContinuousRLConfig",
    "CurriculumManager",
    "DatabaseConnectionManager",
    "EnvironmentStateSchema",
    "EpisodeBuffer",
    "EpisodeCollector",
    # Error recovery
    "ErrorCategory",
    "EvalResult",
    # Phase 3: Evaluation & Monitoring
    "EvaluationSuite",
    "ExecutorPortfolioState",
    # Fast rollout generation (lazy - may require torch)
    "FastRolloutGenerator",
    "FastSimulator",
    "FormatValidationResult",
    "GAEConfig",
    "GameState",
    "GracefulShutdown",
    # Phase 4: KL control & multi-turn GAE
    "KLConfig",
    "KLControllerBase",
    "KLStats",
    "LLMCallRecord",
    "LLMCallSchema",
    "LengthAnalysisResult",
    "MarketState",
    "ModelResult",
    "MultiAgentOrchestrator",
    "MultiPromptDatasetBuilder",
    "MultiTurnEpisodeManager",
    "NewsItem",
    "OrchestratorConfig",
    "PerpMarket",
    "PerpetualState",
    "Position",
    "PredictionMarket",
    "PromptDataset",
    "PromptSample",
    "PromptTypeAnalyzer",
    "QualityScore",
    "ReasoningQualityResult",
    "RecoveryResult",
    "Relationship",
    "RewardNormalizer",
    "RewardTracker",
    "RolloutConfig",
    "RolloutDumper",
    "RolloutQualityValidator",
    "RolloutRecord",
    "RolloutResult",
    "SampleResult",
    # Phase 1 & 2: Online GRPO Training Infrastructure
    "Scenario",
    "ScenarioPool",
    "ScenarioPoolConfig",
    "ScenarioPortfolioState",
    "SchemaValidationResult",
    "ServiceConfig",
    # Service manager
    "ServiceManager",
    "ServiceStatus",
    # Phase 5: Simulation Bridge
    "SimulationBridge",
    "SimulatorConfig",
    "SimulatorMetrics",
    "SocialContext",
    "SocialPost",
    "StepSchema",
    "TestScenario",
    "TestScenarioManager",
    "ThinkTagResult",
    "TickData",
    "TickOutcome",
    "TickResult",
    # Tick reward attribution
    "TickRewardAttributor",
    "TinkerConfig",
    "TinkerDatum",
    "TinkerTrainingConfig",
    "TokenizationResult",
    "TrainStepResult",
    "TrainingError",
    "TrainingMetrics",
    "TrainingProgress",
    # Schema validation
    "TrajectorySchema",
    "TurnData",
    "ValidationResult",
    "action_quality_reward",
    "archetype_composite_reward",
    "attribute_temporal_credit",
    "build_training_samples_from_tick",
    "build_trajectory_from_ticks",
    "calculate_action_quality_bonus",
    "calculate_archetype_behavior_bonus",
    "calculate_combined_length_penalty",
    "calculate_response_length_penalty",
    "calculate_thinking_length_penalty",
    # Quality utilities
    "calculate_tick_quality_score",
    "calculate_trajectory_quality_score",
    "check_prerequisites",
    "clamp",
    "classify_error",
    "compare_trajectory_formats",
    "composite_reward",
    "compute_attacker_reward",
    "compute_episode_return",
    "compute_kl_divergence",
    "create_bridge",
    "create_kl_controller",
    "create_masks_from_response_start",
    "efficiency_reward",
    "estimate_kl_from_samples",
    "execute_action_for_training",
    # Hidden dependencies (now exported)
    "extract_regime_from_trajectory",
    "filter_valid_trajectories",
    "fix_historical_masks",
    "get_all_rubrics_hash",
    "get_archetype_weights",
    "get_available_archetypes",
    "get_env_or_default",
    "get_format_and_reasoning_scores",
    "get_priority_metrics",
    "get_quality_bonus_for_archetype",
    "get_regime_expected_return",
    "get_relative_quality_scores",
    # Rubric loading
    "get_rubric",
    "get_rubric_hash",
    "get_rubrics_version",
    "get_temporal_decay_rate",
    "get_wandb_config",
    "group_samples_for_grpo",
    "has_custom_rubric",
    "is_recoverable",
    "normalize_archetype",
    "normalize_episode_rewards",
    "pairwise_preferences_to_scores",
    # Reward functions
    "pnl_reward",
    "prepare_multi_prompt_training_data",
    "ranking_to_scores",
    "recover_json_parse",
    "recover_trajectory_archetype",
    "relative_scores",
    "reload_rubrics",
    "require_env",
    "reset_simulation_rng",
    "risk_adjusted_reward",
    "run_ab_test",
    "run_online_training",
    "safe_divide",
    "score_response",
    "score_response_batch",
    "score_response_for_reward",
    "set_simulation_seed",
    "shape_trading_rewards",
    "state_to_env_state",
    "state_to_observation",
    "tokenize_conversation_for_trainer",
    "tokenize_for_trainer",
    "validate_action",
    "validate_action_json",
    "validate_for_training",
    "validate_llm_call",
    "validate_masks",
    "validate_response_format",
    "validate_step",
    "validate_think_tags",
    "validate_training_sample",
    "validate_trajectory",
    "validate_trajectory_file",
    "validate_trajectory_for_training",
    "validate_trajectory_quality",
    "with_retry",
    "with_retry_async",
]
