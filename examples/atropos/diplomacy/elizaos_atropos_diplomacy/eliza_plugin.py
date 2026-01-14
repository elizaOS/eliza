"""
Canonical ElizaOS integration for Atropos Diplomacy.

Provides:
- ATROPOS_DIPLOMACY provider with current board summary for a given power
- ATROPOS_DIPLOMACY_ORDERS action that stores an orders text block in context
- Character template forcing action selection via params.orders
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from elizaos.types import ActionParameterSchema, Character, Plugin, ProviderResult

from elizaos_atropos_diplomacy.types import GameState, Power

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
class DiplomacyDecisionContext:
    state: GameState
    power: Power
    orders_text: str | None = None


DIPLOMACY_STORE: ContextStore[DiplomacyDecisionContext] = ContextStore()


def set_diplomacy_context(ctx: DiplomacyDecisionContext | None) -> None:
    DIPLOMACY_STORE.set(ctx)


def get_diplomacy_context() -> DiplomacyDecisionContext | None:
    return DIPLOMACY_STORE.get()


def create_diplomacy_provider() -> Provider:
    def render(ctx: DiplomacyDecisionContext) -> ProviderResult:
        s = ctx.state
        p = ctx.power
        ps = s.powers[p]

        units_str = "\n".join(f"- {u}" for u in ps.units) if ps.units else "- (none)"
        centers_str = ", ".join(ps.supply_centers) if ps.supply_centers else "(none)"

        others = []
        for other_power, other_state in s.powers.items():
            if other_power != p and not other_state.is_eliminated:
                others.append(f"- {other_power.full_name}: {other_state.center_count} centers, {other_state.unit_count} units")
        others_str = "\n".join(others) if others else "- (none)"

        text = (
            "# Atropos Diplomacy\n"
            f"- you_are: {p.full_name}\n"
            f"- phase: {s.phase.value}\n"
            f"- phase_name: {s.phase_name}\n"
            "\n"
            "## Your units\n"
            f"{units_str}\n\n"
            f"## Your supply centers ({ps.center_count})\n"
            f"{centers_str}\n\n"
            "## Other powers\n"
            f"{others_str}\n\n"
            "Return orders, one per line, in the same format as the CLI examples.\n"
        )

        return ProviderResult(
            text=text,
            values={"hasDiplomacy": True, "power": p.value, "phase": s.phase.value},
            data={"power": p.value, "phase": s.phase.value},
        )

    return create_provider_from_store(
        name="ATROPOS_DIPLOMACY",
        description="Provides Diplomacy board state for the acting power.",
        store=DIPLOMACY_STORE,
        render=render,
        position=-10,
    )


def create_diplomacy_orders_action() -> Action:
    def apply_param(ctx: DiplomacyDecisionContext, raw: str) -> CaptureActionResponse:
        orders = raw.strip()
        if not orders:
            return err_capture("Missing orders")
        ctx.orders_text = orders
        return ok_capture(values={"orders": orders}, data={"actionName": "ATROPOS_DIPLOMACY_ORDERS"})

    return create_capture_action_from_store(
        name="ATROPOS_DIPLOMACY_ORDERS",
        description="Submit all orders for the current power as a newline-separated block.",
        store=DIPLOMACY_STORE,
        param_name="orders",
        schema=ActionParameterSchema(type="string"),
        apply_param=apply_param,
    )


def create_diplomacy_character(name: str = "DiplomacyAgent") -> Character:
    template = create_action_only_template(
        task="Choose orders for {{agentName}} in Diplomacy.",
        instructions=(
            "Decide orders for ALL of your units. Output ONLY one ElizaOS action: ATROPOS_DIPLOMACY_ORDERS.\n"
            "Put the newline-separated order block into params.orders."
        ),
        action_name="ATROPOS_DIPLOMACY_ORDERS",
        param_name="orders",
        param_placeholder="ONE ORDER PER LINE",
    )

    return create_basic_character(
        name=name,
        bio=["A Diplomacy agent.", "Outputs orders for all controlled units."],
        system="You are a Diplomacy agent. Follow the output format exactly.",
        template=template,
    )


def get_diplomacy_eliza_plugin() -> Plugin:
    return create_simple_plugin(
        name="atropos-diplomacy",
        description="Atropos Diplomacy canonical provider/action integration.",
        providers=[create_diplomacy_provider()],
        actions=[create_diplomacy_orders_action()],
    )

