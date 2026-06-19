"""
Tests for Enhanced Reward Signals

Tests market regime detection, counterfactual rewards, temporal credit,
and the enhanced composite reward function.
"""

import pytest

from src.training.market_regime import (
    BEAR_THRESHOLD,
    BULL_THRESHOLD,
    MarketRegime,
    calculate_volatility,
    detect_market_regime,
    detect_regime_from_prices,
    extract_regime_from_trajectory,
    get_expected_return,
)
from src.training.reward_config import (
    get_regime_expected_return,
    get_reward_weights,
    get_temporal_decay_rate,
    list_weight_profiles,
)
from src.training.rewards import (
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
    DEFAULT_DECAY_RATE,
    aggregate_credits_by_market,
    attribute_temporal_credit,
    calculate_credit_weight,
    is_trading_action,
)

# =============================================================================
# Market Regime Tests
# =============================================================================


class TestMarketRegimeDetection:
    """Tests for market regime detection from price data."""

    def test_detect_bull_market(self):
        """Bull market: >5% average increase."""
        price_data = {
            "BTC": [100000, 110000],  # +10%
            "ETH": [4000, 4400],  # +10%
        }
        regime = detect_market_regime(price_data)

        assert regime.overall == "bull"
        assert regime.avg_change_pct > BULL_THRESHOLD

    def test_detect_bear_market(self):
        """Bear market: <-5% average decrease."""
        price_data = {
            "BTC": [100000, 90000],  # -10%
            "ETH": [4000, 3600],  # -10%
        }
        regime = detect_market_regime(price_data)

        assert regime.overall == "bear"
        assert regime.avg_change_pct < BEAR_THRESHOLD

    def test_detect_sideways_market(self):
        """Sideways market: between -5% and +5%."""
        price_data = {
            "BTC": [100000, 102000],  # +2%
            "ETH": [4000, 3920],  # -2%
        }
        regime = detect_market_regime(price_data)

        assert regime.overall == "sideways"
        assert BEAR_THRESHOLD <= regime.avg_change_pct <= BULL_THRESHOLD

    def test_per_ticker_trends(self):
        """Per-ticker trends are correctly classified."""
        price_data = {
            "BTC": [100000, 110000],  # +10% -> up
            "ETH": [4000, 3600],  # -10% -> down
            "SOL": [100, 102],  # +2% -> flat
        }
        regime = detect_market_regime(price_data)

        assert regime.per_ticker["BTC"] == "up"
        assert regime.per_ticker["ETH"] == "down"
        assert regime.per_ticker["SOL"] == "flat"

    def test_volatility_calculation(self):
        """Volatility is normalized to [0, 1] range."""
        low_vol_changes = [1.0, 1.5, 1.0, 1.5]
        high_vol_changes = [10.0, -15.0, 20.0, -25.0]

        low_vol = calculate_volatility(low_vol_changes)
        high_vol = calculate_volatility(high_vol_changes)

        assert 0.0 <= low_vol <= 1.0
        assert 0.0 <= high_vol <= 1.0
        assert low_vol < high_vol

    def test_empty_price_data(self):
        """Empty price data returns sideways default."""
        regime = detect_market_regime({})

        assert regime.overall == "sideways"
        assert regime.volatility == 0.5

    def test_single_price_list(self):
        """Single-element price list is treated as flat."""
        price_data = {"BTC": [100000]}
        regime = detect_market_regime(price_data)

        assert regime.per_ticker.get("BTC") == "flat"

    def test_regime_from_initial_final_prices(self):
        """Regime detection from initial/final price snapshots."""
        initial = {"BTC": 100000, "ETH": 4000}
        final = {"BTC": 110000, "ETH": 4400}  # +10% each

        regime = detect_regime_from_prices(initial, final)

        assert regime.overall == "bull"
        assert regime.avg_change_pct == 10.0

    def test_market_regime_serialization(self):
        """MarketRegime can be serialized and deserialized."""
        regime = MarketRegime(
            overall="bull",
            volatility=0.3,
            per_ticker={"BTC": "up"},
            avg_change_pct=7.5,
        )

        data = regime.to_dict()
        restored = MarketRegime.from_dict(data)

        assert restored.overall == regime.overall
        assert restored.volatility == regime.volatility
        assert restored.per_ticker == regime.per_ticker

    def test_extract_regime_from_trajectory_metadata(self):
        """Extract regime from trajectory price_context metadata."""
        trajectory = {
            "metadata": {
                "price_context": {
                    "initial_prices": {"BTC": 100000},
                    "final_prices": {"BTC": 90000},  # -10%
                    "regime": None,  # Should compute from prices
                }
            }
        }

        regime = extract_regime_from_trajectory(trajectory)

        assert regime is not None
        assert regime.overall == "bear"

    def test_extract_regime_from_ground_truth(self):
        """Extract regime from legacy ground_truth metadata."""
        trajectory = {
            "metadata": {
                "ground_truth": {
                    "initialPrices": {"BTC": 100000},
                    "finalPrices": {"BTC": 110000},  # +10%
                }
            }
        }

        regime = extract_regime_from_trajectory(trajectory)

        assert regime is not None
        assert regime.overall == "bull"

    def test_expected_return_by_regime(self):
        """Expected returns differ by regime."""
        bull = MarketRegime(overall="bull", volatility=0.3, per_ticker={})
        bear = MarketRegime(overall="bear", volatility=0.3, per_ticker={})
        sideways = MarketRegime(overall="sideways", volatility=0.3, per_ticker={})

        assert get_expected_return(bull) == 0.05
        assert get_expected_return(bear) == -0.05
        assert get_expected_return(sideways) == 0.0


# =============================================================================
# Counterfactual Reward Tests
# =============================================================================


class TestCounterfactualRewards:
    """Tests for counterfactual reward computation."""

    def test_counterfactual_bull_market_underperformance(self):
        """In bull market, underperforming has negative alpha."""
        # Bull market: expected +5% = +500 on 10k starting balance
        # Agent made +3% = +300
        result = compute_counterfactual(
            actual_pnl=300,
            starting_balance=10000,
            regime_overall="bull",
            regime_expected_return=0.05,
        )

        assert result.benchmark_pnl == 500  # 5% of 10k
        assert result.alpha == -200  # 300 - 500
        assert result.actual_pnl == 300

    def test_counterfactual_bear_market_outperformance(self):
        """In bear market, losing less than expected has positive alpha."""
        # Bear market: expected -5% = -500
        # Agent lost -2% = -200
        result = compute_counterfactual(
            actual_pnl=-200,
            starting_balance=10000,
            regime_overall="bear",
            regime_expected_return=-0.05,
        )

        assert result.benchmark_pnl == -500  # -5% of 10k
        assert result.alpha == 300  # -200 - (-500) = +300

    def test_counterfactual_sideways_market(self):
        """In sideways market, any profit is positive alpha."""
        result = compute_counterfactual(
            actual_pnl=100,
            starting_balance=10000,
            regime_overall="sideways",
            regime_expected_return=0.0,
        )

        assert result.benchmark_pnl == 0
        assert result.alpha == 100

    def test_regime_adjusted_pnl_reward_scaling(self):
        """Regime-adjusted reward scales correctly."""
        # 10% adjusted return = 1.0 reward
        reward = regime_adjusted_pnl_reward(
            actual_pnl=1000,
            starting_balance=10000,
            regime_overall="sideways",
            regime_volatility=0.0,
            regime_expected_return=0.0,
        )

        assert reward == 1.0  # 10% return, no adjustment, no dampening

    def test_regime_adjusted_pnl_volatility_dampening(self):
        """High volatility dampens reward signal."""
        # Same P&L, different volatility
        low_vol_reward = regime_adjusted_pnl_reward(
            actual_pnl=500,
            starting_balance=10000,
            regime_overall="sideways",
            regime_volatility=0.0,
            regime_expected_return=0.0,
        )

        high_vol_reward = regime_adjusted_pnl_reward(
            actual_pnl=500,
            starting_balance=10000,
            regime_overall="sideways",
            regime_volatility=1.0,
            regime_expected_return=0.0,
        )

        assert low_vol_reward > high_vol_reward

    def test_alpha_reward_scaling(self):
        """Alpha reward scales appropriately."""
        # 5% alpha = 1.0 reward
        reward = calculate_alpha_reward(
            alpha=500,
            starting_balance=10000,
        )

        assert reward == 1.0  # 5% alpha = max reward


# =============================================================================
# Temporal Credit Tests
# =============================================================================


class TestTemporalCredit:
    """Tests for temporal credit assignment."""

    def test_is_trading_action(self):
        """Trading actions are correctly identified."""
        assert is_trading_action("buy")
        assert is_trading_action("sell")
        assert is_trading_action("open_perp")
        assert is_trading_action("close_perp")
        assert is_trading_action("BUY_PREDICTION")  # Case insensitive

        assert not is_trading_action("social")
        assert not is_trading_action("research")
        assert not is_trading_action("chat")

    def test_credit_weight_decay(self):
        """Credit weight decays exponentially with distance."""
        # Same step = full weight
        assert calculate_credit_weight(10, 10) == 1.0

        # 1 step away
        weight_1 = calculate_credit_weight(9, 10)
        assert weight_1 == DEFAULT_DECAY_RATE  # 0.9

        # 2 steps away
        weight_2 = calculate_credit_weight(8, 10)
        assert weight_2 == DEFAULT_DECAY_RATE**2

        # Weight decreases with distance
        assert weight_2 < weight_1

    def test_attribute_temporal_credit_basic(self):
        """Basic temporal credit attribution."""
        steps = [
            {"action": {"actionType": "buy", "parameters": {"marketId": "BTC"}}},
            {"action": {"actionType": "research", "parameters": {}}},
            {"action": {"actionType": "sell", "parameters": {"marketId": "BTC"}}},
        ]

        credits = attribute_temporal_credit(steps, final_pnl=100)

        # Should have credits for buy and sell actions
        assert len(credits) == 2

        # Later decisions get more weight
        buy_credit = next(c for c in credits if c.decision_step == 0)
        sell_credit = next(c for c in credits if c.decision_step == 2)

        assert sell_credit.credit_weight > buy_credit.credit_weight

    def test_attribute_credit_per_market(self):
        """Credit attribution with per-market outcome data."""
        steps = [
            {"action": {"actionType": "buy", "parameters": {"marketId": "BTC"}}},
            {"action": {"actionType": "buy", "parameters": {"marketId": "ETH"}}},
        ]

        outcome_data = {"BTC": 100, "ETH": -50}
        credits = attribute_temporal_credit(steps, final_pnl=50, outcome_data=outcome_data)

        btc_credit = next(c for c in credits if c.market_id == "BTC")
        eth_credit = next(c for c in credits if c.market_id == "ETH")

        assert btc_credit.outcome_pnl > 0
        assert eth_credit.outcome_pnl < 0

    def test_aggregate_credits_by_market(self):
        """Credits can be aggregated by market."""
        credits = [
            TemporalCredit(
                decision_step=0, outcome_step=5, credit_weight=0.9, outcome_pnl=50, market_id="BTC"
            ),
            TemporalCredit(
                decision_step=2, outcome_step=5, credit_weight=0.8, outcome_pnl=50, market_id="BTC"
            ),
            TemporalCredit(
                decision_step=1,
                outcome_step=5,
                credit_weight=0.85,
                outcome_pnl=-30,
                market_id="ETH",
            ),
        ]

        by_market = aggregate_credits_by_market(credits)

        assert by_market["BTC"] == 100
        assert by_market["ETH"] == -30

    def test_temporal_credit_bonus_calculation(self):
        """Temporal credit bonus scales correctly."""
        credits = [
            TemporalCredit(decision_step=0, outcome_step=5, credit_weight=0.9, outcome_pnl=500),
        ]

        bonus = calculate_temporal_credit_bonus(credits, starting_balance=10000)

        # 500 * 0.9 = 450 credited, 4.5% of starting = 0.45 bonus
        assert 0.4 < bonus < 0.5


# =============================================================================
# Enhanced Composite Reward Tests
# =============================================================================


class TestEnhancedCompositeReward:
    """Tests for the enhanced composite reward function."""

    def test_fallback_to_archetype_reward_without_regime(self):
        """Without regime context, falls back to archetype_composite_reward."""
        inputs = TrajectoryRewardInputs(
            final_pnl=500,
            starting_balance=10000,
            end_balance=10500,
            format_score=0.8,
            reasoning_score=0.7,
        )

        enhanced = enhanced_composite_reward(
            inputs=inputs,
            archetype="trader",
            behavior_metrics=None,
            regime_overall=None,
        )

        archetype = archetype_composite_reward(
            inputs=inputs,
            archetype="trader",
            behavior_metrics=None,
        )

        assert enhanced == archetype

    def test_enhanced_reward_with_regime(self):
        """Enhanced reward uses regime adjustment when available."""
        inputs = TrajectoryRewardInputs(
            final_pnl=500,
            starting_balance=10000,
            end_balance=10500,
            format_score=0.8,
            reasoning_score=0.7,
        )

        # Bull market: +500 is only +5% (expected), so alpha = 0
        bull_reward = enhanced_composite_reward(
            inputs=inputs,
            archetype="trader",
            regime_overall="bull",
            regime_volatility=0.3,
            regime_expected_return=0.05,
            counterfactual_alpha=0,
        )

        # Bear market: +500 is +5% vs -5% expected, so alpha = +1000
        bear_reward = enhanced_composite_reward(
            inputs=inputs,
            archetype="trader",
            regime_overall="bear",
            regime_volatility=0.3,
            regime_expected_return=-0.05,
            counterfactual_alpha=1000,
        )

        # Bear market performance should be rewarded more
        assert bear_reward > bull_reward

    def test_enhanced_reward_bounded(self):
        """Enhanced reward stays in [-1.0, 1.0] range."""
        inputs = TrajectoryRewardInputs(
            final_pnl=5000,  # Huge profit
            starting_balance=10000,
            end_balance=15000,
            format_score=1.0,
            reasoning_score=1.0,
        )

        reward = enhanced_composite_reward(
            inputs=inputs,
            archetype="trader",
            regime_overall="sideways",
            regime_volatility=0.1,
            regime_expected_return=0.0,
            counterfactual_alpha=5000,
        )

        assert -1.0 <= reward <= 1.0

    def test_temporal_credits_integrated(self):
        """Temporal credits are included in enhanced reward."""
        inputs = TrajectoryRewardInputs(
            final_pnl=0,  # No raw P&L
            starting_balance=10000,
            end_balance=10000,
            format_score=0.5,
            reasoning_score=0.5,
        )

        credits = [
            TemporalCredit(decision_step=0, outcome_step=5, credit_weight=1.0, outcome_pnl=500),
        ]

        with_credits = enhanced_composite_reward(
            inputs=inputs,
            archetype="trader",
            regime_overall="sideways",
            regime_expected_return=0.0,
            temporal_credits=credits,
        )

        without_credits = enhanced_composite_reward(
            inputs=inputs,
            archetype="trader",
            regime_overall="sideways",
            regime_expected_return=0.0,
            temporal_credits=[],
        )

        assert with_credits > without_credits


# =============================================================================
# Reward Config Tests
# =============================================================================


class TestRewardConfig:
    """Tests for reward weight configuration loading."""

    def test_default_weights_available(self):
        """Default weight profile is always available."""
        weights = get_reward_weights("default")

        assert "regime_pnl" in weights
        assert "skill_alpha" in weights
        assert "temporal_bonus" in weights
        assert "format" in weights
        assert "reasoning" in weights
        assert "behavior" in weights

    def test_weights_sum_to_one(self):
        """Weight profiles sum to 1.0."""
        for profile in list_weight_profiles():
            weights = get_reward_weights(profile)
            total = sum(weights.values())
            # Allow small floating point error
            assert abs(total - 1.0) < 0.01, f"Profile {profile} sums to {total}"

    def test_regime_expected_returns(self):
        """Regime expected returns are configured."""
        assert get_regime_expected_return("bull") == 0.05
        assert get_regime_expected_return("bear") == -0.05
        assert get_regime_expected_return("sideways") == 0.0

        # Unknown regime defaults to 0
        assert get_regime_expected_return("unknown") == 0.0

    def test_temporal_decay_rate(self):
        """Temporal decay rate is configured."""
        decay = get_temporal_decay_rate()
        assert 0.0 < decay <= 1.0


# =============================================================================
# Integration Tests
# =============================================================================


class TestEnhancedRewardsIntegration:
    """Integration tests for the complete enhanced reward pipeline."""

    def test_full_pipeline_bull_market(self):
        """Full pipeline test in bull market."""
        # Simulate bull market trajectory
        trajectory = {
            "final_pnl": 300,
            "metadata": {
                "price_context": {
                    "initial_prices": {"BTC": 100000, "ETH": 4000},
                    "final_prices": {"BTC": 110000, "ETH": 4400},  # +10% each
                }
            },
            "steps": [
                {"action": {"actionType": "buy", "parameters": {"marketId": "BTC"}}},
                {"action": {"actionType": "sell", "parameters": {"marketId": "BTC"}}},
            ],
        }

        # Extract regime
        regime = extract_regime_from_trajectory(trajectory)
        assert regime is not None
        assert regime.overall == "bull"

        # Compute counterfactual
        expected_return = get_regime_expected_return(regime.overall)
        counterfactual = compute_counterfactual(
            actual_pnl=trajectory["final_pnl"],
            starting_balance=10000,
            regime_overall=regime.overall,
            regime_expected_return=expected_return,
        )

        # In bull market with +5% expected, +3% actual = negative alpha
        assert counterfactual.alpha < 0

        # Compute temporal credits
        credits = attribute_temporal_credit(
            trajectory["steps"],
            trajectory["final_pnl"],
        )
        assert len(credits) == 2

        # Compute enhanced reward
        inputs = TrajectoryRewardInputs(
            final_pnl=trajectory["final_pnl"],
            starting_balance=10000,
            end_balance=10300,
            format_score=0.8,
            reasoning_score=0.7,
        )

        reward = enhanced_composite_reward(
            inputs=inputs,
            archetype="trader",
            regime_overall=regime.overall,
            regime_volatility=regime.volatility,
            regime_expected_return=expected_return,
            counterfactual_alpha=counterfactual.alpha,
            temporal_credits=credits,
        )

        # Should still be positive (profitable) but not max due to underperformance
        assert -1.0 <= reward <= 1.0

    def test_full_pipeline_bear_market_outperformance(self):
        """Full pipeline test: outperforming in bear market."""
        # Simulate bear market trajectory
        trajectory = {
            "final_pnl": -200,  # Lost 2%
            "metadata": {
                "price_context": {
                    "initial_prices": {"BTC": 100000, "ETH": 4000},
                    "final_prices": {"BTC": 90000, "ETH": 3600},  # -10% each
                }
            },
            "steps": [
                {"action": {"actionType": "sell", "parameters": {"marketId": "BTC"}}},
            ],
        }

        # Extract regime
        regime = extract_regime_from_trajectory(trajectory)
        assert regime.overall == "bear"

        # Compute counterfactual
        expected_return = get_regime_expected_return(regime.overall)  # -5%
        counterfactual = compute_counterfactual(
            actual_pnl=trajectory["final_pnl"],
            starting_balance=10000,
            regime_overall=regime.overall,
            regime_expected_return=expected_return,
        )

        # Lost -2% vs expected -5% = positive alpha (+3% = +300)
        assert counterfactual.alpha > 0

        # Enhanced reward should recognize the outperformance
        inputs = TrajectoryRewardInputs(
            final_pnl=trajectory["final_pnl"],
            starting_balance=10000,
            end_balance=9800,
            format_score=0.8,
            reasoning_score=0.7,
        )

        reward = enhanced_composite_reward(
            inputs=inputs,
            archetype="trader",
            regime_overall=regime.overall,
            regime_volatility=regime.volatility,
            regime_expected_return=expected_return,
            counterfactual_alpha=counterfactual.alpha,
        )

        # Should be positive despite negative P&L due to outperformance
        assert reward > 0


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
