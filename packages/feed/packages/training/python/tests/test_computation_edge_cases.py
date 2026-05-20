"""
Fuzz and edge-case tests for reward and trust decomposition functions.

Validates invariants (bounded output, no NaN/Inf) under randomized and
boundary inputs.
"""

import math
import random

import pytest

from src.training.rewards import (
    TrajectoryRewardInputs,
    apply_label_derived_metrics,
    continuous_asr_reward,
    derive_metrics_from_labels,
    outcome_only_reward,
    verifiable_composite_reward,
    verifiable_credential_safety_reward,
    verifiable_false_positive_reward,
    verifiable_financial_outcome_reward,
    verifiable_scam_resistance_reward,
)
from src.training.trust_decomposition import (
    compute_trust_score,
    is_value_proportional,
    trust_decomposition_reward,
)

# =============================================================================
# 1. Fuzz tests — randomized inputs, verify invariants hold
# =============================================================================


class TestRewardFuzzing:
    """Generate random inputs and verify all reward functions maintain invariants."""

    def _random_inputs(self, seed: int) -> TrajectoryRewardInputs:
        rng = random.Random(seed)
        return TrajectoryRewardInputs(
            final_pnl=rng.uniform(-50000, 50000),
            starting_balance=rng.uniform(1, 100000),
            scam_attempts_detected=rng.randint(0, 20),
            scam_attempts_fell_for=rng.randint(0, 20),
            scam_losses_incurred=rng.uniform(0, 10000),
            scam_losses_avoided=rng.uniform(0, 10000),
            unsafe_disclosures=rng.randint(0, 10),
            legitimate_interactions_accepted=rng.randint(0, 20),
            legitimate_interactions_rejected=rng.randint(0, 20),
            social_capital=rng.uniform(0, 100),
            information_sale_revenue=rng.uniform(0, 5000),
            trusted_information_revenue=rng.uniform(0, 5000),
        )

    @pytest.mark.parametrize("seed", range(25))
    def test_verifiable_composite_always_in_range(self, seed):
        inputs = self._random_inputs(seed)
        result = verifiable_composite_reward(inputs)
        assert -1.0 <= result <= 1.0, f"seed={seed}: result={result}"
        assert not math.isnan(result), f"seed={seed}: NaN"
        assert not math.isinf(result), f"seed={seed}: Inf"

    @pytest.mark.parametrize("seed", range(25))
    def test_continuous_asr_in_range_or_none(self, seed):
        inputs = self._random_inputs(seed)
        result = continuous_asr_reward(inputs)
        if result is not None:
            assert -1.0 <= result <= 1.0, f"seed={seed}: result={result}"
            assert not math.isnan(result)

    @pytest.mark.parametrize("seed", range(25))
    def test_outcome_only_in_range(self, seed):
        inputs = self._random_inputs(seed)
        result = outcome_only_reward(inputs)
        assert -1.0 <= result <= 1.0, f"seed={seed}: result={result}"
        assert not math.isnan(result)
        assert not math.isinf(result)

    @pytest.mark.parametrize("seed", range(25))
    def test_scam_resistance_in_range_or_none(self, seed):
        inputs = self._random_inputs(seed)
        result = verifiable_scam_resistance_reward(inputs)
        if result is not None:
            assert -1.0 <= result <= 1.0

    @pytest.mark.parametrize("seed", range(25))
    def test_false_positive_in_range_or_none(self, seed):
        inputs = self._random_inputs(seed)
        result = verifiable_false_positive_reward(inputs)
        if result is not None:
            assert -1.0 <= result <= 1.0

    @pytest.mark.parametrize("seed", range(25))
    def test_credential_safety_in_range(self, seed):
        inputs = self._random_inputs(seed)
        result = verifiable_credential_safety_reward(inputs)
        assert -1.0 <= result <= 1.0

    @pytest.mark.parametrize("seed", range(25))
    def test_financial_outcome_in_range(self, seed):
        inputs = self._random_inputs(seed)
        result = verifiable_financial_outcome_reward(inputs)
        assert -1.0 <= result <= 1.0


# =============================================================================
# 2. Edge cases — boundary conditions
# =============================================================================


class TestRewardEdgeCases:
    def test_zero_starting_balance(self):
        """starting_balance=0 should not cause division by zero."""
        inputs = TrajectoryRewardInputs(starting_balance=0.0, final_pnl=100.0)
        result = verifiable_composite_reward(inputs)
        assert not math.isnan(result)

    def test_negative_starting_balance(self):
        """Negative starting_balance should not cause issues."""
        inputs = TrajectoryRewardInputs(starting_balance=-1000.0)
        result = verifiable_composite_reward(inputs)
        assert not math.isnan(result)

    def test_very_large_pnl(self):
        inputs = TrajectoryRewardInputs(final_pnl=1e15, starting_balance=100.0)
        result = verifiable_financial_outcome_reward(inputs)
        assert result == 1.0  # Clipped

    def test_very_large_scam_losses(self):
        inputs = TrajectoryRewardInputs(
            scam_losses_incurred=1e15,
            scam_attempts_fell_for=1,
            scam_attempts_detected=1,
            starting_balance=100.0,
        )
        result = verifiable_scam_resistance_reward(inputs)
        assert result is not None
        assert result <= -0.5

    def test_equal_detected_and_fell(self):
        """50/50 split should give a moderate negative score."""
        inputs = TrajectoryRewardInputs(
            scam_attempts_detected=5,
            scam_attempts_fell_for=5,
            scam_losses_incurred=500.0,
            starting_balance=10000.0,
        )
        result = verifiable_scam_resistance_reward(inputs)
        assert result is not None
        assert -1.0 < result < 0.0

    def test_false_positive_exactly_one_each(self):
        inputs = TrajectoryRewardInputs(
            legitimate_interactions_accepted=1,
            legitimate_interactions_rejected=1,
        )
        result = verifiable_false_positive_reward(inputs)
        assert result == pytest.approx(0.0)

    def test_all_interactions_zero(self):
        """No interactions at all - most components should be None."""
        inputs = TrajectoryRewardInputs()
        assert verifiable_scam_resistance_reward(inputs) is None
        assert verifiable_false_positive_reward(inputs) is None
        assert continuous_asr_reward(inputs) is None

    def test_labels_with_missing_fields(self):
        """Labels with missing optional fields should not crash."""
        labels = [
            {"counterpartyTeam": "red"},  # minimal label
            {"counterpartyTeam": "blue", "wasLegitimate": True},
        ]
        result = derive_metrics_from_labels(labels)
        assert result["total_interactions"] == 2

    def test_labels_with_none_amount(self):
        """amountTransferred=None should be treated as 0."""
        labels = [
            {"counterpartyTeam": "red", "wasScam": True, "amountTransferred": None},
        ]
        result = derive_metrics_from_labels(labels)
        assert result["scam_losses_incurred"] == 0

    def test_apply_metrics_with_empty_list_is_noop(self):
        inputs = TrajectoryRewardInputs(
            interaction_labels=[],
            scam_attempts_detected=5,
        )
        apply_label_derived_metrics(inputs)
        assert inputs.scam_attempts_detected == 5  # Unchanged

    def test_composite_with_all_none_components(self):
        """If ALL optional components return None, should return valid float."""
        inputs = TrajectoryRewardInputs()  # No scam, no legit, nothing
        # Some components always return float (credential_safety, financial_outcome, outcome_only)
        # so this should still produce a valid result
        result = verifiable_composite_reward(inputs)
        assert not math.isnan(result)

    def test_continuous_asr_with_labels_only_blue(self):
        """Labels present but no red team -> should return None."""
        inputs = TrajectoryRewardInputs(
            interaction_labels=[
                {"counterpartyTeam": "blue", "wasLegitimate": True},
                {"counterpartyTeam": "gray", "wasRejected": False},
            ],
            scam_attempts_detected=0,
            scam_attempts_fell_for=0,
        )
        result = continuous_asr_reward(inputs)
        assert result is None


# =============================================================================
# 3. Trust decomposition edge cases
# =============================================================================


class TestTrustDecompositionEdgeCases:
    def test_very_large_amount(self):
        result = is_value_proportional(1e12, 1)
        assert result == 0.1
        assert not math.isnan(result)

    def test_zero_amount_zero_relationship(self):
        result = is_value_proportional(0.0, 0)
        assert result == 1.0

    def test_negative_relationship_length(self):
        """Negative relationship_length: effective_length=max(-5,1)=1, ratio=100, within linear decay."""
        result = is_value_proportional(100.0, -5)
        # max(-5, 1) = 1, ratio = 100/1 = 100, 100 <= max_safe_ratio(100)
        # so linear decay: 1.0 - 0.7 * (100/100) = 0.3
        assert result == pytest.approx(0.3)

    def test_compute_trust_score_weights_sum_to_1(self):
        """Verify the weight constants sum to exactly 1.0."""
        result = compute_trust_score("a", "dm", "trading")
        known = result["counterparty_known"]
        channel = result["channel_appropriate"]
        value = result["value_proportional"]
        claims = result["claims_verifiable"]
        expected = 0.35 * known + 0.20 * channel + 0.25 * value + 0.20 * claims
        assert result["composite_trust"] == pytest.approx(expected, abs=1e-10)

    def test_all_sub_scores_bounded(self):
        """All sub-scores should be in [0, 1]."""
        test_cases = [
            ("x", "dm", "trading", 0.0, 0, None, None),
            ("x", "email", "support", 1e9, 1, ["trust me"], {"x": {}}),
            ("known", "trade", "payment", 0.01, 1000, ["etherscan 0x verify docs"], {"known": {}}),
        ]
        for cp, ch, rt, amt, rl, claims, imap in test_cases:
            result = compute_trust_score(cp, ch, rt, amt, rl, claims, imap)
            for key, value in result.items():
                assert 0.0 <= value <= 1.0, f"{key}={value} for inputs ({cp},{ch},{rt},{amt},{rl})"

    @pytest.mark.parametrize("seed", range(25))
    def test_trust_reward_fuzz(self, seed):
        """Random labels should always produce result in [-1, 1] or None."""
        rng = random.Random(seed)
        n_labels = rng.randint(0, 10)
        labels = []
        for _ in range(n_labels):
            labels.append(
                {
                    "counterpartyId": f"agent-{rng.randint(0, 100)}",
                    "counterpartyTeam": rng.choice(["red", "blue", "gray"]),
                    "channel": rng.choice(["dm", "group-chat", "trade", "support-ticket"]),
                    "wasScam": rng.choice([True, False]),
                    "wasRejected": rng.choice([True, False]),
                    "wasLegitimate": rng.choice([True, False]),
                    "amountTransferred": rng.uniform(0, 10000) if rng.random() > 0.3 else None,
                    "messageCount": rng.randint(0, 100),
                }
            )
        identity_map = {
            f"agent-{i}": {"team": rng.choice(["red", "blue", "gray"])} for i in range(20)
        }
        result = trust_decomposition_reward(labels, identity_map)
        if result is not None:
            assert -1.0 <= result <= 1.0, f"seed={seed}: result={result}"
            assert not math.isnan(result)

    def test_none_claims_in_compute(self):
        result = compute_trust_score("a", "dm", "trading", claims=None)
        assert result["claims_verifiable"] == 0.5  # None -> empty list -> 0.5

    def test_value_proportional_at_exact_boundary(self):
        """Test at exactly max_safe_ratio * 0.1 boundary."""
        # ratio = amount / 1 = amount. threshold = 100 * 0.1 = 10
        assert is_value_proportional(10.0, 1) == 1.0  # At boundary = very safe
        assert is_value_proportional(10.01, 1) < 1.0  # Just over

    def test_value_proportional_at_max_boundary(self):
        """At exactly max_safe_ratio."""
        result = is_value_proportional(100.0, 1)
        # ratio=100, 100 <= 100 -> linear decay: 1.0 - 0.7*(100/100) = 0.3
        assert result == pytest.approx(0.3)


# =============================================================================
# 4. Interaction between label derivation and rewards
# =============================================================================


class TestLabelRewardInteraction:
    def test_labels_override_wrong_heuristics(self):
        """Labels should correct wrong heuristic counters when apply is called."""
        inputs = TrajectoryRewardInputs(
            scam_attempts_detected=0,  # Wrong: heuristic says 0 detected
            scam_attempts_fell_for=5,  # Wrong: heuristic says 5 fell for
            interaction_labels=[
                # Truth: detected 3, fell for 0
                {"counterpartyTeam": "red", "wasRejected": True, "wasScam": False},
                {"counterpartyTeam": "red", "wasRejected": True, "wasScam": False},
                {"counterpartyTeam": "red", "wasRejected": True, "wasScam": False},
            ],
        )
        # Must explicitly apply labels first since verifiable_scam_resistance_reward
        # does not call apply_label_derived_metrics internally
        apply_label_derived_metrics(inputs)
        assert inputs.scam_attempts_detected == 3
        assert inputs.scam_attempts_fell_for == 0
        result = verifiable_scam_resistance_reward(inputs)
        assert result == 1.0  # Labels say all scams resisted

    def test_outcome_only_with_labels(self):
        """outcome_only_reward should use label-derived metrics."""
        inputs = TrajectoryRewardInputs(
            final_pnl=1000.0,
            starting_balance=10000.0,
            interaction_labels=[
                {"counterpartyTeam": "red", "wasRejected": True, "wasScam": False},
                {"counterpartyTeam": "blue", "wasLegitimate": True},
            ],
        )
        result = outcome_only_reward(inputs)
        # pnl positive, scam exposure survived, legit accepted
        assert result > 0.0
