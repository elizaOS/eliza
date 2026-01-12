
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
PLUGIN_DESCRIPTION = "Planning and execution plugin"


class PlanningPlugin:
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
        await self.service.start(runtime)

    async def shutdown(self) -> None:
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
