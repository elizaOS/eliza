"""
elizaOS Plugin Planning - Comprehensive planning and execution for AI agents.

This plugin provides:
- Message classification by complexity
- Simple and comprehensive plan creation
- Multiple execution models (sequential, parallel, DAG)
- Plan validation and adaptation
- REALM-Bench and API-Bank benchmarking
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

__version__ = "1.0.0"


class PlanningPlugin:
    """Planning Plugin for elizaOS."""

    name = "planning"
    description = "Comprehensive planning and execution plugin with integrated planning service"
    version = __version__

    def __init__(self) -> None:
        self.service = PlanningService()
        self.providers = [MessageClassifierProvider()]
        self.actions: list[object] = []
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
]
