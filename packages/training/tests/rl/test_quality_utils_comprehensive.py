"""
Comprehensive Tests for Quality Utilities (quality_utils.py)

Tests cover:
- XML structure validation (decisions tags, attributes)
- Reasoning-action alignment (directional, financial literacy)
- Reasoning coherence heuristics (structure, conclusions, vocabulary)
- Detailed tick quality scoring
- Archetype-specific quality weights
- Tick quality score calculation
"""

from src.models import Action, LLMCall
from src.training.quality_utils import (
    ARCHETYPE_WEIGHTS,
    calculate_detailed_tick_quality,
    calculate_tick_quality_score,
    check_reasoning_action_alignment,
    check_reasoning_coherence,
    validate_xml_structure,
)

# =============================================================================
# Fixtures
# =============================================================================


def make_llm_call(
    response: str = "", reasoning: str | None = None, purpose: str = "action"
) -> LLMCall:
    return LLMCall(
        model="test-model",
        system_prompt="test",
        user_prompt="test",
        response=response,
        reasoning=reasoning,
        temperature=0.7,
        max_tokens=2048,
        purpose=purpose,
    )


def make_action(
    action_type: str = "buy", success: bool = True, reasoning: str | None = None
) -> Action:
    return Action(
        action_type=action_type,
        parameters={"ticker": "BTC", "amount": 100},
        success=success,
        reasoning=reasoning,
    )


# =============================================================================
# XML Structure Validation Tests
# =============================================================================


class TestValidateXmlStructure:
    def test_valid_xml_with_all_attributes(self):
        response = """
        <decisions>
            <decision ticker="BTC" amount="100" action="buy">
                <reasoning>Bullish market</reasoning>
            </decision>
        </decisions>
        """
        score = validate_xml_structure(response)
        assert score == 0.5

    def test_valid_xml_with_market_id(self):
        response = """
        <decisions>
            <decision marketId="btc-100k" amount="50">
                Buy YES on BTC hitting 100K
            </decision>
        </decisions>
        """
        score = validate_xml_structure(response)
        assert score == 0.5

    def test_missing_decisions_tags(self):
        response = '<decision ticker="BTC" amount="100"/>'
        score = validate_xml_structure(response)
        assert score == -1.0

    def test_missing_decision_inner_tag(self):
        response = "<decisions></decisions>"
        score = validate_xml_structure(response)
        # Has wrappers but no ticker/market/amount -> partial penalty
        assert score < 0

    def test_missing_amount_attribute(self):
        response = """
        <decisions>
            <decision ticker="BTC">buy</decision>
        </decisions>
        """
        score = validate_xml_structure(response)
        assert score == -0.2

    def test_missing_ticker_and_market_id(self):
        response = """
        <decisions>
            <decision amount="100">buy</decision>
        </decisions>
        """
        score = validate_xml_structure(response)
        assert score == -0.2

    def test_empty_response(self):
        assert validate_xml_structure("") == -1.0

    def test_none_response(self):
        assert validate_xml_structure(None) == -1.0

    def test_single_quoted_attributes(self):
        response = """
        <decisions>
            <decision ticker='ETH' amount='200'>sell</decision>
        </decisions>
        """
        score = validate_xml_structure(response)
        assert score == 0.5

    def test_plain_text_response(self):
        response = "I think we should buy BTC because it's going up"
        score = validate_xml_structure(response)
        assert score == -1.0


# =============================================================================
# Reasoning-Action Alignment Tests
# =============================================================================


class TestReasoningActionAlignment:
    def test_bullish_reasoning_buy_action(self):
        reasoning = "The market looks very bullish. Price is going upward, this is a great opportunity to buy."
        action = make_action("buy")
        score = check_reasoning_action_alignment(reasoning, action)
        assert score >= 0.7  # Should be aligned

    def test_bearish_reasoning_sell_action(self):
        reasoning = "Market is bearish, looking downward. I should sell and avoid losses."
        action = make_action("sell")
        score = check_reasoning_action_alignment(reasoning, action)
        assert score >= 0.7

    def test_bullish_reasoning_sell_action_misaligned(self):
        reasoning = "Everything is bullish and going up, great opportunity to buy!"
        action = make_action("sell")
        score = check_reasoning_action_alignment(reasoning, action)
        assert score == 0.0  # Misaligned

    def test_bearish_reasoning_buy_action_misaligned(self):
        reasoning = "Market is very bearish, everything is dumping, prices going downward."
        action = make_action("buy")
        score = check_reasoning_action_alignment(reasoning, action)
        assert score == 0.0

    def test_wait_reasoning_hold_action(self):
        reasoning = "I'm uncertain about the market. Need more data. I'll wait and keep observing."
        action = make_action("wait")
        score = check_reasoning_action_alignment(reasoning, action)
        assert score >= 0.7

    def test_financial_literacy_bonus_exposure(self):
        reasoning = "Considering my current exposure, I should reduce risk."
        action = make_action("sell")
        score = check_reasoning_action_alignment(reasoning, action)
        assert score >= 0.55  # Base 0.4 + 0.15 literacy

    def test_financial_literacy_bonus_pnl(self):
        reasoning = "My profit so far is good. Let me lock in gains."
        action = make_action("sell")
        score = check_reasoning_action_alignment(reasoning, action)
        assert score >= 0.55

    def test_no_action_neutral(self):
        score = check_reasoning_action_alignment("some reasoning", None)
        assert score == 0.5

    def test_no_reasoning_neutral(self):
        score = check_reasoning_action_alignment("", make_action("buy"))
        assert score == 0.5

    def test_prediction_action_types(self):
        reasoning = "I'm bullish on BTC, I believe it will go up. Great opportunity."
        for action_type in ["buy_prediction", "open_perp", "long"]:
            action = make_action(action_type)
            score = check_reasoning_action_alignment(reasoning, action)
            assert score >= 0.7, f"Failed for action type: {action_type}"

    def test_sell_action_types(self):
        reasoning = "Market is bearish and heading downward. I should sell before more losses."
        for action_type in ["sell_prediction", "close_perp", "short"]:
            action = make_action(action_type)
            score = check_reasoning_action_alignment(reasoning, action)
            assert score >= 0.7, f"Failed for action type: {action_type}"


# =============================================================================
# Reasoning Coherence Tests
# =============================================================================


class TestReasoningCoherence:
    def test_empty_reasoning(self):
        assert check_reasoning_coherence("") == 0.1

    def test_very_short_reasoning(self):
        assert check_reasoning_coherence("Buy BTC") == 0.1

    def test_structured_reasoning(self):
        reasoning = """
        1. Market analysis shows bullish trend
        2. Volume is increasing significantly
        3. Technical indicators point upward
        Therefore, I recommend buying BTC at current price levels.
        """
        score = check_reasoning_coherence(reasoning)
        assert score >= 0.5  # Has structure + conclusion

    def test_conclusion_markers(self):
        reasoning = (
            "After careful analysis of the market conditions. Therefore, I recommend buying BTC."
        )
        score = check_reasoning_coherence(reasoning)
        assert score > 0.2  # Has conclusion marker

    def test_numeric_analysis(self):
        reasoning = "BTC is currently at $50,000 which is a 10% increase. The volume is 2.5M."
        score = check_reasoning_coherence(reasoning)
        assert score > 0.1  # Contains numbers

    def test_repetitive_reasoning(self):
        reasoning = "buy buy buy buy buy buy buy buy buy buy buy buy buy buy buy buy buy buy"
        score = check_reasoning_coherence(reasoning)
        assert score < 0.3  # Low vocabulary diversity

    def test_diverse_vocabulary(self):
        reasoning = """
        The market conditions look favorable for accumulation.
        Volume indicators suggest increased institutional interest.
        Technical analysis shows a bullish divergence pattern.
        I recommend opening a long position with careful risk management.
        """
        score = check_reasoning_coherence(reasoning)
        assert score >= 0.4  # Good diversity


# =============================================================================
# Detailed Tick Quality Tests
# =============================================================================


class TestDetailedTickQuality:
    def test_valid_xml_response(self):
        call = make_llm_call(
            response='<decisions><decision ticker="BTC" amount="100">buy</decision></decisions>',
            reasoning="Bullish market, good opportunity to buy",
        )
        fmt, rsn = calculate_detailed_tick_quality([call], make_action("buy"), None)
        assert fmt == 0.5  # Valid XML
        assert rsn > 0

    def test_invalid_xml_response(self):
        call = make_llm_call(response="just plain text, no XML")
        fmt, _rsn = calculate_detailed_tick_quality([call], make_action("buy"), None)
        assert fmt == -1.0

    def test_no_llm_calls(self):
        fmt, rsn = calculate_detailed_tick_quality([], make_action("buy"), None)
        assert fmt == 0.0
        assert rsn == 0.0

    def test_reasoning_from_action(self):
        call = make_llm_call(
            response='<decisions><decision ticker="BTC" amount="100">buy</decision></decisions>'
        )
        action = make_action("buy", reasoning="Bullish market ahead. Buy opportunity.")
        _fmt, rsn = calculate_detailed_tick_quality([call], action, None)
        assert rsn > 0

    def test_reasoning_capped_at_one(self):
        call = make_llm_call(
            response='<decisions><decision ticker="BTC" amount="100">buy</decision></decisions>',
            reasoning="Bullish market with great opportunity to buy. Exposure is manageable. Profit target set.",
        )
        action = make_action("buy", reasoning="Bullish. Buy BTC. Exposure okay. Profit looks good.")
        _fmt, rsn = calculate_detailed_tick_quality([call], action, None)
        assert rsn <= 1.0


# =============================================================================
# Tick Quality Score Tests
# =============================================================================


class TestTickQualityScore:
    def test_successful_action_scores_higher(self):
        call = make_llm_call(
            response='<decisions><decision ticker="BTC" amount="100">buy</decision></decisions>',
        )
        score_success = calculate_tick_quality_score(
            [call], make_action("buy", success=True), {"pnl": 100}
        )
        score_fail = calculate_tick_quality_score(
            [call], make_action("buy", success=False, reasoning=None), {"pnl": -100}
        )
        assert score_success > score_fail

    def test_archetype_affects_weights(self):
        call = make_llm_call(
            response='<decisions><decision ticker="BTC" amount="100">buy</decision></decisions>',
            reasoning="Detailed analysis. Exposure is low. Profit potential high.",
        )
        action = make_action("buy")

        score_trader = calculate_tick_quality_score([call], action, None, archetype="trader")
        score_researcher = calculate_tick_quality_score(
            [call], action, None, archetype="researcher"
        )
        # Both should be valid scores
        assert 0.0 <= score_trader <= 1.0
        assert 0.0 <= score_researcher <= 1.0

    def test_default_archetype_fallback(self):
        call = make_llm_call(response="text")
        score = calculate_tick_quality_score(
            [call], make_action("buy"), None, archetype="nonexistent"
        )
        assert 0.0 <= score <= 1.0


# =============================================================================
# Archetype Weights Configuration Tests
# =============================================================================


class TestArchetypeQualityWeights:
    def test_all_weights_sum_to_one(self):
        for archetype, weights in ARCHETYPE_WEIGHTS.items():
            total = sum(weights.values())
            assert abs(total - 1.0) < 1e-9, f"Quality weights for '{archetype}' sum to {total}"

    def test_all_weights_have_required_keys(self):
        required = {"llm_calls", "reasoning", "action", "feedback"}
        for archetype, weights in ARCHETYPE_WEIGHTS.items():
            assert set(weights.keys()) == required, (
                f"Quality weights for '{archetype}' has wrong keys"
            )

    def test_all_weights_non_negative(self):
        for archetype, weights in ARCHETYPE_WEIGHTS.items():
            for key, val in weights.items():
                assert val >= 0, f"Quality weight '{key}' for '{archetype}' is negative: {val}"

    def test_default_exists(self):
        assert "default" in ARCHETYPE_WEIGHTS

    def test_degen_prioritizes_action(self):
        assert ARCHETYPE_WEIGHTS["degen"]["action"] > ARCHETYPE_WEIGHTS["degen"]["reasoning"]

    def test_researcher_prioritizes_reasoning(self):
        assert (
            ARCHETYPE_WEIGHTS["researcher"]["reasoning"] > ARCHETYPE_WEIGHTS["researcher"]["action"]
        )
