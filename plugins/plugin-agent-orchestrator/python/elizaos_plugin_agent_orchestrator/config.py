"""
Configuration management for the Agent Orchestrator plugin.
"""

from typing import Optional
from .types import AgentOrchestratorPluginOptions

_configured_options: Optional[AgentOrchestratorPluginOptions] = None


def configure_agent_orchestrator_plugin(options: AgentOrchestratorPluginOptions) -> None:
    """
    Configure the agent orchestrator plugin with providers.
    
    This must be called before the runtime is initialized.
    """
    global _configured_options
    _configured_options = options


def get_configured_options() -> Optional[AgentOrchestratorPluginOptions]:
    """Get the configured options, or None if not configured."""
    return _configured_options


def reset_configuration() -> None:
    """Reset configuration (useful for testing)."""
    global _configured_options
    _configured_options = None
