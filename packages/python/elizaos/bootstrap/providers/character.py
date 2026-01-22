from __future__ import annotations

from collections.abc import Iterable
from typing import TYPE_CHECKING

from elizaos.generated.spec_helpers import require_provider_spec
from elizaos.types import Provider, ProviderResult

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State

# Get text content from centralized specs
_spec = require_provider_spec("CHARACTER")


def _to_str_list(value: str | Iterable[str] | None) -> list[str]:
    """
    Normalize a value to list[str].

    Handles str, list, tuple, set, or any Iterable[str].
    Returns empty list for None.

    WHY: Character fields can be str | list[str] | tuple[str] depending on
    how they're defined. This helper ensures consistent handling regardless
    of the input type, avoiding issues like tuples being treated as scalars.
    """
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    # Any other iterable (list, tuple, set, etc.) - convert to list
    return list(value)


def _to_str_list(value: str | Iterable[str] | None) -> list[str]:
    """
    Normalize a value to list[str].

    Handles str, list, tuple, set, or any Iterable[str].
    Returns empty list for None.

    WHY: Character fields can be str | list[str] | tuple[str] depending on
    how they're defined. This helper ensures consistent handling regardless
    of the input type, avoiding issues like tuples being treated as scalars.
    """
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    # Any other iterable (list, tuple, set, etc.) - convert to list
    return list(value)


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
        bio_list = _to_str_list(bio)
        sections.append(f"\n## Bio\n{chr(10).join(bio_list)}")

    adjectives = getattr(character, "adjectives", None)
    if adjectives:
        adjectives_list = _to_str_list(adjectives)
        sections.append(f"\n## Personality Traits\n{', '.join(adjectives_list)}")

    # lore is optional and may not exist on all Character instances
    lore = getattr(character, "lore", None)
    if lore:
        lore_list = _to_str_list(lore)
        sections.append(f"\n## Background\n{chr(10).join(lore_list)}")

    topics = getattr(character, "topics", None)
    if topics:
        topics_list = _to_str_list(topics)
        sections.append(f"\n## Knowledge Areas\n{', '.join(topics_list)}")

    style = getattr(character, "style", None)
    if style:
        style_sections: list[str] = []
        style_all = getattr(style, "all", None)
        if style_all:
            all_style = _to_str_list(style_all)
            style_sections.append(f"General: {', '.join(all_style)}")
        style_chat = getattr(style, "chat", None)
        if style_chat:
            chat_style = _to_str_list(style_chat)
            style_sections.append(f"Chat: {', '.join(chat_style)}")
        style_post = getattr(style, "post", None)
        if style_post:
            post_style = _to_str_list(style_post)
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
    name=_spec["name"],
    description=_spec["description"],
    get=get_character_context,
    dynamic=_spec.get("dynamic", False),
)
