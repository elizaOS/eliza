"""
Canonical ElizaOS integration for Atropos TextWorld.

Provides:
- ATROPOS_TEXTWORLD provider with current observation + admissible commands
- ATROPOS_TEXTWORLD_ACTION action that stores the selected command in context
- A character template forcing the model to select the action with params.command
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from elizaos.types import ActionParameterSchema, Character, Plugin, ProviderResult

from elizaos_atropos_textworld.types import GameState

if TYPE_CHECKING:
    from elizaos.types import Action, Provider


from elizaos_atropos_shared.canonical_eliza import (
    ContextStore,
    CaptureActionResponse,
    create_action_only_template,
    create_basic_character,
    create_capture_action_from_store,
    create_provider_from_store,
    create_simple_plugin,
    err_capture,
    ok_capture,
)


@dataclass
class TextWorldDecisionContext:
    state: GameState
    chosen_command: str | None = None


TEXTWORLD_STORE: ContextStore[TextWorldDecisionContext] = ContextStore()


def set_textworld_context(ctx: TextWorldDecisionContext | None) -> None:
    TEXTWORLD_STORE.set(ctx)


def get_textworld_context() -> TextWorldDecisionContext | None:
    return TEXTWORLD_STORE.get()


def create_textworld_provider() -> Provider:
    def render(ctx: TextWorldDecisionContext) -> ProviderResult:
        s = ctx.state
        cmds = s.admissible_commands[:50]
        cmd_lines = "\n".join(f"- {c}" for c in cmds)

        text = (
            "# Atropos TextWorld\n"
            f"## Location\n{s.description}\n\n"
            f"## Inventory\n{s.inventory_str}\n\n"
            f"## Progress\nscore={s.score}/{s.max_score} step={s.steps}/{s.max_steps}\n\n"
            "## Admissible commands (choose one)\n"
            f"{cmd_lines}\n"
        )

        return ProviderResult(
            text=text,
            values={"hasTextWorld": True},
            data={
                "score": int(s.score),
                "max_score": int(s.max_score),
                "steps": int(s.steps),
                "max_steps": int(s.max_steps),
            },
        )

    return create_provider_from_store(
        name="ATROPOS_TEXTWORLD",
        description="Provides Atropos TextWorld observation and admissible commands.",
        store=TEXTWORLD_STORE,
        render=render,
        position=-10,
    )


def create_textworld_action() -> Action:
    def apply_param(ctx: TextWorldDecisionContext, raw: str) -> CaptureActionResponse:
        cmd = raw.strip()
        if not cmd:
            return err_capture("Missing command")
        ctx.chosen_command = cmd
        return ok_capture(
            values={"command": cmd},
            data={"actionName": "ATROPOS_TEXTWORLD_ACTION", "command": cmd},
            text=f"Chose textworld command: {cmd}",
        )

    return create_capture_action_from_store(
        name="ATROPOS_TEXTWORLD_ACTION",
        description="Select the next TextWorld command. Use params.command exactly as listed.",
        store=TEXTWORLD_STORE,
        param_name="command",
        schema=ActionParameterSchema(type="string"),
        apply_param=apply_param,
    )


def create_textworld_character(name: str = "TextWorldAgent") -> Character:
    template = create_action_only_template(
        task="Choose the next TextWorld command for {{agentName}}.",
        instructions=(
            "Choose exactly ONE admissible command from the list.\n"
            "Output ONLY one ElizaOS action: ATROPOS_TEXTWORLD_ACTION with params.command."
        ),
        action_name="ATROPOS_TEXTWORLD_ACTION",
        param_name="command",
        param_placeholder="one admissible command",
    )

    return create_basic_character(
        name=name,
        bio=[
            "A text-adventure agent for a simplified TextWorld environment.",
            "Chooses admissible commands to find treasure efficiently.",
        ],
        system="You are a text adventure agent. Follow the output format exactly.",
        template=template,
    )


def get_textworld_eliza_plugin() -> Plugin:
    return create_simple_plugin(
        name="atropos-textworld",
        description="Atropos TextWorld canonical provider/action integration.",
        providers=[create_textworld_provider()],
        actions=[create_textworld_action()],
    )

