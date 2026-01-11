"""
elizaOS N8n Plugin - AI-powered plugin creation for ElizaOS.

This package provides an AI-powered plugin creation system using Claude models,
enabling agents to autonomously create, build, test, and deploy ElizaOS plugins.

Example:
    >>> from elizaos_plugin_n8n import PluginCreationClient, N8nConfig
    >>> config = N8nConfig.from_env()
    >>> client = PluginCreationClient(config)
    >>> job_id = await client.create_plugin(spec)
    >>> status = await client.get_job_status(job_id)
"""

from elizaos_plugin_n8n.client import PluginCreationClient
from elizaos_plugin_n8n.config import N8nConfig
from elizaos_plugin_n8n.errors import (
    N8nError,
    ApiKeyError,
    ConfigError,
    JobError,
    RateLimitError,
    ValidationError,
)
from elizaos_plugin_n8n.models import ClaudeModel, JobStatus
from elizaos_plugin_n8n.types import (
    ActionSpecification,
    CreatePluginOptions,
    EnvironmentVariableSpec,
    EvaluatorSpecification,
    JobError as JobErrorType,
    PluginCreationJob,
    PluginRegistryData,
    PluginSpecification,
    ProviderSpecification,
    ServiceSpecification,
    TestResults,
)

__version__ = "1.0.0"

__all__ = [
    # Client
    "PluginCreationClient",
    # Config
    "N8nConfig",
    # Errors
    "N8nError",
    "ApiKeyError",
    "ConfigError",
    "JobError",
    "RateLimitError",
    "ValidationError",
    # Models
    "ClaudeModel",
    "JobStatus",
    # Types
    "ActionSpecification",
    "CreatePluginOptions",
    "EnvironmentVariableSpec",
    "EvaluatorSpecification",
    "JobErrorType",
    "PluginCreationJob",
    "PluginRegistryData",
    "PluginSpecification",
    "ProviderSpecification",
    "ServiceSpecification",
    "TestResults",
]


