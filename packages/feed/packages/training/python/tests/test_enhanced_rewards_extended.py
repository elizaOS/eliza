"""
Extended Tests for Enhanced Reward Signals

Comprehensive coverage for:
- Boundary conditions and edge cases
- Error handling and invalid inputs
- All code paths and branches
- Real function calls (no mocks of code under test)
"""

import math

import pytest

from src.training.market_regime import (
    TICKER_DOWN_THRESHOLD,
    TICKER_UP_THRESHOLD,
    MarketRegime,
    calculate_price_change_pct,
    calculate_volatility,
    detect_market_regime,
    detect_ticker_trend,
    extract_regime_from_trajectory,
)
from src.training.reward_config import (
    RewardWeightConfig,
    get_regime_expected_return,
    get_reward_weights,
    get_temporal_decay_rate,
    list_weight_profiles,
)
from src.training.rewards import (
    ARCHETYPE_REWARD_WEIGHTS,
    BehaviorMetrics,
    TemporalCredit,
    TrajectoryRewardInputs,
    archetype_composite_reward,
    calculate_alpha_reward,
    calculate_temporal_credit_bonus,
    compute_counterfactual,
    enhanced_composite_reward,
    regime_adjusted_pnl_reward,
)
from src.training.temporal_credit import (
    TRADING_ACTION_TYPES,
    aggregate_credits_by_market,
    aggregate_credits_by_step,
    attribute_credit_with_intermediate_outcomes,
    attribute_temporal_credit,
    calculate_credit_weight,
    extract_action_pnl,
    extract_market_id,
    is_trading_action,
)

# =============================================================================
# Market Regime: Boundary Conditions
# =============================================================================


class TestMarketRegimeBoundaries:
    """Boundary condition tests for market regime detection."""

    def test_exactly_at_bull_threshold(self):
        """Price change exactly at bull threshold."""
        price_data = {"BTC": [100000, 105000]}  # Exactly +5%
        regime = detect_market_regime(price_data)
        # At threshold, should be sideways (not strictly greater)
        assert regime.overall == "sideways"
        assert regime.avg_change_pct == 5.0

    def test_just_above_bull_threshold(self):
        """Price change just above bull threshold."""
        price_data = {"BTC": [100000, 105001]}  # +5.001%
        regime = detect_market_regime(price_data)
        assert regime.overall == "bull"

    def test_exactly_at_bear_threshold(self):
        """Price change exactly at bear threshold."""
        price_data = {"BTC": [100000, 95000]}  # Exactly -5%
        regime = detect_market_regime(price_data)
        assert regime.overall == "sideways"
        assert regime.avg_change_pct == -5.0

    def test_just_below_bear_threshold(self):
        """Price change just below bear threshold."""
        price_data = {"BTC": [100000, 94999]}  # -5.001%
        regime = detect_market_regime(price_data)
        assert regime.overall == "bear"

    def test_zero_price_change(self):
        """No price change at all."""
        price_data = {"BTC": [100000, 100000]}
        regime = detect_market_regime(price_data)
        assert regime.overall == "sideways"
        assert regime.avg_change_pct == 0.0

    def test_very_large_positive_change(self):
        """Extreme bull market (+1000%)."""
        price_data = {"BTC": [100000, 1100000]}  # +1000%
        regime = detect_market_regime(price_data)
        assert regime.overall == "bull"
        assert regime.avg_change_pct == 1000.0

    def test_very_large_negative_change(self):
        """Extreme bear market (-99%)."""
        price_data = {"BTC": [100000, 1000]}  # -99%
        regime = detect_market_regime(price_data)
        assert regime.overall == "bear"
        assert regime.avg_change_pct == -99.0

    def test_mixed_tickers_averaging_to_sideways(self):
        """Mixed up/down tickers averaging to sideways."""
        price_data = {
            "BTC": [100000, 110000],  # +10%
            "ETH": [100, 90],  # -10%
        }
        regime = detect_market_regime(price_data)
        assert regime.overall == "sideways"
        assert abs(regime.avg_change_pct) < 0.01
        assert regime.per_ticker["BTC"] == "up"
        assert regime.per_ticker["ETH"] == "down"


class TestMarketRegimeEdgeCases:
    """Edge case tests for market regime detection."""

    def test_zero_initial_price(self):
        """Zero initial price should not cause division by zero."""
        price_data = {"BTC": [0, 100000]}
        regime = detect_market_regime(price_data)
        # Should handle gracefully - 0% change
        assert regime.per_ticker["BTC"] == "flat"

    def test_negative_prices(self):
        """Negative prices (invalid but should not crash)."""
        price_data = {"BTC": [-100, -50]}
        regime = detect_market_regime(price_data)
        # Should still compute (50% decrease in absolute terms)
        assert regime is not None

    def test_single_ticker_single_price(self):
        """Single ticker with single price point."""
        price_data = {"BTC": [100000]}
        regime = detect_market_regime(price_data)
        assert regime.per_ticker["BTC"] == "flat"

    def test_many_tickers(self):
        """Large number of tickers."""
        price_data = {f"TICKER{i}": [100, 110] for i in range(100)}
        regime = detect_market_regime(price_data)
        assert regime.overall == "bull"
        assert len(regime.per_ticker) == 100

    def test_empty_price_list(self):
        """Ticker with empty price list."""
        price_data = {"BTC": []}
        regime = detect_market_regime(price_data)
        # Empty list means no change data
        assert regime is not None


class TestVolatilityCalculation:
    """Tests for volatility calculation edge cases."""

    def test_single_change(self):
        """Single change returns default volatility."""
        vol = calculate_volatility([5.0])
        assert vol == 0.5  # Default for insufficient data

    def test_empty_changes(self):
        """Empty list returns default volatility."""
        vol = calculate_volatility([])
        assert vol == 0.5

    def test_identical_changes(self):
        """All identical changes = zero variance."""
        vol = calculate_volatility([5.0, 5.0, 5.0, 5.0])
        # Zero variance means below low threshold
        assert vol == 0.0

    def test_extreme_volatility(self):
        """Very high volatility is clamped to 1.0."""
        vol = calculate_volatility([100.0, -100.0, 100.0, -100.0])
        assert vol == 1.0

    def test_negative_volatility_clamping(self):
        """Very low std dev doesn't go below 0."""
        vol = calculate_volatility([0.1, 0.1, 0.11, 0.1])
        assert vol >= 0.0


class TestPriceChangeCalculation:
    """Tests for price change percentage calculation."""

    def test_positive_change(self):
        pct = calculate_price_change_pct(100, 110)
        assert pct == 10.0

    def test_negative_change(self):
        pct = calculate_price_change_pct(100, 90)
        assert pct == -10.0

    def test_zero_initial(self):
        """Zero initial price returns 0 to avoid division by zero."""
        pct = calculate_price_change_pct(0, 100)
        assert pct == 0.0

    def test_negative_initial(self):
        """Negative initial price returns 0."""
        pct = calculate_price_change_pct(-100, 100)
        assert pct == 0.0

    def test_double_price(self):
        pct = calculate_price_change_pct(100, 200)
        assert pct == 100.0


class TestTickerTrendDetection:
    """Tests for ticker trend classification."""

    def test_up_exactly_at_threshold(self):
        trend = detect_ticker_trend(TICKER_UP_THRESHOLD)
        # At threshold, should be flat
        assert trend == "flat"

    def test_down_exactly_at_threshold(self):
        trend = detect_ticker_trend(TICKER_DOWN_THRESHOLD)
        assert trend == "flat"

    def test_up_above_threshold(self):
        trend = detect_ticker_trend(TICKER_UP_THRESHOLD + 0.01)
        assert trend == "up"

    def test_down_below_threshold(self):
        trend = detect_ticker_trend(TICKER_DOWN_THRESHOLD - 0.01)
        assert trend == "down"


class TestRegimeFromTrajectoryExtraction:
    """Tests for extracting regime from trajectory metadata."""

    def test_empty_trajectory(self):
        """Empty trajectory returns None."""
        regime = extract_regime_from_trajectory({})
        assert regime is None

    def test_trajectory_without_metadata(self):
        """Trajectory without metadata returns None."""
        regime = extract_regime_from_trajectory({"steps": []})
        assert regime is None

    def test_trajectory_with_empty_metadata(self):
        """Trajectory with empty metadata returns None."""
        regime = extract_regime_from_trajectory({"metadata": {}})
        assert regime is None

    def test_trajectory_with_precomputed_regime(self):
        """Trajectory with pre-computed regime in price_context."""
        trajectory = {
            "metadata": {
                "price_context": {
                    "regime": {
                        "overall": "bear",
                        "volatility": 0.8,
                        "per_ticker": {"BTC": "down"},
                        "avg_change_pct": -10.0,
                    }
                }
            }
        }
        regime = extract_regime_from_trajectory(trajectory)
        assert regime is not None
        assert regime.overall == "bear"
        assert regime.volatility == 0.8

    def test_trajectory_with_only_initial_prices(self):
        """Trajectory with only initial prices, no final."""
        trajectory = {
            "metadata": {
                "price_context": {
                    "initial_prices": {"BTC": 100000},
                }
            }
        }
        regime = extract_regime_from_trajectory(trajectory)
        assert regime is None

    def test_trajectory_with_mixed_camelcase_keys(self):
        """Legacy ground_truth with camelCase keys."""
        trajectory = {
            "metadata": {
                "ground_truth": {
                    "initialPrices": {"BTC": 100000},
                    "finalPrices": {"BTC": 80000},  # -20%
                }
            }
        }
        regime = extract_regime_from_trajectory(trajectory)
        assert regime is not None
        assert regime.overall == "bear"


class TestMarketRegimeSerialization:
    """Tests for MarketRegime to_dict/from_dict."""

    def test_roundtrip_all_fields(self):
        """Full roundtrip preserves all fields."""
        original = MarketRegime(
            overall="bull",
            volatility=0.75,
            per_ticker={"BTC": "up", "ETH": "down", "SOL": "flat"},
            avg_change_pct=7.5,
            window_id="2025-01-14-10",
        )

        data = original.to_dict()
        restored = MarketRegime.from_dict(data)

        assert restored.overall == original.overall
        assert restored.volatility == original.volatility
        assert restored.per_ticker == original.per_ticker
        assert restored.avg_change_pct == original.avg_change_pct
        assert restored.window_id == original.window_id

    def test_from_dict_missing_optional_fields(self):
        """from_dict handles missing optional fields."""
        data = {
            "overall": "sideways",
            "volatility": 0.5,
        }
        regime = MarketRegime.from_dict(data)
        assert regime.per_ticker == {}
        assert regime.avg_change_pct == 0.0
        assert regime.window_id is None

    def test_default_sideways_values(self):
        """default_sideways() creates neutral regime."""
        regime = MarketRegime.default_sideways()
        assert regime.overall == "sideways"
        assert regime.volatility == 0.5
        assert regime.per_ticker == {}
        assert regime.avg_change_pct == 0.0


# =============================================================================
# Temporal Credit: Edge Cases and Boundaries
# =============================================================================


class TestIsTradingActionComprehensive:
    """Comprehensive tests for is_trading_action."""

    def test_all_known_trading_actions(self):
        """All explicitly listed trading actions."""
        for action in TRADING_ACTION_TYPES:
            assert is_trading_action(action), f"{action} should be trading"

    def test_case_variations(self):
        """Case insensitivity."""
        assert is_trading_action("BUY")
        assert is_trading_action("Buy")
        assert is_trading_action("SELL")
        assert is_trading_action("OpenPerp")

    def test_whitespace_handling(self):
        """Whitespace is stripped."""
        assert is_trading_action("  buy  ")
        assert is_trading_action("\tsell\n")

    def test_partial_matches(self):
        """Partial string matches for flexibility."""
        assert is_trading_action("buy_btc")
        assert is_trading_action("market_sell")
        assert is_trading_action("open_position")
        assert is_trading_action("close_all")

    def test_non_trading_actions(self):
        """Non-trading actions."""
        assert not is_trading_action("chat")
        assert not is_trading_action("message")
        assert not is_trading_action("research")
        assert not is_trading_action("wait")
        assert not is_trading_action("observe")
        assert not is_trading_action("analyze")

    def test_empty_string(self):
        """Empty string is not a trading action."""
        assert not is_trading_action("")

    def test_special_characters(self):
        """Actions with special characters."""
        assert is_trading_action("buy!")
        assert is_trading_action("sell@market")


class TestExtractMarketId:
    """Tests for extract_market_id from step data."""

    def test_marketId_in_parameters(self):
        step = {"action": {"parameters": {"marketId": "BTC"}}}
        assert extract_market_id(step) == "BTC"

    def test_market_id_snake_case(self):
        step = {"action": {"parameters": {"market_id": "ETH"}}}
        assert extract_market_id(step) == "ETH"

    def test_ticker_parameter(self):
        step = {"action": {"parameters": {"ticker": "SOL"}}}
        assert extract_market_id(step) == "SOL"

    def test_market_parameter(self):
        step = {"action": {"parameters": {"market": "DOGE"}}}
        assert extract_market_id(step) == "DOGE"

    def test_symbol_parameter(self):
        step = {"action": {"parameters": {"symbol": "AVAX"}}}
        assert extract_market_id(step) == "AVAX"

    def test_market_in_result(self):
        step = {"action": {"result": {"market": "BNB"}}}
        assert extract_market_id(step) == "BNB"

    def test_empty_step(self):
        assert extract_market_id({}) is None

    def test_no_action(self):
        step = {"result": {"market": "XRP"}}
        assert extract_market_id(step) is None

    def test_no_parameters_or_result(self):
        step = {"action": {"actionType": "buy"}}
        assert extract_market_id(step) is None

    def test_numeric_market_id(self):
        """Numeric market IDs are converted to string."""
        step = {"action": {"parameters": {"marketId": 12345}}}
        assert extract_market_id(step) == "12345"


class TestExtractActionPnl:
    """Tests for extract_action_pnl from step data."""

    def test_pnl_in_result(self):
        step = {"action": {"result": {"pnl": 150.50}}}
        assert extract_action_pnl(step) == 150.50

    def test_realized_pnl_camelcase(self):
        step = {"action": {"result": {"realizedPnL": -50.0}}}
        assert extract_action_pnl(step) == -50.0

    def test_realized_pnl_snake_case(self):
        step = {"action": {"result": {"realized_pnl": 200}}}
        assert extract_action_pnl(step) == 200.0

    def test_pnl_zero(self):
        step = {"action": {"result": {"pnl": 0}}}
        assert extract_action_pnl(step) == 0.0

    def test_no_pnl(self):
        step = {"action": {"result": {"success": True}}}
        assert extract_action_pnl(step) is None

    def test_empty_step(self):
        assert extract_action_pnl({}) is None

    def test_string_pnl(self):
        """String P&L is converted to float."""
        step = {"action": {"result": {"pnl": "100.5"}}}
        assert extract_action_pnl(step) == 100.5


class TestCreditWeightCalculation:
    """Tests for calculate_credit_weight."""

    def test_same_step_full_weight(self):
        """Decision at outcome step gets full weight."""
        assert calculate_credit_weight(5, 5) == 1.0

    def test_one_step_away(self):
        """One step before outcome."""
        weight = calculate_credit_weight(4, 5, decay_rate=0.9)
        assert weight == 0.9

    def test_many_steps_away(self):
        """Many steps before outcome (exponential decay)."""
        weight = calculate_credit_weight(0, 10, decay_rate=0.9)
        expected = 0.9**10
        assert abs(weight - expected) < 1e-9

    def test_future_decision_clamped(self):
        """Decision after outcome (invalid) clamps to 0 distance."""
        weight = calculate_credit_weight(10, 5)
        assert weight == 1.0  # max(0, -5) = 0, decay^0 = 1

    def test_zero_decay_rate(self):
        """Zero decay rate = only same-step credit."""
        assert calculate_credit_weight(0, 10, decay_rate=0.0) == 0.0
        assert calculate_credit_weight(10, 10, decay_rate=0.0) == 1.0

    def test_decay_rate_one(self):
        """Decay rate 1.0 = uniform credit."""
        assert calculate_credit_weight(0, 100, decay_rate=1.0) == 1.0

    def test_custom_decay_rate(self):
        """Custom decay rate."""
        weight = calculate_credit_weight(0, 5, decay_rate=0.5)
        assert weight == 0.5**5


class TestAttributeTemporalCreditEdgeCases:
    """Edge case tests for attribute_temporal_credit."""

    def test_empty_steps(self):
        """Empty step list returns empty credits."""
        credits = attribute_temporal_credit([], final_pnl=1000)
        assert credits == []

    def test_no_trading_actions(self):
        """Steps with no trading actions return empty credits."""
        steps = [
            {"action": {"actionType": "research"}},
            {"action": {"actionType": "chat"}},
        ]
        credits = attribute_temporal_credit(steps, final_pnl=1000)
        assert credits == []

    def test_trading_action_without_market_id(self):
        """Trading action without market ID is skipped."""
        steps = [
            {"action": {"actionType": "buy", "parameters": {}}},  # No market
        ]
        credits = attribute_temporal_credit(steps, final_pnl=1000)
        assert credits == []

    def test_single_trading_action(self):
        """Single trading action gets full credit."""
        steps = [
            {"action": {"actionType": "buy", "parameters": {"marketId": "BTC"}}},
        ]
        credits = attribute_temporal_credit(steps, final_pnl=500)
        assert len(credits) == 1
        assert credits[0].outcome_pnl == 500  # Full P&L

    def test_zero_final_pnl(self):
        """Zero final P&L distributes zero credit."""
        steps = [
            {"action": {"actionType": "buy", "parameters": {"marketId": "BTC"}}},
            {"action": {"actionType": "sell", "parameters": {"marketId": "BTC"}}},
        ]
        credits = attribute_temporal_credit(steps, final_pnl=0)
        assert all(c.outcome_pnl == 0 for c in credits)

    def test_negative_final_pnl(self):
        """Negative final P&L distributes negative credit."""
        steps = [
            {"action": {"actionType": "buy", "parameters": {"marketId": "BTC"}}},
        ]
        credits = attribute_temporal_credit(steps, final_pnl=-500)
        assert credits[0].outcome_pnl == -500

    def test_per_market_outcome_data(self):
        """Per-market outcome data is used correctly."""
        steps = [
            {"action": {"actionType": "buy", "parameters": {"marketId": "BTC"}}},
            {"action": {"actionType": "buy", "parameters": {"marketId": "ETH"}}},
        ]
        outcome_data = {"BTC": 300, "ETH": -100}
        credits = attribute_temporal_credit(steps, final_pnl=200, outcome_data=outcome_data)

        btc_credits = [c for c in credits if c.market_id == "BTC"]
        eth_credits = [c for c in credits if c.market_id == "ETH"]

        assert len(btc_credits) == 1
        assert len(eth_credits) == 1
        assert btc_credits[0].outcome_pnl == 300  # Only BTC trade for BTC
        assert eth_credits[0].outcome_pnl == -100

    def test_outcome_data_with_missing_market(self):
        """Outcome data for market not in steps is ignored."""
        steps = [
            {"action": {"actionType": "buy", "parameters": {"marketId": "BTC"}}},
        ]
        outcome_data = {"BTC": 100, "ETH": 200}  # ETH not in steps
        credits = attribute_temporal_credit(steps, final_pnl=100, outcome_data=outcome_data)

        assert len(credits) == 1
        assert credits[0].market_id == "BTC"


class TestAttributeCreditWithIntermediateOutcomes:
    """Tests for intermediate outcome credit assignment."""

    def test_open_and_close_with_pnl(self):
        """Open position followed by close with P&L."""
        steps = [
            {"action": {"actionType": "buy", "parameters": {"marketId": "BTC"}}},
            {
                "action": {
                    "actionType": "sell",
                    "parameters": {"marketId": "BTC"},
                    "result": {"pnl": 150},
                }
            },
        ]
        credits = attribute_credit_with_intermediate_outcomes(steps)

        # Should have credit for buy (opening) and sell (closing)
        assert len(credits) == 2

        # Closing decision gets full credit
        close_credit = next(c for c in credits if c.decision_step == 1)
        assert close_credit.outcome_pnl == 150
        assert close_credit.credit_weight == 1.0

    def test_no_closes_no_credits(self):
        """Only opens without closes = no credits."""
        steps = [
            {"action": {"actionType": "open_long", "parameters": {"marketId": "BTC"}}},
            {"action": {"actionType": "open_long", "parameters": {"marketId": "ETH"}}},
        ]
        credits = attribute_credit_with_intermediate_outcomes(steps)
        assert credits == []

    def test_close_without_pnl(self):
        """Close without P&L in result = no credit."""
        steps = [
            {"action": {"actionType": "buy", "parameters": {"marketId": "BTC"}}},
            {
                "action": {
                    "actionType": "sell",
                    "parameters": {"marketId": "BTC"},
                    "result": {"success": True},
                }
            },
        ]
        credits = attribute_credit_with_intermediate_outcomes(steps)
        assert credits == []

    def test_lifo_matching(self):
        """Multiple opens: LIFO matching for closes."""
        steps = [
            {"action": {"actionType": "buy", "parameters": {"marketId": "BTC"}}},  # 0
            {"action": {"actionType": "buy", "parameters": {"marketId": "BTC"}}},  # 1
            {
                "action": {
                    "actionType": "sell",
                    "parameters": {"marketId": "BTC"},
                    "result": {"pnl": 100},
                }
            },  # 2
        ]
        credits = attribute_credit_with_intermediate_outcomes(steps)

        # Should credit step 1 (most recent open) not step 0
        open_credit = next((c for c in credits if c.decision_step < 2), None)
        assert open_credit is not None
        assert open_credit.decision_step == 1


class TestAggregateCredits:
    """Tests for credit aggregation functions."""

    def test_aggregate_by_step_empty(self):
        result = aggregate_credits_by_step([])
        assert result == {}

    def test_aggregate_by_step_single(self):
        credits = [
            TemporalCredit(decision_step=0, outcome_step=5, credit_weight=0.9, outcome_pnl=100)
        ]
        result = aggregate_credits_by_step(credits)
        assert result == {0: 100}

    def test_aggregate_by_step_multiple_same_step(self):
        credits = [
            TemporalCredit(decision_step=0, outcome_step=5, credit_weight=0.9, outcome_pnl=100),
            TemporalCredit(decision_step=0, outcome_step=5, credit_weight=0.8, outcome_pnl=50),
        ]
        result = aggregate_credits_by_step(credits)
        assert result == {0: 150}

    def test_aggregate_by_market_empty(self):
        result = aggregate_credits_by_market([])
        assert result == {}

    def test_aggregate_by_market_none_market(self):
        credits = [
            TemporalCredit(
                decision_step=0, outcome_step=5, credit_weight=0.9, outcome_pnl=100, market_id=None
            )
        ]
        result = aggregate_credits_by_market(credits)
        assert result == {"unknown": 100}


# =============================================================================
# Counterfactual Rewards: Edge Cases
# =============================================================================


class TestCounterfactualEdgeCases:
    """Edge case tests for counterfactual computation."""

    def test_zero_starting_balance(self):
        """Zero starting balance should not cause division by zero."""
        result = compute_counterfactual(
            actual_pnl=100,
            starting_balance=0,
            regime_overall="bull",
            regime_expected_return=0.05,
        )
        # Benchmark should be 0
        assert result.benchmark_pnl == 0
        assert result.alpha == 100

    def test_negative_starting_balance(self):
        """Negative starting balance (invalid but should not crash)."""
        result = compute_counterfactual(
            actual_pnl=100,
            starting_balance=-10000,
            regime_overall="bull",
            regime_expected_return=0.05,
        )
        # Negative expected return
        assert result.benchmark_pnl == -500

    def test_very_large_pnl(self):
        """Very large P&L values."""
        result = compute_counterfactual(
            actual_pnl=1_000_000,
            starting_balance=10000,
            regime_overall="sideways",
            regime_expected_return=0.0,
        )
        assert result.alpha == 1_000_000

    def test_matching_benchmark(self):
        """Actual P&L exactly matches benchmark."""
        result = compute_counterfactual(
            actual_pnl=500,
            starting_balance=10000,
            regime_overall="bull",
            regime_expected_return=0.05,
        )
        assert result.benchmark_pnl == 500
        assert result.alpha == 0

    def test_unknown_regime(self):
        """Unknown regime type defaults to sideways behavior."""
        result = compute_counterfactual(
            actual_pnl=100,
            starting_balance=10000,
            regime_overall="unknown_regime",
            regime_expected_return=0.0,  # Would need to pass 0 for unknown
        )
        assert result.benchmark_pnl == 0
        assert result.alpha == 100


class TestRegimeAdjustedPnlReward:
    """Tests for regime_adjusted_pnl_reward edge cases."""

    def test_zero_starting_balance(self):
        """Zero starting balance returns 0 reward."""
        reward = regime_adjusted_pnl_reward(
            actual_pnl=1000,
            starting_balance=0,
            regime_overall="bull",
            regime_volatility=0.5,
            regime_expected_return=0.05,
        )
        # Should handle gracefully
        assert reward == 0.0 or not math.isnan(reward)

    def test_extreme_pnl_bounded(self):
        """Extreme P&L is bounded to [-1, 1]."""
        reward = regime_adjusted_pnl_reward(
            actual_pnl=100000,  # 1000% gain
            starting_balance=10000,
            regime_overall="sideways",
            regime_volatility=0.0,
            regime_expected_return=0.0,
        )
        assert -1.0 <= reward <= 1.0

    def test_volatility_dampening_range(self):
        """Volatility dampening works across full range."""
        for vol in [0.0, 0.25, 0.5, 0.75, 1.0]:
            reward = regime_adjusted_pnl_reward(
                actual_pnl=500,
                starting_balance=10000,
                regime_overall="sideways",
                regime_volatility=vol,
                regime_expected_return=0.0,
            )
            assert -1.0 <= reward <= 1.0


class TestAlphaReward:
    """Tests for calculate_alpha_reward edge cases."""

    def test_zero_alpha(self):
        reward = calculate_alpha_reward(alpha=0, starting_balance=10000)
        assert reward == 0.0

    def test_positive_alpha(self):
        # 5% alpha = max reward
        reward = calculate_alpha_reward(alpha=500, starting_balance=10000)
        assert reward == 1.0

    def test_negative_alpha(self):
        # -5% alpha = min reward
        reward = calculate_alpha_reward(alpha=-500, starting_balance=10000)
        assert reward == -1.0

    def test_extreme_alpha_bounded(self):
        reward = calculate_alpha_reward(alpha=100000, starting_balance=10000)
        assert -1.0 <= reward <= 1.0

    def test_zero_starting_balance(self):
        reward = calculate_alpha_reward(alpha=100, starting_balance=0)
        # Should handle gracefully
        assert isinstance(reward, float)


class TestTemporalCreditBonus:
    """Tests for calculate_temporal_credit_bonus."""

    def test_empty_credits(self):
        bonus = calculate_temporal_credit_bonus([], starting_balance=10000)
        assert bonus == 0.0

    def test_positive_credits(self):
        credits = [
            TemporalCredit(decision_step=0, outcome_step=5, credit_weight=1.0, outcome_pnl=500),
        ]
        bonus = calculate_temporal_credit_bonus(credits, starting_balance=10000)
        assert bonus > 0

    def test_negative_credits(self):
        credits = [
            TemporalCredit(decision_step=0, outcome_step=5, credit_weight=1.0, outcome_pnl=-500),
        ]
        bonus = calculate_temporal_credit_bonus(credits, starting_balance=10000)
        assert bonus < 0

    def test_mixed_credits(self):
        credits = [
            TemporalCredit(decision_step=0, outcome_step=5, credit_weight=1.0, outcome_pnl=500),
            TemporalCredit(decision_step=1, outcome_step=5, credit_weight=0.9, outcome_pnl=-200),
        ]
        bonus = calculate_temporal_credit_bonus(credits, starting_balance=10000)
        # Net positive, but partial
        assert isinstance(bonus, float)


# =============================================================================
# Enhanced Composite Reward: All Code Paths
# =============================================================================


class TestEnhancedCompositeRewardCodePaths:
    """Tests covering all code paths in enhanced_composite_reward."""

    def _make_inputs(self, final_pnl=500) -> TrajectoryRewardInputs:
        return TrajectoryRewardInputs(
            final_pnl=final_pnl,
            starting_balance=10000,
            end_balance=10000 + final_pnl,
            format_score=0.8,
            reasoning_score=0.7,
        )

    def test_all_weight_profiles(self):
        """Test with all available weight profiles."""
        inputs = self._make_inputs()

        # Test that enhanced_composite_reward works with the default profile
        # (profile selection happens at a higher level in feed_env)
        reward = enhanced_composite_reward(
            inputs=inputs,
            archetype="trader",
            regime_overall="sideways",
        )
        assert -1.0 <= reward <= 1.0

        # Verify profiles are loadable
        for profile in list_weight_profiles():
            weights = get_reward_weights(profile)
            assert sum(weights.values()) > 0, f"Profile {profile} has no weights"

    def test_all_archetypes(self):
        """Test with all archetypes."""
        inputs = self._make_inputs()

        for archetype in ARCHETYPE_REWARD_WEIGHTS.keys():
            reward = enhanced_composite_reward(
                inputs=inputs,
                archetype=archetype,
                regime_overall="sideways",
            )
            assert -1.0 <= reward <= 1.0, f"Archetype {archetype} gave out of range reward"

    def test_with_behavior_metrics(self):
        """Test with behavior metrics provided."""
        inputs = self._make_inputs()
        metrics = BehaviorMetrics(
            trades_executed=10,
            profitable_trades=6,
            win_rate=0.6,
            total_pnl=500,
        )

        reward = enhanced_composite_reward(
            inputs=inputs,
            archetype="trader",
            behavior_metrics=metrics,
            regime_overall="bull",
            regime_expected_return=0.05,
        )
        assert -1.0 <= reward <= 1.0

    def test_all_components_zero(self):
        """Test with all components being zero."""
        inputs = TrajectoryRewardInputs(
            final_pnl=0,
            starting_balance=10000,
            end_balance=10000,
            format_score=0.0,
            reasoning_score=0.0,
        )

        reward = enhanced_composite_reward(
            inputs=inputs,
            archetype="trader",
            regime_overall="sideways",
            counterfactual_alpha=0,
            temporal_credits=[],
        )
        # Should be 0 or very small
        assert -0.1 <= reward <= 0.1

    def test_negative_scores(self):
        """Format and reasoning scores can't be negative by design, but test robustness."""
        inputs = TrajectoryRewardInputs(
            final_pnl=-1000,
            starting_balance=10000,
            end_balance=9000,
            format_score=0.0,  # Min valid
            reasoning_score=0.0,  # Min valid
        )

        reward = enhanced_composite_reward(
            inputs=inputs,
            archetype="trader",
            regime_overall="bear",
            regime_expected_return=-0.05,
            counterfactual_alpha=-500,  # Underperformed
        )
        assert -1.0 <= reward <= 1.0

    def test_unknown_archetype_fallback(self):
        """Unknown archetype should use default weights."""
        inputs = self._make_inputs()

        reward = enhanced_composite_reward(
            inputs=inputs,
            archetype="unknown_archetype_xyz",
            regime_overall="sideways",
        )
        assert -1.0 <= reward <= 1.0


class TestEnhancedVsArchetypeReward:
    """Compare enhanced and archetype rewards."""

    def test_regime_awareness_changes_score(self):
        """Regime awareness should change score vs vanilla archetype."""
        inputs = TrajectoryRewardInputs(
            final_pnl=300,
            starting_balance=10000,
            end_balance=10300,
            format_score=0.7,
            reasoning_score=0.6,
        )

        # Vanilla archetype reward
        archetype = archetype_composite_reward(inputs=inputs, archetype="trader")

        # Enhanced with bull market (underperformance)
        enhanced_bull = enhanced_composite_reward(
            inputs=inputs,
            archetype="trader",
            regime_overall="bull",
            regime_volatility=0.3,
            regime_expected_return=0.05,
            counterfactual_alpha=-200,  # Made 3%, expected 5%
        )

        # Enhanced with bear market (outperformance)
        enhanced_bear = enhanced_composite_reward(
            inputs=inputs,
            archetype="trader",
            regime_overall="bear",
            regime_volatility=0.3,
            regime_expected_return=-0.05,
            counterfactual_alpha=800,  # Made +3%, expected -5%
        )

        # Bear market profit should be rewarded more
        assert enhanced_bear > enhanced_bull


# =============================================================================
# Reward Config: Singleton and Edge Cases
# =============================================================================


class TestRewardConfigSingleton:
    """Tests for RewardWeightConfig singleton behavior."""

    def test_singleton_same_instance(self):
        """Multiple calls return same instance."""
        config1 = RewardWeightConfig()
        config2 = RewardWeightConfig()
        assert config1 is config2

    def test_get_weights_for_unknown_profile(self):
        """Unknown profile returns default weights."""
        weights = get_reward_weights("nonexistent_profile_xyz")
        default = get_reward_weights("default")
        assert weights == default

    def test_get_regime_expected_return_unknown(self):
        """Unknown regime returns 0."""
        ret = get_regime_expected_return("unknown_regime_xyz")
        assert ret == 0.0

    def test_get_temporal_decay_rate_valid(self):
        """Decay rate is valid."""
        rate = get_temporal_decay_rate()
        assert 0.0 < rate <= 1.0

    def test_get_volatility_config_has_keys(self):
        """Volatility config has expected keys."""
        config = RewardWeightConfig().get_volatility_config()
        assert "low" in config
        assert "high" in config
        assert "dampening_factor" in config


# =============================================================================
# Integration: Full Pipeline Tests
# =============================================================================


class TestFullPipelineEdgeCases:
    """Integration tests for edge cases in the full pipeline."""

    def test_empty_trajectory_pipeline(self):
        """Empty trajectory should not crash pipeline."""
        trajectory = {}

        regime = extract_regime_from_trajectory(trajectory)
        assert regime is None

        credits = attribute_temporal_credit([], final_pnl=0)
        assert credits == []

        inputs = TrajectoryRewardInputs(
            final_pnl=0,
            starting_balance=10000,
            end_balance=10000,
            format_score=0.5,
            reasoning_score=0.5,
        )

        # Should fall back to archetype reward
        reward = enhanced_composite_reward(
            inputs=inputs,
            archetype="trader",
            regime_overall=None,
        )

        archetype_reward = archetype_composite_reward(
            inputs=inputs,
            archetype="trader",
        )

        assert reward == archetype_reward

    def test_minimal_valid_trajectory(self):
        """Minimal valid trajectory with all components."""
        trajectory = {
            "final_pnl": 100,
            "metadata": {
                "price_context": {
                    "initial_prices": {"BTC": 100000},
                    "final_prices": {"BTC": 101000},  # +1%
                }
            },
            "steps": [
                {"action": {"actionType": "buy", "parameters": {"marketId": "BTC"}}},
            ],
        }

        regime = extract_regime_from_trajectory(trajectory)
        assert regime is not None
        assert regime.overall == "sideways"  # +1% < 5%

        credits = attribute_temporal_credit(
            trajectory["steps"],
            trajectory["final_pnl"],
        )
        assert len(credits) == 1

        inputs = TrajectoryRewardInputs(
            final_pnl=trajectory["final_pnl"],
            starting_balance=10000,
            end_balance=10100,
            format_score=0.7,
            reasoning_score=0.6,
        )

        counterfactual = compute_counterfactual(
            actual_pnl=100,
            starting_balance=10000,
            regime_overall=regime.overall,
            regime_expected_return=get_regime_expected_return(regime.overall),
        )

        reward = enhanced_composite_reward(
            inputs=inputs,
            archetype="trader",
            regime_overall=regime.overall,
            regime_volatility=regime.volatility,
            regime_expected_return=get_regime_expected_return(regime.overall),
            counterfactual_alpha=counterfactual.alpha,
            temporal_credits=credits,
        )

        assert -1.0 <= reward <= 1.0


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
