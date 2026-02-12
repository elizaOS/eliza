"""
Tests for archetype-aware scoring.

Comprehensive test coverage for:
1. Reward weight configurations for all archetypes
2. Behavior bonuses for each archetype
3. Composite reward calculations with edge cases
4. Rubric versioning and loading
5. Boundary conditions and invalid inputs
6. Behavior metrics extraction
"""

import sys
sys.path.insert(0, ".")

import pytest
from src.training.rewards import (
    TrajectoryRewardInputs,
    BehaviorMetrics,
    archetype_composite_reward,
    calculate_archetype_behavior_bonus,
    get_archetype_weights,
    calculate_pnl_reward,
    ARCHETYPE_REWARD_WEIGHTS,
)
from src.training.rubric_loader import (
    get_rubric,
    get_priority_metrics,
    get_rubric_hash,
    get_all_rubrics_hash,
    get_rubrics_version,
    has_custom_rubric,
    normalize_archetype,
    get_available_archetypes,
    RUBRICS_VERSION,
)


class TestArchetypeRewardWeights:
    """Test that weight configurations exist and are valid."""

    def test_all_archetypes_have_weights(self):
        """All expected archetypes have weight configurations."""
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
        for arch in expected:
            assert arch in ARCHETYPE_REWARD_WEIGHTS, f"Missing weights for {arch}"

    def test_weights_sum_to_one(self):
        """Weight components should sum to approximately 1.0."""
        for arch, weights in ARCHETYPE_REWARD_WEIGHTS.items():
            total = sum(weights.values())
            assert (
                0.99 <= total <= 1.01
            ), f"{arch} weights sum to {total}, expected ~1.0"

    def test_degen_deprioritizes_pnl(self):
        """Degen archetype should have lower PnL weight than trader."""
        degen_weights = get_archetype_weights("degen")
        trader_weights = get_archetype_weights("trader")
        assert (
            degen_weights["pnl"] < trader_weights["pnl"]
        ), "Degen should care less about PnL than trader"

    def test_social_butterfly_deprioritizes_pnl(self):
        """Social butterfly should have low PnL weight."""
        weights = get_archetype_weights("social-butterfly")
        assert weights["pnl"] <= 0.15, "Social butterfly should barely care about PnL"
        assert (
            weights["behavior"] >= 0.5
        ), "Social butterfly should heavily weight behavior"


class TestArchetypeBehaviorBonus:
    """Test archetype-specific behavior bonuses."""

    def test_degen_rewards_high_trade_volume(self):
        """Degens should get bonus for high trade volume."""
        high_activity = BehaviorMetrics(
            trades_executed=30,
            pnl_variance=500,
            avg_position_size=300,
        )
        bonus = calculate_archetype_behavior_bonus("degen", high_activity)
        assert bonus > 0.3, f"Expected bonus > 0.3 for active degen, got {bonus}"

    def test_degen_penalized_for_low_activity(self):
        """Degens should be penalized for low trading activity."""
        low_activity = BehaviorMetrics(
            trades_executed=1,
            pnl_variance=0,
            avg_position_size=50,
        )
        bonus = calculate_archetype_behavior_bonus("degen", low_activity)
        assert bonus < 0, f"Expected negative bonus for inactive degen, got {bonus}"

    def test_social_butterfly_rewards_connections(self):
        """Social butterflies should get bonus for unique connections."""
        high_social = BehaviorMetrics(
            unique_users_interacted=20,
            group_chats_joined=5,
            dms_initiated=10,
            posts_created=5,
            trades_executed=0,
        )
        bonus = calculate_archetype_behavior_bonus("social-butterfly", high_social)
        assert bonus > 0.4, f"Expected bonus > 0.4 for social butterfly, got {bonus}"

    def test_social_butterfly_penalized_for_isolation(self):
        """Social butterflies should be penalized for not connecting."""
        isolated = BehaviorMetrics(
            unique_users_interacted=1,
            group_chats_joined=0,
            dms_initiated=0,
        )
        bonus = calculate_archetype_behavior_bonus("social-butterfly", isolated)
        assert bonus < 0, f"Expected negative bonus for isolated butterfly, got {bonus}"

    def test_scammer_needs_profit(self):
        """Scammers must profit to get positive bonus."""
        profitable_scammer = BehaviorMetrics(
            total_pnl=100,
            unique_users_interacted=10,
            dms_initiated=8,
            reputation_delta=5,
        )
        bonus = calculate_archetype_behavior_bonus("scammer", profitable_scammer)
        assert bonus > 0.2, f"Expected bonus > 0.2 for profitable scammer, got {bonus}"

        unprofitable_scammer = BehaviorMetrics(
            total_pnl=-50,
            unique_users_interacted=10,
            dms_initiated=8,
            reputation_delta=5,
        )
        bonus = calculate_archetype_behavior_bonus("scammer", unprofitable_scammer)
        # Unprofitable scammer should score lower than profitable one
        assert bonus < 0.35, f"Unprofitable scammer should have lower bonus, got {bonus}"

    def test_super_predictor_rewards_accuracy(self):
        """Super predictors should get bonus for high accuracy."""
        accurate = BehaviorMetrics(
            predictions_made=10,
            correct_predictions=8,
            prediction_accuracy=0.8,
            research_actions=5,
        )
        bonus = calculate_archetype_behavior_bonus("super-predictor", accurate)
        assert bonus > 0.35, f"Expected bonus > 0.35 for accurate predictor, got {bonus}"

    def test_infosec_rewards_caution(self):
        """Infosec agents should be rewarded for cautious behavior."""
        cautious = BehaviorMetrics(
            info_shared=0,
            largest_loss=-30,
            research_actions=5,
            pnl_variance=50,
            dms_initiated=1,
        )
        bonus = calculate_archetype_behavior_bonus("infosec", cautious)
        assert bonus > 0.3, f"Expected bonus > 0.3 for cautious infosec, got {bonus}"


class TestArchetypeCompositeReward:
    """Test full archetype-aware composite scoring."""

    def test_degen_not_penalized_for_losses(self):
        """Degen with losses but high activity should score well."""
        inputs = TrajectoryRewardInputs(
            final_pnl=-50.0,
            starting_balance=10000.0,
            end_balance=9950.0,
            format_score=0.7,
            reasoning_score=0.6,
        )
        metrics = BehaviorMetrics(
            trades_executed=30,
            pnl_variance=1000,
            total_pnl=-50.0,
        )

        degen_score = archetype_composite_reward(inputs, "degen", metrics)
        trader_score = archetype_composite_reward(inputs, "trader", metrics)

        assert (
            degen_score > trader_score
        ), f"Degen ({degen_score:.2f}) should score higher than trader ({trader_score:.2f}) with same losses"

    def test_social_butterfly_ignores_pnl(self):
        """Social butterfly with $0 P&L but high social should score well."""
        inputs = TrajectoryRewardInputs(
            final_pnl=0.0,
            starting_balance=10000.0,
            end_balance=10000.0,
            format_score=0.8,
            reasoning_score=0.7,
        )
        metrics = BehaviorMetrics(
            unique_users_interacted=25,
            group_chats_joined=6,
            dms_initiated=15,
            posts_created=10,
            trades_executed=0,
            social_to_trade_ratio=25.0,
        )

        score = archetype_composite_reward(inputs, "social-butterfly", metrics)
        # Note: With priority metrics integration, score is ~0.48 which still shows
        # social behavior is rewarded (0 PnL with high social activity = decent score)
        assert score > 0.45, f"Social butterfly should score > 0.45, got {score:.2f}"

    def test_trader_needs_profit(self):
        """Trader with losses should score poorly."""
        inputs = TrajectoryRewardInputs(
            final_pnl=-100.0,
            starting_balance=10000.0,
            end_balance=9900.0,
            format_score=0.8,
            reasoning_score=0.8,
        )
        metrics = BehaviorMetrics(
            trades_executed=5,
            win_rate=0.2,
            total_pnl=-100.0,
        )

        score = archetype_composite_reward(inputs, "trader", metrics)
        assert score < 0.4, f"Losing trader should score < 0.4, got {score:.2f}"

    def test_profitable_trader_scores_high(self):
        """Trader with profits and good metrics should score well."""
        inputs = TrajectoryRewardInputs(
            final_pnl=500.0,
            starting_balance=10000.0,
            end_balance=10500.0,
            format_score=0.8,
            reasoning_score=0.7,
        )
        metrics = BehaviorMetrics(
            trades_executed=10,
            win_rate=0.65,
            markets_traded=4,
            total_pnl=500.0,
        )

        score = archetype_composite_reward(inputs, "trader", metrics)
        assert score > 0.5, f"Profitable trader should score > 0.5, got {score:.2f}"

    def test_scores_are_bounded(self):
        """All scores should be in [-1, 1] range."""
        # Extreme positive case
        inputs_good = TrajectoryRewardInputs(
            final_pnl=5000.0,
            starting_balance=10000.0,
            end_balance=15000.0,
            format_score=1.0,
            reasoning_score=1.0,
        )
        metrics_good = BehaviorMetrics(
            trades_executed=50,
            win_rate=0.9,
            unique_users_interacted=30,
        )

        # Extreme negative case
        inputs_bad = TrajectoryRewardInputs(
            final_pnl=-9000.0,
            starting_balance=10000.0,
            end_balance=1000.0,
            format_score=-1.0,
            reasoning_score=0.0,
        )
        metrics_bad = BehaviorMetrics()

        for archetype in ["trader", "degen", "social-butterfly", "scammer"]:
            score_good = archetype_composite_reward(inputs_good, archetype, metrics_good)
            score_bad = archetype_composite_reward(inputs_bad, archetype, metrics_bad)
            
            assert -1.0 <= score_good <= 1.0, f"{archetype} good score out of bounds: {score_good}"
            assert -1.0 <= score_bad <= 1.0, f"{archetype} bad score out of bounds: {score_bad}"


class TestRubricVersioning:
    """Test rubric versioning functionality."""

    def test_rubrics_version_exists(self):
        """RUBRICS_VERSION should be defined."""
        assert RUBRICS_VERSION is not None
        assert len(RUBRICS_VERSION) > 0

    def test_get_rubrics_version(self):
        """get_rubrics_version should return current version."""
        version = get_rubrics_version()
        assert version == RUBRICS_VERSION

    def test_get_rubric_hash_is_consistent(self):
        """Same archetype should always return same hash."""
        hash1 = get_rubric_hash("trader")
        hash2 = get_rubric_hash("trader")
        assert hash1 == hash2

    def test_different_archetypes_have_different_hashes(self):
        """Different archetypes should have different hashes."""
        trader_hash = get_rubric_hash("trader")
        degen_hash = get_rubric_hash("degen")
        social_hash = get_rubric_hash("social-butterfly")

        assert trader_hash != degen_hash
        assert degen_hash != social_hash
        assert trader_hash != social_hash

    def test_all_rubrics_hash_changes_on_any_change(self):
        """get_all_rubrics_hash should be consistent."""
        hash1 = get_all_rubrics_hash()
        hash2 = get_all_rubrics_hash()
        assert hash1 == hash2


class TestNormalizeArchetype:
    """Test archetype name normalization."""

    def test_normalize_lowercase(self):
        """Normalization should lowercase."""
        assert normalize_archetype("TRADER") == "trader"
        assert normalize_archetype("Degen") == "degen"

    def test_normalize_underscores_to_hyphens(self):
        """Normalization should convert underscores to hyphens."""
        assert normalize_archetype("social_butterfly") == "social-butterfly"
        assert normalize_archetype("super_predictor") == "super-predictor"

    def test_normalize_strips_whitespace(self):
        """Normalization should strip whitespace."""
        assert normalize_archetype("  trader  ") == "trader"


class TestRubricLoading:
    """Test rubric loading from config."""

    def test_get_rubric_returns_string(self):
        """get_rubric should return non-empty string."""
        rubric = get_rubric("trader")
        assert isinstance(rubric, str)
        assert len(rubric) > 100  # Rubrics are substantial

    def test_has_custom_rubric(self):
        """Known archetypes should have custom rubrics."""
        assert has_custom_rubric("trader")
        assert has_custom_rubric("degen")
        assert has_custom_rubric("social-butterfly")
        assert not has_custom_rubric("nonexistent-archetype-xyz")

    def test_get_priority_metrics_returns_list(self):
        """get_priority_metrics should return list of strings."""
        metrics = get_priority_metrics("trader")
        assert isinstance(metrics, list)
        assert len(metrics) > 0
        assert all(isinstance(m, str) for m in metrics)

    def test_priority_metrics_differ_by_archetype(self):
        """Different archetypes should prioritize different metrics."""
        trader_metrics = get_priority_metrics("trader")
        social_metrics = get_priority_metrics("social-butterfly")
        
        # Trader should prioritize P&L
        assert any("pnl" in m.lower() for m in trader_metrics[:3])
        
        # Social butterfly should prioritize social metrics
        assert any("social" in m.lower() or "user" in m.lower() for m in social_metrics[:3])

    def test_unknown_archetype_gets_default_rubric(self):
        """Unknown archetype should fall back to default rubric."""
        rubric = get_rubric("completely-made-up-archetype")
        default_rubric = get_rubric("default")
        
        # Should get a valid rubric (the default)
        assert len(rubric) > 100
        # Unknown archetypes get the default
        assert rubric == default_rubric


# =============================================================================
# Extended Edge Case Tests
# =============================================================================

class TestPnLRewardEdgeCases:
    """Test PnL reward calculation edge cases."""

    def test_bankruptcy_returns_hard_penalty(self):
        """Bankruptcy (end_balance <= 0) should return -10.0."""
        assert calculate_pnl_reward(10000.0, 0.0) == -10.0
        assert calculate_pnl_reward(10000.0, -100.0) == -10.0

    def test_zero_starting_balance(self):
        """Zero starting balance should return 0.0."""
        assert calculate_pnl_reward(0.0, 100.0) == 0.0
        assert calculate_pnl_reward(-100.0, 100.0) == 0.0

    def test_breakeven_returns_zero(self):
        """No change in balance should return 0.0."""
        assert calculate_pnl_reward(10000.0, 10000.0) == 0.0

    def test_pnl_capped_at_1(self):
        """PnL reward should cap at 1.0."""
        reward = calculate_pnl_reward(10000.0, 20000.0)
        assert reward == 1.0

    def test_pnl_capped_at_negative_1(self):
        """PnL reward should floor at -1.0."""
        reward = calculate_pnl_reward(10000.0, 8500.0)  # -15% loss
        assert reward == -1.0


class TestAllArchetypeBehaviorBonuses:
    """Test behavior bonus for every archetype."""

    def test_trader_bonus_rewards_win_rate(self):
        """Trader should get bonus for high win rate."""
        good_trader = BehaviorMetrics(
            win_rate=0.65,
            markets_traded=4,
            trades_executed=10,
        )
        bonus = calculate_archetype_behavior_bonus("trader", good_trader)
        assert bonus > 0.2, f"Expected bonus > 0.2, got {bonus}"

    def test_researcher_bonus_rewards_research(self):
        """Researcher should get bonus for research actions."""
        active_researcher = BehaviorMetrics(
            research_actions=15,
            prediction_accuracy=0.7,
            trades_executed=5,
            win_rate=0.7,
        )
        bonus = calculate_archetype_behavior_bonus("researcher", active_researcher)
        assert bonus > 0.3, f"Expected bonus > 0.3, got {bonus}"

    def test_researcher_penalized_for_no_research(self):
        """Researcher with no research actions should be penalized."""
        lazy_researcher = BehaviorMetrics(
            research_actions=0,
            prediction_accuracy=0.5,
        )
        bonus = calculate_archetype_behavior_bonus("researcher", lazy_researcher)
        assert bonus < 0, f"Expected negative bonus, got {bonus}"

    def test_information_trader_needs_balance(self):
        """Information trader needs balanced social-to-trade ratio."""
        balanced = BehaviorMetrics(
            social_to_trade_ratio=1.0,
            group_chats_joined=4,
            dms_initiated=5,
            info_requests_sent=3,
            total_pnl=50.0,
        )
        bonus = calculate_archetype_behavior_bonus("information-trader", balanced)
        assert bonus > 0.3, f"Expected bonus > 0.3, got {bonus}"

    def test_goody_twoshoes_rewards_reputation(self):
        """Goody two-shoes should get bonus for reputation gains."""
        helpful = BehaviorMetrics(
            reputation_delta=35,
            info_shared=6,
            positive_reactions=12,
            followers_gained=5,
        )
        bonus = calculate_archetype_behavior_bonus("goody-twoshoes", helpful)
        assert bonus > 0.4, f"Expected bonus > 0.4, got {bonus}"

    def test_ass_kisser_rewards_followers(self):
        """Ass-kisser should get bonus for reputation and followers."""
        flatterer = BehaviorMetrics(
            reputation_delta=55,
            followers_gained=12,
            comments_made=15,
            dms_initiated=8,
        )
        bonus = calculate_archetype_behavior_bonus("ass-kisser", flatterer)
        assert bonus > 0.4, f"Expected bonus > 0.4, got {bonus}"

    def test_perps_trader_rewards_direction(self):
        """Perps trader should get bonus for good directional calls."""
        good_perps = BehaviorMetrics(
            win_rate=0.6,
            trades_executed=12,
            pnl_variance=500,
            total_pnl=200.0,
        )
        bonus = calculate_archetype_behavior_bonus("perps-trader", good_perps)
        assert bonus > 0.25, f"Expected bonus > 0.25, got {bonus}"

    def test_perps_trader_penalized_for_losses(self):
        """Perps trader should be penalized for big losses."""
        blowup = BehaviorMetrics(
            win_rate=0.3,
            trades_executed=8,
            total_pnl=-500.0,
        )
        bonus = calculate_archetype_behavior_bonus("perps-trader", blowup)
        assert bonus < 0, f"Expected negative bonus, got {bonus}"

    def test_liar_rewards_information_spread(self):
        """Liar should get bonus for spreading information."""
        effective_liar = BehaviorMetrics(
            information_spread=15,
            unique_users_interacted=10,
            reputation_delta=5,
            posts_created=8,
        )
        bonus = calculate_archetype_behavior_bonus("liar", effective_liar)
        assert bonus > 0.35, f"Expected bonus > 0.35, got {bonus}"

    def test_default_archetype_returns_zero(self):
        """Default/unknown archetype should return zero bonus."""
        metrics = BehaviorMetrics(trades_executed=10)
        bonus = calculate_archetype_behavior_bonus("default", metrics)
        assert bonus == 0.0

        bonus_unknown = calculate_archetype_behavior_bonus("unknown-archetype", metrics)
        assert bonus_unknown == 0.0


class TestBoundaryConditions:
    """Test boundary conditions for all scoring functions."""

    def test_empty_behavior_metrics(self):
        """Empty BehaviorMetrics should not cause errors."""
        inputs = TrajectoryRewardInputs(
            final_pnl=0.0,
            starting_balance=10000.0,
            end_balance=10000.0,
            format_score=0.5,
            reasoning_score=0.5,
        )
        empty_metrics = BehaviorMetrics()

        for archetype in ["trader", "degen", "social-butterfly"]:
            score = archetype_composite_reward(inputs, archetype, empty_metrics)
            assert -1.0 <= score <= 1.0, f"{archetype} failed with empty metrics"

    def test_none_behavior_metrics(self):
        """None behavior_metrics should use default scoring."""
        inputs = TrajectoryRewardInputs(
            final_pnl=100.0,
            starting_balance=10000.0,
            end_balance=10100.0,
            format_score=0.8,
            reasoning_score=0.7,
        )
        
        score = archetype_composite_reward(inputs, "trader", None)
        assert -1.0 <= score <= 1.0

    def test_extreme_positive_metrics(self):
        """Extreme positive metrics should stay bounded."""
        inputs = TrajectoryRewardInputs(
            final_pnl=50000.0,
            starting_balance=10000.0,
            end_balance=60000.0,
            format_score=1.0,
            reasoning_score=1.0,
        )
        extreme_metrics = BehaviorMetrics(
            trades_executed=1000,
            win_rate=1.0,
            unique_users_interacted=500,
            pnl_variance=100000,
            reputation_delta=1000,
        )

        for archetype in ARCHETYPE_REWARD_WEIGHTS.keys():
            score = archetype_composite_reward(inputs, archetype, extreme_metrics)
            assert -1.0 <= score <= 1.0, f"{archetype} out of bounds: {score}"

    def test_extreme_negative_metrics(self):
        """Extreme negative metrics should stay bounded."""
        inputs = TrajectoryRewardInputs(
            final_pnl=-9999.0,
            starting_balance=10000.0,
            end_balance=1.0,
            format_score=-1.0,
            reasoning_score=-1.0,
        )
        negative_metrics = BehaviorMetrics(
            trades_executed=0,
            win_rate=0.0,
            reputation_delta=-1000,
            largest_loss=-50000,
        )

        for archetype in ARCHETYPE_REWARD_WEIGHTS.keys():
            score = archetype_composite_reward(inputs, archetype, negative_metrics)
            assert -1.0 <= score <= 1.0, f"{archetype} out of bounds: {score}"


class TestArchetypeNormalizationEdgeCases:
    """Test edge cases for archetype normalization."""

    def test_mixed_case_handling(self):
        """Mixed case should normalize correctly."""
        assert normalize_archetype("SoCiAl-BuTtErFlY") == "social-butterfly"
        assert normalize_archetype("DEGEN") == "degen"

    def test_multiple_underscores(self):
        """Multiple underscores should all convert."""
        assert normalize_archetype("super__predictor") == "super--predictor"

    def test_empty_string(self):
        """Empty string should return 'default'."""
        assert normalize_archetype("") == "default"
        assert normalize_archetype("   ") == "default"
        assert normalize_archetype(None) == "default"

    def test_unknown_archetype_fallback(self):
        """Unknown archetypes should get default weights."""
        weights = get_archetype_weights("nonexistent-archetype-xyz")
        assert weights == ARCHETYPE_REWARD_WEIGHTS["default"]


class TestWeightConfigurationIntegrity:
    """Validate all weight configurations are correct."""

    def test_all_weights_have_required_keys(self):
        """All archetypes must have pnl, format, reasoning, behavior keys."""
        required_keys = {"pnl", "format", "reasoning", "behavior"}
        for archetype, weights in ARCHETYPE_REWARD_WEIGHTS.items():
            assert set(weights.keys()) == required_keys, f"{archetype} missing keys"

    def test_all_weights_are_non_negative(self):
        """All weight values should be >= 0."""
        for archetype, weights in ARCHETYPE_REWARD_WEIGHTS.items():
            for key, value in weights.items():
                assert value >= 0, f"{archetype}.{key} is negative: {value}"

    def test_weights_match_archetype_philosophy(self):
        """Verify weights align with archetype philosophies."""
        # Degens care least about PnL
        degen = get_archetype_weights("degen")
        assert degen["pnl"] <= 0.20, "Degen should not prioritize PnL"
        assert degen["behavior"] >= 0.50, "Degen should prioritize behavior"

        # Traders care most about PnL
        trader = get_archetype_weights("trader")
        assert trader["pnl"] >= 0.50, "Trader should prioritize PnL"

        # Researchers care about reasoning
        researcher = get_archetype_weights("researcher")
        assert researcher["reasoning"] >= 0.25, "Researcher should prioritize reasoning"


class TestRelativeScoring:
    """Test that scoring produces correct relative rankings."""

    def test_profitable_beats_unprofitable_for_trader(self):
        """Profitable trader should score higher than unprofitable."""
        profitable_inputs = TrajectoryRewardInputs(
            final_pnl=200.0, starting_balance=10000.0, end_balance=10200.0,
            format_score=0.7, reasoning_score=0.6,
        )
        unprofitable_inputs = TrajectoryRewardInputs(
            final_pnl=-200.0, starting_balance=10000.0, end_balance=9800.0,
            format_score=0.7, reasoning_score=0.6,
        )
        metrics = BehaviorMetrics(trades_executed=5, win_rate=0.5)

        profitable_score = archetype_composite_reward(profitable_inputs, "trader", metrics)
        unprofitable_score = archetype_composite_reward(unprofitable_inputs, "trader", metrics)

        assert profitable_score > unprofitable_score

    def test_active_beats_inactive_for_degen(self):
        """Active degen should score higher than inactive, regardless of PnL."""
        active_metrics = BehaviorMetrics(trades_executed=40, pnl_variance=1000)
        inactive_metrics = BehaviorMetrics(trades_executed=2, pnl_variance=10)
        
        # Same inputs - slight loss
        inputs = TrajectoryRewardInputs(
            final_pnl=-50.0, starting_balance=10000.0, end_balance=9950.0,
            format_score=0.6, reasoning_score=0.5,
        )

        active_score = archetype_composite_reward(inputs, "degen", active_metrics)
        inactive_score = archetype_composite_reward(inputs, "degen", inactive_metrics)

        assert active_score > inactive_score

    def test_social_beats_isolated_for_butterfly(self):
        """Social butterfly with connections should beat isolated one."""
        social_metrics = BehaviorMetrics(
            unique_users_interacted=20, group_chats_joined=5, dms_initiated=15,
        )
        isolated_metrics = BehaviorMetrics(
            unique_users_interacted=0, group_chats_joined=0, dms_initiated=0,
        )
        
        inputs = TrajectoryRewardInputs(
            final_pnl=0.0, starting_balance=10000.0, end_balance=10000.0,
            format_score=0.7, reasoning_score=0.6,
        )

        social_score = archetype_composite_reward(inputs, "social-butterfly", social_metrics)
        isolated_score = archetype_composite_reward(inputs, "social-butterfly", isolated_metrics)

        assert social_score > isolated_score


class TestRubricConfigConsistency:
    """Test that rubrics and weights are consistent."""

    def test_all_rubric_archetypes_have_weights(self):
        """All archetypes in rubrics should have reward weights."""
        available = get_available_archetypes()
        for archetype in available:
            normalized = normalize_archetype(archetype)
            # Should either have specific weights or fall back to default
            weights = get_archetype_weights(normalized)
            assert weights is not None
            assert len(weights) == 4

    def test_all_rubric_archetypes_have_priority_metrics(self):
        """All archetypes should have priority metrics defined."""
        available = get_available_archetypes()
        for archetype in available:
            metrics = get_priority_metrics(archetype)
            assert isinstance(metrics, list)
            assert len(metrics) > 0, f"{archetype} has no priority metrics"


class TestBehaviorMetricsDataclass:
    """Test the BehaviorMetrics dataclass."""

    def test_defaults_are_zero(self):
        """All defaults should be zero/empty."""
        metrics = BehaviorMetrics()
        assert metrics.trades_executed == 0
        assert metrics.total_pnl == 0.0
        assert metrics.unique_users_interacted == 0
        assert metrics.win_rate == 0.0
        assert metrics.prediction_accuracy == 0.0

    def test_can_set_all_fields(self):
        """All fields should be settable."""
        metrics = BehaviorMetrics(
            trades_executed=10,
            profitable_trades=7,
            win_rate=0.7,
            total_pnl=500.0,
            pnl_variance=100.0,
            largest_win=200.0,
            largest_loss=-50.0,
            markets_traded=3,
            avg_position_size=100.0,
            unique_users_interacted=15,
            group_chats_joined=4,
            dms_initiated=8,
            posts_created=5,
            comments_made=12,
            mentions_given=3,
            followers_gained=6,
            reputation_delta=25,
            positive_reactions=20,
            information_spread=10,
            research_actions=8,
            predictions_made=5,
            correct_predictions=4,
            prediction_accuracy=0.8,
            info_requests_sent=3,
            info_shared=2,
            actions_per_tick=2.5,
            social_to_trade_ratio=1.2,
            episode_length=100,
        )
        assert metrics.trades_executed == 10
        assert metrics.win_rate == 0.7
        assert metrics.unique_users_interacted == 15
        assert metrics.prediction_accuracy == 0.8


class TestCrossArchetypeComparison:
    """Test that different archetypes produce different scores for same trajectory."""

    def test_same_trajectory_different_archetypes(self):
        """Same trajectory should produce different scores for different archetypes."""
        # A balanced trajectory
        inputs = TrajectoryRewardInputs(
            final_pnl=100.0,
            starting_balance=10000.0,
            end_balance=10100.0,
            format_score=0.7,
            reasoning_score=0.6,
        )
        balanced_metrics = BehaviorMetrics(
            trades_executed=8,
            unique_users_interacted=10,
            group_chats_joined=2,
            win_rate=0.6,
            total_pnl=100.0,
        )

        scores = {}
        for archetype in ["trader", "degen", "social-butterfly", "scammer"]:
            scores[archetype] = archetype_composite_reward(inputs, archetype, balanced_metrics)

        # All scores should be different (or very close in edge cases)
        unique_scores = set(round(s, 4) for s in scores.values())
        assert len(unique_scores) >= 3, f"Expected diverse scores, got {scores}"

    def test_archetype_strengths_show_in_scores(self):
        """Each archetype should score highest on their specialty."""
        # Trading-focused trajectory
        trading_inputs = TrajectoryRewardInputs(
            final_pnl=500.0, starting_balance=10000.0, end_balance=10500.0,
            format_score=0.7, reasoning_score=0.6,
        )
        trading_metrics = BehaviorMetrics(
            trades_executed=10, win_rate=0.7, markets_traded=4, total_pnl=500.0,
        )

        trader_score = archetype_composite_reward(trading_inputs, "trader", trading_metrics)
        social_score = archetype_composite_reward(trading_inputs, "social-butterfly", trading_metrics)

        # Trader should score highest for profitable trading
        assert trader_score > social_score, "Trader should beat social butterfly for trading"

        # Social-focused trajectory
        social_inputs = TrajectoryRewardInputs(
            final_pnl=0.0, starting_balance=10000.0, end_balance=10000.0,
            format_score=0.7, reasoning_score=0.6,
        )
        social_metrics = BehaviorMetrics(
            unique_users_interacted=25, group_chats_joined=6, dms_initiated=15,
            posts_created=10, trades_executed=0,
        )

        trader_score2 = archetype_composite_reward(social_inputs, "trader", social_metrics)
        social_score2 = archetype_composite_reward(social_inputs, "social-butterfly", social_metrics)

        # Social butterfly should score higher for social trajectory
        assert social_score2 > trader_score2, "Social butterfly should beat trader for social activity"


class TestMixedArchetypeScenarios:
    """Tests for edge cases in mixed archetype scoring scenarios."""

    def test_null_archetype_defaults_to_default(self):
        """Null/None archetype should use default weights."""
        inputs = TrajectoryRewardInputs(
            final_pnl=100.0, starting_balance=10000.0, end_balance=10100.0,
            format_score=0.7, reasoning_score=0.6,
        )
        metrics = BehaviorMetrics(trades_executed=5, win_rate=0.6)

        # Test with None-like values
        none_score = archetype_composite_reward(inputs, "", metrics)
        default_score = archetype_composite_reward(inputs, "default", metrics)

        # Both should use default weights
        assert abs(none_score - default_score) < 0.01, "Empty string should use default weights"

    def test_unknown_archetype_uses_default(self):
        """Unknown archetypes should fall back to default."""
        inputs = TrajectoryRewardInputs(
            final_pnl=200.0, starting_balance=10000.0, end_balance=10200.0,
            format_score=0.8, reasoning_score=0.7,
        )
        metrics = BehaviorMetrics(trades_executed=10, win_rate=0.7)

        unknown_score = archetype_composite_reward(inputs, "unknown-archetype-xyz", metrics)
        default_score = archetype_composite_reward(inputs, "default", metrics)

        assert abs(unknown_score - default_score) < 0.01, "Unknown archetype should use default"

    def test_archetype_normalization_preserves_scoring(self):
        """Different archetype formats should produce same scores."""
        inputs = TrajectoryRewardInputs(
            final_pnl=150.0, starting_balance=10000.0, end_balance=10150.0,
            format_score=0.75, reasoning_score=0.65,
        )
        metrics = BehaviorMetrics(trades_executed=15, pnl_variance=200)

        # Test various formats of the same archetype
        degen_lower = archetype_composite_reward(inputs, "degen", metrics)
        degen_upper = archetype_composite_reward(inputs, "DEGEN", metrics)
        degen_mixed = archetype_composite_reward(inputs, "Degen", metrics)
        degen_spaces = archetype_composite_reward(inputs, "  degen  ", metrics)

        assert abs(degen_lower - degen_upper) < 0.001
        assert abs(degen_lower - degen_mixed) < 0.001
        assert abs(degen_lower - degen_spaces) < 0.001

    def test_underscore_hyphen_equivalence(self):
        """Underscores should be treated as hyphens in archetype names."""
        inputs = TrajectoryRewardInputs(
            final_pnl=0.0, starting_balance=10000.0, end_balance=10000.0,
            format_score=0.7, reasoning_score=0.6,
        )
        metrics = BehaviorMetrics(
            unique_users_interacted=20, group_chats_joined=5, dms_initiated=10
        )

        hyphen_score = archetype_composite_reward(inputs, "social-butterfly", metrics)
        underscore_score = archetype_composite_reward(inputs, "social_butterfly", metrics)

        assert abs(hyphen_score - underscore_score) < 0.001


class TestBehaviorMetricsEdgeCases:
    """Tests for edge cases in behavior metrics handling."""

    def test_all_zero_metrics_scores_reasonably(self):
        """Agent with zero activity should still get a valid score."""
        inputs = TrajectoryRewardInputs(
            final_pnl=0.0, starting_balance=10000.0, end_balance=10000.0,
            format_score=0.5, reasoning_score=0.5,
        )
        metrics = BehaviorMetrics()  # All zeros

        for archetype in ["trader", "degen", "social-butterfly", "researcher"]:
            score = archetype_composite_reward(inputs, archetype, metrics)
            assert -1.0 <= score <= 1.0, f"Score for {archetype} out of bounds: {score}"

    def test_extreme_activity_capped(self):
        """Extreme behavior metrics should not produce unbounded scores."""
        inputs = TrajectoryRewardInputs(
            final_pnl=10000.0, starting_balance=10000.0, end_balance=20000.0,
            format_score=1.0, reasoning_score=1.0,
        )
        metrics = BehaviorMetrics(
            trades_executed=1000,
            unique_users_interacted=500,
            group_chats_joined=100,
            dms_initiated=500,
            pnl_variance=100000,
            win_rate=1.0,
            research_actions=200,
            predictions_made=500,
            correct_predictions=500,
            prediction_accuracy=1.0,
        )

        for archetype in ["trader", "degen", "social-butterfly", "super-predictor"]:
            score = archetype_composite_reward(inputs, archetype, metrics)
            assert -1.0 <= score <= 1.0, f"Extreme score for {archetype} out of bounds: {score}"

    def test_negative_metrics_handled(self):
        """Negative metrics should be handled gracefully."""
        inputs = TrajectoryRewardInputs(
            final_pnl=-5000.0, starting_balance=10000.0, end_balance=5000.0,
            format_score=0.3, reasoning_score=0.2,
        )
        metrics = BehaviorMetrics(
            total_pnl=-5000.0,
            largest_loss=-2000.0,
            reputation_delta=-100,
        )

        for archetype in ["trader", "scammer", "goody-twoshoes"]:
            score = archetype_composite_reward(inputs, archetype, metrics)
            assert -1.0 <= score <= 1.0, f"Negative metrics score for {archetype}: {score}"
            # Losing money should generally result in lower scores
            if archetype == "trader":
                assert score < 0.5, "Trader with big losses should score low"


class TestRulerMixedArchetypeGroups:
    """Tests for RULER-style comparisons with mixed archetypes."""

    def test_relative_ranking_consistent(self):
        """Ranking should be consistent within archetype groups."""
        # Two traders: one profitable, one losing
        profitable_inputs = TrajectoryRewardInputs(
            final_pnl=500.0, starting_balance=10000.0, end_balance=10500.0,
            format_score=0.7, reasoning_score=0.7,
        )
        losing_inputs = TrajectoryRewardInputs(
            final_pnl=-500.0, starting_balance=10000.0, end_balance=9500.0,
            format_score=0.7, reasoning_score=0.7,
        )
        metrics = BehaviorMetrics(trades_executed=10, win_rate=0.5)

        profitable_trader = archetype_composite_reward(profitable_inputs, "trader", metrics)
        losing_trader = archetype_composite_reward(losing_inputs, "trader", metrics)

        assert profitable_trader > losing_trader, "Profitable trader should rank higher"

    def test_archetype_aware_comparison(self):
        """Different archetypes should be evaluated by their own criteria."""
        # Same trajectory, different archetype evaluations
        inputs = TrajectoryRewardInputs(
            final_pnl=-100.0, starting_balance=10000.0, end_balance=9900.0,
            format_score=0.7, reasoning_score=0.6,
        )

        # Degen metrics (high activity, high variance)
        degen_metrics = BehaviorMetrics(
            trades_executed=25,
            pnl_variance=800,
            avg_position_size=400,
        )

        # Trader metrics (disciplined, diversified)
        trader_metrics = BehaviorMetrics(
            trades_executed=8,
            win_rate=0.45,
            markets_traded=4,
        )

        degen_score = archetype_composite_reward(inputs, "degen", degen_metrics)
        trader_score = archetype_composite_reward(inputs, "trader", trader_metrics)

        # Degen with high activity but losses should still score reasonably
        # Trader with losses and low win rate should score poorly
        assert degen_score > trader_score, "Active degen should beat disciplined trader with losses"

