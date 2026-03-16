from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.generated.spec_helpers import require_provider_spec
from elizaos.types import Provider, ProviderResult

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State

# Get text content from centralized specs
_spec = require_provider_spec("CHARACTER")


async def get_character_context(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> ProviderResult:
    character = runtime.character

    sections: list[str] = []

    sections.append(f"# Agent: {character.name}")

    if character.bio:
        bio_text = character.bio if isinstance(character.bio, str) else "\n".join(character.bio)
        sections.append(f"\n## Bio\n{bio_text}")

    if character.adjectives:
        adjectives = (
            character.adjectives
            if isinstance(character.adjectives, list)
            else [character.adjectives]
        )
        sections.append(f"\n## Personality Traits\n{', '.join(adjectives)}")

    # lore is optional and may not exist on all Character instances
    lore = getattr(character, "lore", None)
    if lore:
        lore_text = lore if isinstance(lore, str) else "\n".join(lore)
        sections.append(f"\n## Background\n{lore_text}")

    if character.topics:
        topics = character.topics if isinstance(character.topics, list) else [character.topics]
        sections.append(f"\n## Knowledge Areas\n{', '.join(topics)}")

    if character.style:
        style_sections: list[str] = []
        if character.style.all:
            all_style = (
                character.style.all
                if isinstance(character.style.all, list)
                else [character.style.all]
            )
            style_sections.append(f"General: {', '.join(all_style)}")
        if character.style.chat:
            chat_style = (
                character.style.chat
                if isinstance(character.style.chat, list)
                else [character.style.chat]
            )
            style_sections.append(f"Chat: {', '.join(chat_style)}")
        if character.style.post:
            post_style = (
                character.style.post
                if isinstance(character.style.post, list)
                else [character.style.post]
            )
            style_sections.append(f"Posts: {', '.join(post_style)}")
        if style_sections:
            sections.append("\n## Communication Style\n" + "\n".join(style_sections))

    context_text = "\n".join(sections)

    # Note: Protobuf ProviderResult.data is a Struct which has limited type support.
    # The text already contains all the information needed for the agent context.
    return ProviderResult(text=context_text)


character_provider = Provider(
    name=_spec["name"],
    description=_spec["description"],
    get=get_character_context,
    dynamic=_spec.get("dynamic", False),
)
