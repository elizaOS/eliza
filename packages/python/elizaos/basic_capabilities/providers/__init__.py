"""Basic Providers - Core providers for agent operation.

Fundamental providers included by default in the bootstrap plugin.
"""

from .action_state import action_state_provider
from .actions import actions_provider
from .attachments import attachments_provider
from .capabilities import capabilities_provider
from .character import character_provider
from .choice import choice_provider
from .context_bench import context_bench_provider
from .current_time import current_time_provider
from .entities import entities_provider
from .evaluators import evaluators_provider
from .providers_list import providers_list_provider
from .recent_messages import recent_messages_provider
from .time import time_provider
from .world import world_provider

__all__ = [
    "action_state_provider",
    "actions_provider",
    "attachments_provider",
    "capabilities_provider",
    "character_provider",
    "choice_provider",
    "context_bench_provider",
    "current_time_provider",
    "entities_provider",
    "evaluators_provider",
    "providers_list_provider",
    "recent_messages_provider",
    "time_provider",
    "world_provider",
    "basic_providers",
]

basic_providers = [
    actions_provider,
    action_state_provider,
    attachments_provider,
    capabilities_provider,
    character_provider,
    choice_provider,
    context_bench_provider,
    current_time_provider,
    entities_provider,
    evaluators_provider,
    providers_list_provider,
    recent_messages_provider,
    time_provider,
    world_provider,
]
