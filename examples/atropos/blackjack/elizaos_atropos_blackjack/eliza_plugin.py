"""
Canonical ElizaOS integration for Atropos Blackjack.

This provides a provider + action pair so the agent can make decisions via the
full ElizaOS message pipeline:

- providers → compose_state()
- message_service.handle_message()
- action selection + params via XML
- action execution via runtime.process_actions()

The action handler stores the chosen BlackjackAction in an in-memory context
for retrieval by the calling agent.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from elizaos.types import (
    ActionParameterSchema,
    Character,
    Plugin,
    ProviderResult,
)

from elizaos_atropos_blackjack.types import BlackjackAction, BlackjackState

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
class BlackjackDecisionContext:
    state: BlackjackState
    chosen: BlackjackAction | None = None


BLACKJACK_STORE: ContextStore[BlackjackDecisionContext] = ContextStore()


def set_blackjack_context(ctx: BlackjackDecisionContext | None) -> None:
    BLACKJACK_STORE.set(ctx)


def get_blackjack_context() -> BlackjackDecisionContext | None:
    return BLACKJACK_STORE.get()


def create_blackjack_provider() -> Provider:
    def render(ctx: BlackjackDecisionContext) -> ProviderResult:
        s = ctx.state
        dealer_card = "A" if s.dealer_card == 1 else str(s.dealer_card)
        ace_info = "usable_ace=true" if s.usable_ace else "usable_ace=false"

        text = (
            "# Atropos Blackjack\n"
            f"- player_sum: {s.player_sum}\n"
            f"- dealer_card: {dealer_card}\n"
            f"- {ace_info}\n"
            "\n"
            "## Allowed actions\n"
            "- HIT\n"
            "- STAND\n"
        )

        return ProviderResult(
            text=text,
            values={"hasBlackjack": True},
            data={
                "player_sum": int(s.player_sum),
                "dealer_card": int(s.dealer_card),
                "usable_ace": bool(s.usable_ace),
            },
        )

    return create_provider_from_store(
        name="ATROPOS_BLACKJACK",
        description="Provides Atropos blackjack state and allowed actions.",
        store=BLACKJACK_STORE,
        render=render,
        position=-10,
    )


def create_blackjack_action() -> Action:
    def apply_param(ctx: BlackjackDecisionContext, raw: str) -> CaptureActionResponse:
        normalized = raw.strip().upper()
        if normalized in ("HIT", "1"):
            ctx.chosen = BlackjackAction.HIT
        elif normalized in ("STAND", "STICK", "0"):
            ctx.chosen = BlackjackAction.STICK
        else:
            return err_capture(f"Invalid blackjack action: {raw}")

        chosen = ctx.chosen
        return ok_capture(
            values={"action": "HIT" if chosen == BlackjackAction.HIT else "STAND"},
            data={"actionName": "ATROPOS_BLACKJACK_ACTION", "action": normalized},
            text=f"Chose blackjack action: {normalized}",
        )

    return create_capture_action_from_store(
        name="ATROPOS_BLACKJACK_ACTION",
        description="Select the next blackjack action. Use params.action = HIT or STAND.",
        store=BLACKJACK_STORE,
        param_name="action",
        schema=ActionParameterSchema(type="string", enum=["HIT", "STAND"]),
        apply_param=apply_param,
    )


def create_blackjack_character(name: str = "BlackjackAgent") -> Character:
    template = create_action_only_template(
        task="Choose the next blackjack action for {{agentName}}.",
        instructions=(
            "You must choose ONE action from the allowed actions.\n\n"
            "CRITICAL:\n"
            "- Output ONLY one ElizaOS action: ATROPOS_BLACKJACK_ACTION\n"
            "- Put the chosen action in params.action as either HIT or STAND"
        ),
        action_name="ATROPOS_BLACKJACK_ACTION",
        param_name="action",
        param_placeholder="HIT|STAND",
    )

    return create_basic_character(
        name=name,
        bio=[
            "A blackjack decision policy.",
            "Chooses HIT or STAND based on the provided game state.",
        ],
        system="You are a blackjack decision policy. Be concise and follow the output format.",
        template=template,
    )


def get_blackjack_eliza_plugin() -> Plugin:
    return create_simple_plugin(
        name="atropos-blackjack",
        description="Atropos blackjack canonical provider/action integration.",
        providers=[create_blackjack_provider()],
        actions=[create_blackjack_action()],
    )

