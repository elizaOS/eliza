"""Advanced Capabilities - Extended features for agent operation.

This module provides advanced capabilities that can be enabled with
`advanced_capabilities=True` or `enable_extended=True`:
- Extended actions (contacts, room management, image generation, etc.)
- Extended providers (facts, knowledge, relationships, etc.)
- Evaluators (reflection, relationship extraction)
- Extended services (relationships, follow-up scheduling)
- Form capability (conversational form management)
- Clipboard capability (file-based memory and task clipboard)
- Personality capability (character management and evolution)
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
from .clipboard import (
    ClipboardService,
    TaskClipboardService,
    clipboard_append_action,
    clipboard_delete_action,
    clipboard_list_action,
    clipboard_provider,
    clipboard_read_action,
    clipboard_search_action,
    clipboard_write_action,
)
from .evaluators import (
    advanced_evaluators,
    reflection_evaluator,
    relationship_extraction_evaluator,
)
from .experience import (
    EXPERIENCE_SERVICE_TYPE,
    ExperienceService,
    ExperienceType,
    OutcomeType,
    experience_evaluator,
    experience_provider,
    record_experience_action,
)
from .form import (
    FormService,
    form_context_provider,
    form_evaluator,
    form_restore_action,
)
from .personality import (
    CharacterFileManager,
    character_evolution_evaluator,
    modify_character_action,
    user_personality_provider,
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
    RelationshipsService,
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
    "RelationshipsService",
    # Experience
    "EXPERIENCE_SERVICE_TYPE",
    "ExperienceService",
    "ExperienceType",
    "OutcomeType",
    "experience_evaluator",
    "experience_provider",
    "record_experience_action",
    # Form
    "FormService",
    "form_context_provider",
    "form_evaluator",
    "form_restore_action",
    # Clipboard
    "ClipboardService",
    "TaskClipboardService",
    "clipboard_append_action",
    "clipboard_delete_action",
    "clipboard_list_action",
    "clipboard_provider",
    "clipboard_read_action",
    "clipboard_search_action",
    "clipboard_write_action",
    # Personality
    "CharacterFileManager",
    "character_evolution_evaluator",
    "modify_character_action",
    "user_personality_provider",
]
