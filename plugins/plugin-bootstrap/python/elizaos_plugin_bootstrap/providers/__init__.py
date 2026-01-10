"""
Providers for the elizaOS Bootstrap Plugin.

This module exports all available providers for the bootstrap plugin.
"""

from .action_state import action_state_provider
from .actions import actions_provider
from .agent_settings import agent_settings_provider
from .attachments import attachments_provider
from .capabilities import capabilities_provider
from .character import character_provider
from .choice import choice_provider
from .current_time import current_time_provider
from .entities import entities_provider
from .evaluators import evaluators_provider
from .facts import facts_provider
from .knowledge import knowledge_provider
from .providers_list import providers_list_provider
from .recent_messages import recent_messages_provider
from .relationships import relationships_provider
from .roles import roles_provider
from .world import world_provider

__all__ = [
    "action_state_provider",
    "actions_provider",
    "agent_settings_provider",
    "attachments_provider",
    "capabilities_provider",
    "character_provider",
    "choice_provider",
    "current_time_provider",
    "entities_provider",
    "evaluators_provider",
    "facts_provider",
    "knowledge_provider",
    "providers_list_provider",
    "recent_messages_provider",
    "relationships_provider",
    "roles_provider",
    "world_provider",
]

# All providers list for easy registration
ALL_PROVIDERS = [
    # Core providers (order matters for prompt composition)
    character_provider,
    current_time_provider,
    # Context providers
    recent_messages_provider,
    entities_provider,
    relationships_provider,
    facts_provider,
    knowledge_provider,
    world_provider,
    # State providers
    action_state_provider,
    agent_settings_provider,
    # Capability providers
    actions_provider,
    capabilities_provider,
    evaluators_provider,
    providers_list_provider,
    # Dynamic providers
    attachments_provider,
    choice_provider,
    roles_provider,
]
