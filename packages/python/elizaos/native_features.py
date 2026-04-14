from __future__ import annotations

from typing import Literal

from elizaos.features.advanced_capabilities.actions import (
    add_contact_action,
    remove_contact_action,
    schedule_follow_up_action,
    search_contacts_action,
    send_message_action,
    update_contact_action,
    update_entity_action,
)
from elizaos.features.advanced_capabilities.evaluators import (
    reflection_evaluator,
    relationship_extraction_evaluator,
)
from elizaos.features.advanced_capabilities.providers import (
    contacts_provider,
    facts_provider,
    follow_ups_provider,
    knowledge_provider,
    relationships_provider,
)
from elizaos.features.advanced_capabilities.services import FollowUpService, RelationshipsService
from elizaos.services.trajectories import TrajectoriesService
from elizaos.types import Plugin

NativeRuntimeFeature = Literal["knowledge", "relationships", "trajectories"]


knowledge_plugin = Plugin(
    name="knowledge",
    description="Native knowledge retrieval capabilities.",
    providers=[knowledge_provider],
)

relationships_plugin = Plugin(
    name="relationships",
    description="Native relationship, contact, and follow-up capabilities.",
    actions=[
        add_contact_action,
        remove_contact_action,
        schedule_follow_up_action,
        search_contacts_action,
        send_message_action,
        update_contact_action,
        update_entity_action,
    ],
    providers=[
        contacts_provider,
        facts_provider,
        follow_ups_provider,
        relationships_provider,
    ],
    evaluators=[
        reflection_evaluator,
        relationship_extraction_evaluator,
    ],
    services=[RelationshipsService, FollowUpService],
)

trajectories_plugin = Plugin(
    name="trajectories",
    description="Native trajectory logging capabilities.",
    services=[TrajectoriesService],
)

native_runtime_feature_plugins: dict[NativeRuntimeFeature, Plugin] = {
    "knowledge": knowledge_plugin,
    "relationships": relationships_plugin,
    "trajectories": trajectories_plugin,
}

native_runtime_feature_defaults: dict[NativeRuntimeFeature, bool] = {
    "knowledge": True,
    "relationships": True,
    "trajectories": True,
}

native_runtime_feature_plugin_names: dict[NativeRuntimeFeature, str] = {
    feature: plugin.name for feature, plugin in native_runtime_feature_plugins.items()
}


def get_native_runtime_feature_plugin(feature: NativeRuntimeFeature) -> Plugin:
    return native_runtime_feature_plugins[feature]


def resolve_native_runtime_feature_from_plugin_name(
    plugin_name: str | None,
) -> NativeRuntimeFeature | None:
    if not plugin_name:
        return None

    for feature, canonical_name in native_runtime_feature_plugin_names.items():
        if plugin_name == canonical_name:
            return feature

    return None
