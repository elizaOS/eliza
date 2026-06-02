"""Scenario expansion helpers for Vending-Bench."""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import date
from decimal import Decimal
from typing import Callable

from elizaos_vending_bench.types import VendingBenchConfig


@dataclass(frozen=True)
class EdgeVariant:
    """A deterministic operational variant for a base vending run."""

    variant_id: str
    description: str
    apply: Callable[[VendingBenchConfig], VendingBenchConfig]


def _with(config: VendingBenchConfig, **updates: object) -> VendingBenchConfig:
    return replace(config, include_edge_scenarios=False, **updates)


EDGE_VARIANTS: tuple[EdgeVariant, ...] = (
    EdgeVariant(
        "low_cash_launch",
        "Launch with thin working capital and seeded inventory.",
        lambda c: _with(
            c,
            initial_cash=min(c.initial_cash, Decimal("180.00")),
            starter_inventory=True,
            daily_base_fee=max(c.daily_base_fee, Decimal("3.00")),
        ),
    ),
    EdgeVariant(
        "summer_heat_wave",
        "Mid-summer start date with starter inventory for beverage demand.",
        lambda c: _with(c, start_date=date(2026, 7, 15), starter_inventory=True),
    ),
    EdgeVariant(
        "winter_lobby",
        "Winter office lobby traffic with stocked snacks and warm-drink substitutes absent.",
        lambda c: _with(c, start_date=date(2026, 1, 12), starter_inventory=True),
    ),
    EdgeVariant(
        "high_rent_location",
        "Higher fixed daily fee in a premium location.",
        lambda c: _with(
            c,
            location="Downtown Co-working Lobby",
            daily_base_fee=max(c.daily_base_fee, Decimal("7.50")),
        ),
    ),
    EdgeVariant(
        "slot_fee_pressure",
        "Per-slot maintenance costs make oversized assortments expensive.",
        lambda c: _with(c, slot_fee=max(c.slot_fee, Decimal("0.25"))),
    ),
    EdgeVariant(
        "small_machine",
        "Compact machine with fewer facings and lower replenishment margin for error.",
        lambda c: _with(c, machine_rows=3, machine_columns=2, starter_inventory=True),
    ),
    EdgeVariant(
        "large_machine",
        "Larger machine that rewards broader assortment planning.",
        lambda c: _with(c, machine_rows=5, machine_columns=4),
    ),
    EdgeVariant(
        "one_action_days",
        "Very limited daily action budget forces prioritization.",
        lambda c: _with(c, max_actions_per_day=1),
    ),
    EdgeVariant(
        "campus_gym",
        "Gym-adjacent campus traffic with health-oriented demand assumptions.",
        lambda c: _with(
            c,
            location="Campus Recreation Center",
            start_date=date(2026, 4, 6),
            starter_inventory=True,
        ),
    ),
    EdgeVariant(
        "longer_horizon",
        "Longer operating horizon with the same base capital.",
        lambda c: _with(c, max_days_per_run=c.max_days_per_run + 2),
    ),
)


def expanded_run_configs(
    config: VendingBenchConfig,
) -> list[tuple[str, int, VendingBenchConfig]]:
    """Return ``(run_id_suffix, base_run_idx, config)`` tuples for execution."""

    base = replace(config, include_edge_scenarios=False)
    scenarios: list[tuple[str, int, VendingBenchConfig]] = [
        ("base", run_idx, base) for run_idx in range(config.num_runs)
    ]
    if not config.include_edge_scenarios:
        return scenarios

    for run_idx in range(config.num_runs):
        for variant in EDGE_VARIANTS:
            scenarios.append((variant.variant_id, run_idx, variant.apply(base)))
    return scenarios


def count_scenarios(config: VendingBenchConfig) -> dict[str, int]:
    base = max(0, int(config.num_runs))
    edge = base * len(EDGE_VARIANTS) if config.include_edge_scenarios else 0
    return {"base": base, "edge": edge, "total": base + edge}


def validate_scenarios(config: VendingBenchConfig) -> None:
    if config.num_runs < 0:
        raise ValueError("num_runs must be non-negative")
    if config.max_days_per_run < 1:
        raise ValueError("max_days_per_run must be at least 1")
    if config.initial_cash <= 0:
        raise ValueError("initial_cash must be positive")
    if config.max_actions_per_day < 1:
        raise ValueError("max_actions_per_day must be at least 1")
    if config.machine_rows < 1 or config.machine_columns < 1:
        raise ValueError("machine dimensions must be positive")

    if config.include_edge_scenarios:
        seen: set[str] = set()
        for variant in EDGE_VARIANTS:
            if variant.variant_id in seen:
                raise ValueError(f"duplicate edge variant id: {variant.variant_id}")
            seen.add(variant.variant_id)
            edge_config = variant.apply(config)
            validate_scenarios(replace(edge_config, include_edge_scenarios=False))
