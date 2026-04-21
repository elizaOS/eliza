from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.generated.spec_helpers import require_provider_spec
from elizaos.types import Provider, ProviderResult

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State

# Get text content from centralized specs
_spec = require_provider_spec("CHARACTER")


def _resolve_character_placeholders(
    text: str,
    agent_name: str,
    example_names: list[str] | None = None,
) -> str:
    resolved = text.replace("{{agentName}}", agent_name).replace("{{name}}", agent_name)
    for index, name in enumerate(example_names or [], start=1):
        resolved = resolved.replace(f"{{{{name{index}}}}}", name).replace(
            f"{{{{user{index}}}}}", name
        )
    return resolved


def _resolve_list(items: list[str], agent_name: str) -> list[str]:
    return [_resolve_character_placeholders(item, agent_name) for item in items]


async def get_character_context(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> ProviderResult:
    character = runtime.character
    agent_name = character.name

    sections: list[str] = []

    sections.append(f"# Agent: {agent_name}")

    if character.bio:
        bio_text = character.bio if isinstance(character.bio, str) else "\n".join(character.bio)
        sections.append(f"\n## Bio\n{_resolve_character_placeholders(bio_text, agent_name)}")

    if character.adjectives:
        adjectives = (
            character.adjectives
            if isinstance(character.adjectives, list)
            else [character.adjectives]
        )
        sections.append(
            f"\n## Personality Traits\n{', '.join(_resolve_list(adjectives, agent_name))}"
        )

    # lore is optional and may not exist on all Character instances
    lore = getattr(character, "lore", None)
    if lore:
        lore_text = lore if isinstance(lore, str) else "\n".join(lore)
        sections.append(
            f"\n## Background\n{_resolve_character_placeholders(lore_text, agent_name)}"
        )

    if character.topics:
        topics = character.topics if isinstance(character.topics, list) else [character.topics]
        sections.append(f"\n## Knowledge Areas\n{', '.join(_resolve_list(topics, agent_name))}")

    if character.style:
        style_sections: list[str] = []
        if character.style.all:
            all_style = (
                character.style.all
                if isinstance(character.style.all, list)
                else [character.style.all]
            )
            style_sections.append(f"General: {', '.join(_resolve_list(all_style, agent_name))}")
        if character.style.chat:
            chat_style = (
                character.style.chat
                if isinstance(character.style.chat, list)
                else [character.style.chat]
            )
            style_sections.append(f"Chat: {', '.join(_resolve_list(chat_style, agent_name))}")
        if character.style.post:
            post_style = (
                character.style.post
                if isinstance(character.style.post, list)
                else [character.style.post]
            )
            style_sections.append(f"Posts: {', '.join(_resolve_list(post_style, agent_name))}")
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
