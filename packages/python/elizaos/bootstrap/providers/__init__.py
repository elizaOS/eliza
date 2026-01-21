from .action_state import action_state_provider
from .actions import actions_provider
from .agent_settings import agent_settings_provider
from .attachments import attachments_provider
from .capabilities import capabilities_provider
from .character import character_provider
from .choice import choice_provider
from .contacts import contacts_provider
from .context_bench import context_bench_provider
from .current_time import current_time_provider
from .entities import entities_provider
from .evaluators import evaluators_provider
from .facts import facts_provider
from .follow_ups import follow_ups_provider
from .knowledge import knowledge_provider
from .providers_list import providers_list_provider
from .recent_messages import recent_messages_provider
from .relationships import relationships_provider
from .roles import roles_provider
from .settings import settings_provider
from .time import time_provider
from .world import world_provider

__all__ = [
    "action_state_provider",
    "actions_provider",
    "agent_settings_provider",
    "attachments_provider",
    "capabilities_provider",
    "character_provider",
    "context_bench_provider",
    "choice_provider",
    "contacts_provider",
    "current_time_provider",
    "entities_provider",
    "evaluators_provider",
    "facts_provider",
    "follow_ups_provider",
    "knowledge_provider",
    "providers_list_provider",
    "recent_messages_provider",
    "relationships_provider",
    "roles_provider",
    "settings_provider",
    "time_provider",
    "world_provider",
    "BASIC_PROVIDERS",
    "EXTENDED_PROVIDERS",
    "ALL_PROVIDERS",
]

BASIC_PROVIDERS = [
    actions_provider,
    action_state_provider,
    attachments_provider,
    capabilities_provider,
    character_provider,
    context_bench_provider,
    entities_provider,
    evaluators_provider,
    providers_list_provider,
    recent_messages_provider,
    current_time_provider,
    time_provider,
    world_provider,
]

EXTENDED_PROVIDERS = [
    choice_provider,
    contacts_provider,
    facts_provider,
    follow_ups_provider,
    knowledge_provider,
    relationships_provider,
    roles_provider,
    agent_settings_provider,
    settings_provider,
]

ALL_PROVIDERS = BASIC_PROVIDERS + EXTENDED_PROVIDERS
