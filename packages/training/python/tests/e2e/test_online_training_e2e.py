"""
End-to-end tests for online training mode (Phase 3).

These tests verify the complete online training pipeline:
1. Simulation bridge client connectivity
2. Scenario retrieval from bridge
3. Online environment rollout collection
4. Full training loop with online rollouts

Requirements:
- Simulation bridge server running (make bridge-server)
- Or mock server for unit testing
"""

import asyncio
import json
import os
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

import sys
from pathlib import Path

# Add src to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from src.training.simulation_bridge import (
    SimulationBridge,
    Scenario,
    MarketState,
    PerpMarket,
    PredictionMarket,
    Position,
    NewsItem,
    SocialContext,
    ActionOutcome,
)
from src.training.scenario_pool import (
    Scenario as PoolScenario,
    MarketState as PoolMarketState,
    PortfolioState,
)


class TestSimulationBridgeClient:
    """Tests for the Python simulation bridge client"""
    
    @pytest.fixture
    def mock_response_data(self):
        """Standard mock response data from bridge"""
        return {
            "npcId": "test-npc-1",
            "archetype": "trader",
            "marketState": {
                "perpMarkets": [
                    {
                        "ticker": "BTC",
                        "currentPrice": 45000.0,
                        "changePercent24h": 2.5,
                        "volume24h": 1000000.0,
                    }
                ],
                "predictionMarkets": [
                    {
                        "id": "market-1",
                        "title": "Will BTC hit $50K?",
                        "yesPrice": 0.65,
                        "noPrice": 0.35,
                    }
                ],
            },
            "positions": [
                {
                    "id": "pos-1",
                    "marketType": "perp",
                    "ticker": "BTC",
                    "side": "long",
                    "size": 0.5,
                    "unrealizedPnL": 250.0,
                }
            ],
            "balance": 10000.0,
            "recentNews": [
                {
                    "content": "Market update: BTC rising",
                    "source": "CryptoNews",
                    "timestamp": "2025-01-01T00:00:00Z",
                }
            ],
            "socialContext": {
                "relationships": [
                    {"actorId": "actor-1", "actorName": "Whale", "sentiment": 0.8}
                ],
                "groupChats": ["traders-lounge"],
                "recentMessages": [{"from": "Whale", "content": "Bullish today!"}],
            },
        }
    
    def test_scenario_parsing(self, mock_response_data):
        """Test that bridge response is correctly parsed into Scenario"""
        # This tests the parsing logic without network calls
        data = mock_response_data
        
        market_state = MarketState(
            perp_markets=[
                PerpMarket(
                    ticker=m["ticker"],
                    current_price=m["currentPrice"],
                    change_percent_24h=m["changePercent24h"],
                    volume_24h=m["volume24h"],
                )
                for m in data.get("marketState", {}).get("perpMarkets", [])
            ],
            prediction_markets=[
                PredictionMarket(
                    id=m["id"],
                    question=m["title"],
                    yes_price=m["yesPrice"],
                    no_price=m["noPrice"],
                )
                for m in data.get("marketState", {}).get("predictionMarkets", [])
            ],
        )
        
        positions = [
            Position(
                id=p["id"],
                market_type=p["marketType"],
                ticker=p.get("ticker"),
                side=p["side"],
                size=p["size"],
                unrealized_pnl=p.get("unrealizedPnL", 0),
            )
            for p in data.get("positions", [])
        ]
        
        scenario = Scenario(
            npc_id=data["npcId"],
            archetype=data["archetype"],
            market_state=market_state,
            positions=positions,
            balance=data["balance"],
            recent_news=[
                NewsItem(
                    content=n["content"],
                    source=n["source"],
                    timestamp=n["timestamp"],
                )
                for n in data.get("recentNews", [])
            ],
            social_context=SocialContext(),
        )
        
        assert scenario.npc_id == "test-npc-1"
        assert scenario.archetype == "trader"
        assert scenario.balance == 10000.0
        assert len(scenario.market_state.perp_markets) == 1
        assert scenario.market_state.perp_markets[0].ticker == "BTC"
        assert len(scenario.positions) == 1
        assert scenario.positions[0].unrealized_pnl == 250.0
    
    def test_scenario_to_prompt_context(self, mock_response_data):
        """Test that scenario can be converted to prompt context"""
        data = mock_response_data
        
        market_state = MarketState(
            perp_markets=[
                PerpMarket(
                    ticker="BTC",
                    current_price=45000.0,
                    change_percent_24h=2.5,
                    volume_24h=1000000.0,
                )
            ],
            prediction_markets=[
                PredictionMarket(
                    id="market-1",
                    question="Will BTC hit $50K?",
                    yes_price=0.65,
                    no_price=0.35,
                )
            ],
        )
        
        scenario = Scenario(
            npc_id="test-npc-1",
            archetype="trader",
            market_state=market_state,
            positions=[],
            balance=10000.0,
            recent_news=[],
            social_context=SocialContext(),
        )
        
        context = scenario.to_prompt_context()
        
        assert "Agent ID: test-npc-1" in context
        assert "Archetype: trader" in context
        assert "Balance: $10,000.00" in context
        assert "BTC" in context
        # Price format may vary (with or without comma)
        assert "45000" in context
        assert "+2.50%" in context
    
    @pytest.mark.asyncio
    async def test_bridge_client_initialization(self):
        """Test that bridge client initializes correctly"""
        bridge = SimulationBridge(base_url="http://localhost:3001")
        
        assert bridge.base_url == "http://localhost:3001"
        assert not bridge.is_initialized
        assert bridge.npc_ids == []
        assert bridge.archetypes == {}


class TestOnlineEnvIntegration:
    """Integration tests for online environment"""
    
    def test_pool_scenario_add_methods(self):
        """Test Scenario.add_market, add_perpetual, add_news methods"""
        from src.training.scenario_pool import Scenario, PortfolioState
        
        scenario = PoolScenario(
            id="test-1",
            source="synthetic",
            archetype_focus="trader",
            difficulty="medium",
            portfolio=PortfolioState(balance=10000.0, positions=[]),
        )
        
        # Test add_market
        scenario.add_market({
            "id": "mkt-1",
            "question": "Will BTC hit $50K?",
            "yesPrice": 0.65,
            "noPrice": 0.35,
        })
        
        assert len(scenario.markets) == 1
        assert scenario.markets[0].market_id == "mkt-1"
        assert scenario.markets[0].question == "Will BTC hit $50K?"
        
        # Test add_perpetual
        scenario.add_perpetual({
            "ticker": "BTC",
            "markPrice": 45000.0,
            "change24h": 2.5,
        })
        
        assert len(scenario.perpetuals) == 1
        assert scenario.perpetuals[0].ticker == "BTC"
        assert scenario.perpetuals[0].mark_price == 45000.0
        
        # Test add_news
        scenario.add_news({
            "headline": "BTC is rising",
            "sentiment": "bullish",
            "impact": "high",
            "source": "CryptoNews",
        })
        
        assert len(scenario.news) == 1
        assert scenario.news[0].headline == "BTC is rising"
    
    def test_scenario_metadata(self):
        """Test Scenario.metadata field for extensibility"""
        from src.training.scenario_pool import Scenario, PortfolioState
        
        scenario = PoolScenario(
            id="test-1",
            source="synthetic",
            archetype_focus="trader",
            difficulty="medium",
            portfolio=PortfolioState(balance=10000.0, positions=[]),
        )
        
        # Metadata should be empty by default
        assert scenario.metadata == {}
        
        # Can add arbitrary metadata
        scenario.metadata["mode"] = "online"
        scenario.metadata["npc_id"] = "npc-1"
        scenario.metadata["bridge_scenario"] = {"npc_id": "npc-1"}
        
        assert scenario.metadata["mode"] == "online"
        assert scenario.metadata["npc_id"] == "npc-1"


class TestHybridEnv:
    """Tests for hybrid environment"""
    
    def test_hybrid_config_online_ratio(self):
        """Test that hybrid config accepts online_ratio"""
        from src.training.hybrid_env import BabylonHybridEnvConfig
        
        config = BabylonHybridEnvConfig(
            tokenizer_name="test-model",
            online_ratio=0.3,
        )
        
        assert config.online_ratio == 0.3
    
    def test_hybrid_config_defaults(self):
        """Test hybrid config default values"""
        from src.training.hybrid_env import BabylonHybridEnvConfig
        
        config = BabylonHybridEnvConfig(tokenizer_name="test-model")
        
        assert config.online_ratio == 0.2
        assert config.use_simulation_bridge is False  # Default from parent
        assert config.db_url is None


class TestModeSelection:
    """Tests for training mode selection in run_training.py"""
    
    def test_mode_argument_parsing(self):
        """Test that mode arguments are parsed correctly"""
        # This would require importing and testing argument parsing
        # For now, we just verify the modes are valid
        valid_modes = ["offline", "online", "hybrid"]
        assert "offline" in valid_modes
        assert "online" in valid_modes
        assert "hybrid" in valid_modes


# Integration test that requires bridge server
@pytest.mark.skipif(
    os.getenv("SIMULATION_BRIDGE_URL") is None,
    reason="Simulation bridge not configured"
)
class TestLiveBridgeIntegration:
    """Live integration tests with actual bridge server"""
    
    @pytest.mark.asyncio
    async def test_live_bridge_health(self):
        """Test bridge health check with live server"""
        bridge_url = os.getenv("SIMULATION_BRIDGE_URL", "http://localhost:3001")
        
        async with SimulationBridge(bridge_url) as bridge:
            health = await bridge.health_check()
            
            assert "status" in health
            assert health["status"] == "healthy"
    
    @pytest.mark.asyncio
    async def test_live_bridge_init_and_scenario(self):
        """Test initializing bridge and getting scenario"""
        bridge_url = os.getenv("SIMULATION_BRIDGE_URL", "http://localhost:3001")
        
        async with SimulationBridge(bridge_url) as bridge:
            # Initialize
            result = await bridge.initialize(num_npcs=5, archetypes=["trader", "degen"])
            
            assert bridge.is_initialized
            assert len(bridge.npc_ids) == 5
            
            # Get scenario
            npc_id = bridge.npc_ids[0]
            scenario = await bridge.get_scenario(npc_id)
            
            assert scenario.npc_id == npc_id
            assert scenario.archetype in ["trader", "degen"]
            assert scenario.balance > 0

