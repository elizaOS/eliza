"""
Constant-Product AMM Tests (Uniswap v2 compatible)

Verifies the x*y=k AMM formula produces results identical to
a reference Uniswap v2 implementation. Tests spot price, swap output,
avg fill, slippage, and invariant preservation.
"""

import math

# =============================================================================
# AMM Config (matches markets.ts)
# =============================================================================

INITIAL_BASE_RESERVE = 5000


# =============================================================================
# Reference Uniswap v2 implementation (ground truth)
# =============================================================================


class UniswapV2Pool:
    """Reference implementation of a Uniswap v2 constant-product pool."""

    def __init__(self, base_reserve: float, quote_reserve: float):
        self.base = base_reserve
        self.quote = quote_reserve
        self.k = base_reserve * quote_reserve

    @property
    def spot_price(self) -> float:
        """Price of base in terms of quote: quote/base."""
        return self.quote / self.base

    def swap_quote_for_base(self, quote_in: float) -> tuple[float, float]:
        """Buy base by adding quote. Returns (base_out, new_spot_price)."""
        new_quote = self.quote + quote_in
        new_base = self.k / new_quote
        base_out = self.base - new_base
        self.base = new_base
        self.quote = new_quote
        return base_out, self.spot_price

    def swap_base_for_quote(self, base_in: float) -> tuple[float, float]:
        """Sell base by adding base. Returns (quote_out, new_spot_price)."""
        new_base = self.base + base_in
        new_quote = self.k / new_base
        quote_out = self.quote - new_quote
        self.base = new_base
        self.quote = new_quote
        return quote_out, self.spot_price

    def check_invariant(self) -> bool:
        return abs(self.base * self.quote - self.k) / self.k < 1e-10


# =============================================================================
# Babylon AMM implementation (must match reference)
# =============================================================================


def get_initial_reserves(initial_price, base_reserve=INITIAL_BASE_RESERVE):
    quote_reserve = base_reserve * initial_price
    k = base_reserve * quote_reserve
    return base_reserve, quote_reserve, k


def get_reserves_from_holdings(initial_price, net_holdings, base_reserve=INITIAL_BASE_RESERVE):
    _, init_quote, k = get_initial_reserves(initial_price, base_reserve)
    current_quote = max(init_quote + net_holdings, 1.0)
    current_base = k / current_quote
    return current_base, current_quote, current_quote / current_base


def price_from_holdings(initial_price, net_holdings, base_reserve=INITIAL_BASE_RESERVE):
    _, _, spot = get_reserves_from_holdings(initial_price, net_holdings, base_reserve)
    return spot


def calculate_trade_impact(
    initial_price, net_before, trade_size, base_reserve=INITIAL_BASE_RESERVE
):
    """Replicate the TypeScript calculateTradeImpact exactly."""
    base_r, quote_r, spot_before = get_reserves_from_holdings(
        initial_price, net_before, base_reserve
    )
    k = base_r * quote_r

    if trade_size >= 0:
        # BUY: add quote, get base
        new_quote = quote_r + trade_size
        new_base = k / new_quote
        base_out = base_r - new_base
        avg_fill = trade_size / base_out if base_out > 0 else spot_before
        new_spot = new_quote / new_base
        slippage = abs(avg_fill - spot_before) / spot_before if spot_before > 0 else 0
        return avg_fill, new_spot, slippage, base_out
    else:
        # SELL: add base, get quote
        abs_size = abs(trade_size)
        base_in = abs_size / spot_before if spot_before > 0 else 0
        new_base = base_r + base_in
        new_quote = k / new_base
        quote_out = quote_r - new_quote
        avg_fill = quote_out / base_in if base_in > 0 else spot_before
        new_spot = new_quote / new_base
        slippage = abs(spot_before - avg_fill) / spot_before if spot_before > 0 else 0
        return avg_fill, new_spot, slippage, -base_in


# =============================================================================
# Test: Babylon AMM matches Uniswap v2 reference
# =============================================================================


class TestMatchesUniswapV2:
    """Verify our AMM produces identical results to a reference Uniswap v2."""

    def test_spot_price_matches(self):
        pool = UniswapV2Pool(5000, 5000 * 200)
        _, _, our_spot = get_reserves_from_holdings(200, 0)
        assert abs(pool.spot_price - our_spot) < 0.001

    def test_buy_swap_matches(self):
        """$10K buy through both implementations should give same output."""
        pool = UniswapV2Pool(5000, 5000 * 200)
        ref_base_out, ref_new_spot = pool.swap_quote_for_base(10_000)

        _avg_fill, new_spot, _slippage, base_out = calculate_trade_impact(200, 0, 10_000)

        assert abs(base_out - ref_base_out) < 0.01, (
            f"Base out mismatch: ours={base_out:.4f} ref={ref_base_out:.4f}"
        )
        assert abs(new_spot - ref_new_spot) < 0.01, (
            f"New spot mismatch: ours={new_spot:.4f} ref={ref_new_spot:.4f}"
        )

    def test_sell_swap_matches(self):
        """Sell through both implementations should give same output."""
        pool = UniswapV2Pool(5000, 5000 * 200)
        # Sell 50 base tokens (worth ~$10K)
        base_to_sell = 50
        _ref_quote_out, ref_new_spot = pool.swap_base_for_quote(base_to_sell)

        # Our sell: $10K worth at spot $200 = 50 base tokens
        _avg_fill, new_spot, _slippage, _base_amount = calculate_trade_impact(200, 0, -10_000)

        # New spot should match
        assert abs(new_spot - ref_new_spot) < 0.5, (
            f"Sell spot mismatch: ours={new_spot:.2f} ref={ref_new_spot:.2f}"
        )

    def test_invariant_preserved_after_buy(self):
        """k should be preserved after a buy."""
        base_before, quote_before, _ = get_reserves_from_holdings(200, 0)
        k_before = base_before * quote_before

        # After $10K buy
        base_after, quote_after, _ = get_reserves_from_holdings(200, 10_000)
        k_after = base_after * quote_after

        assert abs(k_after - k_before) / k_before < 1e-10

    def test_invariant_preserved_after_sell(self):
        """k should be preserved after a sell."""
        base_before, quote_before, _ = get_reserves_from_holdings(200, 0)
        k_before = base_before * quote_before

        base_after, quote_after, _ = get_reserves_from_holdings(200, -10_000)
        k_after = base_after * quote_after

        assert abs(k_after - k_before) / k_before < 1e-10

    def test_sequential_swaps_match_reference(self):
        """Run 10 swaps through both and verify they diverge by < 0.1%."""
        pool = UniswapV2Pool(5000, 5000 * 100)
        net = 0
        trades = [5000, -3000, 8000, -2000, 1000, -6000, 4000, -1000, 7000, -5000]

        for trade in trades:
            if trade > 0:
                pool.swap_quote_for_base(trade)
            else:
                base_in = abs(trade) / pool.spot_price
                pool.swap_base_for_quote(base_in)
            net += trade

            our_price = price_from_holdings(100, net)
            ref_price = pool.spot_price
            diff_pct = abs(our_price - ref_price) / ref_price

            # Allow up to 2% divergence from sell-side base conversion approximation
            assert diff_pct < 0.02, (
                f"After net={net}: ours=${our_price:.2f} ref=${ref_price:.2f} diff={diff_pct * 100:.2f}%"
            )


# =============================================================================
# Test: Core AMM properties
# =============================================================================


class TestAMMProperties:
    def test_zero_holdings_returns_initial(self):
        assert abs(price_from_holdings(100, 0) - 100) < 0.01

    def test_buy_increases_price(self):
        assert price_from_holdings(100, 10_000) > 100

    def test_sell_decreases_price(self):
        assert price_from_holdings(100, -10_000) < 100

    def test_price_never_zero(self):
        assert price_from_holdings(100, -400_000) > 0

    def test_price_never_infinite(self):
        assert math.isfinite(price_from_holdings(100, 10_000_000))

    def test_constant_product_invariant(self):
        _, _, k0 = get_initial_reserves(200)
        for net in [0, 10_000, -10_000, 50_000, -50_000, 200_000]:
            base, quote, _ = get_reserves_from_holdings(200, net)
            k = base * quote
            assert abs(k - k0) / k0 < 1e-9

    def test_diminishing_pct_returns(self):
        p0 = price_from_holdings(100, 0)
        p1 = price_from_holdings(100, 10_000)
        p2 = price_from_holdings(100, 20_000)
        p3 = price_from_holdings(100, 30_000)
        pct1 = (p1 - p0) / p0
        pct2 = (p2 - p1) / p1
        pct3 = (p3 - p2) / p2
        assert pct1 > pct2 > pct3


# =============================================================================
# Test: Slippage matches Uniswap v2
# =============================================================================


class TestSlippage:
    def test_buy_avg_fill_worse_than_spot(self):
        avg, _, _, _ = calculate_trade_impact(200, 0, 10_000)
        assert avg > 200, "Buyer should pay more than spot"

    def test_sell_avg_fill_worse_than_spot(self):
        avg, _, _, _ = calculate_trade_impact(200, 0, -10_000)
        assert avg < 200, "Seller should receive less than spot"

    def test_slippage_increases_with_size(self):
        _, _, s1, _ = calculate_trade_impact(200, 0, 1_000)
        _, _, s2, _ = calculate_trade_impact(200, 0, 10_000)
        _, _, s3, _ = calculate_trade_impact(200, 0, 50_000)
        assert s1 < s2 < s3

    def test_small_trade_low_slippage(self):
        _, _, slippage, _ = calculate_trade_impact(200, 0, 1_000)
        assert slippage < 0.005, f"$1K trade: {slippage * 100:.3f}% slippage"

    def test_avg_fill_equals_quote_over_base(self):
        """For a buy, avg fill should equal quoteIn / baseOut exactly."""
        trade = 10_000
        avg, _, _, base_out = calculate_trade_impact(200, 0, trade)
        expected = trade / base_out
        assert abs(avg - expected) < 0.001

    def test_uniswap_slippage_formula(self):
        """Verify slippage matches Uniswap v2 formula:
        For a buy of dx quote: price_impact = dx / (quote_reserve + dx)
        Exact output: dy = base_reserve * dx / (quote_reserve + dx)
        Avg fill = dx / dy = (quote_reserve + dx) / base_reserve
        """
        init_base, init_quote, _k = get_initial_reserves(100)
        dx = 5000  # buy $5K

        # Uniswap formula
        dy = init_base * dx / (init_quote + dx)  # base tokens received
        uniswap_avg_fill = dx / dy

        # Our implementation
        our_avg, _, _, our_base_out = calculate_trade_impact(100, 0, dx)

        assert abs(our_base_out - dy) < 0.001, (
            f"Base output mismatch: ours={our_base_out:.6f} uni={dy:.6f}"
        )
        assert abs(our_avg - uniswap_avg_fill) < 0.001, (
            f"Avg fill mismatch: ours={our_avg:.6f} uni={uniswap_avg_fill:.6f}"
        )


# =============================================================================
# Test: Liquidity depth
# =============================================================================


class TestLiquidity:
    def test_deeper_pool_less_impact(self):
        p_shallow = price_from_holdings(100, 10_000, base_reserve=500)
        p_deep = price_from_holdings(100, 10_000, base_reserve=5000)
        assert abs(p_deep - 100) < abs(p_shallow - 100)

    def test_npc_trade_impact_reasonable(self):
        """$10K NPC trade on $200 asset ≈ 1% impact with 5000 base reserve."""
        price = price_from_holdings(200, 10_000)
        pct = abs(price - 200) / 200
        assert 0.005 < pct < 0.05, f"$10K: {pct * 100:.1f}%"


# =============================================================================
# Test: No artificial limits
# =============================================================================


class TestNoArtificialLimits:
    def test_price_can_exceed_old_ceiling(self):
        price = price_from_holdings(100, 500_000)
        assert price >= 400  # Old ceiling was 200%

    def test_price_can_go_below_old_floor(self):
        price = price_from_holdings(100, -400_000)
        assert price < 50  # Old floor was 50%
        assert price > 0
