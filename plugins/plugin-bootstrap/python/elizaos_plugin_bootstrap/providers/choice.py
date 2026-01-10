"""
Choice Provider - Provides choice options for the agent.

This provider formats available choices when the agent needs
to select from a list of options.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.types import Provider, ProviderResult

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State


def format_choice(index: int, choice: dict[str, str]) -> str:
    """Format a single choice option."""
    label = choice.get("label", f"Option {index + 1}")
    description = choice.get("description", "")
    value = choice.get("value", str(index))

    if description:
        return f"{index + 1}. [{value}] {label}: {description}"
    return f"{index + 1}. [{value}] {label}"


async def get_choice_options(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> ProviderResult:
    """
    Get available choice options.

    Returns formatted choice options if the current context
    requires the agent to make a selection.
    """
    choices: list[dict[str, str]] = []

    # Extract choices from message content
    if message.content and hasattr(message.content, "choices"):
        raw_choices = message.content.choices or []
        for choice in raw_choices:
            if isinstance(choice, dict):
                choices.append(choice)
            elif isinstance(choice, str):
                choices.append({"label": choice, "value": choice})

    # Also check state for choices
    if state and hasattr(state, "choices"):
        state_choices = state.choices or []
        for choice in state_choices:
            if isinstance(choice, dict):
                choices.append(choice)
            elif isinstance(choice, str):
                choices.append({"label": choice, "value": choice})

    if not choices:
        return ProviderResult(
            text="",
            values={
                "hasChoices": False,
                "choiceCount": 0,
            },
            data={
                "choices": [],
            },
        )

    formatted_choices = "\n".join(
        format_choice(i, choice) for i, choice in enumerate(choices)
    )

    text = f"# Available Choices\n{formatted_choices}"

    return ProviderResult(
        text=text,
        values={
            "hasChoices": True,
            "choiceCount": len(choices),
            "choiceLabels": [c.get("label", "") for c in choices],
        },
        data={
            "choices": choices,
        },
    )


# Create the provider instance
choice_provider = Provider(
    name="CHOICE",
    description="Available choice options for selection",
    get=get_choice_options,
    dynamic=True,
)


