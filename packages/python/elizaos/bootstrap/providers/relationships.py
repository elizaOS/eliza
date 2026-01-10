"""
Relationships Provider - Provides entity relationship context.

This provider returns information about relationships between
entities that the agent has observed.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.types import Provider, ProviderResult

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State


def format_relationship(
    relationship: dict[str, str | int | list[str] | dict[str, str]],
    target_name: str,
) -> str:
    """Format a single relationship for display."""
    tags = relationship.get("tags", [])
    if isinstance(tags, list):
        tags_str = ", ".join(tags) if tags else "none"
    else:
        tags_str = str(tags)

    interactions = relationship.get("metadata", {})
    if isinstance(interactions, dict):
        interaction_count = interactions.get("interactions", 0)
    else:
        interaction_count = 0

    return f"- {target_name}: tags=[{tags_str}], interactions={interaction_count}"


async def get_relationships(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> ProviderResult:
    """
    Get relationship information for the current entity.

    Returns formatted information about relationships between
    the message sender and other entities.
    """
    entity_id = message.entity_id
    if not entity_id:
        return ProviderResult(
            text="No relationships found.",
            values={
                "relationshipCount": 0,
            },
            data={
                "relationships": [],
            },
        )

    # Get relationships for this entity
    try:
        relationships = await runtime.get_relationships(entity_id=entity_id)
    except Exception as e:
        runtime.logger.debug(
            {
                "src": "provider:relationships",
                "agentId": runtime.agent_id,
                "error": str(e),
            },
            "Failed to get relationships",
        )
        relationships = []

    if not relationships:
        return ProviderResult(
            text="No relationships found.",
            values={
                "relationshipCount": 0,
            },
            data={
                "relationships": [],
            },
        )

    # Sort by interaction count (descending)
    sorted_relationships = sorted(
        relationships,
        key=lambda r: (r.get("metadata", {}) or {}).get("interactions", 0),
        reverse=True,
    )[:30]  # Top 30

    # Get entity names for formatting
    formatted_relationships: list[str] = []
    for rel in sorted_relationships:
        target_id = rel.get("targetEntityId")
        if not target_id:
            continue

        try:
            target_entity = await runtime.get_entity(target_id)
            target_name = target_entity.name if target_entity else str(target_id)[:8]
        except Exception:
            target_name = str(target_id)[:8]

        formatted_relationships.append(format_relationship(rel, target_name))

    if not formatted_relationships:
        return ProviderResult(
            text="No relationships found.",
            values={
                "relationshipCount": 0,
            },
            data={
                "relationships": [],
            },
        )

    sender_name = message.content.sender_name if message.content else "Unknown"
    text = f"# {runtime.character.name} has observed {sender_name} interacting with:\n" + "\n".join(
        formatted_relationships
    )

    return ProviderResult(
        text=text,
        values={
            "relationshipCount": len(sorted_relationships),
        },
        data={
            "relationships": sorted_relationships,
        },
    )


# Create the provider instance
relationships_provider = Provider(
    name="RELATIONSHIPS",
    description="Relationships between entities observed by the agent",
    get=get_relationships,
    dynamic=True,
)
