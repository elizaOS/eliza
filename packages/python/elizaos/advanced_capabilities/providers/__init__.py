"""Advanced Providers - Extended providers for agent operation.

Extended providers that can be enabled with `advanced_capabilities=True`.
"""

from .agent_settings import agent_settings_provider
from .contacts import contacts_provider
from .facts import facts_provider
from .follow_ups import follow_ups_provider
from .knowledge import knowledge_provider
from .relationships import relationships_provider
from .roles import roles_provider
from .settings import settings_provider

__all__ = [
    "agent_settings_provider",
    "contacts_provider",
    "facts_provider",
    "follow_ups_provider",
    "knowledge_provider",
    "relationships_provider",
    "roles_provider",
    "settings_provider",
    "advanced_providers",
]

advanced_providers = [
    contacts_provider,
    facts_provider,
    follow_ups_provider,
    knowledge_provider,
    relationships_provider,
    roles_provider,
    agent_settings_provider,
    settings_provider,
]
