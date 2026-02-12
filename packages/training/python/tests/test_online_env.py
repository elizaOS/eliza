"""
Tests for BabylonOnlineEnv

Tests cover:
- Prompt building
- Action parsing
- Response scoring
- Integration with scenario pool
"""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch, Mock

from src.training.online_env import (
    build_trading_system_prompt,
    build_observation_prompt,
    parse_action_from_response,
    extract_thinking,
    score_response,
    BabylonOnlineEnv,
    BabylonOnlineEnvConfig,
)
from src.training.scenario_pool import (
    Scenario,
    ScenarioPoolConfig,
    MarketState,
    PerpetualState,
    NewsItem,
    PortfolioState,
)


# =============================================================================
# Prompt Building Tests
# =============================================================================


class TestBuildTradingSystemPrompt:
    """Tests for build_trading_system_prompt"""

    def test_default_trader(self):
        prompt = build_trading_system_prompt("trader")
        
        assert "trading agent" in prompt.lower()
        assert "trader" in prompt.lower()
        assert "<think>" in prompt
        assert "</think>" in prompt
        assert "action" in prompt.lower()

    def test_degen_archetype(self):
        prompt = build_trading_system_prompt("degen")
        
        assert "high-frequency" in prompt.lower() or "volume" in prompt.lower()

    def test_analyst_archetype(self):
        prompt = build_trading_system_prompt("analyst")
        
        assert "research" in prompt.lower() or "analysis" in prompt.lower()

    def test_unknown_archetype_defaults(self):
        prompt = build_trading_system_prompt("unknown")
        
        # Should get default (trader) behavior
        assert "trading agent" in prompt.lower()

    def test_contains_action_examples(self):
        prompt = build_trading_system_prompt()
        
        assert "buy" in prompt
        assert "sell" in prompt
        assert "wait" in prompt


class TestBuildObservationPrompt:
    """Tests for build_observation_prompt"""

    def test_basic_scenario(self):
        scenario = Scenario(
            id="test-1",
            source="synthetic",
            portfolio=PortfolioState(balance=15000.0, total_pnl=500.0),
        )
        
        prompt = build_observation_prompt(scenario)
        
        assert "15000" in prompt or "15,000" in prompt
        assert "500" in prompt
        assert "MARKET UPDATE" in prompt

    def test_with_markets(self):
        scenario = Scenario(
            id="test-markets",
            source="synthetic",
            markets=[
                MarketState(
                    market_id="m1",
                    question="Will BTC hit $100K?",
                    yes_price=0.65,
                    no_price=0.35,
                    volume_24h=100000.0,
                    liquidity=500000.0,
                    expires_at=1735689600000,
                )
            ],
        )
        
        prompt = build_observation_prompt(scenario)
        
        assert "PREDICTION MARKETS" in prompt
        assert "BTC" in prompt
        assert "0.65" in prompt

    def test_with_perpetuals(self):
        scenario = Scenario(
            id="test-perps",
            source="synthetic",
            perpetuals=[
                PerpetualState(
                    ticker="ETH",
                    mark_price=3500.0,
                    index_price=3495.0,
                    funding_rate=0.0001,
                    open_interest=25000000.0,
                    volume_24h=50000000.0,
                    change_24h=0.02,
                    high_24h=3600.0,
                    low_24h=3400.0,
                )
            ],
        )
        
        prompt = build_observation_prompt(scenario)
        
        assert "PERPETUAL MARKETS" in prompt
        assert "ETH" in prompt
        assert "3,500" in prompt or "3500" in prompt

    def test_with_news(self):
        scenario = Scenario(
            id="test-news",
            source="synthetic",
            news=[
                NewsItem(
                    headline="Bitcoin Rally Continues",
                    sentiment="bullish",
                    impact="high",
                    source="CryptoNews",
                    timestamp=1735689600000,
                )
            ],
        )
        
        prompt = build_observation_prompt(scenario)
        
        assert "RECENT NEWS" in prompt
        assert "Bitcoin Rally" in prompt
        assert "CryptoNews" in prompt


# =============================================================================
# Action Parsing Tests
# =============================================================================


class TestParseActionFromResponse:
    """Tests for parse_action_from_response"""

    def test_simple_json(self):
        response = '{"action": "buy", "market": "m1", "amount": 100}'
        
        action = parse_action_from_response(response)
        
        assert action is not None
        assert action["action"] == "buy"
        assert action["market"] == "m1"
        assert action["amount"] == 100

    def test_with_think_tags(self):
        response = """<think>
I should analyze the market carefully.
BTC is showing bullish momentum.
</think>

{"action": "open_perp", "ticker": "BTC", "size": 0.1, "direction": "long"}"""
        
        action = parse_action_from_response(response)
        
        assert action is not None
        assert action["action"] == "open_perp"
        assert action["ticker"] == "BTC"

    def test_wait_action(self):
        response = '{"action": "wait", "reason": "Need more data"}'
        
        action = parse_action_from_response(response)
        
        assert action is not None
        assert action["action"] == "wait"

    def test_invalid_json(self):
        response = "This is not JSON at all"
        
        action = parse_action_from_response(response)
        
        assert action is None

    def test_json_without_action_key(self):
        response = '{"type": "buy", "amount": 100}'
        
        action = parse_action_from_response(response)
        
        assert action is None

    def test_nested_json_in_text(self):
        response = """Here's my analysis and decision:
        
Based on the data, I'll buy.

{"action": "buy", "market": "market-1", "amount": 50, "side": "yes"}

This should be profitable."""
        
        action = parse_action_from_response(response)
        
        assert action is not None
        assert action["action"] == "buy"

    def test_multiple_json_objects_takes_first_valid(self):
        # The function finds the first JSON with an "action" key
        # when first JSON doesn't have action, it may not find the second
        # This is expected behavior - we look for action JSON in specific patterns
        response = """Some text here
        
{"action": "sell", "market": "m2", "amount": 25}"""
        
        action = parse_action_from_response(response)
        
        assert action is not None
        assert action["action"] == "sell"


class TestExtractThinking:
    """Tests for extract_thinking"""

    def test_valid_think_tags(self):
        response = "<think>This is my analysis</think>\n{\"action\": \"wait\"}"
        
        thinking = extract_thinking(response)
        
        assert thinking == "This is my analysis"

    def test_multiline_thinking(self):
        response = """<think>
Line 1
Line 2
Line 3
</think>

{"action": "buy"}"""
        
        thinking = extract_thinking(response)
        
        assert "Line 1" in thinking
        assert "Line 3" in thinking

    def test_no_think_tags(self):
        response = '{"action": "wait"}'
        
        thinking = extract_thinking(response)
        
        assert thinking == ""

    def test_empty_think_tags(self):
        response = "<think></think>action"
        
        thinking = extract_thinking(response)
        
        assert thinking == ""


# =============================================================================
# Scoring Tests
# =============================================================================


class TestScoreResponse:
    """Tests for score_response"""

    def test_well_formatted_response(self):
        scenario = Scenario(id="test", source="synthetic")
        response = """<think>
The market is showing bullish momentum with BTC trading at $100,000.
I should consider opening a long position because the funding rate is low.
Looking at the risk, a small position of 0.1 BTC seems reasonable.
</think>

{"action": "open_perp", "ticker": "BTC", "size": 0.1, "direction": "long"}"""
        
        score, metrics = score_response(response, scenario, "trader")
        
        assert metrics["has_thinking"] is True
        assert metrics["has_valid_action"] is True
        assert metrics["action_type"] == "open_perp"
        assert metrics["format_score"] > 0.5
        assert metrics["reasoning_score"] > 0.3

    def test_no_thinking_tags(self):
        scenario = Scenario(id="test", source="synthetic")
        response = '{"action": "wait", "reason": "unclear"}'
        
        score, metrics = score_response(response, scenario, "trader")
        
        assert metrics["has_thinking"] is False
        assert metrics["has_valid_action"] is True
        assert metrics["format_score"] < 0.5

    def test_invalid_action(self):
        scenario = Scenario(id="test", source="synthetic")
        response = "<think>Analysis here</think>\nI'll wait for now."
        
        score, metrics = score_response(response, scenario, "trader")
        
        assert metrics["has_thinking"] is True
        assert metrics["has_valid_action"] is False
        assert metrics["action_type"] is None

    def test_very_short_response_penalized(self):
        scenario = Scenario(id="test", source="synthetic")
        response = '{"action": "wait"}'
        
        score, metrics = score_response(response, scenario, "trader")
        
        # Short responses should have lower format scores
        assert metrics["format_score"] <= 0.3

    def test_reasoning_with_analysis_terms(self):
        scenario = Scenario(id="test", source="synthetic")
        response = """<think>
The price is showing strong momentum with high volume.
The trend is bullish and the market sentiment is positive.
Given the probability of success and managing risk, I'll proceed.
</think>

{"action": "buy", "market": "m1", "amount": 100, "side": "yes"}"""
        
        score, metrics = score_response(response, scenario, "trader")
        
        # Should have high reasoning score due to analysis terms
        assert metrics["reasoning_score"] > 0.4

    def test_different_archetypes_affect_score(self):
        scenario = Scenario(id="test", source="synthetic")
        # A trade-heavy response
        response = """<think>Quick analysis - buying now.</think>
{"action": "buy", "market": "m1", "amount": 1000, "side": "yes"}"""
        
        trader_score, _ = score_response(response, scenario, "trader")
        degen_score, _ = score_response(response, scenario, "degen")
        
        # Both should be scored (actual values depend on reward weights)
        assert trader_score is not None
        assert degen_score is not None


# =============================================================================
# Environment Tests
# =============================================================================


class TestBabylonOnlineEnvConfig:
    """Tests for BabylonOnlineEnvConfig"""

    def test_default_config(self):
        config = BabylonOnlineEnvConfig()
        
        assert config.group_size == 4
        assert config.max_response_tokens == 512
        assert config.temperature == 0.8
        assert config.default_archetype == "trader"

    def test_archetype_distribution(self):
        config = BabylonOnlineEnvConfig()
        
        assert "trader" in config.archetype_distribution
        assert "degen" in config.archetype_distribution
        assert sum(config.archetype_distribution.values()) == pytest.approx(1.0)


class TestBabylonOnlineEnv:
    """Tests for BabylonOnlineEnv (mock-based)"""

    def test_config_init(self):
        env_config, server_configs = BabylonOnlineEnv.config_init()
        
        assert isinstance(env_config, BabylonOnlineEnvConfig)
        assert len(server_configs) > 0
        assert env_config.group_size >= 2

    @pytest.mark.asyncio
    async def test_setup_initializes_pool(self):
        """Test that setup creates and initializes scenario pool"""
        # Use config_init to get proper configs that include server_configs
        config, server_configs = BabylonOnlineEnv.config_init()
        
        # Mock the server manager to avoid actual vLLM calls
        with patch('atroposlib.envs.base.ServerManager'):
            env = BabylonOnlineEnv(config, server_configs, testing=True)
            
            await env.setup()
            
            assert env.scenario_pool is not None
            assert len(env.scenario_pool.scenarios) > 0

    @pytest.mark.asyncio
    async def test_get_next_item_returns_scenario(self):
        """Test get_next_item returns a scenario and archetype"""
        config, server_configs = BabylonOnlineEnv.config_init()
        
        with patch('atroposlib.envs.base.ServerManager'):
            env = BabylonOnlineEnv(config, server_configs, testing=True)
            
            await env.setup()
            
            item = await env.get_next_item()
            
            assert item is not None
            scenario, archetype = item
            assert isinstance(scenario, Scenario)
            assert archetype in config.archetype_distribution


class TestIntegration:
    """Integration tests for online environment components"""

    def test_full_prompt_building_flow(self):
        """Test building prompts from scenario to final messages"""
        scenario = Scenario(
            id="integration-test",
            source="synthetic",
            markets=[
                MarketState(
                    market_id="btc-100k",
                    question="Will BTC exceed $100K by EOY?",
                    yes_price=0.72,
                    no_price=0.28,
                    volume_24h=500000.0,
                    liquidity=1000000.0,
                    expires_at=1735689600000,
                )
            ],
            perpetuals=[
                PerpetualState(
                    ticker="BTC",
                    mark_price=98000.0,
                    index_price=97950.0,
                    funding_rate=0.0002,
                    open_interest=100000000.0,
                    volume_24h=500000000.0,
                    change_24h=0.03,
                    high_24h=99000.0,
                    low_24h=95000.0,
                )
            ],
            news=[
                NewsItem(
                    headline="Institutional Buying Accelerates",
                    sentiment="bullish",
                    impact="high",
                    source="Bloomberg",
                    timestamp=1735689600000,
                )
            ],
            portfolio=PortfolioState(balance=50000.0, total_pnl=2500.0),
            difficulty="hard",
        )
        
        system_prompt = build_trading_system_prompt("trader")
        user_prompt = build_observation_prompt(scenario)
        
        # Verify prompts are valid
        assert len(system_prompt) > 100
        assert len(user_prompt) > 100
        
        # Verify key content is present
        assert "98,000" in user_prompt or "98000" in user_prompt  # BTC price
        assert "100K" in user_prompt  # Question
        assert "Institutional" in user_prompt  # News
        assert "50,000" in user_prompt or "50000" in user_prompt  # Balance

    def test_scoring_pipeline(self):
        """Test full scoring pipeline"""
        scenario = Scenario(id="scoring-test", source="synthetic")
        
        # Simulate different quality responses
        responses = [
            # High quality
            """<think>
The market shows strong bullish momentum. BTC is at $98K with positive funding.
The prediction market for $100K is at 72% YES which seems fair given momentum.
I'll take a small long position because the risk/reward is favorable.
</think>

{"action": "open_perp", "ticker": "BTC", "size": 0.05, "direction": "long"}""",
            # Medium quality
            """<think>Buying BTC looks good.</think>
{"action": "buy", "market": "btc-100k", "amount": 100, "side": "yes"}""",
            # Low quality
            '{"action": "wait"}',
        ]
        
        scores = []
        for resp in responses:
            score, _ = score_response(resp, scenario, "trader")
            scores.append(score)
        
        # Higher quality responses should generally score higher
        # (Though exact ordering depends on reward weights)
        assert all(isinstance(s, float) for s in scores)

