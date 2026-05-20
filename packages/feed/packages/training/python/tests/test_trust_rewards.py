"""
Tests for trust/scam reward functions and profile mixing.
"""

from src.training.reward_config import blend_weight_profiles, get_reward_weights
from src.training.rewards import (
    TrajectoryRewardInputs,
    anti_scam_reward,
    enhanced_composite_reward,
    information_sale_reward,
    mixed_motive_grpo_reward,
    offensive_scam_reward,
    social_capital_reward,
    trade_quality_reward,
    trust_objective_reward,
    trust_reward_breakdown,
)
from src.training.schemas import StepSchema, TrajectorySchema


class TestTrustRewardFunctions:
    def _make_inputs(self) -> TrajectoryRewardInputs:
        return TrajectoryRewardInputs(
            final_pnl=500,
            starting_balance=10000,
            end_balance=10500,
            format_score=0.8,
            reasoning_score=0.7,
            scam_losses_avoided=1800,
            scam_losses_incurred=100,
            scam_attempts_fell_for=0,
            unsafe_disclosures=0,
            social_capital=45,
            information_sale_revenue=300,
            trusted_information_revenue=300,
            fraudulent_information_revenue=0,
            correct_predictions=4,
            incorrect_predictions=1,
            good_trades=3,
            bad_trades=1,
            prediction_pnl=220,
            leveraged_pnl=280,
        )

    def test_blue_objective_prefers_defense(self):
        inputs = self._make_inputs()
        reward = trust_objective_reward(inputs, "trust_blue")
        assert reward > 0
        assert anti_scam_reward(inputs) > 0
        assert social_capital_reward(inputs) > 0

    def test_red_objective_rewards_extraction(self):
        inputs = self._make_inputs()
        inputs.successful_scams = 2
        inputs.fraudulent_information_revenue = 650

        assert offensive_scam_reward(inputs) > 0
        assert trust_objective_reward(inputs, "trust_red") > 0

    def test_information_sale_reward_penalizes_fraud_by_default(self):
        inputs = self._make_inputs()
        clean_score = information_sale_reward(inputs)
        inputs.fraudulent_information_revenue = 1000
        dirty_score = information_sale_reward(inputs)
        assert dirty_score < clean_score

    def test_trade_quality_uses_accuracy_and_trade_outcomes(self):
        inputs = self._make_inputs()
        strong = trade_quality_reward(inputs)
        inputs.correct_predictions = 1
        inputs.incorrect_predictions = 4
        inputs.good_trades = 1
        inputs.bad_trades = 3
        weak = trade_quality_reward(inputs)
        assert strong > weak

    def test_grpo_mix_blends_auxiliary_profiles(self):
        inputs = self._make_inputs()
        mixed = mixed_motive_grpo_reward(
            inputs,
            primary_profile="trust_blue",
            auxiliary_profiles=["trust_relationship", "trust_mixed"],
            auxiliary_mix=0.25,
        )
        assert -1.0 <= mixed <= 1.0

    def test_reward_breakdown_contains_weighted_components(self):
        inputs = self._make_inputs()
        breakdown = trust_reward_breakdown(inputs, "trust_mixed")
        assert breakdown.total_score != 0
        assert breakdown.anti_scam_component > 0
        assert breakdown.trade_quality_component > 0

    def test_enhanced_composite_uses_trust_profile_without_regime_context(self):
        inputs = self._make_inputs()
        inputs.final_pnl = 0
        inputs.end_balance = inputs.starting_balance
        inputs.format_score = 0.0
        inputs.reasoning_score = 0.0

        default_score = enhanced_composite_reward(
            inputs,
            archetype="trader",
            weight_profile="default",
        )
        trust_score = enhanced_composite_reward(
            inputs,
            archetype="trader",
            weight_profile="trust_blue",
        )

        assert trust_score > default_score
        assert trust_score > 0


class TestTrustRewardProfiles:
    def test_trust_profiles_exist(self):
        for profile in ("trust_blue", "trust_red", "trust_relationship", "trust_mixed"):
            weights = get_reward_weights(profile)
            assert abs(sum(weights.values()) - 1.0) < 0.01

    def test_blended_profile_stays_normalized(self):
        weights = blend_weight_profiles(
            "trust_blue",
            ["trust_relationship", "trust_mixed"],
            secondary_ratio=0.2,
        )
        assert abs(sum(weights.values()) - 1.0) < 1e-6
        assert weights["anti_scam"] > 0


class TestTrustSchemas:
    def test_step_schema_parses_trust_state(self):
        step = StepSchema.from_dict(
            {
                "stepNumber": 1,
                "trustState": {
                    "profile": "blue",
                    "trustScore": 72.5,
                    "scamLossesAvoided": 1500,
                    "socialCapital": 25,
                },
            }
        )
        assert step.trust_state.profile == "blue"
        assert step.trust_state.trust_score == 72.5
        assert step.trust_state.scam_losses_avoided == 1500

    def test_trajectory_schema_parses_final_trust_fields(self):
        trajectory = TrajectorySchema.from_dict(
            {
                "trajectoryId": "traj-1",
                "agentId": "agent-1",
                "windowId": "window-1",
                "finalTrustScore": 68.0,
                "scenarioProfile": "blue",
            }
        )
        assert trajectory.final_trust_score == 68.0
        assert trajectory.scenario_profile == "blue"

    def test_trajectory_schema_parses_trust_fields_from_nested_json(self):
        trajectory = TrajectorySchema.from_dict(
            {
                "trajectoryId": "traj-2",
                "agentId": "agent-2",
                "windowId": "window-2",
                "metricsJson": '{"finalTrustScore": 71.5}',
                "metadataJson": '{"scenarioProfile": "mixed"}',
            }
        )
        assert trajectory.final_trust_score == 71.5
        assert trajectory.scenario_profile == "mixed"
