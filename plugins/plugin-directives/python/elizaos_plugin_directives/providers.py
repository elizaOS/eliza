"""DirectiveStateProvider - exposes current directive state to the agent."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from elizaos_plugin_directives.parsers import format_directive_state, parse_all_directives
from elizaos_plugin_directives.types import DirectiveState


@dataclass(frozen=True)
class ProviderResult:
    """Standard provider return value."""

    values: dict[str, Any]
    text: str
    data: dict[str, Any]


class DirectiveStateProvider:
    """Provider that exposes current directive state to the agent.

    On each call it parses the message text for inline directives, builds a
    :class:`DirectiveState` from the parsed values, and returns it as
    structured data alongside a human-readable summary.
    """

    @property
    def name(self) -> str:
        return "DIRECTIVE_STATE"

    @property
    def description(self) -> str:
        return "Current directive levels (thinking, verbose, model, etc.)"

    @property
    def position(self) -> int:
        return 10

    async def get(
        self,
        message: dict[str, Any],
        _state: dict[str, Any] | None = None,
    ) -> ProviderResult:
        text = ""
        content = message.get("content")
        if isinstance(content, dict):
            text = content.get("text", "")

        directives = parse_all_directives(text)

        state = DirectiveState(
            thinking=directives.think or "off",
            verbose=directives.verbose or "off",
            reasoning=directives.reasoning or "off",
            elevated=directives.elevated or "off",
            exec=directives.exec or DirectiveState().exec,
            model=directives.model or DirectiveState().model,
        )

        display = format_directive_state(state)

        return ProviderResult(
            values={
                "thinkingLevel": state.thinking,
                "verboseLevel": state.verbose,
                "reasoningLevel": state.reasoning,
                "elevatedLevel": state.elevated,
                "isElevated": state.elevated != "off",
                "modelProvider": state.model.provider or "",
                "modelName": state.model.model or "",
            },
            text=display,
            data={"directives": state.to_dict()},
        )
