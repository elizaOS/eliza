"""
Character Provider - Provides character information for agent context.

This provider supplies the agent's character definition and personality
information to be included in prompts.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.types import Provider, ProviderResult

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State


async def get_character_context(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> ProviderResult:
    """
    Get the character context for the current agent.

    Returns character information including:
    - Name
    - Bio/description
    - Personality traits
    - Knowledge areas
    - Communication style
    """
    character = runtime.character

    # Build character context sections
    sections: list[str] = []

    # Name section
    sections.append(f"# Agent: {character.name}")

    # Bio section
    if character.bio:
        bio_text = character.bio if isinstance(character.bio, str) else "\n".join(character.bio)
        sections.append(f"\n## Bio\n{bio_text}")

    # Personality/Adjectives section
    if character.adjectives:
        adjectives = (
            character.adjectives
            if isinstance(character.adjectives, list)
            else [character.adjectives]
        )
        sections.append(f"\n## Personality Traits\n{', '.join(adjectives)}")

    # Lore/Background section
    if character.lore:
        lore_text = character.lore if isinstance(character.lore, str) else "\n".join(character.lore)
        sections.append(f"\n## Background\n{lore_text}")

    # Topics/Knowledge areas section
    if character.topics:
        topics = character.topics if isinstance(character.topics, list) else [character.topics]
        sections.append(f"\n## Knowledge Areas\n{', '.join(topics)}")

    # Style section
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

    return ProviderResult(
        text=context_text,
        values={
            "agentName": character.name,
            "hasCharacter": True,
        },
        data={
            "name": character.name,
            "bio": character.bio,
            "adjectives": character.adjectives,
            "topics": character.topics,
        },
    )


# Create the provider instance
character_provider = Provider(
    name="CHARACTER",
    description="Provides the agent's character definition and personality information",
    get=get_character_context,
    dynamic=False,  # Character doesn't change during runtime
)
