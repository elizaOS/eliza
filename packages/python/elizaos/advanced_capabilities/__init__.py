"""Advanced Capabilities - Extended features for agent operation.

This module provides advanced capabilities that can be enabled with
`advanced_capabilities=True` or `enable_extended=True`:
- Extended actions (contacts, room management, image generation, etc.)
- Extended providers (facts, knowledge, relationships, etc.)
- Evaluators (reflection, relationship extraction)
- Extended services (rolodex, follow-up scheduling)
"""

from .actions import (
    add_contact_action,
    advanced_actions,
    follow_room_action,
    generate_image_action,
    mute_room_action,
    remove_contact_action,
    schedule_follow_up_action,
    search_contacts_action,
    send_message_action,
    unfollow_room_action,
    unmute_room_action,
    update_contact_action,
    update_entity_action,
    update_role_action,
    update_settings_action,
)
from .evaluators import (
    advanced_evaluators,
    reflection_evaluator,
    relationship_extraction_evaluator,
)
from .providers import (
    advanced_providers,
    agent_settings_provider,
    contacts_provider,
    facts_provider,
    follow_ups_provider,
    knowledge_provider,
    relationships_provider,
    roles_provider,
    settings_provider,
)
from .services import (
    FollowUpService,
    RolodexService,
    advanced_services,
)

__all__ = [
    # Actions
    "advanced_actions",
    "add_contact_action",
    "follow_room_action",
    "generate_image_action",
    "mute_room_action",
    "remove_contact_action",
    "schedule_follow_up_action",
    "search_contacts_action",
    "send_message_action",
    "unfollow_room_action",
    "unmute_room_action",
    "update_contact_action",
    "update_entity_action",
    "update_role_action",
    "update_settings_action",
    # Providers
    "advanced_providers",
    "agent_settings_provider",
    "contacts_provider",
    "facts_provider",
    "follow_ups_provider",
    "knowledge_provider",
    "relationships_provider",
    "roles_provider",
    "settings_provider",
    # Evaluators
    "advanced_evaluators",
    "reflection_evaluator",
    "relationship_extraction_evaluator",
    # Services
    "advanced_services",
    "FollowUpService",
    "RolodexService",
]
