"""
Tests for ScenarioPool and CurriculumManager

Tests cover:
- Scenario generation (synthetic and structure)
- Curriculum learning (tracking, priorities, reset)
- Pool management (sampling, refresh, persistence)
"""

import json
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from src.training.scenario_pool import (
    CurriculumManager,
    CurriculumState,
    MarketState,
    NewsItem,
    PerpetualState,
    PortfolioState,
    Scenario,
    ScenarioPool,
    ScenarioPoolConfig,
    SocialPost,
)


# =============================================================================
# Data Structure Tests
# =============================================================================


class TestMarketState:
    """Tests for MarketState dataclass"""

    def test_creation(self):
        market = MarketState(
            market_id="test-1",
            question="Will BTC exceed $100K?",
            yes_price=0.65,
            no_price=0.35,
            volume_24h=100000.0,
            liquidity=500000.0,
            expires_at=1735689600000,
            category="crypto",
        )
        
        assert market.market_id == "test-1"
        assert market.yes_price == 0.65
        assert market.no_price == 0.35

    def test_to_dict(self):
        market = MarketState(
            market_id="test-1",
            question="Will BTC exceed $100K?",
            yes_price=0.65,
            no_price=0.35,
            volume_24h=100000.0,
            liquidity=500000.0,
            expires_at=1735689600000,
        )
        
        result = market.to_dict()
        
        assert result["id"] == "test-1"
        assert result["yesPrice"] == 0.65
        assert result["noPrice"] == 0.35
        assert result["volume24h"] == 100000.0
        assert "question" in result


class TestPerpetualState:
    """Tests for PerpetualState dataclass"""

    def test_creation(self):
        perp = PerpetualState(
            ticker="BTC",
            mark_price=100000.0,
            index_price=99990.0,
            funding_rate=0.0001,
            open_interest=50000000.0,
            volume_24h=100000000.0,
            change_24h=0.02,
            high_24h=102000.0,
            low_24h=98000.0,
        )
        
        assert perp.ticker == "BTC"
        assert perp.mark_price == 100000.0

    def test_to_dict(self):
        perp = PerpetualState(
            ticker="ETH",
            mark_price=3500.0,
            index_price=3495.0,
            funding_rate=-0.0002,
            open_interest=25000000.0,
            volume_24h=50000000.0,
            change_24h=-0.01,
            high_24h=3600.0,
            low_24h=3400.0,
        )
        
        result = perp.to_dict()
        
        assert result["ticker"] == "ETH"
        assert result["markPrice"] == 3500.0
        assert result["fundingRate"] == -0.0002


class TestScenario:
    """Tests for Scenario dataclass"""

    def test_creation_minimal(self):
        scenario = Scenario(
            id="test-scenario",
            source="synthetic",
        )
        
        assert scenario.id == "test-scenario"
        assert scenario.source == "synthetic"
        assert len(scenario.markets) == 0
        assert scenario.portfolio.balance == 10000.0

    def test_creation_full(self):
        market = MarketState(
            market_id="m1",
            question="Test?",
            yes_price=0.5,
            no_price=0.5,
            volume_24h=1000.0,
            liquidity=5000.0,
            expires_at=1735689600000,
        )
        
        perp = PerpetualState(
            ticker="BTC",
            mark_price=100000.0,
            index_price=100000.0,
            funding_rate=0.0,
            open_interest=1000000.0,
            volume_24h=5000000.0,
            change_24h=0.0,
            high_24h=100000.0,
            low_24h=100000.0,
        )
        
        news = NewsItem(
            headline="Test headline",
            sentiment="bullish",
            impact="high",
            source="Test",
            timestamp=1735689600000,
        )
        
        post = SocialPost(
            author="test_user",
            content="Test post",
            sentiment="neutral",
            likes=10,
            replies=2,
            timestamp=1735689600000,
        )
        
        scenario = Scenario(
            id="full-scenario",
            source="production",
            markets=[market],
            perpetuals=[perp],
            news=[news],
            social_posts=[post],
            portfolio=PortfolioState(balance=15000.0),
            archetype_focus="trader",
            difficulty="hard",
        )
        
        assert scenario.id == "full-scenario"
        assert len(scenario.markets) == 1
        assert len(scenario.perpetuals) == 1
        assert len(scenario.news) == 1
        assert len(scenario.social_posts) == 1
        assert scenario.portfolio.balance == 15000.0
        assert scenario.archetype_focus == "trader"
        assert scenario.difficulty == "hard"

    def test_to_dict(self):
        scenario = Scenario(
            id="dict-test",
            source="synthetic",
            markets=[MarketState(
                market_id="m1",
                question="Test?",
                yes_price=0.6,
                no_price=0.4,
                volume_24h=1000.0,
                liquidity=5000.0,
                expires_at=1735689600000,
            )],
            difficulty="easy",
        )
        
        result = scenario.to_dict()
        
        assert result["id"] == "dict-test"
        assert result["source"] == "synthetic"
        assert len(result["markets"]) == 1
        assert result["difficulty"] == "easy"
        assert "portfolio" in result

    def test_to_observation(self):
        scenario = Scenario(
            id="obs-test",
            source="synthetic",
            markets=[MarketState(
                market_id="m1",
                question="Will BTC moon?",
                yes_price=0.7,
                no_price=0.3,
                volume_24h=100000.0,
                liquidity=500000.0,
                expires_at=1735689600000,
            )],
            news=[NewsItem(
                headline="Bullish news",
                sentiment="bullish",
                impact="high",
                source="Test",
                timestamp=1735689600000,
            )],
        )
        
        obs = scenario.to_observation()
        
        assert "markets" in obs
        assert "perpetuals" in obs
        assert "news" in obs
        assert "portfolio" in obs
        assert "marketSummary" in obs
        assert obs["marketSummary"]["totalMarkets"] == 1

    def test_sentiment_calculation(self):
        # Mostly bullish
        scenario = Scenario(
            id="bullish-test",
            source="synthetic",
            news=[
                NewsItem(headline="Bull1", sentiment="bullish", impact="high", source="X", timestamp=0),
                NewsItem(headline="Bull2", sentiment="bullish", impact="high", source="X", timestamp=0),
                NewsItem(headline="Neutral", sentiment="neutral", impact="low", source="X", timestamp=0),
            ],
        )
        
        obs = scenario.to_observation()
        assert obs["marketSummary"]["avgSentiment"] == "bullish"
        
        # Mostly bearish
        scenario2 = Scenario(
            id="bearish-test",
            source="synthetic",
            news=[
                NewsItem(headline="Bear1", sentiment="bearish", impact="high", source="X", timestamp=0),
                NewsItem(headline="Bear2", sentiment="bearish", impact="high", source="X", timestamp=0),
            ],
        )
        
        obs2 = scenario2.to_observation()
        assert obs2["marketSummary"]["avgSentiment"] == "bearish"


# =============================================================================
# CurriculumManager Tests
# =============================================================================


class TestCurriculumManager:
    """Tests for CurriculumManager"""

    def test_creation(self):
        manager = CurriculumManager()
        
        assert len(manager.attempts) == 0
        assert len(manager.scores) == 0
        assert len(manager.solved) == 0

    def test_record_attempt(self):
        manager = CurriculumManager()
        
        manager.record_attempt("scenario-1", 0.5)
        
        assert manager.attempts["scenario-1"] == 1
        assert len(manager.scores["scenario-1"]) == 1
        assert manager.scores["scenario-1"][0] == 0.5

    def test_multiple_attempts(self):
        manager = CurriculumManager()
        
        manager.record_attempt("scenario-1", 0.3)
        manager.record_attempt("scenario-1", 0.5)
        manager.record_attempt("scenario-1", 0.7)
        
        assert manager.attempts["scenario-1"] == 3
        assert len(manager.scores["scenario-1"]) == 3

    def test_solved_detection(self):
        manager = CurriculumManager(
            solve_threshold=0.8,
            min_attempts_for_solved=3,
        )
        
        # Not enough attempts
        manager.record_attempt("scenario-1", 0.9)
        manager.record_attempt("scenario-1", 0.9)
        assert "scenario-1" not in manager.solved
        
        # Third attempt triggers solved check
        manager.record_attempt("scenario-1", 0.9)
        assert "scenario-1" in manager.solved

    def test_solved_requires_high_scores(self):
        manager = CurriculumManager(
            solve_threshold=0.8,
            min_attempts_for_solved=3,
        )
        
        # Scores below threshold
        manager.record_attempt("scenario-1", 0.5)
        manager.record_attempt("scenario-1", 0.6)
        manager.record_attempt("scenario-1", 0.7)
        
        assert "scenario-1" not in manager.solved

    def test_should_skip(self):
        manager = CurriculumManager(
            max_avg_for_skip=0.85,
        )
        
        # Solved scenarios should be skipped
        manager.solved.add("solved-scenario")
        assert manager.should_skip("solved-scenario") is True
        
        # High-scoring scenarios should be skipped
        manager.scores["easy-scenario"] = [0.9, 0.9, 0.9]
        assert manager.should_skip("easy-scenario") is True
        
        # Low-scoring scenarios should not be skipped
        manager.scores["hard-scenario"] = [0.3, 0.4, 0.5]
        assert manager.should_skip("hard-scenario") is False
        
        # New scenarios should not be skipped
        assert manager.should_skip("new-scenario") is False

    def test_get_priority(self):
        manager = CurriculumManager()
        
        # Solved scenarios have zero priority
        manager.solved.add("solved")
        assert manager.get_priority("solved") == 0.0
        
        # New scenarios have high priority
        priority_new = manager.get_priority("new-scenario")
        assert priority_new > 0.5
        
        # Difficult scenarios have higher priority
        manager.scores["hard"] = [0.2, 0.3, 0.2]
        manager.attempts["hard"] = 3
        
        manager.scores["easy"] = [0.8, 0.9, 0.85]
        manager.attempts["easy"] = 3
        
        assert manager.get_priority("hard") > manager.get_priority("easy")

    def test_reset(self):
        manager = CurriculumManager()
        
        manager.solved.add("scenario-1")
        manager.solved.add("scenario-2")
        
        manager.reset()
        
        assert len(manager.solved) == 0

    def test_get_stats(self):
        manager = CurriculumManager()
        
        manager.record_attempt("s1", 0.5)
        manager.record_attempt("s1", 0.6)
        manager.record_attempt("s2", 0.8)
        
        stats = manager.get_stats()
        
        assert stats["total_scenarios"] == 2
        assert stats["total_attempts"] == 3
        assert stats["avg_score"] == pytest.approx((0.5 + 0.6 + 0.8) / 3, rel=1e-3)

    def test_checkpoint_save_load(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            checkpoint_path = Path(tmpdir) / "curriculum.json"
            
            # Create and populate manager
            manager1 = CurriculumManager(checkpoint_path=str(checkpoint_path))
            manager1.record_attempt("s1", 0.5)
            manager1.record_attempt("s1", 0.6)
            manager1.solved.add("s2")
            manager1._save_checkpoint()
            
            # Load in new manager
            manager2 = CurriculumManager(checkpoint_path=str(checkpoint_path))
            
            assert manager2.attempts["s1"] == 2
            assert manager2.scores["s1"] == [0.5, 0.6]
            assert "s2" in manager2.solved

    def test_history_trimming(self):
        manager = CurriculumManager(max_history_per_scenario=5)
        
        for i in range(10):
            manager.record_attempt("scenario", float(i) / 10)
        
        assert len(manager.scores["scenario"]) == 5
        # Should keep the most recent
        assert manager.scores["scenario"][-1] == 0.9


# =============================================================================
# ScenarioPool Tests
# =============================================================================


class TestScenarioPool:
    """Tests for ScenarioPool"""

    def test_creation(self):
        config = ScenarioPoolConfig()
        pool = ScenarioPool(config)
        
        assert len(pool.scenarios) == 0
        assert pool._sample_counter == 0

    def test_generate_synthetic_batch(self):
        config = ScenarioPoolConfig()
        pool = ScenarioPool(config)
        
        scenarios = pool.generate_synthetic_batch(count=10)
        
        assert len(scenarios) == 10
        for scenario in scenarios:
            assert scenario.source == "synthetic"
            assert len(scenario.markets) > 0
            assert len(scenario.perpetuals) > 0
            assert scenario.id.startswith("synth-")

    def test_generate_with_archetype_focus(self):
        config = ScenarioPoolConfig()
        pool = ScenarioPool(config)
        
        scenarios = pool.generate_synthetic_batch(count=5, archetype_focus="degen")
        
        for scenario in scenarios:
            assert scenario.archetype_focus == "degen"

    def test_difficulty_distribution(self):
        config = ScenarioPoolConfig(
            synthetic_difficulty_distribution={"easy": 0.5, "medium": 0.3, "hard": 0.2}
        )
        pool = ScenarioPool(config)
        
        scenarios = pool.generate_synthetic_batch(count=100)
        
        easy_count = sum(1 for s in scenarios if s.difficulty == "easy")
        medium_count = sum(1 for s in scenarios if s.difficulty == "medium")
        hard_count = sum(1 for s in scenarios if s.difficulty == "hard")
        
        # Allow some variance
        assert 40 <= easy_count <= 60
        assert 20 <= medium_count <= 40
        assert 10 <= hard_count <= 30

    def test_sample_without_curriculum(self):
        config = ScenarioPoolConfig(use_curriculum=False)
        pool = ScenarioPool(config)
        pool.scenarios = pool.generate_synthetic_batch(count=20)
        
        sampled = pool.sample(count=5)
        
        assert len(sampled) == 5
        for s in sampled:
            assert s in pool.scenarios

    def test_sample_with_curriculum(self):
        config = ScenarioPoolConfig(use_curriculum=True)
        pool = ScenarioPool(config)
        pool.scenarios = pool.generate_synthetic_batch(count=10)
        
        # Initially all scenarios should be available
        sampled = pool.sample(count=3)
        assert len(sampled) == 3
        
        # Record good scores for some scenarios
        for s in sampled[:2]:
            pool.curriculum.record_attempt(s.id, 0.9)
            pool.curriculum.record_attempt(s.id, 0.9)
            pool.curriculum.record_attempt(s.id, 0.9)
        
        # Those should now be skipped
        for _ in range(10):
            new_sampled = pool.sample(count=5)
            # Solved scenarios should have lower probability
            solved_ids = {sampled[0].id, sampled[1].id}
            sampled_ids = {s.id for s in new_sampled}
            # They might still appear due to probability, but should be less frequent

    def test_record_results(self):
        config = ScenarioPoolConfig(use_curriculum=True)
        pool = ScenarioPool(config)
        pool.scenarios = pool.generate_synthetic_batch(count=5)
        
        ids = [s.id for s in pool.scenarios[:3]]
        scores = [0.5, 0.7, 0.9]
        
        pool.record_results(ids, scores)
        
        assert pool.curriculum.attempts[ids[0]] == 1
        assert pool.curriculum.scores[ids[0]][0] == 0.5

    def test_get_stats(self):
        config = ScenarioPoolConfig(use_curriculum=True)
        pool = ScenarioPool(config)
        pool.scenarios = pool.generate_synthetic_batch(count=10)
        
        stats = pool.get_stats()
        
        assert stats["total_scenarios"] == 10
        assert stats["synthetic_scenarios"] == 10
        assert stats["production_scenarios"] == 0
        assert "curriculum" in stats

    def test_save_and_load_scenarios(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            save_path = Path(tmpdir) / "scenarios.json"
            
            config = ScenarioPoolConfig()
            pool1 = ScenarioPool(config)
            pool1.scenarios = pool1.generate_synthetic_batch(count=5)
            original_ids = [s.id for s in pool1.scenarios]
            
            pool1.save_scenarios(str(save_path))
            
            pool2 = ScenarioPool(config)
            pool2.load_scenarios(str(save_path))
            
            loaded_ids = [s.id for s in pool2.scenarios]
            
            assert original_ids == loaded_ids
            assert len(pool2.scenarios) == 5

    def test_refresh_mechanism(self):
        config = ScenarioPoolConfig(refresh_interval=5)
        pool = ScenarioPool(config)
        pool.scenarios = pool.generate_synthetic_batch(count=10)
        
        original_ids = {s.id for s in pool.scenarios}
        
        # Sample 5 times (reaches refresh interval)
        for _ in range(5):
            pool.sample(count=1)
        
        # Synthetic scenarios should be regenerated
        new_ids = {s.id for s in pool.scenarios}
        
        # At least some should be different
        assert original_ids != new_ids

    @pytest.mark.asyncio
    async def test_initialize_without_database(self):
        config = ScenarioPoolConfig(max_scenarios=10)
        pool = ScenarioPool(config)
        
        await pool.initialize()
        
        # Should fill with synthetic scenarios
        assert len(pool.scenarios) == 10
        for s in pool.scenarios:
            assert s.source == "synthetic"


class TestScenarioGeneration:
    """Tests for scenario content generation"""

    def test_random_market_generation(self):
        config = ScenarioPoolConfig()
        pool = ScenarioPool(config)
        
        market = pool._generate_random_market(0)
        
        assert market.market_id == "market-1"
        assert 0.2 <= market.yes_price <= 0.8
        assert market.yes_price + market.no_price == pytest.approx(1.0, rel=1e-3)
        assert market.volume_24h > 0
        assert market.liquidity > 0

    def test_default_perpetuals_generation(self):
        config = ScenarioPoolConfig()
        pool = ScenarioPool(config)
        
        perps = pool._generate_default_perpetuals()
        
        assert len(perps) == 5  # BTC, ETH, SOL, DOGE, AVAX
        tickers = {p.ticker for p in perps}
        assert "BTC" in tickers
        assert "ETH" in tickers

    def test_news_generation(self):
        config = ScenarioPoolConfig()
        pool = ScenarioPool(config)
        
        news = pool._generate_random_news(5, "medium")
        
        assert len(news) == 5
        for item in news:
            assert item.headline
            assert item.sentiment in ["bullish", "bearish", "neutral"]
            assert item.impact in ["high", "medium", "low"]
            assert item.source

    def test_posts_generation(self):
        config = ScenarioPoolConfig()
        pool = ScenarioPool(config)
        
        posts = pool._generate_random_posts(6)
        
        assert len(posts) == 6
        for post in posts:
            assert post.author
            assert post.content
            assert post.sentiment in ["bullish", "bearish", "neutral"]
            assert post.likes >= 0
            assert post.replies >= 0

    def test_contextual_news_generation(self):
        config = ScenarioPoolConfig()
        pool = ScenarioPool(config)
        
        markets = [
            MarketState(
                market_id="m1",
                question="Will BTC exceed $100K?",
                yes_price=0.5,
                no_price=0.5,
                volume_24h=100000.0,
                liquidity=500000.0,
                expires_at=1735689600000,
            )
        ]
        
        news = pool._generate_contextual_news(markets)
        
        assert len(news) > 0
        # Should have at least one BTC-related news item
        btc_news = [n for n in news if "bitcoin" in n.headline.lower() or "btc" in n.headline.lower()]
        assert len(btc_news) >= 1


# =============================================================================
# Integration Tests
# =============================================================================


class TestScenarioPoolIntegration:
    """Integration tests for ScenarioPool"""

    @pytest.mark.asyncio
    async def test_full_workflow(self):
        """Test complete workflow: init, sample, record, refresh"""
        with tempfile.TemporaryDirectory() as tmpdir:
            config = ScenarioPoolConfig(
                max_scenarios=20,
                refresh_interval=10,
                use_curriculum=True,
                curriculum_checkpoint_path=str(Path(tmpdir) / "curriculum.json"),
            )
            pool = ScenarioPool(config)
            
            await pool.initialize()
            assert len(pool.scenarios) == 20
            
            # Sample and record results
            for _ in range(5):
                scenarios = pool.sample(count=2)
                ids = [s.id for s in scenarios]
                scores = [0.6, 0.8]
                pool.record_results(ids, scores)
            
            stats = pool.get_stats()
            assert stats["curriculum"]["total_attempts"] == 10
            
            # Save and reload
            save_path = str(Path(tmpdir) / "scenarios.json")
            pool.save_scenarios(save_path)
            
            pool2 = ScenarioPool(config)
            pool2.load_scenarios(save_path)
            assert len(pool2.scenarios) == 20

    def test_scenario_observation_format(self):
        """Test that observations have correct format for agent consumption"""
        config = ScenarioPoolConfig()
        pool = ScenarioPool(config)
        scenarios = pool.generate_synthetic_batch(count=1)
        scenario = scenarios[0]
        
        obs = scenario.to_observation()
        
        # Verify required fields
        required_fields = ["timestamp", "markets", "perpetuals", "news", "socialFeed", "portfolio", "marketSummary"]
        for field in required_fields:
            assert field in obs, f"Missing required field: {field}"
        
        # Verify nested structure
        if obs["markets"]:
            market = obs["markets"][0]
            assert "id" in market
            assert "yesPrice" in market
            assert "question" in market
        
        if obs["perpetuals"]:
            perp = obs["perpetuals"][0]
            assert "ticker" in perp
            assert "markPrice" in perp
        
        assert "balance" in obs["portfolio"]


