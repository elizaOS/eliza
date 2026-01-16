from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.generated.spec_helpers import require_provider_spec
from elizaos.types import Provider, ProviderResult

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State

# Get text content from centralized specs
_spec = require_provider_spec("RELATIONSHIPS")


def format_relationship(
    relationship: dict[str, str | int | list[str] | dict[str, str]],
    target_name: str,
) -> str:
    tags = relationship.get("tags", [])
    tags_str = (", ".join(tags) if tags else "none") if isinstance(tags, list) else str(tags)

    interactions = relationship.get("metadata", {})
    interaction_count = interactions.get("interactions", 0) if isinstance(interactions, dict) else 0

    return f"- {target_name}: tags=[{tags_str}], interactions={interaction_count}"


async def get_relationships(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> ProviderResult:
    entity_id = message.entity_id
    if not entity_id:
        return ProviderResult(
            text="No relationships found.",
            values={"relationshipCount": 0},
            data={"relationships": []},
        )

    try:
        relationships = await runtime.get_relationships(entity_id=entity_id)
    except Exception as e:
        runtime.logger.debug(
            {"src": "provider:relationships", "agentId": runtime.agent_id, "error": str(e)},
            "Failed to get relationships",
        )
        relationships = []

    if not relationships:
        return ProviderResult(
            text="No relationships found.",
            values={"relationshipCount": 0},
            data={"relationships": []},
        )

    sorted_relationships = sorted(
        relationships,
        key=lambda r: (r.get("metadata", {}) or {}).get("interactions", 0),
        reverse=True,
    )[:30]

    formatted_relationships: list[str] = []
    entity_cache: dict[object, str] = {}
    for rel in sorted_relationships:
        target_id = rel.get("targetEntityId")
        if not target_id:
            continue

        target_name = entity_cache.get(target_id)
        if target_name is None:
            target_entity = await runtime.get_entity(target_id)
            target_name = target_entity.name if target_entity else str(target_id)[:8]
            entity_cache[target_id] = target_name

        formatted_relationships.append(format_relationship(rel, target_name))

    if not formatted_relationships:
        return ProviderResult(
            text="No relationships found.",
            values={"relationshipCount": 0},
            data={"relationships": []},
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


relationships_provider = Provider(
    name=_spec["name"],
    description=_spec["description"],
    get=get_relationships,
    dynamic=_spec.get("dynamic", True),
)
