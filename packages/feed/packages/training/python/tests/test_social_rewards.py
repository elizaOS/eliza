"""
Unit tests for Social Reward Functions (BAB-71)

Tests the social reward calculation functions that enable
non-trading archetypes like "Social Butterfly" to achieve
high scores without trading.

Coverage includes:
- Happy path tests
- Boundary conditions (exact thresholds)
- Edge cases (zeros, negatives, large values)
- Error handling (invalid inputs)
- Weight validation (sums to 1.0)
- All archetypes
"""

from src.training.rewards import (
    SOCIAL_COMPOSITE_WEIGHTS,
    SOCIAL_EXCELLENT_ENGAGEMENT,
    SOCIAL_EXCELLENT_NETWORK,
    # Import constants and helpers for boundary testing
    SOCIAL_EXCELLENT_SPREAD,
    SOCIAL_GOOD_ENGAGEMENT,
    SOCIAL_GOOD_NETWORK,
    SOCIAL_GOOD_SPREAD,
    SOCIAL_MIN_ENGAGEMENT,
    SOCIAL_MIN_NETWORK,
    SOCIAL_REWARD_WEIGHTS,
    BehaviorMetrics,
    NarrativeEvent,
    SocialRewardResult,
    TrajectoryRewardInputs,
    _interpolate_score,
    calculate_engagement_score,
    calculate_information_spread_score,
    calculate_narrative_alignment_score,
    calculate_network_score,
    calculate_social_reward,
    social_only_composite_reward,
)

# =============================================================================
# Helper Function Tests
# =============================================================================


class TestInterpolateScore:
    """Tests for _interpolate_score() helper - the core scoring logic"""

    def test_at_excellent_threshold(self):
        """Value at excellent threshold should score 1.0"""
        score = _interpolate_score(20, 3, 10, 20)
        assert score == 1.0

    def test_above_excellent_threshold(self):
        """Value above excellent threshold should still score 1.0 (capped)"""
        score = _interpolate_score(100, 3, 10, 20)
        assert score == 1.0

    def test_at_good_threshold(self):
        """Value at good threshold should score 0.6"""
        score = _interpolate_score(10, 3, 10, 20)
        assert score == 0.6

    def test_at_min_threshold(self):
        """Value at min threshold should score 0.2"""
        score = _interpolate_score(3, 3, 10, 20)
        assert score == 0.2

    def test_zero_value(self):
        """Zero value should score 0.0"""
        score = _interpolate_score(0, 3, 10, 20)
        assert score == 0.0

    def test_between_good_and_excellent(self):
        """Value between good and excellent should interpolate linearly"""
        # Midpoint between 10 and 20 is 15, should be midpoint between 0.6 and 1.0 = 0.8
        score = _interpolate_score(15, 3, 10, 20)
        assert 0.75 <= score <= 0.85

    def test_between_min_and_good(self):
        """Value between min and good should interpolate linearly"""
        # Midpoint between 3 and 10 is 6.5
        score = _interpolate_score(6, 3, 10, 20)
        assert 0.35 <= score <= 0.45

    def test_below_min(self):
        """Value below min should scale proportionally"""
        score = _interpolate_score(1, 3, 10, 20)
        assert 0.0 < score < 0.2

    def test_handles_zero_min(self):
        """Should handle min_val of 0 without division by zero"""
        # When min_val is 0, value at min should return 0.2 (the base score at min threshold)
        score_at_min = _interpolate_score(0, 0, 5, 10)
        assert score_at_min == 0.2  # At min threshold

        # Value above min but below good should interpolate correctly
        score_above_min = _interpolate_score(2, 0, 5, 10)
        assert 0.2 < score_above_min < 0.6  # Between min and good scores

    def test_equal_good_and_excellent_thresholds(self):
        """Should handle excellent_val == good_val without division by zero"""
        score = _interpolate_score(10, 3, 10, 10)  # good == excellent
        assert score == 1.0  # At or above good should return 1.0
        score_below = _interpolate_score(5, 3, 10, 10)
        assert score_below == 0.6  # Below good should return 0.6

    def test_equal_min_and_good_thresholds(self):
        """Should handle good_val == min_val without division by zero"""
        score = _interpolate_score(5, 5, 5, 10)  # min == good
        assert score == 0.6  # At or above min should return 0.6
        score_below = _interpolate_score(2, 5, 5, 10)
        assert score_below == 0.0  # Below min with equal thresholds


# =============================================================================
# Engagement Score Tests
# =============================================================================


class TestEngagementScore:
    """Tests for calculate_engagement_score()"""

    def test_high_engagement_score(self):
        """Agent with lots of social activity should score high"""
        metrics = BehaviorMetrics(
            posts_created=10,
            comments_made=8,
            dms_initiated=5,
            group_chats_joined=4,
            mentions_given=3,
        )
        score = calculate_engagement_score(metrics)
        assert score >= 0.8, f"High activity should score >= 0.8, got {score}"

    def test_moderate_engagement_score(self):
        """Agent with moderate activity should score moderately"""
        metrics = BehaviorMetrics(
            posts_created=2,
            comments_made=2,
            dms_initiated=1,
            group_chats_joined=1,
            mentions_given=0,
        )
        score = calculate_engagement_score(metrics)
        assert 0.4 <= score <= 0.8, f"Moderate activity should score 0.4-0.8, got {score}"

    def test_zero_engagement_score(self):
        """Agent with no social activity should score low"""
        metrics = BehaviorMetrics()
        score = calculate_engagement_score(metrics)
        assert score <= 0.2, f"No activity should score <= 0.2, got {score}"

    def test_diversity_bonus(self):
        """Diverse activity types should score higher than single type"""
        # Single type: all posts
        single_type = BehaviorMetrics(posts_created=10)

        # Diverse: spread across types
        diverse = BehaviorMetrics(
            posts_created=2,
            comments_made=2,
            dms_initiated=2,
            group_chats_joined=2,
            mentions_given=2,
        )

        single_score = calculate_engagement_score(single_type)
        diverse_score = calculate_engagement_score(diverse)

        assert diverse_score > single_score, (
            f"Diverse activity ({diverse_score}) should beat single type ({single_score})"
        )

    # Boundary condition tests
    def test_exactly_at_excellent_threshold(self):
        """Engagement exactly at SOCIAL_EXCELLENT_ENGAGEMENT"""
        metrics = BehaviorMetrics(posts_created=SOCIAL_EXCELLENT_ENGAGEMENT)
        score = calculate_engagement_score(metrics)
        # Should hit 1.0 volume + diversity bonus (1 type = 0.04)
        assert score >= 1.0, f"At excellent threshold should score >= 1.0, got {score}"

    def test_exactly_at_good_threshold(self):
        """Engagement exactly at SOCIAL_GOOD_ENGAGEMENT"""
        metrics = BehaviorMetrics(posts_created=SOCIAL_GOOD_ENGAGEMENT)
        score = calculate_engagement_score(metrics)
        # Volume score 0.6 + diversity bonus 0.04 = 0.64
        assert 0.6 <= score <= 0.7, f"At good threshold should score ~0.64, got {score}"

    def test_exactly_at_min_threshold(self):
        """Engagement exactly at SOCIAL_MIN_ENGAGEMENT"""
        metrics = BehaviorMetrics(posts_created=SOCIAL_MIN_ENGAGEMENT)
        score = calculate_engagement_score(metrics)
        # Volume score 0.2 + diversity bonus 0.04 = 0.24
        assert 0.2 <= score <= 0.3, f"At min threshold should score ~0.24, got {score}"

    def test_max_diversity_bonus(self):
        """All 5 activity types should give max diversity bonus (0.20)"""
        metrics = BehaviorMetrics(
            posts_created=1,
            comments_made=1,
            dms_initiated=1,
            group_chats_joined=1,
            mentions_given=1,
        )
        score = calculate_engagement_score(metrics)
        # Total = 5 actions, all types active
        # Volume + 0.20 diversity = should be higher than 4 actions of same type
        single_type = BehaviorMetrics(posts_created=5)
        single_score = calculate_engagement_score(single_type)
        assert score > single_score

    def test_very_large_engagement(self):
        """Very large engagement values should still score 1.0 (capped)"""
        metrics = BehaviorMetrics(posts_created=1000)
        score = calculate_engagement_score(metrics)
        assert score == 1.0, f"Very large engagement should cap at 1.0, got {score}"


# =============================================================================
# Information Spread Score Tests
# =============================================================================


class TestInformationSpreadScore:
    """Tests for calculate_information_spread_score()"""

    def test_high_spread_score(self):
        """Content that spreads widely should score high"""
        metrics = BehaviorMetrics(
            information_spread=20,
            positive_reactions=10,
            followers_gained=5,
        )
        score = calculate_information_spread_score(metrics)
        assert score >= 0.9, f"High spread should score >= 0.9, got {score}"

    def test_moderate_spread_score(self):
        """Content that spreads moderately should score moderately"""
        metrics = BehaviorMetrics(
            information_spread=6,
            positive_reactions=3,
            followers_gained=1,
        )
        score = calculate_information_spread_score(metrics)
        assert 0.5 <= score <= 0.9, f"Moderate spread should score 0.5-0.9, got {score}"

    def test_zero_spread_score(self):
        """Content that doesn't spread should score low"""
        metrics = BehaviorMetrics(
            information_spread=0,
            positive_reactions=0,
            followers_gained=0,
        )
        score = calculate_information_spread_score(metrics)
        assert score <= 0.2, f"No spread should score <= 0.2, got {score}"

    def test_reactions_boost_score(self):
        """Reactions should boost score even without direct spread"""
        no_reactions = BehaviorMetrics(information_spread=5)
        with_reactions = BehaviorMetrics(
            information_spread=5,
            positive_reactions=10,
        )

        assert calculate_information_spread_score(
            with_reactions
        ) > calculate_information_spread_score(no_reactions)

    # Boundary tests
    def test_exactly_at_excellent_spread(self):
        """Spread exactly at SOCIAL_EXCELLENT_SPREAD"""
        metrics = BehaviorMetrics(information_spread=SOCIAL_EXCELLENT_SPREAD)
        score = calculate_information_spread_score(metrics)
        assert score == 1.0, f"At excellent spread should score 1.0, got {score}"

    def test_exactly_at_good_spread(self):
        """Spread exactly at SOCIAL_GOOD_SPREAD"""
        metrics = BehaviorMetrics(information_spread=SOCIAL_GOOD_SPREAD)
        score = calculate_information_spread_score(metrics)
        assert score == 0.6, f"At good spread should score 0.6, got {score}"

    def test_follower_bonus_caps_at_015(self):
        """Follower bonus should cap at 0.15"""
        # Very high followers to test cap
        metrics = BehaviorMetrics(
            information_spread=0,
            followers_gained=100,
        )
        score = calculate_information_spread_score(metrics)
        # With spread=0 and followers_gained=100, bonus = min(0.15, 100*0.03) = 0.15
        assert score <= 0.35, f"Follower bonus should be capped, got {score}"

    def test_reaction_bonus_caps_at_020(self):
        """Reaction bonus should cap at 0.20"""
        metrics = BehaviorMetrics(
            information_spread=0,
            positive_reactions=100,
        )
        score = calculate_information_spread_score(metrics)
        # With spread=0 and reactions=100, bonus = min(0.2, 100*0.02) = 0.2
        assert score <= 0.2, f"Reaction bonus should be capped, got {score}"

    def test_negative_followers_handled(self):
        """Negative follower gains should not break scoring"""
        metrics = BehaviorMetrics(
            information_spread=5,
            followers_gained=-10,  # Lost followers
        )
        score = calculate_information_spread_score(metrics)
        # Should handle gracefully, bonus = min(0.15, max(0, -10)*0.03) = 0
        assert 0.0 <= score <= 1.0, f"Should handle negative followers, got {score}"

    def test_all_bonuses_stack(self):
        """All bonuses should stack up to cap of 1.0"""
        metrics = BehaviorMetrics(
            information_spread=SOCIAL_EXCELLENT_SPREAD,  # 1.0
            positive_reactions=20,  # +0.2 (capped)
            followers_gained=10,  # +0.15 (capped)
        )
        score = calculate_information_spread_score(metrics)
        assert score == 1.0, f"Bonuses should stack to 1.0 cap, got {score}"


# =============================================================================
# Network Score Tests
# =============================================================================


class TestNetworkScore:
    """Tests for calculate_network_score()"""

    def test_large_network_score(self):
        """Agent with many connections should score high"""
        metrics = BehaviorMetrics(
            unique_users_interacted=20,
            group_chats_joined=5,
            reputation_delta=30,
        )
        score = calculate_network_score(metrics)
        assert score >= 0.9, f"Large network should score >= 0.9, got {score}"

    def test_moderate_network_score(self):
        """Agent with moderate connections should score moderately"""
        metrics = BehaviorMetrics(
            unique_users_interacted=8,
            group_chats_joined=2,
            reputation_delta=5,
        )
        score = calculate_network_score(metrics)
        assert 0.5 <= score <= 0.9, f"Moderate network should score 0.5-0.9, got {score}"

    def test_isolated_score(self):
        """Agent with few connections should score low"""
        metrics = BehaviorMetrics(
            unique_users_interacted=1,
            group_chats_joined=0,
            reputation_delta=0,
        )
        score = calculate_network_score(metrics)
        assert score <= 0.3, f"Isolated agent should score <= 0.3, got {score}"

    def test_negative_reputation_penalty(self):
        """Negative reputation should penalize score"""
        good_rep = BehaviorMetrics(
            unique_users_interacted=10,
            reputation_delta=20,
        )
        bad_rep = BehaviorMetrics(
            unique_users_interacted=10,
            reputation_delta=-20,
        )

        assert calculate_network_score(good_rep) > calculate_network_score(bad_rep)

    # Boundary tests
    def test_exactly_at_excellent_network(self):
        """Connections exactly at SOCIAL_EXCELLENT_NETWORK"""
        metrics = BehaviorMetrics(unique_users_interacted=SOCIAL_EXCELLENT_NETWORK)
        score = calculate_network_score(metrics)
        assert score == 1.0, f"At excellent network should score 1.0, got {score}"

    def test_exactly_at_good_network(self):
        """Connections exactly at SOCIAL_GOOD_NETWORK"""
        metrics = BehaviorMetrics(unique_users_interacted=SOCIAL_GOOD_NETWORK)
        score = calculate_network_score(metrics)
        assert score == 0.6, f"At good network should score 0.6, got {score}"

    def test_exactly_at_min_network(self):
        """Connections exactly at SOCIAL_MIN_NETWORK"""
        metrics = BehaviorMetrics(unique_users_interacted=SOCIAL_MIN_NETWORK)
        score = calculate_network_score(metrics)
        assert score == 0.2, f"At min network should score 0.2, got {score}"

    def test_reputation_cap_positive(self):
        """Positive reputation bonus caps at 0.15"""
        metrics = BehaviorMetrics(
            unique_users_interacted=SOCIAL_EXCELLENT_NETWORK,
            reputation_delta=100,  # Very high
        )
        score = calculate_network_score(metrics)
        # 1.0 base + 0.15 cap = capped at 1.0
        assert score == 1.0

    def test_reputation_cap_negative(self):
        """Negative reputation penalty caps at -0.15"""
        metrics = BehaviorMetrics(
            unique_users_interacted=SOCIAL_EXCELLENT_NETWORK,
            reputation_delta=-100,  # Very negative
        )
        score = calculate_network_score(metrics)
        # 1.0 base - 0.15 penalty = 0.85
        assert score == 0.85, f"Reputation penalty should cap, got {score}"

    def test_group_bonus_caps(self):
        """Group participation bonus caps at 0.20"""
        metrics = BehaviorMetrics(
            unique_users_interacted=0,
            group_chats_joined=50,  # Very high
        )
        score = calculate_network_score(metrics)
        # 0 network + 0.20 group cap = 0.20
        assert score == 0.2, f"Group bonus should cap at 0.20, got {score}"

    def test_score_floor_at_zero(self):
        """Score should never go below 0.0"""
        metrics = BehaviorMetrics(
            unique_users_interacted=0,
            group_chats_joined=0,
            reputation_delta=-100,  # Very negative
        )
        score = calculate_network_score(metrics)
        assert score == 0.0, f"Score should floor at 0.0, got {score}"

    def test_reputation_in_mild_negative_range(self):
        """Mild negative reputation (> -10) uses proportional penalty"""
        metrics = BehaviorMetrics(
            unique_users_interacted=10,
            reputation_delta=-5,  # Mild negative
        )
        score = calculate_network_score(metrics)
        # -5 * 0.01 = -0.05 penalty
        base_score = calculate_network_score(BehaviorMetrics(unique_users_interacted=10))
        # Use approximate comparison to avoid floating-point precision issues
        assert abs(score - (base_score - 0.05)) < 1e-9


# =============================================================================
# Narrative Alignment Score Tests
# =============================================================================


class TestNarrativeAlignmentScore:
    """Tests for calculate_narrative_alignment_score()"""

    def test_prediction_accuracy_proxy(self):
        """Without timeline, prediction accuracy should be used"""
        metrics = BehaviorMetrics(
            predictions_made=10,
            correct_predictions=8,
            prediction_accuracy=0.8,
        )
        score = calculate_narrative_alignment_score(metrics)
        assert score == 0.8, f"Should use prediction_accuracy, got {score}"

    def test_no_predictions_neutral(self):
        """No predictions should return neutral score"""
        metrics = BehaviorMetrics(predictions_made=0)
        score = calculate_narrative_alignment_score(metrics)
        assert score == 0.5, f"No predictions should return 0.5, got {score}"

    def test_timeline_alignment(self):
        """Agent that reacts correctly to events should score high"""
        metrics = BehaviorMetrics()

        events = [
            NarrativeEvent(
                tick=10,
                event_type="earnings",
                affected_tickers=["AAPL"],
                direction="up",
                revealed=True,
            ),
        ]

        actions = [
            {"tick": 12, "action_type": "buy", "ticker": "AAPL"},
        ]

        score = calculate_narrative_alignment_score(metrics, actions, events)
        assert score == 1.0, f"Correct reaction should score 1.0, got {score}"

    def test_timeline_misalignment(self):
        """Agent that reacts incorrectly to events should score low"""
        metrics = BehaviorMetrics()

        events = [
            NarrativeEvent(
                tick=10,
                event_type="scandal",
                affected_tickers=["AAPL"],
                direction="down",
                revealed=True,
            ),
        ]

        actions = [
            {"tick": 12, "action_type": "buy", "ticker": "AAPL"},  # Wrong: should sell
        ]

        score = calculate_narrative_alignment_score(metrics, actions, events)
        assert score == 0.0, f"Wrong reaction should score 0.0, got {score}"

    # Edge cases
    def test_unrevealed_events_ignored(self):
        """Unrevealed events should not affect scoring"""
        metrics = BehaviorMetrics()

        events = [
            NarrativeEvent(
                tick=10,
                event_type="insider",
                affected_tickers=["AAPL"],
                direction="up",
                revealed=False,  # Not revealed
            ),
        ]

        actions = [
            {"tick": 12, "action_type": "sell", "ticker": "AAPL"},  # "Wrong" but event not revealed
        ]

        score = calculate_narrative_alignment_score(metrics, actions, events)
        assert score == 0.5, f"Unrevealed events should return neutral, got {score}"

    def test_action_on_wrong_ticker(self):
        """Action on different ticker should not count"""
        metrics = BehaviorMetrics()

        events = [
            NarrativeEvent(
                tick=10,
                event_type="earnings",
                affected_tickers=["AAPL"],
                direction="up",
                revealed=True,
            ),
        ]

        actions = [
            {"tick": 12, "action_type": "buy", "ticker": "GOOG"},  # Wrong ticker
        ]

        score = calculate_narrative_alignment_score(metrics, actions, events)
        # Action was taken but on wrong ticker, so no correct reaction
        assert score == 0.0, f"Wrong ticker should score 0.0, got {score}"

    def test_action_too_late(self):
        """Action more than 5 ticks after event should not count"""
        metrics = BehaviorMetrics()

        events = [
            NarrativeEvent(
                tick=10,
                event_type="earnings",
                affected_tickers=["AAPL"],
                direction="up",
                revealed=True,
            ),
        ]

        actions = [
            {"tick": 20, "action_type": "buy", "ticker": "AAPL"},  # Too late (10 ticks)
        ]

        score = calculate_narrative_alignment_score(metrics, actions, events)
        assert score == 0.5, f"Late action should not count, got {score}"

    def test_action_before_event(self):
        """Action before event should not count as reaction"""
        metrics = BehaviorMetrics()

        events = [
            NarrativeEvent(
                tick=10,
                event_type="earnings",
                affected_tickers=["AAPL"],
                direction="up",
                revealed=True,
            ),
        ]

        actions = [
            {"tick": 8, "action_type": "buy", "ticker": "AAPL"},  # Before event
        ]

        score = calculate_narrative_alignment_score(metrics, actions, events)
        assert score == 0.5, f"Action before event should not count, got {score}"

    def test_multiple_events_partial_alignment(self):
        """Score should reflect proportion of correct reactions"""
        metrics = BehaviorMetrics()

        events = [
            NarrativeEvent(
                tick=10, event_type="good", affected_tickers=["AAPL"], direction="up", revealed=True
            ),
            NarrativeEvent(
                tick=20,
                event_type="bad",
                affected_tickers=["GOOG"],
                direction="down",
                revealed=True,
            ),
        ]

        actions = [
            {"tick": 12, "action_type": "buy", "ticker": "AAPL"},  # Correct
            {"tick": 22, "action_type": "buy", "ticker": "GOOG"},  # Wrong (should sell)
        ]

        score = calculate_narrative_alignment_score(metrics, actions, events)
        assert score == 0.5, f"Half right should score 0.5, got {score}"

    def test_long_action_type(self):
        """'long' in action_type should count as buy"""
        metrics = BehaviorMetrics()

        events = [
            NarrativeEvent(
                tick=10, event_type="good", affected_tickers=["BTC"], direction="up", revealed=True
            ),
        ]

        actions = [
            {"tick": 12, "action_type": "open_long", "ticker": "BTC"},
        ]

        score = calculate_narrative_alignment_score(metrics, actions, events)
        assert score == 1.0, f"'long' should count as buy, got {score}"

    def test_short_action_type(self):
        """'short' in action_type should count as sell"""
        metrics = BehaviorMetrics()

        events = [
            NarrativeEvent(
                tick=10, event_type="bad", affected_tickers=["BTC"], direction="down", revealed=True
            ),
        ]

        actions = [
            {"tick": 12, "action_type": "open_short", "ticker": "BTC"},
        ]

        score = calculate_narrative_alignment_score(metrics, actions, events)
        assert score == 1.0, f"'short' should count as sell, got {score}"

    def test_empty_events_list(self):
        """Empty events list should return neutral"""
        metrics = BehaviorMetrics()
        score = calculate_narrative_alignment_score(metrics, [{"tick": 1}], [])
        assert score == 0.5, f"Empty events should return 0.5, got {score}"

    def test_empty_actions_list(self):
        """Empty actions list should return neutral (no reactions)"""
        metrics = BehaviorMetrics()
        events = [
            NarrativeEvent(
                tick=10, event_type="x", affected_tickers=["A"], direction="up", revealed=True
            )
        ]
        score = calculate_narrative_alignment_score(metrics, [], events)
        assert score == 0.5, f"Empty actions should return 0.5, got {score}"

    def test_missing_tick_in_action(self):
        """Action missing tick field should be handled"""
        metrics = BehaviorMetrics()
        events = [
            NarrativeEvent(
                tick=10, event_type="x", affected_tickers=["A"], direction="up", revealed=True
            )
        ]
        actions = [{"action_type": "buy", "ticker": "A"}]  # No tick
        score = calculate_narrative_alignment_score(metrics, actions, events)
        # get("tick", 0) defaults to 0, which is before event
        assert score == 0.5


# =============================================================================
# Social Reward Weight Validation
# =============================================================================


class TestSocialRewardWeights:
    """Verify weight configurations are valid"""

    def test_all_social_weights_sum_to_one(self):
        """All archetype weight profiles should sum to 1.0"""
        for archetype, weights in SOCIAL_REWARD_WEIGHTS.items():
            total = sum(weights.values())
            assert abs(total - 1.0) < 1e-9, f"Weights for {archetype} sum to {total}, expected 1.0"

    def test_all_composite_weights_sum_to_one(self):
        """All composite weight profiles should sum to 1.0"""
        for archetype, weights in SOCIAL_COMPOSITE_WEIGHTS.items():
            total = sum(weights.values())
            assert abs(total - 1.0) < 1e-9, (
                f"Composite weights for {archetype} sum to {total}, expected 1.0"
            )

    def test_all_weights_non_negative(self):
        """All weights should be non-negative"""
        for archetype, weights in SOCIAL_REWARD_WEIGHTS.items():
            for key, value in weights.items():
                assert value >= 0, f"Weight {key} for {archetype} is negative: {value}"

    def test_required_weight_keys_present(self):
        """All weight dicts should have required keys"""
        required_social = {"engagement", "spread", "network", "narrative"}
        required_composite = {"social", "format", "reasoning", "pnl"}

        for archetype, weights in SOCIAL_REWARD_WEIGHTS.items():
            assert set(weights.keys()) == required_social, f"Missing keys in {archetype}"

        for archetype, weights in SOCIAL_COMPOSITE_WEIGHTS.items():
            assert set(weights.keys()) == required_composite, f"Missing keys in {archetype}"


# =============================================================================
# Calculate Social Reward Tests
# =============================================================================


class TestCalculateSocialReward:
    """Tests for calculate_social_reward()"""

    def test_social_butterfly_weights(self):
        """Social Butterfly should weight network highly"""
        metrics = BehaviorMetrics(
            unique_users_interacted=20,
            group_chats_joined=5,
            posts_created=10,
            information_spread=5,
            reputation_delta=20,
        )

        result = calculate_social_reward(metrics, "social-butterfly")

        assert isinstance(result, SocialRewardResult)
        assert result.network_score > 0.8
        assert result.total_score > 0.6

    def test_information_trader_weights(self):
        """Information Trader should weight narrative alignment highly"""
        metrics = BehaviorMetrics(
            predictions_made=10,
            correct_predictions=8,
            prediction_accuracy=0.8,
            unique_users_interacted=5,
            group_chats_joined=3,
        )

        result = calculate_social_reward(metrics, "information-trader")

        assert result.narrative_alignment_score == 0.8
        # Info trader weights narrative at 40%
        assert result.total_score > 0.4

    def test_scammer_weights(self):
        """Scammer should weight spread highly"""
        metrics = BehaviorMetrics(
            information_spread=15,
            positive_reactions=10,
            unique_users_interacted=10,
        )

        result = calculate_social_reward(metrics, "scammer")

        assert result.information_spread_score > 0.8
        # Scammer weights spread at 40%
        assert result.total_score > 0.5

    def test_default_archetype_balanced(self):
        """Unknown archetype should use balanced weights"""
        metrics = BehaviorMetrics(
            unique_users_interacted=10,
            posts_created=5,
            information_spread=5,
            predictions_made=5,
            correct_predictions=3,
            prediction_accuracy=0.6,
        )

        result = calculate_social_reward(metrics, "unknown-archetype")

        # All components should contribute equally (25% each)
        assert 0.3 <= result.total_score <= 0.7

    # Additional archetype tests
    def test_liar_weights(self):
        """Liar should use same weights as scammer (spread-focused)"""
        metrics = BehaviorMetrics(information_spread=15)

        scammer_result = calculate_social_reward(metrics, "scammer")
        liar_result = calculate_social_reward(metrics, "liar")

        assert scammer_result.total_score == liar_result.total_score

    def test_goody_twoshoes_weights(self):
        """Goody Two-Shoes should have balanced weights"""
        metrics = BehaviorMetrics(
            unique_users_interacted=10,
            posts_created=5,
            information_spread=5,
            prediction_accuracy=0.6,
            predictions_made=5,
        )

        result = calculate_social_reward(metrics, "goody-twoshoes")
        assert 0.3 <= result.total_score <= 0.7

    def test_ass_kisser_weights(self):
        """Ass-Kisser should weight engagement and network highly"""
        metrics = BehaviorMetrics(
            unique_users_interacted=15,
            posts_created=10,
            comments_made=10,
        )

        result = calculate_social_reward(metrics, "ass-kisser")
        # 35% engagement + 40% network = 75% from these two
        assert result.total_score > 0.5

    def test_archetype_normalization(self):
        """Archetype names should be normalized (case, underscores)"""
        metrics = BehaviorMetrics(unique_users_interacted=10)

        # Test various formats
        r1 = calculate_social_reward(metrics, "social-butterfly")
        r2 = calculate_social_reward(metrics, "Social-Butterfly")
        r3 = calculate_social_reward(metrics, "SOCIAL_BUTTERFLY")
        r4 = calculate_social_reward(metrics, "social_butterfly")

        assert r1.total_score == r2.total_score == r3.total_score == r4.total_score

    def test_result_to_dict(self):
        """SocialRewardResult.to_dict() should return all components"""
        metrics = BehaviorMetrics(
            unique_users_interacted=10,
            posts_created=5,
            information_spread=5,
        )

        result = calculate_social_reward(metrics, "social-butterfly")
        result_dict = result.to_dict()

        assert "engagement_score" in result_dict
        assert "information_spread_score" in result_dict
        assert "narrative_alignment_score" in result_dict
        assert "network_score" in result_dict
        assert "total_score" in result_dict

        # Verify values match
        assert result_dict["total_score"] == result.total_score

    def test_all_zero_metrics(self):
        """All zero metrics should still return valid result"""
        metrics = BehaviorMetrics()
        result = calculate_social_reward(metrics, "social-butterfly")

        assert result.engagement_score >= 0.0
        assert result.network_score >= 0.0
        assert result.information_spread_score >= 0.0
        assert result.narrative_alignment_score == 0.5  # Neutral with no predictions
        assert 0.0 <= result.total_score <= 1.0


# =============================================================================
# Social Only Composite Reward Tests
# =============================================================================


class TestSocialOnlyCompositeReward:
    """Tests for social_only_composite_reward()"""

    def test_social_butterfly_pnl_irrelevant(self):
        """Social Butterfly should score high even with zero PnL"""
        inputs = TrajectoryRewardInputs(
            final_pnl=0,
            starting_balance=10000,
            end_balance=10000,
            format_score=0.8,
            reasoning_score=0.7,
        )

        metrics = BehaviorMetrics(
            unique_users_interacted=20,
            group_chats_joined=5,
            posts_created=10,
            dms_initiated=8,
            reputation_delta=30,
        )

        reward = social_only_composite_reward(
            inputs=inputs,
            archetype="social-butterfly",
            behavior_metrics=metrics,
        )

        assert reward > 0.5, (
            f"Social Butterfly with great social metrics should score > 0.5 even with $0 PnL, got {reward}"
        )

    def test_bankruptcy_still_penalized(self):
        """Even social butterflies shouldn't go bankrupt"""
        inputs = TrajectoryRewardInputs(
            final_pnl=-10000,
            starting_balance=10000,
            end_balance=0,
            format_score=0.8,
            reasoning_score=0.7,
        )

        metrics = BehaviorMetrics(
            unique_users_interacted=20,
            group_chats_joined=5,
        )

        reward = social_only_composite_reward(
            inputs=inputs,
            archetype="social-butterfly",
            behavior_metrics=metrics,
        )

        assert reward == -0.5, f"Bankruptcy should return -0.5, got {reward}"

    def test_social_butterfly_beats_poor_trader(self):
        """Social Butterfly with great social should beat trader with poor trading"""
        # Great social, no trading
        social_inputs = TrajectoryRewardInputs(
            final_pnl=0,
            starting_balance=10000,
            end_balance=10000,
            format_score=0.8,
            reasoning_score=0.7,
        )
        social_metrics = BehaviorMetrics(
            unique_users_interacted=20,
            group_chats_joined=5,
            posts_created=15,
            dms_initiated=10,
            reputation_delta=40,
        )

        # Bad trading, no social
        trader_inputs = TrajectoryRewardInputs(
            final_pnl=-500,
            starting_balance=10000,
            end_balance=9500,
            format_score=0.6,
            reasoning_score=0.5,
        )
        trader_metrics = BehaviorMetrics(
            trades_executed=10,
            profitable_trades=3,
            win_rate=0.3,
            total_pnl=-500,
        )

        social_reward = social_only_composite_reward(
            inputs=social_inputs,
            archetype="social-butterfly",
            behavior_metrics=social_metrics,
        )

        # For fair comparison, evaluate trader using same social scoring
        trader_reward = social_only_composite_reward(
            inputs=trader_inputs,
            archetype="social-butterfly",
            behavior_metrics=trader_metrics,
        )

        assert social_reward > trader_reward, (
            f"Social butterfly ({social_reward}) should beat poor trader ({trader_reward})"
        )

    # Edge cases
    def test_negative_end_balance(self):
        """Negative end balance should trigger bankruptcy penalty"""
        inputs = TrajectoryRewardInputs(
            final_pnl=-15000,
            starting_balance=10000,
            end_balance=-5000,
            format_score=1.0,
            reasoning_score=1.0,
        )

        reward = social_only_composite_reward(
            inputs=inputs,
            archetype="social-butterfly",
            behavior_metrics=BehaviorMetrics(unique_users_interacted=100),
        )

        assert reward == -0.5, f"Negative balance should return -0.5, got {reward}"

    def test_zero_starting_balance(self):
        """Zero starting balance should not cause division by zero"""
        inputs = TrajectoryRewardInputs(
            final_pnl=0,
            starting_balance=0,
            end_balance=100,  # Not bankrupt
            format_score=0.5,
            reasoning_score=0.5,
        )

        reward = social_only_composite_reward(
            inputs=inputs,
            archetype="social-butterfly",
            behavior_metrics=BehaviorMetrics(),
        )

        # Should not raise, should return valid score
        assert -1.0 <= reward <= 1.0

    def test_no_behavior_metrics(self):
        """Should handle None behavior_metrics gracefully"""
        inputs = TrajectoryRewardInputs(
            final_pnl=100,
            starting_balance=10000,
            end_balance=10100,
            format_score=0.8,
            reasoning_score=0.7,
        )

        reward = social_only_composite_reward(
            inputs=inputs,
            archetype="social-butterfly",
            behavior_metrics=None,
        )

        # Should use empty SocialRewardResult
        assert -1.0 <= reward <= 1.0

    def test_large_profit_pnl_bonus(self):
        """Large profit should give PnL bonus (but social still dominates)"""
        inputs_profit = TrajectoryRewardInputs(
            final_pnl=1000,
            starting_balance=10000,
            end_balance=11000,
            format_score=0.5,
            reasoning_score=0.5,
        )

        inputs_break_even = TrajectoryRewardInputs(
            final_pnl=0,
            starting_balance=10000,
            end_balance=10000,
            format_score=0.5,
            reasoning_score=0.5,
        )

        metrics = BehaviorMetrics(unique_users_interacted=10)

        profit_reward = social_only_composite_reward(inputs_profit, "social-butterfly", metrics)
        even_reward = social_only_composite_reward(inputs_break_even, "social-butterfly", metrics)

        # Profit should give slight bonus
        assert profit_reward > even_reward

    def test_heavy_loss_penalty(self):
        """Heavy loss (>50% of starting) should give penalty"""
        inputs = TrajectoryRewardInputs(
            final_pnl=-6000,  # >50% loss
            starting_balance=10000,
            end_balance=4000,
            format_score=0.8,
            reasoning_score=0.8,
        )

        metrics = BehaviorMetrics(unique_users_interacted=10)

        reward = social_only_composite_reward(inputs, "social-butterfly", metrics)

        # Should have -0.3 penalty on PnL component
        break_even = social_only_composite_reward(
            TrajectoryRewardInputs(
                final_pnl=0,
                starting_balance=10000,
                end_balance=10000,
                format_score=0.8,
                reasoning_score=0.8,
            ),
            "social-butterfly",
            metrics,
        )

        assert reward < break_even

    def test_all_weights_archetypes(self):
        """All archetypes with composite weights should work"""
        inputs = TrajectoryRewardInputs(
            final_pnl=0,
            starting_balance=10000,
            end_balance=10000,
            format_score=0.5,
            reasoning_score=0.5,
        )
        metrics = BehaviorMetrics(unique_users_interacted=10)

        for archetype in ["social-butterfly", "ass-kisser", "goody-twoshoes", "unknown"]:
            reward = social_only_composite_reward(inputs, archetype, metrics)
            assert -1.0 <= reward <= 1.0, f"Invalid reward for {archetype}: {reward}"

    def test_reward_clamped_to_bounds(self):
        """Reward should always be in [-1.0, 1.0]"""
        # Best case: everything perfect
        best_inputs = TrajectoryRewardInputs(
            final_pnl=5000,
            starting_balance=10000,
            end_balance=15000,
            format_score=1.0,
            reasoning_score=1.0,
        )
        best_metrics = BehaviorMetrics(
            unique_users_interacted=50,
            posts_created=50,
            information_spread=50,
            reputation_delta=100,
        )

        best_reward = social_only_composite_reward(best_inputs, "social-butterfly", best_metrics)
        assert best_reward <= 1.0, f"Best case should cap at 1.0, got {best_reward}"

        # Worst case (non-bankrupt): everything bad
        worst_inputs = TrajectoryRewardInputs(
            final_pnl=-4000,
            starting_balance=10000,
            end_balance=6000,  # Not bankrupt but bad
            format_score=0.0,
            reasoning_score=0.0,
        )
        worst_metrics = BehaviorMetrics()

        worst_reward = social_only_composite_reward(worst_inputs, "social-butterfly", worst_metrics)
        assert worst_reward >= -1.0, f"Worst case should floor at -1.0, got {worst_reward}"


class TestIntegrationNonTraderCanWin:
    """
    Integration test: Non-trader archetype can outscore passive trader

    This proves that the reward function allows social-focused agents
    to achieve high scores without trading profitably.
    """

    def test_social_butterfly_outscores_passive_trader(self):
        """
        A Social Butterfly with high social engagement should outscore
        a passive trader who just holds their balance.
        """
        # Passive trader: held balance, did nothing
        passive_inputs = TrajectoryRewardInputs(
            final_pnl=0,
            starting_balance=10000,
            end_balance=10000,
            format_score=0.5,  # Average format
            reasoning_score=0.5,  # Average reasoning
        )
        passive_metrics = BehaviorMetrics(
            trades_executed=0,
            unique_users_interacted=0,
        )

        # Active Social Butterfly: lots of engagement, no trading
        butterfly_inputs = TrajectoryRewardInputs(
            final_pnl=0,
            starting_balance=10000,
            end_balance=10000,
            format_score=0.8,
            reasoning_score=0.7,
        )
        butterfly_metrics = BehaviorMetrics(
            trades_executed=0,
            unique_users_interacted=25,
            group_chats_joined=6,
            dms_initiated=15,
            posts_created=20,
            comments_made=30,
            mentions_given=10,
            followers_gained=15,
            reputation_delta=50,
            positive_reactions=25,
            information_spread=12,
        )

        passive_reward = social_only_composite_reward(
            inputs=passive_inputs,
            archetype="social-butterfly",
            behavior_metrics=passive_metrics,
        )

        butterfly_reward = social_only_composite_reward(
            inputs=butterfly_inputs,
            archetype="social-butterfly",
            behavior_metrics=butterfly_metrics,
        )

        assert butterfly_reward > passive_reward, (
            f"Active butterfly ({butterfly_reward:.3f}) should outscore passive ({passive_reward:.3f})"
        )

        # The difference should be significant
        assert butterfly_reward - passive_reward > 0.2, (
            f"Score difference ({butterfly_reward - passive_reward:.3f}) should be > 0.2"
        )

    def test_information_trader_with_predictions_outscores_random_trader(self):
        """
        Information Trader with good predictions but no trading
        should outscore trader with random trades.
        """
        # Random trader: traded randomly, lost money
        random_inputs = TrajectoryRewardInputs(
            final_pnl=-200,
            starting_balance=10000,
            end_balance=9800,
            format_score=0.5,
            reasoning_score=0.4,
        )
        random_metrics = BehaviorMetrics(
            trades_executed=10,
            profitable_trades=4,
            win_rate=0.4,
            total_pnl=-200,
        )

        # Information trader: gathered intel, made predictions
        intel_inputs = TrajectoryRewardInputs(
            final_pnl=0,
            starting_balance=10000,
            end_balance=10000,
            format_score=0.9,
            reasoning_score=0.85,
        )
        intel_metrics = BehaviorMetrics(
            trades_executed=0,
            predictions_made=15,
            correct_predictions=12,
            prediction_accuracy=0.8,
            unique_users_interacted=10,
            group_chats_joined=4,
            dms_initiated=8,
            info_requests_sent=10,
        )

        random_reward = social_only_composite_reward(
            inputs=random_inputs,
            archetype="information-trader",
            behavior_metrics=random_metrics,
        )

        intel_reward = social_only_composite_reward(
            inputs=intel_inputs,
            archetype="information-trader",
            behavior_metrics=intel_metrics,
        )

        assert intel_reward > random_reward, (
            f"Intel trader ({intel_reward:.3f}) should outscore random ({random_reward:.3f})"
        )
