from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.generated.spec_helpers import require_provider_spec
from elizaos.types import Provider, ProviderResult

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State

# Get text content from centralized specs
_spec = require_provider_spec("CHARACTER")


def _resolve_name(text: str, name: str) -> str:
    """Replace ``{{name}}`` placeholders with the character's name.

    Supports character template files where the name is injected at render
    time so changing the character's name doesn't require rewriting every
    field.
    """
    return text.replace("{{name}}", name)


def _resolve_name_list(items: list[str], name: str) -> list[str]:
    """Resolve ``{{name}}`` in every element of a string list."""
    return [_resolve_name(s, name) for s in items]


async def get_character_context(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> ProviderResult:
    character = runtime.character
    agent_name: str = character.name

    sections: list[str] = []

    sections.append(f"# Agent: {agent_name}")

    if character.bio:
        if isinstance(character.bio, str):
            bio_text = _resolve_name(character.bio, agent_name)
        else:
            bio_text = "\n".join(_resolve_name_list(list(character.bio), agent_name))
        sections.append(f"\n## Bio\n{bio_text}")

    if character.adjectives:
        adjectives = (
            character.adjectives
            if isinstance(character.adjectives, list)
            else [character.adjectives]
        )
        resolved_adjectives = _resolve_name_list(adjectives, agent_name)
        sections.append(f"\n## Personality Traits\n{', '.join(resolved_adjectives)}")

    # lore is optional and may not exist on all Character instances
    lore = getattr(character, "lore", None)
    if lore:
        if isinstance(lore, str):
            lore_text = _resolve_name(lore, agent_name)
        else:
            lore_text = "\n".join(_resolve_name_list(list(lore), agent_name))
        sections.append(f"\n## Background\n{lore_text}")

    if character.topics:
        topics = character.topics if isinstance(character.topics, list) else [character.topics]
        resolved_topics = _resolve_name_list(topics, agent_name)
        sections.append(f"\n## Knowledge Areas\n{', '.join(resolved_topics)}")

    if character.style:
        style_sections: list[str] = []
        if character.style.all:
            all_style = (
                character.style.all
                if isinstance(character.style.all, list)
                else [character.style.all]
            )
            resolved_all = _resolve_name_list(all_style, agent_name)
            style_sections.append(f"General: {', '.join(resolved_all)}")
        if character.style.chat:
            chat_style = (
                character.style.chat
                if isinstance(character.style.chat, list)
                else [character.style.chat]
            )
            resolved_chat = _resolve_name_list(chat_style, agent_name)
            style_sections.append(f"Chat: {', '.join(resolved_chat)}")
        if character.style.post:
            post_style = (
                character.style.post
                if isinstance(character.style.post, list)
                else [character.style.post]
            )
            resolved_post = _resolve_name_list(post_style, agent_name)
            style_sections.append(f"Posts: {', '.join(resolved_post)}")
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
