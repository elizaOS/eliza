"""
GAIA Benchmark Implementation for ElizaOS

A comprehensive implementation of the GAIA (General AI Assistants) benchmark
for evaluating AI systems on real-world tasks requiring reasoning, multimodal
processing, web browsing, and tool use.

Reference: https://gaiabenchmark.com/
Paper: https://proceedings.iclr.cc/paper_files/paper/2024/hash/25ae35b5b1738d80f1f03a8713e405ec-Abstract-Conference.html
"""

from elizaos_gaia.agent import GAIAAgent
from elizaos_gaia.dataset import GAIADataset
from elizaos_gaia.evaluator import GAIAEvaluator
from elizaos_gaia.metrics import MetricsCalculator
from elizaos_gaia.plugin import create_gaia_plugin, gaia_plugin
from elizaos_gaia.providers import (
    PRESETS,
    SUPPORTED_MODELS,
    ModelConfig,
    ModelProvider,
    call_provider,
    get_available_providers,
    get_default_config,
    list_models,
)
from elizaos_gaia.runner import GAIARunner, run_quick_test
from elizaos_gaia.types import (
    LEADERBOARD_SCORES,
    AnnotatorMetadata,
    GAIABenchmarkResults,
    GAIAConfig,
    GAIALevel,
    GAIAMetrics,
    GAIAQuestion,
    GAIAResult,
    LeaderboardComparison,
    StepRecord,
    TaskCategory,
    ToolType,
)

__version__ = "1.0.0"
__all__ = [
    # Enums
    "GAIALevel",
    "ToolType",
    "TaskCategory",
    "ModelProvider",
    # Data classes
    "GAIAQuestion",
    "GAIAResult",
    "GAIAMetrics",
    "GAIAConfig",
    "GAIABenchmarkResults",
    "LeaderboardComparison",
    "StepRecord",
    "AnnotatorMetadata",
    "ModelConfig",
    # Constants
    "LEADERBOARD_SCORES",
    "SUPPORTED_MODELS",
    "PRESETS",
    # Classes
    "GAIADataset",
    "GAIAEvaluator",
    "GAIARunner",
    "GAIAAgent",
    "MetricsCalculator",
    # Plugin
    "gaia_plugin",
    "create_gaia_plugin",
    # Functions
    "run_quick_test",
    "call_provider",
    "get_default_config",
    "get_available_providers",
    "list_models",
]
