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
    character = runtime.character

    sections: list[str] = []

    sections.append(f"# Agent: {character.name}")

    bio = getattr(character, "bio", None)
    if bio:
        bio_text = bio if isinstance(bio, str) else "\n".join(bio)
        sections.append(f"\n## Bio\n{bio_text}")

    adjectives = getattr(character, "adjectives", None)
    if adjectives:
        adjectives_list = adjectives if isinstance(adjectives, list) else [adjectives]
        sections.append(f"\n## Personality Traits\n{', '.join(adjectives_list)}")

    lore = getattr(character, "lore", None)
    if lore:
        lore_text = lore if isinstance(lore, str) else "\n".join(lore)
        sections.append(f"\n## Background\n{lore_text}")

    topics = getattr(character, "topics", None)
    if topics:
        topics_list = topics if isinstance(topics, list) else [topics]
        sections.append(f"\n## Knowledge Areas\n{', '.join(topics_list)}")

    style = getattr(character, "style", None)
    if style:
        style_sections: list[str] = []
        style_all = getattr(style, "all", None)
        if style_all:
            all_style = style_all if isinstance(style_all, list) else [style_all]
            style_sections.append(f"General: {', '.join(all_style)}")
        style_chat = getattr(style, "chat", None)
        if style_chat:
            chat_style = style_chat if isinstance(style_chat, list) else [style_chat]
            style_sections.append(f"Chat: {', '.join(chat_style)}")
        style_post = getattr(style, "post", None)
        if style_post:
            post_style = style_post if isinstance(style_post, list) else [style_post]
            style_sections.append(f"Posts: {', '.join(post_style)}")
        if style_sections:
            sections.append("\n## Communication Style\n" + "\n".join(style_sections))

    context_text = "\n".join(sections)

    # Use variables retrieved via getattr above to avoid AttributeError
    # if these optional attributes are missing from the character object
    return ProviderResult(
        text=context_text,
        values={
            "agentName": character.name,
            "hasCharacter": True,
        },
        data={
            "name": character.name,
            "bio": bio,
            "adjectives": adjectives,
            "topics": topics,
        },
    )


character_provider = Provider(
    name="CHARACTER",
    description="Provides the agent's character definition and personality information",
    get=get_character_context,
    dynamic=False,
)
