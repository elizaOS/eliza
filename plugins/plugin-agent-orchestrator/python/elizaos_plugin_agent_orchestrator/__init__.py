"""
Agent Orchestrator Plugin for ElizaOS.

Orchestrates tasks across registered agent providers without performing
file I/O directly - that responsibility belongs to sub-agent workers.
"""

from .actions import (
    cancel_task_action,
    create_task_action,
    list_tasks_action,
    pause_task_action,
    resume_task_action,
    search_tasks_action,
    switch_task_action,
)
from .config import configure_agent_orchestrator_plugin, get_configured_options, reset_configuration
from .providers import task_context_provider
from .service import AgentOrchestratorService
from .types import (
    AgentOrchestratorPluginOptions,
    AgentProvider,
    AgentProviderId,
    JsonValue,
    OrchestratedTask,
    OrchestratedTaskMetadata,
    ProviderTaskExecutionContext,
    TaskEvent,
    TaskEventType,
    TaskResult,
    TaskStatus,
    TaskStep,
    TaskUserStatus,
)

__all__ = [
    # Types
    "JsonValue",
    "TaskStatus",
    "TaskUserStatus",
    "TaskStep",
    "TaskResult",
    "AgentProviderId",
    "OrchestratedTaskMetadata",
    "OrchestratedTask",
    "ProviderTaskExecutionContext",
    "AgentProvider",
    "AgentOrchestratorPluginOptions",
    "TaskEventType",
    "TaskEvent",
    # Service
    "AgentOrchestratorService",
    # Config
    "configure_agent_orchestrator_plugin",
    "get_configured_options",
    "reset_configuration",
    # Actions
    "create_task_action",
    "list_tasks_action",
    "switch_task_action",
    "search_tasks_action",
    "pause_task_action",
    "resume_task_action",
    "cancel_task_action",
    # Providers
    "task_context_provider",
]

# Plugin definition for elizaos
plugin = {
    "name": "agent-orchestrator",
    "description": "Orchestrates tasks across registered agent providers",
    "services": [AgentOrchestratorService],
    "actions": [
        create_task_action,
        list_tasks_action,
        switch_task_action,
        search_tasks_action,
        pause_task_action,
        resume_task_action,
        cancel_task_action,
    ],
    "providers": [task_context_provider],
}
