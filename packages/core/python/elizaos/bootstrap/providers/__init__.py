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
    # Capability lists
    "BASIC_PROVIDERS",
    "EXTENDED_PROVIDERS",
    "ALL_PROVIDERS",
]

# Basic providers - included by default
BASIC_PROVIDERS = [
    actions_provider,
    action_state_provider,
    attachments_provider,
    capabilities_provider,
    character_provider,
    entities_provider,
    evaluators_provider,
    providers_list_provider,
    recent_messages_provider,
    current_time_provider,
    world_provider,
]

# Extended providers - opt-in
EXTENDED_PROVIDERS = [
    choice_provider,
    facts_provider,
    relationships_provider,
    roles_provider,
    agent_settings_provider,
    knowledge_provider,
]

# All providers list for easy registration (backwards compatibility)
ALL_PROVIDERS = BASIC_PROVIDERS + EXTENDED_PROVIDERS
