"""
Full Game Simulation with Constant-Product AMM

Simulates a 30-day game (720 ticks) with diverse NPCs trading
through a real x*y=k AMM to verify emergent price behavior.
"""

import math
import random
from dataclasses import dataclass, field
from typing import Literal

import pytest

# =============================================================================
# Replicate AMM from markets.ts
# =============================================================================

INITIAL_BASE_RESERVE = 5000


def get_reserves(initial_price, net_holdings, base_reserve=INITIAL_BASE_RESERVE):
    init_quote = base_reserve * initial_price
    k = base_reserve * init_quote
    current_quote = max(init_quote + net_holdings, 1.0)
    current_base = k / current_quote
    return current_base, current_quote, current_quote / current_base


def price_from_holdings(initial_price, net_holdings):
    _, _, spot = get_reserves(initial_price, net_holdings)
    return spot


# =============================================================================
# Simulation Types
# =============================================================================


@dataclass
class SimNPC:
    id: str
    strategy: Literal["trend", "contrarian", "random"]
    balance: float = 10_000.0


@dataclass
class SimMarket:
    ticker: str
    initial_price: float
    net_holdings: float = 0.0
    price_history: list = field(default_factory=list)

    @property
    def current_price(self) -> float:
        return price_from_holdings(self.initial_price, self.net_holdings)

    def record(self, tick: int):
        self.price_history.append({"tick": tick, "price": self.current_price})


# =============================================================================
# NPC Decision Simulation
# =============================================================================


def npc_decide(npc, market, rng):
    if rng.random() > 0.6:
        return None  # Hold

    price_ratio = market.current_price / market.initial_price

    # Close existing exposure ~30% of the time (prevents unbounded accumulation)
    if abs(market.net_holdings) > 20_000 and rng.random() < 0.3:
        close_size = min(abs(market.net_holdings) * 0.2, npc.balance * 0.1)
        if market.net_holdings > 0:
            return {"side": "short", "amount": close_size}
        else:
            return {"side": "long", "amount": close_size}

    # Strategy
    if npc.strategy == "contrarian":
        side = (
            "short"
            if price_ratio > 1.2
            else "long"
            if price_ratio < 0.8
            else ("short" if rng.random() > 0.5 else "long")
        )
    elif npc.strategy == "trend":
        if len(market.price_history) >= 2:
            delta = market.price_history[-1]["price"] - market.price_history[-2]["price"]
            side = (
                "long"
                if delta > 0
                else "short"
                if delta < 0
                else ("long" if rng.random() > 0.5 else "short")
            )
        else:
            side = "long" if rng.random() > 0.5 else "short"
    else:
        if rng.random() > 0.6:
            return None
        side = "long" if rng.random() > 0.5 else "short"

    amount = min(npc.balance * rng.uniform(0.03, 0.12), 2000)
    if amount < 10 or npc.balance < 100:
        return None
    return {"side": side, "amount": amount}


def execute(decision, npc, market):
    size = decision["amount"] * 5  # 5x leverage
    if decision["side"] == "long":
        market.net_holdings += size
        npc.balance -= decision["amount"]
    else:
        market.net_holdings -= size
        npc.balance -= decision["amount"]


# =============================================================================
# Full Simulation
# =============================================================================


def run_simulation(initial_price=200.0, num_npcs=12, num_ticks=720, seed=42):
    rng = random.Random(seed)
    market = SimMarket(ticker="TSLAI", initial_price=initial_price)
    market.record(0)

    strategies = ["trend"] * 4 + ["contrarian"] * 4 + ["random"] * 4
    npcs = [
        SimNPC(id=f"npc-{i}", strategy=strategies[i % len(strategies)]) for i in range(num_npcs)
    ]

    for tick in range(1, num_ticks + 1):
        for npc in npcs:
            dec = npc_decide(npc, market, rng)
            if dec:
                execute(dec, npc, market)
        market.record(tick)

    return market


# =============================================================================
# Analysis
# =============================================================================


def detect_sawtooth(prices, threshold=0.03):
    if len(prices) < 20:
        return False
    reversals = 0
    big_moves = 0
    for i in range(2, len(prices)):
        d1 = prices[i - 1] - prices[i - 2]
        d2 = prices[i] - prices[i - 1]
        if d1 * d2 < 0:
            reversals += 1
        if abs(d2) / prices[i - 1] > threshold:
            big_moves += 1
    r_rate = reversals / (len(prices) - 2)
    m_rate = big_moves / (len(prices) - 1)
    return r_rate > 0.6 and m_rate > 0.3


def max_drawdown(prices):
    peak = prices[0]
    dd = 0
    for p in prices:
        peak = max(peak, p)
        dd = max(dd, (peak - p) / peak if peak > 0 else 0)
    return dd


# =============================================================================
# Tests
# =============================================================================


class TestFullGame:
    @pytest.fixture(scope="class")
    def sim(self):
        return run_simulation()

    def test_price_always_positive(self, sim):
        for h in sim.price_history:
            assert h["price"] > 0

    def test_no_sawtooth(self, sim):
        prices = [h["price"] for h in sim.price_history]
        assert not detect_sawtooth(prices)

    def test_no_tick_exceeds_50pct(self, sim):
        prices = [h["price"] for h in sim.price_history]
        for i in range(1, len(prices)):
            if prices[i - 1] > 0:
                chg = abs(prices[i] - prices[i - 1]) / prices[i - 1]
                assert chg < 0.50, f"Tick {i}: {chg * 100:.1f}% single-tick move"

    def test_correct_tick_count(self, sim):
        assert len(sim.price_history) == 721


class TestMultiSeed:
    @pytest.mark.parametrize("seed", [1, 42, 100, 999, 12345])
    def test_no_sawtooth(self, seed):
        sim = run_simulation(seed=seed, num_ticks=200)
        prices = [h["price"] for h in sim.price_history]
        assert not detect_sawtooth(prices)

    @pytest.mark.parametrize("seed", [1, 42, 100, 999, 12345])
    def test_price_always_positive(self, seed):
        sim = run_simulation(seed=seed, num_ticks=200)
        assert all(h["price"] > 0 for h in sim.price_history)


class TestStress:
    def test_20_npcs_all_buy(self):
        """AMM absorbs even extreme one-sided pressure."""
        price = price_from_holdings(200, 20 * 10_000)
        assert price > 200
        assert price < 200 * 50  # Bounded by math

    def test_20_npcs_all_sell(self):
        """$200K net short on $200 asset with 5000 base reserve."""
        price = price_from_holdings(200, -20 * 10_000)
        assert price < 200
        assert price > 0  # Never zero (AMM math guarantees positive)

    def test_extreme_buy_doesnt_overflow(self):
        price = price_from_holdings(200, 10_000_000)
        assert math.isfinite(price)
        assert price > 0


class TestChart:
    def test_print_chart(self, capsys):
        sim = run_simulation()
        prices = [h["price"] for h in sim.price_history]
        daily = [prices[i] for i in range(0, len(prices), 24)]
        lo, hi = min(daily), max(daily)

        print(f"\n{'=' * 60}")
        print(f"  AMM PRICE CHART: {sim.ticker} (30-day sim)")
        print(f"  Initial: ${sim.initial_price:.0f} | Final: ${sim.current_price:.2f}")
        print(f"  Min: ${lo:.2f} | Max: ${hi:.2f}")
        print(f"  Net holdings: ${sim.net_holdings:,.0f}")
        print(f"{'=' * 60}")
        for day, p in enumerate(daily):
            w = 50
            pos = int((p - lo) / (hi - lo) * w) if hi > lo else w // 2
            print(f"  Day {day:2d} | ${p:8.2f} |{' ' * pos}█")
        print(f"{'=' * 60}")
        dd = max_drawdown(prices)
        ret = (prices[-1] - prices[0]) / prices[0]
        print(f"  Return: {ret * 100:+.1f}% | Max DD: {dd * 100:.1f}%")
        print(f"  Sawtooth: {detect_sawtooth(prices)}")
        print(f"{'=' * 60}")

        assert not detect_sawtooth(prices)
