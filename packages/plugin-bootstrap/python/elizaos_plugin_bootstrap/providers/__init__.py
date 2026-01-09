"""
Providers for the elizaOS Bootstrap Plugin.

This module exports all available providers for the bootstrap plugin.
"""

from .action_state import action_state_provider
from .agent_settings import agent_settings_provider
from .character import character_provider
from .current_time import current_time_provider
from .entities import entities_provider
from .facts import facts_provider
from .knowledge import knowledge_provider
from .recent_messages import recent_messages_provider
from .world import world_provider

__all__ = [
    "action_state_provider",
    "agent_settings_provider",
    "character_provider",
    "current_time_provider",
    "entities_provider",
    "facts_provider",
    "knowledge_provider",
    "recent_messages_provider",
    "world_provider",
]

# All providers list for easy registration
ALL_PROVIDERS = [
    action_state_provider,
    agent_settings_provider,
    character_provider,
    current_time_provider,
    entities_provider,
    facts_provider,
    knowledge_provider,
    recent_messages_provider,
    world_provider,
]
