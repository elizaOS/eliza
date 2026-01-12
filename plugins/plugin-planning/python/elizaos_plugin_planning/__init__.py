"""
elizaOS Plugin Planning - Comprehensive planning and execution for AI agents.

This plugin provides:
- Message classification by complexity
- Simple and comprehensive plan creation
- Multiple execution models (sequential, parallel, DAG)
- Plan validation and adaptation
- REALM-Bench and API-Bank benchmarking

Actions:
- ANALYZE_INPUT: Analyzes user input and extracts key information
- PROCESS_ANALYSIS: Processes analysis results and makes decisions
- EXECUTE_FINAL: Executes the final action based on processing results
- CREATE_PLAN: Creates a comprehensive project plan

Providers:
- messageClassifier: Classifies messages by complexity and planning requirements
"""

from elizaos_plugin_planning.types import (
    StrategySpec,
    ExecutionStep,
    ExecutionDAG,
    ExecutionResult,
    RequiredCapability,
    CapabilityGap,
    GenerationMethod,
    MessageClassification,
    PlanningConfig,
    ClassificationResult,
    RetryPolicy,
)
from elizaos_plugin_planning.services.planning_service import PlanningService
from elizaos_plugin_planning.providers.message_classifier import MessageClassifierProvider

# Actions
from elizaos_plugin_planning.actions import (
    AnalyzeInputAction,
    ProcessAnalysisAction,
    ExecuteFinalAction,
    CreatePlanAction,
    get_planning_action_names,
)

__version__ = "1.0.0"

# Plugin metadata
PLUGIN_NAME = "planning"
PLUGIN_DESCRIPTION = "Comprehensive planning and execution plugin with integrated planning service"


class PlanningPlugin:
    """Planning Plugin for elizaOS."""

    name = PLUGIN_NAME
    description = PLUGIN_DESCRIPTION
    version = __version__

    def __init__(self) -> None:
        self.service = PlanningService()
        self.providers = [MessageClassifierProvider()]
        self.actions = [
            AnalyzeInputAction(),
            ProcessAnalysisAction(),
            ExecuteFinalAction(),
            CreatePlanAction(),
        ]
        self.evaluators: list[object] = []

    async def initialize(self, runtime: object) -> None:
        """Initialize the plugin with runtime context."""
        await self.service.start(runtime)

    async def shutdown(self) -> None:
        """Cleanup plugin resources."""
        await self.service.stop()


__all__ = [
    # Plugin
    "PlanningPlugin",
    # Actions
    "AnalyzeInputAction",
    "ProcessAnalysisAction",
    "ExecuteFinalAction",
    "CreatePlanAction",
    "get_planning_action_names",
    # Types
    "StrategySpec",
    "ExecutionStep",
    "ExecutionDAG",
    "ExecutionResult",
    "RequiredCapability",
    "CapabilityGap",
    "GenerationMethod",
    "MessageClassification",
    "PlanningConfig",
    "ClassificationResult",
    "RetryPolicy",
    # Services
    "PlanningService",
    # Providers
    "MessageClassifierProvider",
    # Metadata
    "PLUGIN_NAME",
    "PLUGIN_DESCRIPTION",
]
