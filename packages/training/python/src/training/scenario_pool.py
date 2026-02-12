"""
Scenario Pool for Online GRPO Training

Manages scenario sampling for online rollout generation.

Sources:
1. Production snapshots - Real market states from database
2. Synthetic scenarios - Generated for curriculum learning
3. Edge cases - Hand-crafted for robustness testing

Features:
- Curriculum learning with difficulty tracking
- Archetype-specific scenario generation
- Periodic refresh from production data
- Serializable state for checkpointing
"""

import json
import logging
import random
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Literal, Optional, Set
from uuid import uuid4

import numpy as np
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


# =============================================================================
# Scenario Data Structures
# =============================================================================


@dataclass
class MarketState:
    """State of a single market"""
    market_id: str
    question: str
    yes_price: float
    no_price: float
    volume_24h: float
    liquidity: float
    expires_at: int  # Unix timestamp ms
    category: str = "general"
    status: str = "active"

    def to_dict(self) -> Dict:
        return {
            "id": self.market_id,
            "question": self.question,
            "yesPrice": self.yes_price,
            "noPrice": self.no_price,
            "volume24h": self.volume_24h,
            "liquidity": self.liquidity,
            "expiresAt": self.expires_at,
            "category": self.category,
            "status": self.status,
        }


@dataclass
class PerpetualState:
    """State of a perpetual market"""
    ticker: str
    mark_price: float
    index_price: float
    funding_rate: float
    open_interest: float
    volume_24h: float
    change_24h: float
    high_24h: float
    low_24h: float

    def to_dict(self) -> Dict:
        return {
            "ticker": self.ticker,
            "markPrice": self.mark_price,
            "indexPrice": self.index_price,
            "fundingRate": self.funding_rate,
            "openInterest": self.open_interest,
            "volume24h": self.volume_24h,
            "change24h": self.change_24h,
            "high24h": self.high_24h,
            "low24h": self.low_24h,
        }


@dataclass
class NewsItem:
    """A news item in the scenario"""
    headline: str
    sentiment: Literal["bullish", "bearish", "neutral"]
    impact: Literal["high", "medium", "low"]
    source: str
    timestamp: int
    relevance_score: float = 1.0

    def to_dict(self) -> Dict:
        return {
            "headline": self.headline,
            "sentiment": self.sentiment,
            "impact": self.impact,
            "source": self.source,
            "timestamp": self.timestamp,
            "relevanceScore": self.relevance_score,
        }


@dataclass
class SocialPost:
    """A social post in the scenario"""
    author: str
    content: str
    sentiment: Literal["bullish", "bearish", "neutral"]
    likes: int
    replies: int
    timestamp: int
    verified: bool = False

    def to_dict(self) -> Dict:
        return {
            "author": self.author,
            "content": self.content,
            "sentiment": self.sentiment,
            "likes": self.likes,
            "replies": self.replies,
            "timestamp": self.timestamp,
            "verified": self.verified,
        }


@dataclass
class PortfolioState:
    """Agent's starting portfolio"""
    balance: float
    positions: List[Dict] = field(default_factory=list)
    total_pnl: float = 0.0

    def to_dict(self) -> Dict:
        return {
            "balance": self.balance,
            "positions": self.positions,
            "totalPnL": self.total_pnl,
        }


@dataclass
class Scenario:
    """
    Complete scenario for agent rollout.
    
    Contains all information an agent needs to make decisions:
    - Market state (prediction markets, perpetuals)
    - Information sources (news, social)
    - Agent's portfolio
    - Metadata for curriculum
    """
    id: str
    source: Literal["production", "synthetic", "edge_case"]
    
    # Market data
    markets: List[MarketState] = field(default_factory=list)
    perpetuals: List[PerpetualState] = field(default_factory=list)
    
    # Information sources
    news: List[NewsItem] = field(default_factory=list)
    social_posts: List[SocialPost] = field(default_factory=list)
    
    # Agent state
    portfolio: PortfolioState = field(default_factory=lambda: PortfolioState(balance=10000.0))
    
    # Metadata
    archetype_focus: Optional[str] = None
    difficulty: Literal["easy", "medium", "hard"] = "medium"
    timestamp: int = field(default_factory=lambda: int(datetime.now(timezone.utc).timestamp() * 1000))
    
    # Ground truth for evaluation (optional)
    ground_truth: Optional[Dict] = None
    
    # Extensible metadata for runtime data (e.g., bridge scenario reference)
    metadata: Dict = field(default_factory=dict)

    def add_market(self, market_dict: Dict) -> None:
        """Add a prediction market from dict data"""
        self.markets.append(MarketState(
            market_id=market_dict.get("id", f"market-{len(self.markets)}"),
            question=market_dict.get("question", "Unknown"),
            yes_price=market_dict.get("yesPrice", 0.5),
            no_price=market_dict.get("noPrice", 0.5),
            volume_24h=market_dict.get("volume24h", 0),
            liquidity=market_dict.get("liquidity", 0),
            expires_at=market_dict.get("expiresAt", 0),
            category=market_dict.get("category", "general"),
        ))

    def add_perpetual(self, perp_dict: Dict) -> None:
        """Add a perpetual market from dict data"""
        self.perpetuals.append(PerpetualState(
            ticker=perp_dict.get("ticker", "UNKNOWN"),
            mark_price=perp_dict.get("markPrice", 0),
            index_price=perp_dict.get("indexPrice", perp_dict.get("markPrice", 0)),
            funding_rate=perp_dict.get("fundingRate", 0),
            open_interest=perp_dict.get("openInterest", 0),
            volume_24h=perp_dict.get("volume24h", 0),
            change_24h=perp_dict.get("change24h", 0),
            high_24h=perp_dict.get("high24h", 0),
            low_24h=perp_dict.get("low24h", 0),
        ))

    def add_news(self, news_dict: Dict) -> None:
        """Add a news item from dict data"""
        # Map sentiment value to allowed literals
        sentiment_raw = news_dict.get("sentiment", "neutral")
        if isinstance(sentiment_raw, (int, float)):
            sentiment = "bullish" if sentiment_raw > 0 else "bearish" if sentiment_raw < 0 else "neutral"
        else:
            sentiment = sentiment_raw if sentiment_raw in ("bullish", "bearish", "neutral") else "neutral"
        
        self.news.append(NewsItem(
            headline=news_dict.get("headline", news_dict.get("content", "")[:100]),
            sentiment=sentiment,
            impact=news_dict.get("impact", "medium"),
            source=news_dict.get("source", "Unknown"),
            timestamp=news_dict.get("timestamp", int(datetime.now(timezone.utc).timestamp() * 1000)),
        ))

    def to_dict(self) -> Dict:
        return {
            "id": self.id,
            "source": self.source,
            "markets": [m.to_dict() for m in self.markets],
            "perpetuals": [p.to_dict() for p in self.perpetuals],
            "news": [n.to_dict() for n in self.news],
            "socialPosts": [s.to_dict() for s in self.social_posts],
            "portfolio": self.portfolio.to_dict(),
            "archetypeFocus": self.archetype_focus,
            "difficulty": self.difficulty,
            "timestamp": self.timestamp,
            "groundTruth": self.ground_truth,
        }

    def to_observation(self) -> Dict:
        """
        Convert to agent observation format.
        
        This is what the agent sees as context.
        """
        return {
            "timestamp": self.timestamp,
            "markets": [m.to_dict() for m in self.markets],
            "perpetuals": [p.to_dict() for p in self.perpetuals],
            "news": [n.to_dict() for n in self.news],
            "socialFeed": [s.to_dict() for s in self.social_posts],
            "portfolio": self.portfolio.to_dict(),
            "marketSummary": {
                "totalMarkets": len(self.markets),
                "totalPerpetuals": len(self.perpetuals),
                "avgSentiment": self._calculate_avg_sentiment(),
            },
        }

    def _calculate_avg_sentiment(self) -> str:
        """Calculate average sentiment from news and social"""
        sentiment_scores = {"bullish": 1, "neutral": 0, "bearish": -1}
        scores = []
        
        for item in self.news:
            scores.append(sentiment_scores.get(item.sentiment, 0))
        for post in self.social_posts:
            scores.append(sentiment_scores.get(post.sentiment, 0))
        
        if not scores:
            return "neutral"
        
        avg = sum(scores) / len(scores)
        if avg > 0.3:
            return "bullish"
        elif avg < -0.3:
            return "bearish"
        return "neutral"


# =============================================================================
# Curriculum Manager
# =============================================================================


class CurriculumState(BaseModel):
    """Serializable curriculum state"""
    attempts: Dict[str, int] = Field(default_factory=dict)
    scores: Dict[str, List[float]] = Field(default_factory=dict)
    solved: List[str] = Field(default_factory=list)
    last_updated: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class CurriculumManager:
    """
    Adaptive curriculum for scenario selection.
    
    Tracks:
    - Per-scenario attempt counts
    - Per-scenario score history
    - Solved/unsolved status
    
    Prioritizes:
    - Unsolved scenarios
    - Difficult scenarios (low avg score)
    - Underexplored scenarios
    """

    def __init__(
        self,
        checkpoint_path: Optional[str] = None,
        solve_threshold: float = 0.8,
        min_attempts_for_solved: int = 3,
        max_avg_for_skip: float = 0.85,
        max_history_per_scenario: int = 10,
    ):
        self.checkpoint_path = Path(checkpoint_path) if checkpoint_path else None
        self.solve_threshold = solve_threshold
        self.min_attempts_for_solved = min_attempts_for_solved
        self.max_avg_for_skip = max_avg_for_skip
        self.max_history_per_scenario = max_history_per_scenario
        
        # State
        self.attempts: Dict[str, int] = {}
        self.scores: Dict[str, List[float]] = {}
        self.solved: Set[str] = set()
        
        self._load_checkpoint()

    def _load_checkpoint(self) -> None:
        """Load curriculum state from checkpoint"""
        if not self.checkpoint_path or not self.checkpoint_path.exists():
            return
        
        try:
            with open(self.checkpoint_path) as f:
                state = CurriculumState.model_validate_json(f.read())
                self.attempts = state.attempts
                self.scores = state.scores
                self.solved = set(state.solved)
                logger.info(f"Loaded curriculum state: {len(self.solved)} solved scenarios")
        except Exception as e:
            logger.warning(f"Failed to load curriculum checkpoint: {e}")

    def _save_checkpoint(self) -> None:
        """Save curriculum state to checkpoint"""
        if not self.checkpoint_path:
            return
        
        try:
            self.checkpoint_path.parent.mkdir(parents=True, exist_ok=True)
            state = CurriculumState(
                attempts=self.attempts,
                scores=self.scores,
                solved=list(self.solved),
            )
            with open(self.checkpoint_path, "w") as f:
                f.write(state.model_dump_json(indent=2))
        except Exception as e:
            logger.warning(f"Failed to save curriculum checkpoint: {e}")

    def record_attempt(self, scenario_id: str, score: float) -> None:
        """Record an attempt on a scenario"""
        self.attempts[scenario_id] = self.attempts.get(scenario_id, 0) + 1
        
        if scenario_id not in self.scores:
            self.scores[scenario_id] = []
        
        self.scores[scenario_id].append(score)
        
        # Trim history
        if len(self.scores[scenario_id]) > self.max_history_per_scenario:
            self.scores[scenario_id] = self.scores[scenario_id][-self.max_history_per_scenario:]
        
        # Check if solved
        recent = self.scores[scenario_id][-self.min_attempts_for_solved:]
        if len(recent) >= self.min_attempts_for_solved:
            avg = sum(recent) / len(recent)
            if avg >= self.solve_threshold:
                self.solved.add(scenario_id)
                logger.debug(f"Scenario {scenario_id} marked as solved (avg: {avg:.2f})")
        
        self._save_checkpoint()

    def should_skip(self, scenario_id: str) -> bool:
        """Check if scenario should be skipped (too easy)"""
        if scenario_id in self.solved:
            return True
        
        scores = self.scores.get(scenario_id, [])
        if len(scores) < 2:
            return False
        
        recent = scores[-3:]
        avg = sum(recent) / len(recent)
        return avg > self.max_avg_for_skip

    def get_priority(self, scenario_id: str) -> float:
        """
        Get priority score for scenario (higher = more priority).
        
        Combines:
        - Difficulty (low scores = high priority)
        - Exploration bonus (few attempts = high priority)
        """
        if scenario_id in self.solved:
            return 0.0
        
        scores = self.scores.get(scenario_id, [])
        attempts = self.attempts.get(scenario_id, 0)
        
        # Difficulty priority: lower scores = higher priority
        if scores:
            avg = sum(scores) / len(scores)
            difficulty_priority = 1.0 - avg
        else:
            difficulty_priority = 1.0  # Unexplored = high priority
        
        # Exploration bonus: fewer attempts = higher priority
        exploration_bonus = 1.0 / (1.0 + attempts)
        
        return difficulty_priority + exploration_bonus * 0.5

    def reset(self) -> None:
        """Reset curriculum (all scenarios unsolved)"""
        self.solved.clear()
        logger.info("Curriculum reset: all scenarios marked unsolved")
        self._save_checkpoint()

    def get_stats(self) -> Dict:
        """Get curriculum statistics"""
        total_scenarios = len(self.attempts)
        total_attempts = sum(self.attempts.values())
        
        all_scores = [s for scores in self.scores.values() for s in scores]
        avg_score = sum(all_scores) / len(all_scores) if all_scores else 0.0
        
        return {
            "total_scenarios": total_scenarios,
            "solved_scenarios": len(self.solved),
            "total_attempts": total_attempts,
            "avg_score": avg_score,
            "solve_rate": len(self.solved) / total_scenarios if total_scenarios > 0 else 0.0,
        }


# =============================================================================
# Scenario Pool
# =============================================================================


class ScenarioPoolConfig(BaseModel):
    """Configuration for scenario pool"""
    
    # Pool size
    max_scenarios: int = Field(default=500, description="Maximum scenarios to keep in pool")
    min_scenarios: int = Field(default=50, description="Minimum scenarios before refresh")
    
    # Refresh settings
    refresh_interval: int = Field(default=1000, description="Refresh every N samples")
    production_ratio: float = Field(default=0.6, description="Ratio of production vs synthetic")
    
    # Curriculum settings
    use_curriculum: bool = Field(default=True, description="Enable curriculum learning")
    curriculum_checkpoint_path: str = Field(
        default="./curriculum_state.json",
        description="Path to curriculum state checkpoint",
    )
    
    # Generation settings
    synthetic_difficulty_distribution: Dict[str, float] = Field(
        default_factory=lambda: {"easy": 0.3, "medium": 0.5, "hard": 0.2},
        description="Distribution of synthetic scenario difficulties",
    )


class ScenarioPool:
    """
    Manages scenario sampling for online rollouts.
    
    Features:
    - Load production snapshots from database
    - Generate synthetic scenarios
    - Curriculum-aware sampling
    - Automatic refresh
    """

    def __init__(
        self,
        config: ScenarioPoolConfig,
        database_url: Optional[str] = None,
    ):
        self.config = config
        self.database_url = database_url
        
        self.scenarios: List[Scenario] = []
        self._sample_counter = 0
        
        # Curriculum manager
        self.curriculum = CurriculumManager(
            checkpoint_path=config.curriculum_checkpoint_path if config.use_curriculum else None,
        ) if config.use_curriculum else None

    async def initialize(self) -> None:
        """Initialize scenario pool"""
        logger.info("Initializing scenario pool...")
        
        # Load production scenarios if database available
        if self.database_url:
            production_count = int(self.config.max_scenarios * self.config.production_ratio)
            await self.load_production_snapshots(limit=production_count)
        
        # Fill remaining with synthetic
        remaining = self.config.max_scenarios - len(self.scenarios)
        if remaining > 0:
            synthetic = self.generate_synthetic_batch(count=remaining)
            self.scenarios.extend(synthetic)
        
        logger.info(f"Scenario pool initialized with {len(self.scenarios)} scenarios")

    async def load_production_snapshots(
        self,
        limit: int = 200,
        min_quality: float = 0.5,
    ) -> None:
        """
        Load high-quality scenarios from production games.
        
        Extracts market states from recent game windows.
        """
        if not self.database_url:
            logger.warning("No database URL configured, skipping production snapshots")
            return

        try:
            import asyncpg
        except ImportError:
            logger.warning("asyncpg not installed, skipping production snapshots")
            return

        try:
            pool = await asyncpg.create_pool(
                self.database_url,
                min_size=1,
                max_size=5,
                command_timeout=30,
            )
        except Exception as e:
            logger.warning(f"Failed to connect to database: {e}")
            return

        try:
            async with pool.acquire() as conn:
                # Query recent game states with market data
                rows = await conn.fetch("""
                    SELECT 
                        w.id as window_id,
                        w."startTime" as start_time,
                        w."endTime" as end_time,
                        m.id as market_id,
                        m.question,
                        m."yesPrice",
                        m."noPrice",
                        m."totalVolume" as volume,
                        m.category
                    FROM "GameWindow" w
                    JOIN "Question" m ON m."gameWindowId" = w.id
                    WHERE w."createdAt" > NOW() - INTERVAL '7 days'
                    AND m.status = 'active'
                    ORDER BY w."createdAt" DESC
                    LIMIT $1
                """, limit * 5)  # Get more rows to group into scenarios

            # Group by window
            windows: Dict[str, List[Dict]] = {}
            for row in rows:
                window_id = str(row["window_id"])
                if window_id not in windows:
                    windows[window_id] = []
                windows[window_id].append(dict(row))

            # Create scenarios from windows
            for window_id, market_rows in list(windows.items())[:limit]:
                markets = []
                for row in market_rows[:10]:  # Max 10 markets per scenario
                    markets.append(MarketState(
                        market_id=str(row.get("market_id", uuid4())),
                        question=row.get("question", "Unknown question"),
                        yes_price=float(row.get("yesPrice", 0.5)),
                        no_price=1.0 - float(row.get("yesPrice", 0.5)),
                        volume_24h=float(row.get("volume", 0)),
                        liquidity=float(row.get("volume", 0)) * 10,
                        expires_at=int(datetime.now(timezone.utc).timestamp() * 1000) + 86400000,
                        category=row.get("category", "general"),
                    ))

                if markets:
                    scenario = Scenario(
                        id=f"prod-{window_id}",
                        source="production",
                        markets=markets,
                        perpetuals=self._generate_default_perpetuals(),
                        news=self._generate_contextual_news(markets),
                        social_posts=self._generate_contextual_posts(markets),
                        difficulty="medium",
                    )
                    self.scenarios.append(scenario)

            logger.info(f"Loaded {len(windows)} production scenarios")

        except Exception as e:
            logger.warning(f"Error loading production snapshots: {e}")
        finally:
            await pool.close()

    def generate_synthetic_batch(
        self,
        count: int,
        archetype_focus: Optional[str] = None,
    ) -> List[Scenario]:
        """Generate batch of synthetic scenarios"""
        scenarios = []
        
        # Distribute by difficulty
        difficulties = []
        for diff, ratio in self.config.synthetic_difficulty_distribution.items():
            difficulties.extend([diff] * int(count * ratio))
        
        # Fill remaining
        while len(difficulties) < count:
            difficulties.append("medium")
        
        random.shuffle(difficulties)
        
        for i, difficulty in enumerate(difficulties[:count]):
            scenario = self._generate_synthetic_scenario(
                difficulty=difficulty,
                archetype_focus=archetype_focus,
            )
            scenarios.append(scenario)
        
        return scenarios

    def _generate_synthetic_scenario(
        self,
        difficulty: Literal["easy", "medium", "hard"] = "medium",
        archetype_focus: Optional[str] = None,
    ) -> Scenario:
        """Generate a single synthetic scenario"""
        scenario_id = f"synth-{uuid4().hex[:8]}"
        
        # Generate markets based on difficulty
        num_markets = {"easy": 3, "medium": 5, "hard": 8}[difficulty]
        markets = [self._generate_random_market(i) for i in range(num_markets)]
        
        # Generate perpetuals
        perpetuals = self._generate_default_perpetuals()
        
        # Generate news and posts
        num_news = {"easy": 2, "medium": 5, "hard": 8}[difficulty]
        news = self._generate_random_news(num_news, difficulty)
        
        num_posts = {"easy": 3, "medium": 6, "hard": 10}[difficulty]
        posts = self._generate_random_posts(num_posts)
        
        # Starting balance based on difficulty
        balance = {"easy": 15000, "medium": 10000, "hard": 5000}[difficulty]
        
        return Scenario(
            id=scenario_id,
            source="synthetic",
            markets=markets,
            perpetuals=perpetuals,
            news=news,
            social_posts=posts,
            portfolio=PortfolioState(balance=float(balance)),
            archetype_focus=archetype_focus,
            difficulty=difficulty,
        )

    def _generate_random_market(self, index: int) -> MarketState:
        """Generate a random prediction market"""
        templates = [
            ("Will BTC exceed ${price}K by end of {period}?", "crypto"),
            ("Will ETH outperform BTC this {period}?", "crypto"),
            ("Will the Fed announce rate {action}?", "macro"),
            ("Will {company} stock reach new ATH?", "stocks"),
            ("Will total crypto market cap exceed ${cap}T?", "crypto"),
            ("Will {coin} flip {coin2} in market cap?", "crypto"),
            ("Will inflation be above {rate}% next month?", "macro"),
        ]
        
        template, category = random.choice(templates)
        question = template.format(
            price=random.choice([100, 120, 150, 200]),
            period=random.choice(["week", "month", "quarter"]),
            action=random.choice(["cuts", "hikes", "pause"]),
            company=random.choice(["NVIDIA", "Apple", "Microsoft", "Tesla"]),
            cap=random.choice([3, 4, 5]),
            coin=random.choice(["SOL", "DOGE", "AVAX"]),
            coin2=random.choice(["ETH", "BNB"]),
            rate=random.choice([2, 3, 4]),
        )
        
        yes_price = random.uniform(0.2, 0.8)
        
        return MarketState(
            market_id=f"market-{index + 1}",
            question=question,
            yes_price=round(yes_price, 2),
            no_price=round(1 - yes_price, 2),
            volume_24h=float(random.randint(10000, 500000)),
            liquidity=float(random.randint(50000, 1000000)),
            expires_at=int(datetime.now(timezone.utc).timestamp() * 1000) + random.randint(86400000, 604800000),
            category=category,
        )

    def _generate_default_perpetuals(self) -> List[PerpetualState]:
        """Generate default perpetual markets"""
        tickers = ["BTC", "ETH", "SOL", "DOGE", "AVAX"]
        base_prices = {"BTC": 100000, "ETH": 3500, "SOL": 180, "DOGE": 0.35, "AVAX": 40}
        
        perpetuals = []
        for ticker in tickers:
            base = base_prices.get(ticker, 100)
            price = base * (1 + random.uniform(-0.05, 0.05))
            
            perpetuals.append(PerpetualState(
                ticker=ticker,
                mark_price=round(price, 2),
                index_price=round(price * (1 + random.uniform(-0.001, 0.001)), 2),
                funding_rate=round(random.uniform(-0.001, 0.001), 6),
                open_interest=float(random.randint(1000000, 50000000)),
                volume_24h=float(random.randint(5000000, 100000000)),
                change_24h=round(random.uniform(-0.1, 0.1), 4),
                high_24h=round(price * 1.05, 2),
                low_24h=round(price * 0.95, 2),
            ))
        
        return perpetuals

    def _generate_random_news(
        self,
        count: int,
        difficulty: str,
    ) -> List[NewsItem]:
        """Generate random news items"""
        templates = [
            ("Bitcoin Approaches Key Resistance Level at ${price}K", "bullish", "high"),
            ("Federal Reserve Hints at {action} Shift in Policy", "neutral", "high"),
            ("Major Exchange Reports Record {metric} Volume", "bullish", "medium"),
            ("Regulatory Clarity Expected Next {period}", "neutral", "medium"),
            ("Whale Alert: Large {direction} Transfer Detected", "bearish", "low"),
            ("New DeFi Protocol Launches with ${tvl}M TVL", "bullish", "low"),
            ("Mining Difficulty Reaches New {direction}", "neutral", "low"),
            ("Institutional Investors {action} Crypto Holdings", "bullish", "high"),
            ("Market Analysis: Technical Indicators Show {signal}", "neutral", "medium"),
            ("Breaking: {entity} Announces Crypto {action}", "bullish", "high"),
        ]
        
        news = []
        sources = ["CoinDesk", "Bloomberg Crypto", "Reuters", "CryptoNews", "The Block"]
        
        selected = random.sample(templates, min(count, len(templates)))
        for headline_template, sentiment, impact in selected:
            headline = headline_template.format(
                price=random.choice([100, 120, 150]),
                action=random.choice(["Bullish", "Dovish", "Cautious"]),
                metric=random.choice(["Trading", "Spot", "Derivatives"]),
                period=random.choice(["Month", "Quarter"]),
                direction=random.choice(["Buy", "Sell", "High", "Low"]),
                tvl=random.randint(10, 100),
                signal=random.choice(["Bullish Breakout", "Consolidation", "Bearish Divergence"]),
                entity=random.choice(["BlackRock", "Fidelity", "Goldman Sachs"]),
            )
            
            # Harder scenarios have more conflicting signals
            if difficulty == "hard" and random.random() > 0.5:
                sentiment = random.choice(["bullish", "bearish", "neutral"])
            
            news.append(NewsItem(
                headline=headline,
                sentiment=sentiment,
                impact=impact,
                source=random.choice(sources),
                timestamp=int(datetime.now(timezone.utc).timestamp() * 1000) - random.randint(0, 3600000),
                relevance_score=random.uniform(0.5, 1.0),
            ))
        
        return news

    def _generate_random_posts(self, count: int) -> List[SocialPost]:
        """Generate random social posts"""
        templates = [
            ("Just went long on {ticker}, looking {outlook} 🚀", "bullish"),
            ("Taking profits here, market looks overextended", "bearish"),
            ("Anyone else seeing this pattern on the {period} chart?", "neutral"),
            ("New ATH incoming, calling it now 💎🙌", "bullish"),
            ("Be careful, volume is declining significantly", "bearish"),
            ("Great entry opportunity if you missed the dip", "bullish"),
            ("Liquidation cascade might be coming, stay safe", "bearish"),
            ("{ticker} breaking out of the descending wedge!", "bullish"),
            ("Funding rates getting extreme, reversal soon?", "neutral"),
            ("This is the dip you've been waiting for", "bullish"),
        ]
        
        posts = []
        for i in range(count):
            template, sentiment = random.choice(templates)
            content = template.format(
                ticker=random.choice(["BTC", "ETH", "SOL"]),
                outlook=random.choice(["bullish", "strong", "good"]),
                period=random.choice(["4H", "1D", "Weekly"]),
            )
            
            posts.append(SocialPost(
                author=f"trader_{random.randint(100, 999)}",
                content=content,
                sentiment=sentiment,
                likes=random.randint(0, 500),
                replies=random.randint(0, 50),
                timestamp=int(datetime.now(timezone.utc).timestamp() * 1000) - random.randint(0, 1800000),
                verified=random.random() > 0.7,
            ))
        
        return posts

    def _generate_contextual_news(self, markets: List[MarketState]) -> List[NewsItem]:
        """Generate news relevant to the markets"""
        news = []
        
        for market in markets[:3]:
            # Extract key terms from question
            question_lower = market.question.lower()
            
            if "btc" in question_lower or "bitcoin" in question_lower:
                news.append(NewsItem(
                    headline=f"Bitcoin Technical Analysis: Key Levels to Watch",
                    sentiment=random.choice(["bullish", "neutral"]),
                    impact="medium",
                    source="CryptoNews",
                    timestamp=int(datetime.now(timezone.utc).timestamp() * 1000) - random.randint(0, 3600000),
                ))
            elif "eth" in question_lower or "ethereum" in question_lower:
                news.append(NewsItem(
                    headline="Ethereum Network Activity Surges to New Highs",
                    sentiment="bullish",
                    impact="medium",
                    source="The Block",
                    timestamp=int(datetime.now(timezone.utc).timestamp() * 1000) - random.randint(0, 3600000),
                ))
            elif "fed" in question_lower or "rate" in question_lower:
                news.append(NewsItem(
                    headline="Fed Officials Signal Patience on Rate Decisions",
                    sentiment="neutral",
                    impact="high",
                    source="Bloomberg",
                    timestamp=int(datetime.now(timezone.utc).timestamp() * 1000) - random.randint(0, 3600000),
                ))
        
        # Add some generic news
        generic_news = self._generate_random_news(3, "medium")
        news.extend(generic_news)
        
        return news

    def _generate_contextual_posts(self, markets: List[MarketState]) -> List[SocialPost]:
        """Generate social posts relevant to the markets"""
        posts = []
        
        for market in markets[:2]:
            question_lower = market.question.lower()
            
            if market.yes_price > 0.6:
                sentiment = "bullish"
                content = f"Market is pricing in high probability - {market.question[:50]}..."
            elif market.yes_price < 0.4:
                sentiment = "bearish"
                content = f"Looks unlikely based on current odds - {market.question[:50]}..."
            else:
                sentiment = "neutral"
                content = f"This one could go either way - {market.question[:50]}..."
            
            posts.append(SocialPost(
                author=f"analyst_{random.randint(1, 100)}",
                content=content,
                sentiment=sentiment,
                likes=random.randint(10, 100),
                replies=random.randint(1, 20),
                timestamp=int(datetime.now(timezone.utc).timestamp() * 1000) - random.randint(0, 1800000),
                verified=True,
            ))
        
        # Add generic posts
        generic_posts = self._generate_random_posts(4)
        posts.extend(generic_posts)
        
        return posts

    def sample(self, count: int = 1) -> List[Scenario]:
        """
        Sample scenarios respecting curriculum.
        
        Uses priority-weighted sampling when curriculum is enabled.
        """
        self._sample_counter += count
        
        # Check if refresh needed
        if self._sample_counter >= self.config.refresh_interval:
            self._sample_counter = 0
            logger.info("Refresh interval reached, regenerating synthetic scenarios")
            # Keep production, regenerate synthetic
            production = [s for s in self.scenarios if s.source == "production"]
            synthetic_count = self.config.max_scenarios - len(production)
            synthetic = self.generate_synthetic_batch(synthetic_count)
            self.scenarios = production + synthetic
        
        if not self.scenarios:
            return []
        
        if self.curriculum:
            # Filter out scenarios that should be skipped
            available = [s for s in self.scenarios if not self.curriculum.should_skip(s.id)]
            
            if not available:
                # All solved, reset curriculum
                logger.info("All scenarios solved, resetting curriculum")
                self.curriculum.reset()
                available = self.scenarios
            
            # Calculate priorities
            priorities = [self.curriculum.get_priority(s.id) for s in available]
            
            # Normalize to probabilities
            total = sum(priorities)
            if total == 0:
                probs = [1.0 / len(available)] * len(available)
            else:
                probs = [p / total for p in priorities]
            
            # Sample with replacement if count > available
            indices = np.random.choice(
                len(available),
                size=min(count, len(available)),
                replace=False,
                p=probs,
            )
            
            return [available[i] for i in indices]
        else:
            # Simple random sampling
            return random.sample(self.scenarios, min(count, len(self.scenarios)))

    def record_results(
        self,
        scenario_ids: List[str],
        scores: List[float],
    ) -> None:
        """Record training results for curriculum updates"""
        if not self.curriculum:
            return
        
        for scenario_id, score in zip(scenario_ids, scores):
            self.curriculum.record_attempt(scenario_id, score)

    def get_stats(self) -> Dict:
        """Get pool statistics"""
        stats = {
            "total_scenarios": len(self.scenarios),
            "production_scenarios": len([s for s in self.scenarios if s.source == "production"]),
            "synthetic_scenarios": len([s for s in self.scenarios if s.source == "synthetic"]),
            "samples_since_refresh": self._sample_counter,
        }
        
        if self.curriculum:
            stats["curriculum"] = self.curriculum.get_stats()
        
        return stats

    def save_scenarios(self, path: str) -> None:
        """Save scenarios to JSON file"""
        output_path = Path(path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        
        data = [s.to_dict() for s in self.scenarios]
        
        with open(output_path, "w") as f:
            json.dump(data, f, indent=2)
        
        logger.info(f"Saved {len(data)} scenarios to {path}")

    def load_scenarios(self, path: str) -> None:
        """Load scenarios from JSON file"""
        with open(path) as f:
            data = json.load(f)
        
        # Clear existing
        self.scenarios.clear()
        
        for item in data:
            # Reconstruct scenario from dict
            markets = [MarketState(
                market_id=m["id"],
                question=m["question"],
                yes_price=m["yesPrice"],
                no_price=m["noPrice"],
                volume_24h=m["volume24h"],
                liquidity=m["liquidity"],
                expires_at=m["expiresAt"],
                category=m.get("category", "general"),
            ) for m in item.get("markets", [])]
            
            perpetuals = [PerpetualState(
                ticker=p["ticker"],
                mark_price=p["markPrice"],
                index_price=p["indexPrice"],
                funding_rate=p["fundingRate"],
                open_interest=p["openInterest"],
                volume_24h=p["volume24h"],
                change_24h=p["change24h"],
                high_24h=p["high24h"],
                low_24h=p["low24h"],
            ) for p in item.get("perpetuals", [])]
            
            news = [NewsItem(
                headline=n["headline"],
                sentiment=n["sentiment"],
                impact=n["impact"],
                source=n["source"],
                timestamp=n["timestamp"],
            ) for n in item.get("news", [])]
            
            posts = [SocialPost(
                author=p["author"],
                content=p["content"],
                sentiment=p["sentiment"],
                likes=p["likes"],
                replies=p["replies"],
                timestamp=p["timestamp"],
                verified=p.get("verified", False),
            ) for p in item.get("socialPosts", [])]
            
            portfolio_data = item.get("portfolio", {})
            portfolio = PortfolioState(
                balance=portfolio_data.get("balance", 10000.0),
                positions=portfolio_data.get("positions", []),
                total_pnl=portfolio_data.get("totalPnL", 0.0),
            )
            
            scenario = Scenario(
                id=item["id"],
                source=item["source"],
                markets=markets,
                perpetuals=perpetuals,
                news=news,
                social_posts=posts,
                portfolio=portfolio,
                archetype_focus=item.get("archetypeFocus"),
                difficulty=item.get("difficulty", "medium"),
                timestamp=item.get("timestamp", int(datetime.now(timezone.utc).timestamp() * 1000)),
                ground_truth=item.get("groundTruth"),
            )
            self.scenarios.append(scenario)
        
        logger.info(f"Loaded {len(self.scenarios)} scenarios from {path}")

