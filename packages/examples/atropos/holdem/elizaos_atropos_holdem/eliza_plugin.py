"""
Canonical ElizaOS integration for Atropos Texas Hold'em.

Provides:
- ATROPOS_HOLDEM provider with the current table state + valid actions
- ATROPOS_HOLDEM_ACTION to select an action (FOLD/CHECK/CALL/RAISE/ALL_IN)
- Character template forcing action selection via params.action
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from elizaos.types import ActionParameterSchema, Character, Plugin, ProviderResult

from elizaos_atropos_holdem.types import GameState

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
class HoldemDecisionContext:
    state: GameState
    position: int
    chosen: str | None = None


HOLDEM_STORE: ContextStore[HoldemDecisionContext] = ContextStore()


def set_holdem_context(ctx: HoldemDecisionContext | None) -> None:
    HOLDEM_STORE.set(ctx)


def get_holdem_context() -> HoldemDecisionContext | None:
    return HOLDEM_STORE.get()


def create_holdem_provider() -> Provider:
    def render(ctx: HoldemDecisionContext) -> ProviderResult:
        s = ctx.state
        p = s.get_player(ctx.position)
        valid = s.get_valid_actions()
        actions_str = "\n".join(f"- {a}" for a in valid)

        hole = "None"
        if p.hole_cards is not None:
            hole = f"{p.hole_cards[0]} {p.hole_cards[1]}"
        board = " ".join(str(c) for c in s.community_cards) if s.community_cards else "None"

        to_call = s.current_bet - p.bet_this_round

        text = (
            "# Atropos Holdem\n"
            f"- phase: {s.phase.value}\n"
            f"- pot: {s.pot}\n"
            f"- stack: {p.stack}\n"
            f"- to_call: {to_call}\n"
            f"- hole_cards: {hole}\n"
            f"- board: {board}\n"
            "\n"
            "## Valid actions\n"
            f"{actions_str}\n"
            "\n"
            "Choose one of: FOLD, CHECK, CALL, RAISE, ALL_IN.\n"
        )

        return ProviderResult(
            text=text,
            values={"hasHoldem": True},
            data={"phase": s.phase.value, "pot": float(s.pot), "to_call": float(to_call)},
        )

    return create_provider_from_store(
        name="ATROPOS_HOLDEM",
        description="Provides Holdem state and valid actions for decision-making.",
        store=HOLDEM_STORE,
        render=render,
        position=-10,
    )


def create_holdem_action() -> Action:
    def apply_param(ctx: HoldemDecisionContext, raw: str) -> CaptureActionResponse:
        act = raw.strip().upper()
        if act not in ("FOLD", "CHECK", "CALL", "RAISE", "ALL_IN"):
            return err_capture(f"Invalid holdem action: {raw}")
        ctx.chosen = act
        return ok_capture(values={"action": act}, data={"actionName": "ATROPOS_HOLDEM_ACTION"})

    return create_capture_action_from_store(
        name="ATROPOS_HOLDEM_ACTION",
        description="Select the next holdem action (FOLD/CHECK/CALL/RAISE/ALL_IN).",
        store=HOLDEM_STORE,
        param_name="action",
        schema=ActionParameterSchema(type="string", enum=["FOLD", "CHECK", "CALL", "RAISE", "ALL_IN"]),
        apply_param=apply_param,
    )


def create_holdem_character(name: str = "HoldemAgent") -> Character:
    template = create_action_only_template(
        task="Choose the next Holdem action for {{agentName}}.",
        instructions=(
            "Choose ONE action. Output ONLY one ElizaOS action: ATROPOS_HOLDEM_ACTION.\n"
            "Put the choice in params.action as one of: FOLD, CHECK, CALL, RAISE, ALL_IN."
        ),
        action_name="ATROPOS_HOLDEM_ACTION",
        param_name="action",
        param_placeholder="FOLD|CHECK|CALL|RAISE|ALL_IN",
    )

    return create_basic_character(
        name=name,
        bio=["A poker agent for Texas Hold'em.", "Chooses actions from the valid action set."],
        system="You are a poker decision policy. Follow the output format exactly.",
        template=template,
    )


def get_holdem_eliza_plugin() -> Plugin:
    return create_simple_plugin(
        name="atropos-holdem",
        description="Atropos Holdem canonical provider/action integration.",
        providers=[create_holdem_provider()],
        actions=[create_holdem_action()],
    )

