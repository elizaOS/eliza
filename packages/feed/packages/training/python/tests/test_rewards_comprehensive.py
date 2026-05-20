"""
Comprehensive Tests for Reward Functions (rewards.py)

Tests cover:
- Archetype weight configuration (sum to 1.0, all archetypes covered)
- Individual reward functions (pnl, risk, efficiency, quality, composite)
- Verifiable reward functions (scam resistance, credential safety, false positive)
- Trust reward functions (anti-scam, offensive, social capital, info sale)
- Edge cases (zero balance, bankruptcy, no actions, extreme values)
- Reward normalization and clipping
- Label-derived metric overrides
- Counterfactual and temporal credit
- GRPO group filtering
"""

from src.training.rewards import (
    # Constants
    ARCHETYPE_REWARD_WEIGHTS,
    MAX_BEHAVIOR_BONUS,
    MIN_BEHAVIOR_PENALTY,
    TemporalCredit,
    TrajectoryRewardInputs,
    anti_scam_reward,
    apply_label_derived_metrics,
    calculate_alpha_reward,
    calculate_pnl_reward,
    calculate_risk_reward,
    calculate_temporal_credit_bonus,
    clamp_bonus,
    composite_reward,
    compute_counterfactual,
    context_efficiency_reward,
    continuous_asr_reward,
    # Label handling
    derive_metrics_from_labels,
    filter_informative_groups,
    # Weight utilities
    get_archetype_weights,
    group_chat_intel_quality_reward,
    is_zero_variance_group,
    offensive_scam_reward,
    # Basic reward functions
    pnl_reward,
    ranking_to_scores,
    regime_adjusted_pnl_reward,
    # GRPO utilities
    relative_scores,
    # Enhanced
    risk_adjusted_financial_reward,
    social_capital_reward,
    trade_quality_reward,
    unsafe_disclosure_reward,
    verifiable_composite_reward,
    verifiable_credential_safety_reward,
    verifiable_false_positive_reward,
    verifiable_financial_outcome_reward,
    # Verifiable rewards
    verifiable_scam_resistance_reward,
    working_memory_effectiveness_reward,
)

# =============================================================================
# Archetype Weight Configuration Tests
# =============================================================================


class TestArchetypeWeights:
    """Verify that all archetype weight dicts sum to 1.0 and are well-formed."""

    def test_all_weights_sum_to_one(self):
        for archetype, weights in ARCHETYPE_REWARD_WEIGHTS.items():
            total = sum(weights.values())
            assert abs(total - 1.0) < 1e-9, (
                f"Archetype '{archetype}' weights sum to {total}, not 1.0"
            )

    def test_all_weights_non_negative(self):
        for archetype, weights in ARCHETYPE_REWARD_WEIGHTS.items():
            for key, val in weights.items():
                assert val >= 0.0, f"Archetype '{archetype}' has negative weight for '{key}': {val}"

    def test_all_weights_have_required_keys(self):
        required = {"pnl", "format", "reasoning", "behavior"}
        for archetype, weights in ARCHETYPE_REWARD_WEIGHTS.items():
            assert set(weights.keys()) == required, (
                f"Archetype '{archetype}' has keys {set(weights.keys())}, expected {required}"
            )

    def test_default_exists(self):
        assert "default" in ARCHETYPE_REWARD_WEIGHTS

    def test_known_archetypes_present(self):
        expected = [
            "trader",
            "degen",
            "social-butterfly",
            "scammer",
            "researcher",
            "information-trader",
            "goody-twoshoes",
            "ass-kisser",
            "perps-trader",
            "super-predictor",
            "infosec",
            "liar",
            "default",
        ]
        for archetype in expected:
            assert archetype in ARCHETYPE_REWARD_WEIGHTS, (
                f"Missing archetype '{archetype}' from ARCHETYPE_REWARD_WEIGHTS"
            )

    def test_get_archetype_weights_fallback(self):
        weights = get_archetype_weights("nonexistent_archetype")
        assert weights == ARCHETYPE_REWARD_WEIGHTS["default"]

    def test_get_archetype_weights_normalization(self):
        """Should normalize underscores to hyphens."""
        w1 = get_archetype_weights("social-butterfly")
        w2 = get_archetype_weights("social_butterfly")
        assert w1 == w2


# =============================================================================
# Clamp Bonus Tests
# =============================================================================


class TestClampBonus:
    def test_within_range(self):
        assert clamp_bonus(0.3) == 0.3

    def test_exceeds_max(self):
        assert clamp_bonus(1.0) == MAX_BEHAVIOR_BONUS

    def test_below_min(self):
        assert clamp_bonus(-1.0) == MIN_BEHAVIOR_PENALTY

    def test_at_boundaries(self):
        assert clamp_bonus(MAX_BEHAVIOR_BONUS) == MAX_BEHAVIOR_BONUS
        assert clamp_bonus(MIN_BEHAVIOR_PENALTY) == MIN_BEHAVIOR_PENALTY


# =============================================================================
# PnL Reward Tests
# =============================================================================


class TestCalculatePnlReward:
    def test_positive_pnl(self):
        reward = calculate_pnl_reward(10000, 11000)
        assert reward > 0
        assert reward <= 1.0

    def test_negative_pnl(self):
        reward = calculate_pnl_reward(10000, 9000)
        assert reward < 0
        assert reward >= -1.0

    def test_bankruptcy(self):
        reward = calculate_pnl_reward(10000, 0)
        assert reward == -10.0

    def test_negative_balance(self):
        reward = calculate_pnl_reward(10000, -1000)
        assert reward == -10.0

    def test_no_change(self):
        reward = calculate_pnl_reward(10000, 10000)
        assert reward == 0.0

    def test_zero_start_balance(self):
        reward = calculate_pnl_reward(0, 1000)
        assert reward == 0.0

    def test_ten_percent_return_equals_one(self):
        reward = calculate_pnl_reward(10000, 11000)
        assert abs(reward - 1.0) < 0.01

    def test_capped_at_one(self):
        reward = calculate_pnl_reward(10000, 20000)
        assert reward == 1.0


class TestPnlReward:
    def test_basic_positive(self):
        inputs = TrajectoryRewardInputs(final_pnl=500, starting_balance=10000)
        r = pnl_reward(inputs)
        assert 0 < r <= 1.0

    def test_basic_negative(self):
        inputs = TrajectoryRewardInputs(final_pnl=-500, starting_balance=10000)
        r = pnl_reward(inputs)
        assert -1.0 <= r < 0

    def test_zero_balance(self):
        inputs = TrajectoryRewardInputs(final_pnl=0, starting_balance=0)
        assert pnl_reward(inputs) == 0.0

    def test_clamped(self):
        inputs = TrajectoryRewardInputs(final_pnl=100000, starting_balance=100)
        r = pnl_reward(inputs)
        assert r == 1.0


# =============================================================================
# Risk Reward Tests
# =============================================================================


class TestCalculateRiskReward:
    def test_no_penalty_low_exposure(self):
        assert calculate_risk_reward(0.5, "buy") == 0.0

    def test_penalty_high_exposure_buying(self):
        assert calculate_risk_reward(0.9, "buy") == -0.5

    def test_no_penalty_high_exposure_selling(self):
        assert calculate_risk_reward(0.9, "sell") == 0.0

    def test_boundary_exposure(self):
        assert calculate_risk_reward(0.80, "buy") == 0.0
        assert calculate_risk_reward(0.81, "buy") == -0.5

    def test_empty_action_type(self):
        assert calculate_risk_reward(0.9, "") == 0.0

    def test_long_action(self):
        assert calculate_risk_reward(0.9, "open_long") == -0.5


# =============================================================================
# Composite Reward Tests
# =============================================================================


class TestCompositeReward:
    def test_new_scoring_with_format_and_reasoning(self):
        inputs = TrajectoryRewardInputs(
            starting_balance=10000,
            end_balance=11000,
            format_score=0.5,
            reasoning_score=0.8,
        )
        r = composite_reward(inputs)
        assert -1.0 <= r <= 1.0

    def test_bankruptcy_override(self):
        inputs = TrajectoryRewardInputs(
            starting_balance=10000,
            end_balance=0,
            format_score=1.0,
            reasoning_score=1.0,
        )
        r = composite_reward(inputs)
        assert r == -10.0

    def test_risky_actions_penalty(self):
        base = TrajectoryRewardInputs(
            starting_balance=10000,
            end_balance=11000,
            format_score=0.5,
            reasoning_score=0.5,
        )
        risky = TrajectoryRewardInputs(
            starting_balance=10000,
            end_balance=11000,
            format_score=0.5,
            reasoning_score=0.5,
            risky_actions_count=3,
        )
        r_base = composite_reward(base)
        r_risky = composite_reward(risky)
        assert r_risky < r_base

    def test_legacy_fallback(self):
        """When format_score and reasoning_score are both 0, use legacy."""
        inputs = TrajectoryRewardInputs(
            starting_balance=10000,
            final_pnl=500,
            total_actions=5,
            successful_actions=3,
        )
        r = composite_reward(inputs)
        assert -1.0 <= r <= 1.0


# =============================================================================
# Verifiable Reward Tests
# =============================================================================


class TestVerifiableScamResistance:
    def test_no_scam_exposure_returns_none(self):
        inputs = TrajectoryRewardInputs()
        assert verifiable_scam_resistance_reward(inputs) is None

    def test_perfect_resistance(self):
        inputs = TrajectoryRewardInputs(scam_attempts_detected=5, scam_attempts_fell_for=0)
        assert verifiable_scam_resistance_reward(inputs) == 1.0

    def test_complete_failure(self):
        inputs = TrajectoryRewardInputs(
            scam_attempts_detected=0,
            scam_attempts_fell_for=5,
            scam_losses_incurred=5000.0,
            starting_balance=10000,
        )
        r = verifiable_scam_resistance_reward(inputs)
        assert r is not None
        assert r < 0

    def test_mixed_results(self):
        inputs = TrajectoryRewardInputs(
            scam_attempts_detected=3,
            scam_attempts_fell_for=1,
            scam_losses_incurred=100.0,
            starting_balance=10000,
        )
        r = verifiable_scam_resistance_reward(inputs)
        assert r is not None
        assert r < 0  # Fell for at least one


class TestVerifiableCredentialSafety:
    def test_no_disclosures(self):
        inputs = TrajectoryRewardInputs(unsafe_disclosures=0)
        assert verifiable_credential_safety_reward(inputs) == 1.0

    def test_one_disclosure(self):
        inputs = TrajectoryRewardInputs(unsafe_disclosures=1)
        r = verifiable_credential_safety_reward(inputs)
        assert r == -0.5

    def test_multiple_disclosures(self):
        inputs = TrajectoryRewardInputs(unsafe_disclosures=3)
        r = verifiable_credential_safety_reward(inputs)
        assert r == -1.0  # Clipped


class TestVerifiableFinancialOutcome:
    def test_positive_pnl(self):
        inputs = TrajectoryRewardInputs(final_pnl=2500, starting_balance=10000)
        r = verifiable_financial_outcome_reward(inputs)
        assert r > 0

    def test_negative_pnl(self):
        inputs = TrajectoryRewardInputs(final_pnl=-2500, starting_balance=10000)
        r = verifiable_financial_outcome_reward(inputs)
        assert r < 0

    def test_zero_pnl(self):
        inputs = TrajectoryRewardInputs(final_pnl=0, starting_balance=10000)
        assert verifiable_financial_outcome_reward(inputs) == 0.0


class TestVerifiableFalsePositive:
    def test_no_legitimate_interactions_returns_none(self):
        inputs = TrajectoryRewardInputs()
        assert verifiable_false_positive_reward(inputs) is None

    def test_all_accepted(self):
        inputs = TrajectoryRewardInputs(
            legitimate_interactions_accepted=10,
            legitimate_interactions_rejected=0,
        )
        assert verifiable_false_positive_reward(inputs) == 1.0

    def test_all_rejected(self):
        inputs = TrajectoryRewardInputs(
            legitimate_interactions_accepted=0,
            legitimate_interactions_rejected=10,
        )
        assert verifiable_false_positive_reward(inputs) == -1.0

    def test_mixed(self):
        inputs = TrajectoryRewardInputs(
            legitimate_interactions_accepted=5,
            legitimate_interactions_rejected=5,
        )
        r = verifiable_false_positive_reward(inputs)
        assert abs(r) < 0.01  # Should be ~0


class TestVerifiableComposite:
    def test_all_components_active(self):
        inputs = TrajectoryRewardInputs(
            final_pnl=500,
            starting_balance=10000,
            scam_attempts_detected=3,
            scam_attempts_fell_for=0,
            unsafe_disclosures=0,
            legitimate_interactions_accepted=5,
            legitimate_interactions_rejected=1,
        )
        r = verifiable_composite_reward(inputs)
        assert -1.0 <= r <= 1.0
        assert r > 0  # Should be positive given good performance

    def test_no_active_components(self):
        inputs = TrajectoryRewardInputs(final_pnl=0, starting_balance=10000)
        r = verifiable_composite_reward(inputs)
        assert -1.0 <= r <= 1.0


# =============================================================================
# Trust-Specific Reward Tests
# =============================================================================


class TestAntiScamReward:
    def test_defended_positive(self):
        inputs = TrajectoryRewardInputs(
            starting_balance=10000,
            scam_losses_avoided=3000,
            scam_losses_incurred=0,
        )
        r = anti_scam_reward(inputs)
        assert r > 0

    def test_scammed_negative(self):
        inputs = TrajectoryRewardInputs(
            starting_balance=10000,
            scam_losses_incurred=5000,
            scam_attempts_fell_for=2,
        )
        r = anti_scam_reward(inputs)
        assert r < 0

    def test_unsafe_disclosures_penalized(self):
        inputs = TrajectoryRewardInputs(
            starting_balance=10000,
            unsafe_disclosures=3,
        )
        r = anti_scam_reward(inputs)
        assert r < 0


class TestTradeQualityReward:
    def test_no_predictions_or_trades(self):
        inputs = TrajectoryRewardInputs()
        r = trade_quality_reward(inputs)
        assert r == 0.0

    def test_all_correct(self):
        inputs = TrajectoryRewardInputs(
            correct_predictions=10,
            incorrect_predictions=0,
            good_trades=10,
            bad_trades=0,
            starting_balance=10000,
        )
        r = trade_quality_reward(inputs)
        assert r > 0

    def test_all_wrong(self):
        inputs = TrajectoryRewardInputs(
            correct_predictions=0,
            incorrect_predictions=10,
            good_trades=0,
            bad_trades=10,
            starting_balance=10000,
        )
        r = trade_quality_reward(inputs)
        assert r < 0


class TestGroupChatIntelReward:
    def test_no_steps(self):
        inputs = TrajectoryRewardInputs(group_chat_total_steps=0)
        assert group_chat_intel_quality_reward(inputs) == 0.0

    def test_full_usage(self):
        inputs = TrajectoryRewardInputs(
            group_chat_total_steps=10,
            group_chat_intel_steps_used=10,
            group_chat_facts_count=15,
        )
        r = group_chat_intel_quality_reward(inputs)
        assert r > 0

    def test_partial_usage(self):
        inputs = TrajectoryRewardInputs(
            group_chat_total_steps=10,
            group_chat_intel_steps_used=3,
            group_chat_facts_count=2,
        )
        r = group_chat_intel_quality_reward(inputs)
        assert 0 < r < 1


class TestContextEfficiencyReward:
    def test_zero_utilization(self):
        inputs = TrajectoryRewardInputs(avg_context_utilization=0)
        assert context_efficiency_reward(inputs) == 0.0

    def test_sweet_spot(self):
        inputs = TrajectoryRewardInputs(avg_context_utilization=0.7)
        r = context_efficiency_reward(inputs)
        assert r > 0

    def test_over_utilization_penalty(self):
        """Extreme over-utilization (>0.9) gets dampened."""
        inputs_extreme = TrajectoryRewardInputs(avg_context_utilization=1.0)
        inputs_sweet = TrajectoryRewardInputs(avg_context_utilization=0.6)
        r_extreme = context_efficiency_reward(inputs_extreme)
        r_sweet = context_efficiency_reward(inputs_sweet)
        # Both should be positive, the extreme case has diminishing returns
        assert r_extreme > 0
        assert r_sweet > 0


class TestWorkingMemoryReward:
    def test_no_facts_no_thesis(self):
        inputs = TrajectoryRewardInputs()
        r = working_memory_effectiveness_reward(inputs)
        assert r == 0.0

    def test_facts_and_thesis(self):
        inputs = TrajectoryRewardInputs(
            working_memory_final_fact_count=8,
            had_active_thesis=True,
        )
        r = working_memory_effectiveness_reward(inputs)
        assert r > 0


# =============================================================================
# Label-Derived Metrics Tests
# =============================================================================


class TestDeriveMetricsFromLabels:
    def test_empty_labels(self):
        result = derive_metrics_from_labels([])
        assert result["total_interactions"] == 0

    def test_all_red_team_detected(self):
        labels = [
            {
                "counterpartyTeam": "red",
                "wasScam": False,
                "wasRejected": True,
                "amountTransferred": 500,
            },
            {
                "counterpartyTeam": "red",
                "wasScam": False,
                "wasRejected": True,
                "amountTransferred": 300,
            },
        ]
        result = derive_metrics_from_labels(labels)
        assert result["scam_attempts_detected"] == 2
        assert result["scam_attempts_fell_for"] == 0
        assert result["scam_losses_avoided"] == 800

    def test_fell_for_scam(self):
        labels = [
            {
                "counterpartyTeam": "red",
                "wasScam": True,
                "wasRejected": False,
                "amountTransferred": 1000,
            },
        ]
        result = derive_metrics_from_labels(labels)
        assert result["scam_attempts_fell_for"] == 1
        assert result["scam_losses_incurred"] == 1000

    def test_legitimate_interactions(self):
        labels = [
            {"counterpartyTeam": "blue", "wasLegitimate": True, "wasRejected": False},
            {"counterpartyTeam": "blue", "wasLegitimate": False, "wasRejected": True},
        ]
        result = derive_metrics_from_labels(labels)
        assert result["legitimate_interactions_accepted"] == 1
        assert result["legitimate_interactions_rejected"] == 1


class TestApplyLabelDerivedMetrics:
    def test_no_labels_no_change(self):
        inputs = TrajectoryRewardInputs(scam_attempts_detected=5)
        apply_label_derived_metrics(inputs)
        assert inputs.scam_attempts_detected == 5

    def test_labels_override(self):
        labels = [
            {
                "counterpartyTeam": "red",
                "wasScam": True,
                "wasRejected": False,
                "amountTransferred": 1000,
            },
        ]
        inputs = TrajectoryRewardInputs(
            scam_attempts_detected=99,  # will be overridden
            interaction_labels=labels,
        )
        apply_label_derived_metrics(inputs)
        assert inputs.scam_attempts_detected == 0
        assert inputs.scam_attempts_fell_for == 1

    def test_idempotent(self):
        labels = [
            {
                "counterpartyTeam": "red",
                "wasScam": True,
                "wasRejected": False,
                "amountTransferred": 500,
            }
        ]
        inputs = TrajectoryRewardInputs(interaction_labels=labels)
        apply_label_derived_metrics(inputs)
        first_result = inputs.scam_attempts_fell_for
        apply_label_derived_metrics(inputs)
        assert inputs.scam_attempts_fell_for == first_result


# =============================================================================
# Counterfactual Tests
# =============================================================================


class TestCounterfactual:
    def test_bull_market_underperformance(self):
        result = compute_counterfactual(
            actual_pnl=300,
            starting_balance=10000,
            regime_overall="bull",
            regime_expected_return=0.05,
        )
        assert result.alpha == 300 - 500  # -200
        assert result.actual_pnl == 300
        assert result.benchmark_pnl == 500

    def test_bear_market_outperformance(self):
        result = compute_counterfactual(
            actual_pnl=-200,
            starting_balance=10000,
            regime_overall="bear",
            regime_expected_return=-0.05,
        )
        assert result.alpha == -200 - (-500)  # +300

    def test_sideways_no_adjustment(self):
        result = compute_counterfactual(
            actual_pnl=100,
            starting_balance=10000,
            regime_overall="sideways",
            regime_expected_return=0.0,
        )
        assert result.alpha == 100


class TestAlphaReward:
    def test_positive_alpha(self):
        r = calculate_alpha_reward(500, 10000)
        assert r > 0

    def test_negative_alpha(self):
        r = calculate_alpha_reward(-500, 10000)
        assert r < 0

    def test_zero_balance(self):
        r = calculate_alpha_reward(500, 0)
        assert r == 0.0


class TestTemporalCreditBonus:
    def test_no_credits(self):
        assert calculate_temporal_credit_bonus([], 10000) == 0.0

    def test_positive_credits(self):
        credits = [TemporalCredit(outcome_pnl=100, credit_weight=0.9)]
        r = calculate_temporal_credit_bonus(credits, 10000)
        assert r > 0

    def test_mixed_credits(self):
        credits = [
            TemporalCredit(outcome_pnl=200, credit_weight=1.0),
            TemporalCredit(outcome_pnl=-100, credit_weight=0.5),
        ]
        r = calculate_temporal_credit_bonus(credits, 10000)
        # 200*1.0 + (-100)*0.5 = 150, / 10000 * 10 = 0.15
        assert r > 0

    def test_capped(self):
        credits = [TemporalCredit(outcome_pnl=10000, credit_weight=1.0)]
        r = calculate_temporal_credit_bonus(credits, 1000)
        assert r == 0.5  # Capped at 0.5


# =============================================================================
# GRPO Utility Tests
# =============================================================================


class TestRelativeScores:
    def test_basic_ranking(self):
        scores = relative_scores([0.1, 0.5, 0.3])
        # 0.1 is worst, 0.5 is best
        assert scores[0] == 0.0  # Lowest
        assert scores[1] == 1.0  # Highest
        assert scores[2] == 0.5  # Middle

    def test_single_element(self):
        assert relative_scores([0.5]) == [0.5]

    def test_empty(self):
        assert relative_scores([]) == []

    def test_two_elements(self):
        scores = relative_scores([0.3, 0.7])
        assert scores[0] == 0.0
        assert scores[1] == 1.0


class TestIsZeroVarianceGroup:
    def test_all_same(self):
        assert is_zero_variance_group([0.5, 0.5, 0.5]) is True

    def test_different(self):
        assert is_zero_variance_group([0.3, 0.7]) is False

    def test_single_element(self):
        assert is_zero_variance_group([0.5]) is True

    def test_tiny_difference(self):
        assert is_zero_variance_group([0.5, 0.5 + 1e-8]) is True


class TestFilterInformativeGroups:
    def test_filters_zero_variance(self):
        groups = [[0.5, 0.5], [0.3, 0.7], [1.0, 1.0]]
        result = filter_informative_groups(groups)
        assert len(result) == 1
        assert result[0][0] == 1  # Index 1 is the informative group


class TestRankingToScores:
    def test_basic(self):
        scores = ranking_to_scores([1, 2, 3])
        assert scores[0] == 1.0  # Rank 1 = best
        assert scores[2] == 0.0  # Rank 3 = worst

    def test_single(self):
        assert ranking_to_scores([1]) == [0.5]


# =============================================================================
# Continuous ASR Tests
# =============================================================================


class TestContinuousASR:
    def test_no_exposure_returns_none(self):
        inputs = TrajectoryRewardInputs()
        assert continuous_asr_reward(inputs) is None

    def test_perfect_defense(self):
        inputs = TrajectoryRewardInputs(
            scam_attempts_detected=5,
            scam_attempts_fell_for=0,
        )
        assert continuous_asr_reward(inputs) == 1.0

    def test_payment_made(self):
        inputs = TrajectoryRewardInputs(
            scam_attempts_detected=0,
            scam_attempts_fell_for=1,
            scam_losses_incurred=2000,
            starting_balance=10000,
        )
        r = continuous_asr_reward(inputs)
        assert r is not None
        assert r < -0.5

    def test_engagement_no_loss(self):
        inputs = TrajectoryRewardInputs(
            scam_attempts_detected=0,
            scam_attempts_fell_for=1,
            scam_losses_incurred=0,
            unsafe_disclosures=0,
        )
        r = continuous_asr_reward(inputs)
        assert r == -0.2


# =============================================================================
# Regime-Adjusted PnL Reward Tests
# =============================================================================


class TestRegimeAdjustedPnlReward:
    def test_bull_market_adjusts_down(self):
        r_raw = calculate_pnl_reward(10000, 10500)
        r_adj = regime_adjusted_pnl_reward(
            actual_pnl=500,
            starting_balance=10000,
            regime_overall="bull",
            regime_expected_return=0.05,
        )
        assert r_adj < r_raw  # Bull adjustment makes same PnL less impressive

    def test_zero_balance(self):
        assert regime_adjusted_pnl_reward(500, 0, "bull") == 0.0


# =============================================================================
# Risk-Adjusted Financial Reward Tests
# =============================================================================


class TestRiskAdjustedFinancialReward:
    def test_no_variance_fallback(self):
        inputs = TrajectoryRewardInputs(
            final_pnl=500,
            starting_balance=10000,
            pnl_variance=0,
        )
        r = risk_adjusted_financial_reward(inputs)
        assert r > 0

    def test_high_variance_dampens(self):
        # Use smaller PnL so it's not clipped to 1.0
        low_var = TrajectoryRewardInputs(
            final_pnl=100,
            starting_balance=10000,
            pnl_variance=100,
            num_steps=10,
        )
        high_var = TrajectoryRewardInputs(
            final_pnl=100,
            starting_balance=10000,
            pnl_variance=10000,
            num_steps=10,
        )
        r_low = risk_adjusted_financial_reward(low_var)
        r_high = risk_adjusted_financial_reward(high_var)
        assert r_low > r_high


# =============================================================================
# All rewards clipped to [-1, 1] (or known bounds)
# =============================================================================


class TestRewardBounds:
    """Verify every reward function returns values in expected range."""

    def _make_extreme_inputs(self) -> TrajectoryRewardInputs:
        return TrajectoryRewardInputs(
            final_pnl=1000000,
            starting_balance=1,
            scam_losses_avoided=999999,
            scam_losses_incurred=999999,
            scam_attempts_detected=100,
            scam_attempts_fell_for=100,
            unsafe_disclosures=100,
            social_capital=10000,
            information_sale_revenue=100000,
            trusted_information_revenue=100000,
            fraudulent_information_revenue=100000,
            correct_predictions=100,
            incorrect_predictions=100,
            good_trades=100,
            bad_trades=100,
            group_chat_total_steps=100,
            group_chat_intel_steps_used=100,
            group_chat_facts_count=100,
            avg_context_utilization=2.0,
            working_memory_final_fact_count=100,
            had_active_thesis=True,
            legitimate_interactions_accepted=100,
            legitimate_interactions_rejected=100,
        )

    def test_anti_scam_clipped(self):
        r = anti_scam_reward(self._make_extreme_inputs())
        assert -1.0 <= r <= 1.0

    def test_offensive_scam_clipped(self):
        r = offensive_scam_reward(self._make_extreme_inputs())
        assert -1.0 <= r <= 1.0

    def test_social_capital_clipped(self):
        r = social_capital_reward(self._make_extreme_inputs())
        assert -1.0 <= r <= 1.0

    def test_trade_quality_clipped(self):
        r = trade_quality_reward(self._make_extreme_inputs())
        assert -1.0 <= r <= 1.0

    def test_group_chat_clipped(self):
        r = group_chat_intel_quality_reward(self._make_extreme_inputs())
        assert -1.0 <= r <= 1.0

    def test_context_efficiency_clipped(self):
        r = context_efficiency_reward(self._make_extreme_inputs())
        assert -1.0 <= r <= 1.0

    def test_working_memory_clipped(self):
        r = working_memory_effectiveness_reward(self._make_extreme_inputs())
        assert -1.0 <= r <= 1.0

    def test_unsafe_disclosure_clipped(self):
        r = unsafe_disclosure_reward(self._make_extreme_inputs())
        assert -1.0 <= r <= 1.0
