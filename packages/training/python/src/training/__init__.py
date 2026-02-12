"""
RL training orchestration for ElizaOS-compatible runtimes

This package provides training infrastructure:

1. **Atropos-based Trainer** (RECOMMENDED)
   - `atropos_trainer.py` - GRPO trainer consuming from Atropos API
   - `rlaif_env.py` - RLAIF environment with pluggable scoring modes

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
from .rewards import (
    pnl_reward,
    risk_adjusted_reward,
    efficiency_reward,
    action_quality_reward,
    composite_reward,
    relative_scores,
    ranking_to_scores,
    pairwise_preferences_to_scores,
    RewardNormalizer,
    # Archetype-aware scoring
    BehaviorMetrics,
    archetype_composite_reward,
    calculate_archetype_behavior_bonus,
    get_archetype_weights,
    ARCHETYPE_REWARD_WEIGHTS,
)

# Quality utilities (no torch dependency)
from .quality_utils import (
    calculate_tick_quality_score,
    calculate_trajectory_quality_score,
    build_trajectory_from_ticks,
    state_to_observation,
    state_to_env_state,
    validate_trajectory_quality,
    ValidationResult,
)

# Multi-prompt dataset (no torch dependency)
from .multi_prompt_dataset import (
    MultiPromptDatasetBuilder,
    PromptDataset,
    PromptSample,
    prepare_multi_prompt_training_data,
    PromptTypeAnalyzer,
    validate_training_sample,
    validate_trajectory_for_training,
)

# Tick reward attribution (no torch dependency)
from .tick_reward_attribution import (
    TickRewardAttributor,
    TickData,
    TickOutcome,
    LLMCallRecord,
    CallPurpose,
    build_training_samples_from_tick,
    group_samples_for_grpo,
)

# Archetype training configuration (no torch dependency)
from .archetype_trainer import (
    ArchetypeTrainer,
    ArchetypeTrainingConfig,
    ArchetypeTrainingResult,
)

# Rubric loading from config/rubrics.json (single source of truth)
from .rubric_loader import (
    get_rubric,
    get_priority_metrics,
    get_available_archetypes,
    reload_rubrics,
    get_rubric_hash,
    get_all_rubrics_hash,
    get_rubrics_version,
    normalize_archetype,
    has_custom_rubric,
    DEFAULT_RUBRIC,
    RUBRICS_VERSION,
)

# Schema validation for data integrity
from .schemas import (
    TrajectorySchema,
    StepSchema,
    ActionSchema,
    LLMCallSchema,
    EnvironmentStateSchema,
    validate_trajectory,
    validate_step,
    validate_llm_call,
    validate_trajectory_file,
    compare_trajectory_formats,
    ValidationResult as SchemaValidationResult,
)

# Phase 1 & 2: Online GRPO Training Infrastructure
from .scenario_pool import (
    Scenario,
    ScenarioPool,
    ScenarioPoolConfig,
    CurriculumManager,
    MarketState,
    PerpetualState,
    NewsItem,
    SocialPost,
    PortfolioState as ScenarioPortfolioState,
)

from .tokenization_utils import (
    TokenizationResult,
    tokenize_for_trainer,
    tokenize_conversation_for_trainer,
    validate_masks,
    create_masks_from_response_start,
    fix_historical_masks,
)

from .action_executor import (
    ActionResult,
    ActionExecutor,
    PortfolioState as ExecutorPortfolioState,
    validate_action,
    execute_action_for_training,
    calculate_action_quality_bonus,
    set_simulation_seed,
    reset_simulation_rng,
)

from .format_validator import (
    ThinkTagResult,
    ActionValidationResult,
    ReasoningQualityResult,
    LengthAnalysisResult,
    FormatValidationResult,
    validate_response_format,
    validate_think_tags,
    validate_action_json,
    get_format_and_reasoning_scores,
    validate_for_training,
)

from .quality_scorer import (
    QualityScore,
    calculate_thinking_length_penalty,
    calculate_response_length_penalty,
    calculate_combined_length_penalty,
    score_response,
    score_response_for_reward,
    get_quality_bonus_for_archetype,
    score_response_batch,
    get_relative_quality_scores,
)

# Phase 3: Evaluation & Monitoring
from .evaluation import (
    EvaluationSuite,
    EvalResult,
    ArchetypeMetrics,
    TestScenarioManager,
    TestScenario,
    BaselineManager,
    BaselineResult,
    RolloutDumper,
    RolloutRecord,
    get_wandb_config,
    STEP_METRICS,
    EVAL_METRICS,
)

# Phase 4: A/B Testing & Production Evaluation
from .ab_testing import (
    ABTestRunner,
    ABTestResult,
    ModelResult,
    EVAL_SCENARIOS,
    run_ab_test,
)

# Phase 4: Advanced Features (NOT YET INTEGRATED - ready for future use)
# These modules are tested but not called by rlaif/online env runtime paths.
from .kl_controller import (
    KLConfig,
    KLStats,
    KLControllerBase,
    create_kl_controller,
    compute_kl_divergence,
    estimate_kl_from_samples,
)

from .multi_turn import (
    TurnData,
    EpisodeBuffer,
    GAEConfig,
    MultiTurnEpisodeManager,
    EpisodeCollector,
    shape_trading_rewards,
    compute_episode_return,
    normalize_episode_rewards,
)

# Phase 5: Simulation Bridge for online training
from .simulation_bridge import (
    SimulationBridge,
    PerpMarket,
    PredictionMarket,
    Position,
    NewsItem as BridgeNewsItem,
    Relationship,
    SocialContext,
    MarketState as BridgeMarketState,
    Scenario as BridgeScenario,
    ActionOutcome,
    TickResult,
    create_bridge,
)

# Error recovery and graceful degradation
from .error_recovery import (
    ErrorCategory,
    TrainingError,
    classify_error,
    is_recoverable,
    with_retry,
    with_retry_async,
    RecoveryResult,
    recover_json_parse,
    recover_trajectory_archetype,
    filter_valid_trajectories,
    DatabaseConnectionManager,
    GracefulShutdown,
    TrainingProgress,
    safe_divide,
    clamp,
    require_env,
    get_env_or_default,
)

# Lazy imports for torch-dependent modules
# These imports are dynamically returned via __getattr__ - not unused  # noqa: F401
def __getattr__(name: str):
    """Lazy import for torch-dependent modules."""
    if name in (
        "AtroposTrainer",
        "BabylonAtroposTrainer",
        "AtroposTrainingConfig",
    ):
        from .atropos_trainer import (  # noqa: F401
            AtroposTrainer,
            BabylonAtroposTrainer,
            AtroposTrainingConfig,
        )
        return locals()[name]
    
    if name in (
        "RLAIFEnv",
        "RLAIFEnvConfig",
        "BabylonRLAIFEnv",
        "BabylonEnvConfig",
    ):
        from .rlaif_env import (  # noqa: F401
            RLAIFEnv,
            RLAIFEnvConfig,
            BabylonRLAIFEnv,
            BabylonEnvConfig,
        )
        return locals()[name]
    
    if name in (
        "BabylonOnlineEnv",
        "BabylonOnlineEnvConfig",
    ):
        from .online_env import (  # noqa: F401
            BabylonOnlineEnv,
            BabylonOnlineEnvConfig,
        )
        return locals()[name]
    
    if name in (
        "BabylonHybridEnv",
        "BabylonHybridEnvConfig",
    ):
        from .hybrid_env import (  # noqa: F401
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
        from .rollout_generator import (  # noqa: F401
            FastRolloutGenerator,
            RolloutConfig,
            RolloutResult,
            AgentTickData,
            RolloutQualityValidator,
            AgentRunner,
        )
        return locals()[name]
    
    if name in (
        "FastSimulator",
        "SimulatorConfig",
        "SimulatorMetrics",
        "GameState",
    ):
        from .fast_simulator import (  # noqa: F401
            FastSimulator,
            SimulatorConfig,
            SimulatorMetrics,
            GameState,
        )
        return locals()[name]
    
    # Tinker integration (lazy - requires tinker package)
    if name in (
        "TinkerClient",
        "BabylonTinkerClient",
        "TinkerConfig",
        "TinkerDatum",
        "TrainStepResult",
        "SampleResult",
        "TINKER_AVAILABLE",
    ):
        from .tinker_client import (  # noqa: F401
            TinkerClient,
            BabylonTinkerClient,
            TinkerConfig,
            TinkerDatum,
            TrainStepResult,
            SampleResult,
            TINKER_AVAILABLE,
        )
        return locals()[name]
    
    if name in (
        "TinkerTrainer",
        "BabylonTinkerTrainer",
        "TinkerTrainingConfig",
        "TrainingMetrics",
    ):
        from .tinker_trainer import (  # noqa: F401
            TinkerTrainer,
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
        from .service_manager import (  # noqa: F401
            ServiceManager,
            ServiceConfig,
            ServiceStatus,
            check_prerequisites,
        )
        return locals()[name]
    
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = [
    # Atropos trainer (lazy - requires torch)
    "AtroposTrainer",
    "BabylonAtroposTrainer",
    "AtroposTrainingConfig",
    "RLAIFEnv",
    "RLAIFEnvConfig",
    "BabylonRLAIFEnv",
    "BabylonEnvConfig",
    "BabylonOnlineEnv",
    "BabylonOnlineEnvConfig",
    "BabylonHybridEnv",
    "BabylonHybridEnvConfig",
    # Phase 1 & 2: Online GRPO Training Infrastructure
    "Scenario",
    "ScenarioPool",
    "ScenarioPoolConfig",
    "CurriculumManager",
    "MarketState",
    "PerpetualState",
    "NewsItem",
    "SocialPost",
    "ScenarioPortfolioState",
    "TokenizationResult",
    "tokenize_for_trainer",
    "tokenize_conversation_for_trainer",
    "validate_masks",
    "create_masks_from_response_start",
    "fix_historical_masks",
    "ActionResult",
    "ActionExecutor",
    "ExecutorPortfolioState",
    "validate_action",
    "execute_action_for_training",
    "calculate_action_quality_bonus",
    "set_simulation_seed",
    "reset_simulation_rng",
    "ThinkTagResult",
    "ActionValidationResult",
    "ReasoningQualityResult",
    "LengthAnalysisResult",
    "FormatValidationResult",
    "validate_response_format",
    "validate_think_tags",
    "validate_action_json",
    "get_format_and_reasoning_scores",
    "validate_for_training",
    "QualityScore",
    "calculate_thinking_length_penalty",
    "calculate_response_length_penalty",
    "calculate_combined_length_penalty",
    "score_response",
    "score_response_for_reward",
    "get_quality_bonus_for_archetype",
    "score_response_batch",
    "get_relative_quality_scores",
    # Phase 3: Evaluation & Monitoring
    "EvaluationSuite",
    "EvalResult",
    "ArchetypeMetrics",
    "TestScenarioManager",
    "TestScenario",
    "BaselineManager",
    "BaselineResult",
    "RolloutDumper",
    "RolloutRecord",
    "get_wandb_config",
    "STEP_METRICS",
    "EVAL_METRICS",
    # Phase 4: A/B Testing
    "ABTestRunner",
    "ABTestResult",
    "ModelResult",
    "EVAL_SCENARIOS",
    "run_ab_test",
    # Phase 4: Advanced Features
    "KLConfig",
    "KLStats",
    "KLControllerBase",
    "create_kl_controller",
    "compute_kl_divergence",
    "estimate_kl_from_samples",
    "TurnData",
    "EpisodeBuffer",
    "GAEConfig",
    "MultiTurnEpisodeManager",
    "EpisodeCollector",
    "shape_trading_rewards",
    "compute_episode_return",
    "normalize_episode_rewards",
    # Tinker trainer (lazy - requires tinker)
    "TinkerClient",
    "BabylonTinkerClient",
    "TinkerConfig",
    "TinkerDatum",
    "TrainStepResult",
    "SampleResult",
    "TINKER_AVAILABLE",
    "TinkerTrainer",
    "BabylonTinkerTrainer",
    "TinkerTrainingConfig",
    "TrainingMetrics",
    # Reward functions
    "pnl_reward",
    "risk_adjusted_reward",
    "efficiency_reward",
    "action_quality_reward",
    "composite_reward",
    "relative_scores",
    "ranking_to_scores",
    "pairwise_preferences_to_scores",
    "RewardNormalizer",
    # Archetype-aware scoring
    "BehaviorMetrics",
    "archetype_composite_reward",
    "calculate_archetype_behavior_bonus",
    "get_archetype_weights",
    "ARCHETYPE_REWARD_WEIGHTS",
    # Fast rollout generation (lazy - may require torch)
    "FastRolloutGenerator",
    "RolloutConfig",
    "RolloutResult",
    "AgentTickData",
    "RolloutQualityValidator",
    "AgentRunner",
    "FastSimulator",
    "SimulatorConfig",
    "SimulatorMetrics",
    "GameState",
    "MultiPromptDatasetBuilder",
    "PromptDataset",
    "PromptSample",
    "prepare_multi_prompt_training_data",
    "PromptTypeAnalyzer",
    "validate_training_sample",
    "validate_trajectory_for_training",
    # Tick reward attribution
    "TickRewardAttributor",
    "TickData",
    "TickOutcome",
    "LLMCallRecord",
    "CallPurpose",
    "build_training_samples_from_tick",
    "group_samples_for_grpo",
    # Quality utilities
    "calculate_tick_quality_score",
    "calculate_trajectory_quality_score",
    "build_trajectory_from_ticks",
    "state_to_observation",
    "state_to_env_state",
    "validate_trajectory_quality",
    "ValidationResult",
    # Archetype training
    "ArchetypeTrainer",
    "ArchetypeTrainingConfig",
    "ArchetypeTrainingResult",
    # Rubric loading
    "get_rubric",
    "get_priority_metrics",
    "get_available_archetypes",
    "reload_rubrics",
    "get_rubric_hash",
    "get_all_rubrics_hash",
    "get_rubrics_version",
    "normalize_archetype",
    "has_custom_rubric",
    "DEFAULT_RUBRIC",
    "RUBRICS_VERSION",
    # Service manager
    "ServiceManager",
    "ServiceConfig",
    "ServiceStatus",
    "check_prerequisites",
    # Schema validation
    "TrajectorySchema",
    "StepSchema",
    "ActionSchema",
    "LLMCallSchema",
    "EnvironmentStateSchema",
    "validate_trajectory",
    "validate_step",
    "validate_llm_call",
    "validate_trajectory_file",
    "compare_trajectory_formats",
    "SchemaValidationResult",
    # Phase 5: Simulation Bridge
    "SimulationBridge",
    "PerpMarket",
    "PredictionMarket",
    "Position",
    "BridgeNewsItem",
    "Relationship",
    "SocialContext",
    "BridgeMarketState",
    "BridgeScenario",
    "ActionOutcome",
    "TickResult",
    "create_bridge",
    # Error recovery
    "ErrorCategory",
    "TrainingError",
    "classify_error",
    "is_recoverable",
    "with_retry",
    "with_retry_async",
    "RecoveryResult",
    "recover_json_parse",
    "recover_trajectory_archetype",
    "filter_valid_trajectories",
    "DatabaseConnectionManager",
    "GracefulShutdown",
    "TrainingProgress",
    "safe_divide",
    "clamp",
    "require_env",
    "get_env_or_default",
]
