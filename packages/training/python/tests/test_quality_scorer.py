"""
Tests for Quality Scorer

Tests cover:
- Length penalty calculations
- Quality score calculations
- Archetype-specific bonuses
- Integration with format validator
"""

import pytest

from src.training.quality_scorer import (
    QualityScore,
    calculate_thinking_length_penalty,
    calculate_response_length_penalty,
    calculate_combined_length_penalty,
    score_response,
    score_response_for_reward,
    get_quality_bonus_for_archetype,
    score_response_batch,
    get_relative_quality_scores,
)
from src.training.scenario_pool import (
    Scenario,
    MarketState,
    PerpetualState,
    PortfolioState,
)


# =============================================================================
# Test Fixtures
# =============================================================================


def create_test_scenario() -> Scenario:
    """Create a test scenario"""
    return Scenario(
        id="test-scenario",
        source="synthetic",
        markets=[
            MarketState(
                market_id="btc-100k",
                question="Will BTC hit $100K?",
                yes_price=0.65,
                no_price=0.35,
                volume_24h=500000.0,
                liquidity=1000000.0,
                expires_at=1735689600000,
            ),
        ],
        perpetuals=[
            PerpetualState(
                ticker="BTC",
                mark_price=100000.0,
                index_price=99990.0,
                funding_rate=0.0001,
                open_interest=50000000.0,
                volume_24h=500000000.0,
                change_24h=0.02,
                high_24h=102000.0,
                low_24h=98000.0,
            ),
        ],
        portfolio=PortfolioState(balance=50000.0),
    )


# =============================================================================
# QualityScore Tests
# =============================================================================


class TestQualityScore:
    """Tests for QualityScore dataclass"""

    def test_creation(self):
        score = QualityScore(
            format_score=0.8,
            reasoning_score=0.7,
            execution_score=0.6,
            length_penalty=-0.1,
        )
        
        assert score.format_score == 0.8
        assert score.reasoning_score == 0.7
        assert score.length_penalty == -0.1

    def test_total_score(self):
        score = QualityScore(
            format_score=1.0,
            reasoning_score=1.0,
            execution_score=1.0,
            length_penalty=0.0,
        )
        
        # Perfect score
        assert score.total_score == pytest.approx(0.90, rel=0.01)  # 40+30+20 = 90%

    def test_total_score_with_penalty(self):
        score1 = QualityScore(
            format_score=0.8,
            reasoning_score=0.6,
            execution_score=0.5,
            length_penalty=0.0,
        )
        
        score2 = QualityScore(
            format_score=0.8,
            reasoning_score=0.6,
            execution_score=0.5,
            length_penalty=-0.5,
        )
        
        # Penalty should reduce total
        assert score1.total_score > score2.total_score

    def test_combined_format_score(self):
        score = QualityScore(
            format_score=0.8,
            length_penalty=-0.2,
        )
        
        # Combined should be lower due to penalty
        assert score.combined_format_score < score.format_score

    def test_to_dict(self):
        score = QualityScore(
            format_score=0.8,
            reasoning_score=0.7,
            has_thinking=True,
            has_valid_action=True,
            action_type="buy",
        )
        
        d = score.to_dict()
        
        assert "total_score" in d
        assert "format_score" in d
        assert d["has_thinking"] is True
        assert d["action_type"] == "buy"


# =============================================================================
# Length Penalty Tests
# =============================================================================


class TestThinkingLengthPenalty:
    """Tests for thinking length penalty"""

    def test_very_short_penalty(self):
        penalty = calculate_thinking_length_penalty(10)
        assert penalty == -0.5

    def test_short_penalty(self):
        penalty = calculate_thinking_length_penalty(50)
        assert penalty == -0.3

    def test_minimal_penalty(self):
        penalty = calculate_thinking_length_penalty(120)
        assert penalty == -0.1

    def test_ideal_no_penalty(self):
        penalty = calculate_thinking_length_penalty(250)
        assert penalty == 0.0

    def test_still_good_no_penalty(self):
        penalty = calculate_thinking_length_penalty(500)
        assert penalty == 0.0

    def test_verbose_penalty(self):
        penalty = calculate_thinking_length_penalty(800)
        assert penalty == -0.1

    def test_too_long_penalty(self):
        penalty = calculate_thinking_length_penalty(1500)
        assert penalty == -0.2


class TestResponseLengthPenalty:
    """Tests for response length penalty"""

    def test_very_short_penalty(self):
        penalty = calculate_response_length_penalty(20)
        assert penalty == -0.4

    def test_short_penalty(self):
        penalty = calculate_response_length_penalty(100)
        assert penalty == -0.2

    def test_ideal_no_penalty(self):
        penalty = calculate_response_length_penalty(300)
        assert penalty == 0.0

    def test_still_good_no_penalty(self):
        penalty = calculate_response_length_penalty(800)
        assert penalty == 0.0

    def test_verbose_penalty(self):
        penalty = calculate_response_length_penalty(1500)
        assert penalty == -0.1

    def test_too_long_penalty(self):
        penalty = calculate_response_length_penalty(3000)
        assert penalty == -0.2


class TestCombinedLengthPenalty:
    """Tests for combined length penalty"""

    def test_both_ideal(self):
        penalty = calculate_combined_length_penalty(250, 400)
        assert penalty == 0.0

    def test_thinking_too_short(self):
        penalty = calculate_combined_length_penalty(10, 400)
        assert penalty < 0

    def test_both_too_long(self):
        penalty = calculate_combined_length_penalty(1500, 3000)
        assert penalty < -0.1


# =============================================================================
# Score Response Tests
# =============================================================================


class TestScoreResponse:
    """Tests for score_response"""

    def test_excellent_response(self):
        response = """<think>
The market shows strong bullish momentum with BTC trading at $100,000.
Because the volume is high and funding rates are neutral, I expect
continued upward movement. The risk is limited given the strong trend.
</think>

{"action": "open_perp", "ticker": "BTC", "size": 0.1, "direction": "long"}"""
        
        score = score_response(response)
        
        assert score.has_thinking is True
        assert score.has_valid_action is True
        assert score.format_score > 0.6
        assert score.reasoning_score > 0.4
        assert score.total_score > 0.5

    def test_minimal_response(self):
        response = """<think>Quick check</think>
{"action": "wait"}"""
        
        score = score_response(response)
        
        assert score.has_thinking is True
        assert score.has_valid_action is True
        assert score.length_penalty < 0  # Too short

    def test_no_thinking(self):
        response = '{"action": "buy", "market": "btc", "amount": 100}'
        
        score = score_response(response)
        
        assert score.has_thinking is False
        assert score.format_score < 0.5

    def test_no_action(self):
        response = "<think>Long analysis here</think>\nNo action decided."
        
        score = score_response(response)
        
        assert score.has_thinking is True
        assert score.has_valid_action is False

    def test_verbose_penalty(self):
        long_thinking = "x" * 1200
        response = f"<think>{long_thinking}</think>{{\"action\": \"wait\"}}"
        
        score = score_response(response)
        
        assert score.length_penalty < 0

    def test_with_scenario(self):
        scenario = create_test_scenario()
        response = """<think>Analyzing BTC market</think>
{"action": "open_perp", "ticker": "BTC", "size": 0.1, "direction": "long"}"""
        
        score = score_response(response, scenario=scenario)
        
        assert score.has_valid_action is True


# =============================================================================
# Score Response for Reward Tests
# =============================================================================


class TestScoreResponseForReward:
    """Tests for score_response_for_reward"""

    def test_returns_tuple(self):
        response = "<think>Analysis</think>{\"action\": \"wait\"}"
        
        format_score, reasoning_score, metrics = score_response_for_reward(response)
        
        assert 0.0 <= format_score <= 1.0
        assert 0.0 <= reasoning_score <= 1.0
        assert isinstance(metrics, dict)

    def test_with_scenario(self):
        scenario = create_test_scenario()
        response = """<think>Market analysis</think>
{"action": "buy", "market": "btc-100k", "amount": 100}"""
        
        format_score, reasoning_score, metrics = score_response_for_reward(
            response, scenario=scenario
        )
        
        assert "action_pnl" in metrics


# =============================================================================
# Archetype Bonus Tests
# =============================================================================


class TestArchetypeBonus:
    """Tests for archetype-specific quality bonuses"""

    def test_degen_prefers_action(self):
        active = QualityScore(
            has_valid_action=True,
            action_type="buy",
            has_thinking=False,
        )
        
        passive = QualityScore(
            has_valid_action=True,
            action_type="wait",
            has_thinking=True,
        )
        
        active_bonus = get_quality_bonus_for_archetype(active, "degen")
        passive_bonus = get_quality_bonus_for_archetype(passive, "degen")
        
        # Degen should prefer active trading
        assert active_bonus > passive_bonus

    def test_analyst_prefers_reasoning(self):
        deep_thinking = QualityScore(
            reasoning_score=0.9,
            thinking_length=300,
            has_valid_action=True,
        )
        
        shallow = QualityScore(
            reasoning_score=0.3,
            thinking_length=50,
            has_valid_action=True,
        )
        
        deep_bonus = get_quality_bonus_for_archetype(deep_thinking, "analyst")
        shallow_bonus = get_quality_bonus_for_archetype(shallow, "analyst")
        
        assert deep_bonus > shallow_bonus

    def test_trader_balanced(self):
        balanced = QualityScore(
            format_score=0.7,
            reasoning_score=0.6,
            execution_score=0.5,
            has_valid_action=True,
            has_thinking=True,
        )
        
        bonus = get_quality_bonus_for_archetype(balanced, "trader")
        
        # Should get some bonus for balanced response
        assert bonus > 0


# =============================================================================
# Batch Scoring Tests
# =============================================================================


class TestBatchScoring:
    """Tests for batch scoring functions"""

    def test_score_response_batch(self):
        responses = [
            "<think>Good analysis</think>{\"action\": \"wait\"}",
            "<think>Brief</think>{\"action\": \"buy\", \"market\": \"x\", \"amount\": 1}",
            "{\"action\": \"wait\"}",
        ]
        
        scores = score_response_batch(responses)
        
        assert len(scores) == 3
        assert all(isinstance(s, QualityScore) for s in scores)

    def test_get_relative_quality_scores(self):
        # Create scores with different quality
        scores = [
            QualityScore(format_score=0.9, reasoning_score=0.8, execution_score=0.7),
            QualityScore(format_score=0.5, reasoning_score=0.4, execution_score=0.5),
            QualityScore(format_score=0.3, reasoning_score=0.2, execution_score=0.3),
        ]
        
        relative = get_relative_quality_scores(scores)
        
        assert len(relative) == 3
        # Should sum to approximately 0 (centered)
        assert abs(sum(relative)) < 0.01
        # First should be positive, last should be negative
        assert relative[0] > 0
        assert relative[2] < 0


# =============================================================================
# Integration Tests
# =============================================================================


class TestIntegration:
    """Integration tests for quality scoring"""

    def test_full_scoring_flow(self):
        """Test complete scoring flow with scenario"""
        scenario = create_test_scenario()
        
        excellent_response = """<think>
Comprehensive market analysis: BTC is trading at $100,000 with strong
bullish momentum. The funding rate is neutral, suggesting room for
continued upside. Because the risk/reward is favorable and volume
supports the move, I'll take a long position with careful sizing.
</think>

{"action": "open_perp", "ticker": "BTC", "size": 0.05, "direction": "long"}"""
        
        poor_response = '{"action": "wait"}'
        
        excellent_score = score_response(excellent_response, scenario)
        poor_score = score_response(poor_response, scenario)
        
        assert excellent_score.total_score > poor_score.total_score
        assert excellent_score.format_score > poor_score.format_score
        assert excellent_score.reasoning_score > poor_score.reasoning_score

    def test_score_ordering(self):
        """Test that scores order responses correctly"""
        responses = [
            """<think>
Detailed analysis with market price, volume, and risk consideration.
Because the momentum is strong and risk is managed, I'll trade.
</think>
{"action": "open_perp", "ticker": "BTC", "size": 0.1, "direction": "long"}""",
            
            """<think>Quick check</think>
{"action": "wait"}""",
            
            '{"action": "wait"}',
        ]
        
        scores = score_response_batch(responses)
        total_scores = [s.total_score for s in scores]
        
        # Should be in descending order
        assert total_scores[0] > total_scores[1]
        assert total_scores[1] > total_scores[2]


