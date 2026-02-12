"""
Tests for Format Validator

Tests cover:
- Think tag validation
- Action JSON validation
- Reasoning quality analysis
- Length analysis
- Complete validation pipeline
"""

import pytest

from src.training.format_validator import (
    ThinkTagResult,
    ActionValidationResult,
    ReasoningQualityResult,
    LengthAnalysisResult,
    FormatValidationResult,
    validate_think_tags,
    validate_action_json,
    analyze_reasoning_quality,
    analyze_length,
    validate_response_format,
    get_format_and_reasoning_scores,
    validate_for_training,
)


# =============================================================================
# Think Tag Validation Tests
# =============================================================================


class TestValidateThinkTags:
    """Tests for validate_think_tags"""

    def test_valid_tags(self):
        response = "<think>This is my analysis</think>\n{\"action\": \"wait\"}"
        
        result = validate_think_tags(response)
        
        assert result.has_open_tag is True
        assert result.has_close_tag is True
        assert result.is_properly_paired is True
        assert "my analysis" in result.thinking_content

    def test_multiline_thinking(self):
        response = """<think>
Line 1: Market analysis
Line 2: Risk assessment
Line 3: Decision reasoning
</think>

{"action": "buy"}"""
        
        result = validate_think_tags(response)
        
        assert result.is_properly_paired is True
        assert "Line 1" in result.thinking_content
        assert "Line 3" in result.thinking_content
        assert result.thinking_length > 50

    def test_no_tags(self):
        response = '{"action": "wait"}'
        
        result = validate_think_tags(response)
        
        assert result.has_open_tag is False
        assert result.has_close_tag is False
        assert result.score == 0.0

    def test_missing_close_tag(self):
        response = "<think>Some content but no closing"
        
        result = validate_think_tags(response)
        
        assert result.has_open_tag is True
        assert result.has_close_tag is False
        assert result.is_properly_paired is False
        assert len(result.issues) > 0

    def test_missing_open_tag(self):
        response = "Some content</think>"
        
        result = validate_think_tags(response)
        
        assert result.has_open_tag is False
        assert result.has_close_tag is True
        assert result.is_properly_paired is False

    def test_empty_thinking(self):
        response = "<think></think>{\"action\": \"wait\"}"
        
        result = validate_think_tags(response)
        
        assert result.is_properly_paired is True
        assert result.thinking_length == 0
        assert len(result.issues) > 0  # Too short warning

    def test_case_insensitive(self):
        response = "<THINK>Analysis here</THINK>"
        
        result = validate_think_tags(response)
        
        assert result.is_properly_paired is True

    def test_score_calculation(self):
        # Good thinking
        good_response = "<think>" + "x" * 200 + "</think>"
        good_result = validate_think_tags(good_response)
        
        # Minimal thinking
        minimal_response = "<think>" + "x" * 30 + "</think>"
        minimal_result = validate_think_tags(minimal_response)
        
        # No thinking
        no_response = '{"action": "wait"}'
        no_result = validate_think_tags(no_response)
        
        assert good_result.score > minimal_result.score
        assert minimal_result.score > no_result.score


# =============================================================================
# Action JSON Validation Tests
# =============================================================================


class TestValidateActionJson:
    """Tests for validate_action_json"""

    def test_valid_action(self):
        response = '{"action": "buy", "market": "btc", "amount": 100}'
        
        result = validate_action_json(response)
        
        assert result.has_action is True
        assert result.is_valid_json is True
        assert result.action_type == "buy"
        assert result.is_known_action is True

    def test_action_after_think_tags(self):
        response = """<think>Analysis</think>

{"action": "open_perp", "ticker": "BTC", "size": 0.1, "direction": "long"}"""
        
        result = validate_action_json(response)
        
        assert result.is_valid is True
        assert result.action_type == "open_perp"
        assert result.has_required_fields is True

    def test_wait_action(self):
        response = '{"action": "wait", "reason": "waiting"}'
        
        result = validate_action_json(response)
        
        assert result.is_valid is True
        assert result.action_type == "wait"
        assert result.has_required_fields is True

    def test_invalid_json(self):
        response = "{action: buy, market: btc}"  # Invalid JSON (no quotes)
        
        result = validate_action_json(response)
        
        assert result.has_action is True
        assert result.is_valid_json is False
        assert len(result.issues) > 0

    def test_no_json(self):
        response = "I'll wait for now. No action needed."
        
        result = validate_action_json(response)
        
        assert result.has_action is False
        assert len(result.issues) > 0

    def test_unknown_action_type(self):
        response = '{"action": "invalid_action_type"}'
        
        result = validate_action_json(response)
        
        assert result.is_valid_json is True
        assert result.is_known_action is False
        assert "Unknown action type" in str(result.issues)

    def test_missing_required_fields(self):
        response = '{"action": "buy"}'  # Missing market and amount
        
        result = validate_action_json(response)
        
        assert result.is_valid_json is True
        assert result.action_type == "buy"
        assert result.has_required_fields is False

    def test_score_calculation(self):
        # Valid action
        valid = '{"action": "buy", "market": "btc", "amount": 100}'
        valid_result = validate_action_json(valid)
        
        # Missing fields
        incomplete = '{"action": "buy"}'
        incomplete_result = validate_action_json(incomplete)
        
        # No JSON
        none = "No action"
        none_result = validate_action_json(none)
        
        assert valid_result.score > incomplete_result.score
        assert incomplete_result.score > none_result.score


# =============================================================================
# Reasoning Quality Tests
# =============================================================================


class TestAnalyzeReasoningQuality:
    """Tests for analyze_reasoning_quality"""

    def test_high_quality_reasoning(self):
        thinking = """
        Looking at the market price and volume, there's strong bullish momentum.
        The risk is moderate given the current support levels. Because the funding
        rate is low and probability of breakout is high, I'll take a long position.
        The target is $100,000 with a stop at $95,000 for a 2:1 risk-reward ratio.
        """
        
        result = analyze_reasoning_quality(thinking)
        
        assert result.analysis_term_count > 3
        assert result.has_decision_justification is True
        assert result.has_risk_consideration is True
        assert result.numerical_count > 0
        assert result.score > 0.6

    def test_low_quality_reasoning(self):
        thinking = "I'll buy now."
        
        result = analyze_reasoning_quality(thinking)
        
        assert result.analysis_term_count == 0
        assert result.has_decision_justification is False
        assert result.has_risk_consideration is False
        assert result.score < 0.3

    def test_no_reasoning(self):
        result = analyze_reasoning_quality("")
        
        assert result.score == 0.0
        assert result.analysis_term_count == 0

    def test_market_analysis_detection(self):
        thinking = "Looking at BTC's price action and Ethereum's momentum"
        
        result = analyze_reasoning_quality(thinking)
        
        assert result.has_market_analysis is True

    def test_numerical_analysis(self):
        thinking = "Entry at $100, target $120, stop at $95. That's 20% upside vs 5% downside."
        
        result = analyze_reasoning_quality(thinking)
        
        assert result.numerical_count >= 3

    def test_decision_justification(self):
        thinking = "I'm buying because the fundamentals are strong and therefore expect gains."
        
        result = analyze_reasoning_quality(thinking)
        
        assert result.has_decision_justification is True
        assert result.decision_term_count >= 2


# =============================================================================
# Length Analysis Tests
# =============================================================================


class TestAnalyzeLength:
    """Tests for analyze_length"""

    def test_ideal_length(self):
        response = "x" * 300
        thinking = "y" * 200
        action = '{"action": "wait"}'
        
        result = analyze_length(response, thinking, action)
        
        assert result.is_too_short is False
        assert result.is_too_long is False
        assert result.score == 1.0

    def test_too_short(self):
        response = "short"
        thinking = ""
        action = ""
        
        result = analyze_length(response, thinking, action)
        
        assert result.is_too_short is True
        assert result.score < 1.0

    def test_too_long(self):
        response = "x" * 3000
        thinking = "y" * 1500
        action = '{"action": "wait"}'
        
        result = analyze_length(response, thinking, action)
        
        assert result.is_too_long is True
        assert result.thinking_is_too_long is True
        assert result.score < 1.0


# =============================================================================
# Complete Validation Tests
# =============================================================================


class TestValidateResponseFormat:
    """Tests for validate_response_format"""

    def test_perfect_response(self):
        response = """<think>
The market shows bullish momentum with strong volume. BTC is trading at $100,000
with positive funding rates. Because the trend is clear and risk is manageable,
I'll open a small long position. The stop loss at $98,000 limits downside.
</think>

{"action": "open_perp", "ticker": "BTC", "size": 0.1, "direction": "long"}"""
        
        result = validate_response_format(response)
        
        assert result.is_valid is True
        assert result.format_score > 0.7
        assert result.reasoning_score > 0.5
        assert result.think_tags.is_properly_paired is True
        assert result.action.is_valid is True

    def test_minimal_valid_response(self):
        response = """<think>Quick analysis - BTC looks good</think>
{"action": "wait"}"""
        
        result = validate_response_format(response)
        
        assert result.think_tags.is_properly_paired is True
        assert result.action.is_valid is True
        # Lower scores due to minimal content
        assert result.format_score < 0.8

    def test_no_thinking_response(self):
        response = '{"action": "buy", "market": "btc", "amount": 100}'
        
        result = validate_response_format(response)
        
        assert result.think_tags.is_properly_paired is False
        assert result.action.is_valid is True
        assert result.format_score < 0.5

    def test_no_action_response(self):
        response = "<think>I'm thinking about this...</think>\nI'll wait."
        
        result = validate_response_format(response)
        
        assert result.think_tags.is_properly_paired is True
        assert result.action.is_valid is False
        assert result.format_score < 0.5

    def test_get_summary(self):
        response = "<think>Analysis</think>{\"action\": \"wait\"}"
        
        result = validate_response_format(response)
        summary = result.get_summary()
        
        assert "format_score" in summary
        assert "reasoning_score" in summary
        assert "has_thinking" in summary
        assert "has_valid_action" in summary
        assert "issues" in summary


# =============================================================================
# Convenience Function Tests
# =============================================================================


class TestConvenienceFunctions:
    """Tests for convenience functions"""

    def test_get_format_and_reasoning_scores(self):
        response = """<think>Market analysis with price and risk consideration</think>
{"action": "buy", "market": "m1", "amount": 100}"""
        
        format_score, reasoning_score = get_format_and_reasoning_scores(response)
        
        assert 0.0 <= format_score <= 1.0
        assert 0.0 <= reasoning_score <= 1.0

    def test_validate_for_training(self):
        response = """<think>Deep analysis here</think>
{"action": "open_perp", "ticker": "BTC", "size": 0.1, "direction": "long"}"""
        
        result = validate_for_training(response)
        
        assert "format_score" in result
        assert "reasoning_score" in result
        assert "has_thinking" in result
        assert "has_valid_action" in result
        assert "action_type" in result
        assert result["has_thinking"] is True
        assert result["has_valid_action"] is True
        assert result["action_type"] == "open_perp"


# =============================================================================
# Integration Tests
# =============================================================================


class TestIntegration:
    """Integration tests for format validation"""

    def test_scoring_consistency(self):
        """Test that scores are consistent across calls"""
        response = """<think>
The market shows bullish momentum. Because volume is high,
I expect continued upward movement. Risk is moderate.
</think>

{"action": "buy", "market": "btc-100k", "amount": 100, "side": "yes"}"""
        
        result1 = validate_response_format(response)
        result2 = validate_response_format(response)
        
        assert result1.format_score == result2.format_score
        assert result1.reasoning_score == result2.reasoning_score

    def test_score_ordering(self):
        """Test that better responses get higher scores"""
        
        excellent = """<think>
Comprehensive market analysis: BTC trading at $100,000 with strong volume.
Technical indicators show bullish momentum with price above all major MAs.
Because the trend is clearly bullish and funding rates remain neutral,
I'll take a calculated long position. Risk management: stop at $97,000
limits downside to 3% while target at $110,000 gives 10% upside.
</think>

{"action": "open_perp", "ticker": "BTC", "size": 0.05, "direction": "long"}"""
        
        good = """<think>
Market looks bullish. BTC price is up. Taking a position.
</think>

{"action": "open_perp", "ticker": "BTC", "size": 0.1, "direction": "long"}"""
        
        poor = '{"action": "buy"}'
        
        excellent_result = validate_response_format(excellent)
        good_result = validate_response_format(good)
        poor_result = validate_response_format(poor)
        
        assert excellent_result.format_score > good_result.format_score
        assert good_result.format_score > poor_result.format_score

    def test_edge_cases(self):
        """Test edge cases"""
        
        # Empty response
        empty_result = validate_response_format("")
        assert empty_result.format_score < 0.2
        
        # Just whitespace
        ws_result = validate_response_format("   \n\t  ")
        assert ws_result.format_score < 0.2
        
        # Very long response
        long_response = "<think>" + "x" * 2000 + "</think>{\"action\": \"wait\"}"
        long_result = validate_response_format(long_response)
        assert long_result.length.thinking_is_too_long is True


