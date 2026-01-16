from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.generated.spec_helpers import require_provider_spec
from elizaos.types import Provider, ProviderResult

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State

# Get text content from centralized specs
_spec = require_provider_spec("FACTS")


async def get_facts_context(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> ProviderResult:
    sections: list[str] = []
    facts_list: list[dict[str, str]] = []

    entity_id = message.entity_id
    room_id = message.room_id

    if entity_id:
        sender_facts = await runtime.get_memories(
            entity_id=entity_id,
            memory_type="fact",
            limit=10,
        )

        if sender_facts:
            sender = await runtime.get_entity(entity_id)
            sender_name = sender.name if sender and sender.name else "User"
            sections.append(f"\n## Facts about {sender_name}")

            for fact in sender_facts:
                if fact.content and fact.content.text:
                    fact_text = fact.content.text
                    if len(fact_text) > 200:
                        fact_text = fact_text[:200] + "..."
                    facts_list.append(
                        {"entityId": str(entity_id), "entityName": sender_name, "fact": fact_text}
                    )
                    sections.append(f"- {fact_text}")

    if room_id:
        room_facts = await runtime.get_memories(
            room_id=room_id,
            memory_type="fact",
            limit=5,
        )

        if room_facts:
            sections.append("\n## Room Context Facts")
            for fact in room_facts:
                if fact.content and fact.content.text:
                    fact_text = fact.content.text
                    if len(fact_text) > 200:
                        fact_text = fact_text[:200] + "..."
                    facts_list.append({"roomId": str(room_id), "fact": fact_text})
                    sections.append(f"- {fact_text}")

    context_text = ""
    if sections:
        context_text = "# Known Facts" + "\n".join(sections)

    return ProviderResult(
        text=context_text,
        values={
            "factCount": len(facts_list),
            "hasFacts": len(facts_list) > 0,
        },
        data={
            "facts": facts_list,
        },
    )


facts_provider = Provider(
    name=_spec["name"],
    description=_spec["description"],
    get=get_facts_context,
    dynamic=_spec.get("dynamic", True),
)
