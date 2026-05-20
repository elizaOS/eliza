"""
Fast Simulator - BENCHMARK EVALUATION ONLY

=================================================================
WARNING: This module is for BENCHMARK/EVALUATION purposes only!
         Do NOT use for training data generation.

Training data MUST come from:
1. TrajectoryGenerator (real agents with real LLM calls)
2. Database trajectories (real production data)

This simulator generates SYNTHETIC market data which is useful for:
- Consistent benchmark comparisons
- Deterministic testing
- Performance evaluation

It should NEVER be used to generate training data because:
- Market data is synthetic (not real)
- Price movements are random (not realistic)
- Agent interactions are simulated (not real LLM calls)
=================================================================

Key features:
- Zero artificial delays
- Minimal memory allocations
- Async batch processing
- Deterministic replay of benchmark snapshots

Usage:
    # For benchmarking ONLY
    simulator = FastSimulator.for_benchmark(snapshot)
    results = await simulator.run_benchmark(agents)
"""

import asyncio
import json
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Literal, Protocol

import asyncpg

from ..models import (
    BabylonTrajectory,
    EnvironmentState,
)
from .quality_utils import (
    build_trajectory_from_ticks,
    calculate_trajectory_quality_score,
)
from .rollout_generator import AgentTickData, RolloutResult

logger = logging.getLogger(__name__)


@dataclass
class SimulatorConfig:
    """Configuration for the fast simulator"""

    # Mode
    mode: Literal["benchmark", "data_generation"] = "data_generation"

    # Speed settings
    max_concurrent_agents: int = 8
    batch_size: int = 4  # Number of agents to process per batch

    # Tick settings
    ticks_per_window: int = 60  # Ticks in a 1-hour window
    max_ticks: int = 1000

    # Database
    database_url: str = ""
    save_to_db: bool = True

    # Quality settings
    min_actions_per_trajectory: int = 5

    # Benchmark settings (if mode='benchmark')
    benchmark_snapshot: dict | None = None
    ground_truth: dict | None = None


@dataclass
class SimulatorMetrics:
    """Metrics collected during simulation"""

    start_time: float = 0.0
    end_time: float = 0.0

    total_ticks: int = 0
    total_agents: int = 0
    total_llm_calls: int = 0
    total_actions: int = 0

    successful_trajectories: int = 0
    failed_trajectories: int = 0

    avg_tick_duration_ms: float = 0.0
    ticks_per_second: float = 0.0

    # Benchmark specific
    total_pnl: float = 0.0
    avg_accuracy: float = 0.0
    avg_optimality: float = 0.0

    def finalize(self) -> None:
        """Calculate final metrics"""
        duration = self.end_time - self.start_time
        if duration > 0:
            self.ticks_per_second = self.total_ticks / duration
            if self.total_ticks > 0:
                self.avg_tick_duration_ms = (duration / self.total_ticks) * 1000


class AgentRunner(Protocol):
    """Protocol for running agents"""

    async def run_tick(
        self,
        agent_id: str,
        observation: dict,
        env_state: EnvironmentState,
    ) -> AgentTickData:
        """Run a single agent tick"""
        ...


@dataclass
class GameState:
    """
    Rich game state for realistic simulation.

    Provides detailed market data, orderbooks, news, and social context
    that mirrors production environment for high-quality training data.
    """

    tick: int = 0
    time: int = 0

    # Markets with detailed state
    markets: list[dict] = field(default_factory=list)
    perpetuals: list[dict] = field(default_factory=list)

    # Market microstructure
    orderbooks: dict[str, dict] = field(default_factory=dict)  # market_id -> orderbook

    # News/Social
    news: list[dict] = field(default_factory=list)
    posts: list[dict] = field(default_factory=list)

    # Agent states
    portfolios: dict[str, dict] = field(default_factory=dict)

    # Price history for technical analysis
    price_history: dict[str, list[float]] = field(default_factory=dict)

    def _generate_realistic_markets(self) -> list[dict]:
        """Generate realistic prediction markets if none exist"""
        import random

        if self.markets:
            return self.markets

        market_templates = [
            {"question": "Will BTC hit $120,000 by end of month?", "category": "crypto"},
            {"question": "Will ETH outperform BTC this week?", "category": "crypto"},
            {"question": "Will the Fed announce rate cuts?", "category": "macro"},
            {"question": "Will NVIDIA stock reach new ATH?", "category": "stocks"},
            {"question": "Will total crypto market cap exceed $4T?", "category": "crypto"},
        ]

        markets = []
        for i, template in enumerate(market_templates):
            yes_prob = random.uniform(0.2, 0.8)
            markets.append(
                {
                    "id": f"market-{i + 1}",
                    "question": template["question"],
                    "category": template["category"],
                    "yesPrice": round(yes_prob, 2),
                    "noPrice": round(1 - yes_prob, 2),
                    "volume24h": random.randint(10000, 500000),
                    "liquidity": random.randint(50000, 1000000),
                    "expiresAt": self.time + random.randint(86400000, 604800000),  # 1-7 days
                    "status": "active",
                }
            )

        return markets

    def _generate_realistic_perpetuals(self) -> list[dict]:
        """Generate realistic perpetual markets"""
        import random

        if self.perpetuals:
            return self.perpetuals

        tickers = ["BTC", "ETH", "SOL", "DOGE", "AVAX"]
        base_prices = {"BTC": 100000, "ETH": 3500, "SOL": 180, "DOGE": 0.35, "AVAX": 40}

        perpetuals = []
        for ticker in tickers:
            base = base_prices.get(ticker, 100)
            price = base * (1 + random.uniform(-0.05, 0.05))

            perpetuals.append(
                {
                    "ticker": ticker,
                    "markPrice": round(price, 2),
                    "indexPrice": round(price * (1 + random.uniform(-0.001, 0.001)), 2),
                    "fundingRate": round(random.uniform(-0.001, 0.001), 6),
                    "openInterest": random.randint(1000000, 50000000),
                    "volume24h": random.randint(5000000, 100000000),
                    "change24h": round(random.uniform(-0.1, 0.1), 4),
                    "high24h": round(price * 1.05, 2),
                    "low24h": round(price * 0.95, 2),
                }
            )

        return perpetuals

    def _generate_orderbook(self, market_id: str, mid_price: float) -> dict:
        """Generate realistic orderbook data"""
        import random

        bids = []
        asks = []

        for i in range(5):
            spread = 0.01 * (i + 1)
            bid_price = round(mid_price * (1 - spread), 4)
            ask_price = round(mid_price * (1 + spread), 4)

            bids.append(
                {
                    "price": bid_price,
                    "size": random.randint(100, 5000),
                    "total": random.randint(1000, 10000),
                }
            )
            asks.append(
                {
                    "price": ask_price,
                    "size": random.randint(100, 5000),
                    "total": random.randint(1000, 10000),
                }
            )

        return {
            "market_id": market_id,
            "bids": sorted(bids, key=lambda x: -x["price"]),
            "asks": sorted(asks, key=lambda x: x["price"]),
            "spread": round((asks[0]["price"] - bids[0]["price"]) / mid_price * 100, 2),
            "mid_price": mid_price,
        }

    def _generate_news(self) -> list[dict]:
        """Generate realistic news items"""
        import random

        if self.news:
            return self.news

        news_templates = [
            {
                "headline": "Bitcoin Approaches Key Resistance Level",
                "sentiment": "bullish",
                "impact": "high",
            },
            {
                "headline": "Federal Reserve Hints at Policy Shift",
                "sentiment": "neutral",
                "impact": "high",
            },
            {
                "headline": "Major Exchange Reports Record Trading Volume",
                "sentiment": "bullish",
                "impact": "medium",
            },
            {
                "headline": "Regulatory Clarity Expected Next Month",
                "sentiment": "neutral",
                "impact": "medium",
            },
            {
                "headline": "Whale Alert: Large Transfer Detected",
                "sentiment": "bearish",
                "impact": "low",
            },
            {
                "headline": "New DeFi Protocol Launches with $50M TVL",
                "sentiment": "bullish",
                "impact": "low",
            },
            {
                "headline": "Mining Difficulty Reaches New High",
                "sentiment": "neutral",
                "impact": "low",
            },
        ]

        news = []
        selected = random.sample(news_templates, min(5, len(news_templates)))
        for i, template in enumerate(selected):
            news.append(
                {
                    "id": f"news-{self.tick}-{i}",
                    "headline": template["headline"],
                    "sentiment": template["sentiment"],
                    "impact": template["impact"],
                    "source": random.choice(["CoinDesk", "Bloomberg", "Reuters", "CryptoNews"]),
                    "timestamp": self.time - random.randint(0, 3600000),  # Last hour
                    "relevance_score": random.uniform(0.5, 1.0),
                }
            )

        return news

    def _generate_social_posts(self) -> list[dict]:
        """Generate realistic social posts"""
        import random

        if self.posts:
            return self.posts

        post_templates = [
            {"content": "Just went long on BTC, looking bullish 🚀", "sentiment": "bullish"},
            {"content": "Taking profits here, market looks overextended", "sentiment": "bearish"},
            {"content": "Anyone else seeing this pattern on the 4H chart?", "sentiment": "neutral"},
            {"content": "New ATH incoming, calling it now 💎🙌", "sentiment": "bullish"},
            {"content": "Be careful, volume is declining", "sentiment": "bearish"},
            {"content": "Great entry opportunity if you missed the dip", "sentiment": "bullish"},
            {"content": "Liquidation cascade might be coming", "sentiment": "bearish"},
        ]

        posts = []
        selected = random.sample(post_templates, min(6, len(post_templates)))
        for i, template in enumerate(selected):
            posts.append(
                {
                    "id": f"post-{self.tick}-{i}",
                    "author": f"trader_{random.randint(100, 999)}",
                    "content": template["content"],
                    "sentiment": template["sentiment"],
                    "likes": random.randint(0, 500),
                    "replies": random.randint(0, 50),
                    "timestamp": self.time - random.randint(0, 1800000),  # Last 30 min
                    "verified": random.random() > 0.7,
                }
            )

        return posts

    def to_observation(self) -> dict:
        """
        Convert to rich agent observation.

        Provides all data an agent needs for informed decision-making:
        - Current market state with prices and volume
        - Orderbook depth for execution planning
        - Recent news with sentiment
        - Social feed for market pulse
        - Technical indicators (price history)
        """
        # Ensure we have markets
        markets = self._generate_realistic_markets() if not self.markets else self.markets
        perpetuals = (
            self._generate_realistic_perpetuals() if not self.perpetuals else self.perpetuals
        )
        news = self._generate_news() if not self.news else self.news
        posts = self._generate_social_posts() if not self.posts else self.posts

        # Generate orderbooks for each market
        orderbooks = {}
        for market in markets:
            mid_price = market.get("yesPrice", 0.5)
            orderbooks[market["id"]] = self._generate_orderbook(market["id"], mid_price)

        return {
            "tick": self.tick,
            "time": self.time,
            "timestamp_human": datetime.fromtimestamp(
                self.time / 1000, tz=timezone.utc
            ).isoformat(),
            # Market data
            "markets": markets,
            "perpetuals": perpetuals,
            "orderbooks": orderbooks,
            # Information sources
            "news": news[:5],
            "social_feed": posts[:10],
            # Market summary
            "market_summary": {
                "total_markets": len(markets),
                "total_perpetuals": len(perpetuals),
                "avg_sentiment": self._calculate_avg_sentiment(news, posts),
                "market_momentum": self._calculate_momentum(),
            },
        }

    def _calculate_avg_sentiment(self, news: list[dict], posts: list[dict]) -> str:
        """Calculate overall market sentiment"""
        sentiment_scores = {"bullish": 1, "neutral": 0, "bearish": -1}

        scores = []
        for item in news + posts:
            sentiment = item.get("sentiment", "neutral")
            scores.append(sentiment_scores.get(sentiment, 0))

        if not scores:
            return "neutral"

        avg = sum(scores) / len(scores)
        if avg > 0.3:
            return "bullish"
        elif avg < -0.3:
            return "bearish"
        return "neutral"

    def _calculate_momentum(self) -> str:
        """Calculate market momentum from price history"""
        import random

        # In production, this would use actual price history
        return random.choice(["strong_bullish", "bullish", "neutral", "bearish", "strong_bearish"])

    def get_env_state(self, agent_id: str) -> EnvironmentState:
        """Get environment state for an agent"""
        portfolio = self.portfolios.get(agent_id, {})
        return EnvironmentState(
            agent_balance=portfolio.get("balance", 10000.0),
            agent_pnl=portfolio.get("pnl", 0.0),
            open_positions=portfolio.get("positions", 0),
            active_markets=len(self.markets) if self.markets else 5,
        )


class FastSimulator:
    """
    Fast simulator for benchmarking and data generation.

    Optimized for throughput with minimal overhead.
    """

    def __init__(self, config: SimulatorConfig):
        self.config = config
        self.metrics = SimulatorMetrics()
        self.db_pool: asyncpg.Pool | None = None

        # State
        self.current_tick = 0
        self.game_state = GameState()
        self.agent_trajectories: dict[str, list[AgentTickData]] = {}

        # Benchmark data (if applicable)
        self.benchmark_ticks: list[dict] = []
        self.ground_truth: dict = {}

    @classmethod
    def for_benchmark(cls, snapshot: dict) -> "FastSimulator":
        """Create simulator for benchmarking"""
        config = SimulatorConfig(
            mode="benchmark",
            benchmark_snapshot=snapshot,
            ground_truth=snapshot.get("groundTruth", {}),
            max_ticks=len(snapshot.get("ticks", [])),
        )

        sim = cls(config)
        sim.benchmark_ticks = snapshot.get("ticks", [])
        sim.ground_truth = snapshot.get("groundTruth", {})
        sim.game_state = cls._parse_initial_state(snapshot.get("initialState", {}))

        return sim

    @staticmethod
    def _parse_initial_state(state_dict: dict) -> GameState:
        """Parse initial state from snapshot"""
        return GameState(
            tick=0,
            time=state_dict.get("currentTime", int(time.time() * 1000)),
            markets=state_dict.get("predictionMarkets", []),
            perpetuals=state_dict.get("perpetualMarkets", []),
            news=state_dict.get("news", []),
            posts=state_dict.get("socialFeed", []),
        )

    async def initialize(self) -> None:
        """Initialize simulator"""
        if self.config.database_url and self.config.save_to_db:
            self.db_pool = await asyncpg.create_pool(
                self.config.database_url,
                min_size=2,
                max_size=10,
            )
            logger.info("Database connection pool created")

        self.metrics.start_time = time.time()
        self.current_tick = 0
        self.agent_trajectories = {}

        logger.info(
            f"Simulator initialized: mode={self.config.mode}, max_ticks={self.config.max_ticks}"
        )

    async def cleanup(self) -> None:
        """Clean up resources"""
        if self.db_pool:
            await self.db_pool.close()
            self.db_pool = None

    def is_complete(self) -> bool:
        """Check if simulation is complete"""
        if self.config.mode == "benchmark":
            return self.current_tick >= len(self.benchmark_ticks)
        return self.current_tick >= self.config.max_ticks

    def get_observation(self) -> dict:
        """Get current observation for agents"""
        return self.game_state.to_observation()

    def get_env_state(self, agent_id: str) -> EnvironmentState:
        """Get environment state for an agent"""
        return self.game_state.get_env_state(agent_id)

    async def run_tick(
        self,
        agent_runners: dict[str, AgentRunner],
    ) -> dict[str, AgentTickData]:
        """
        Run one simulation tick for all agents in parallel.

        This is the core fast path - uses asyncio.gather for true parallel execution.
        """
        # Get observation once (shared across agents)
        observation = self.get_observation()

        # Create coroutines for all agents
        agent_ids = list(agent_runners.keys())
        coros = []
        for agent_id in agent_ids:
            runner = agent_runners[agent_id]
            env_state = self.get_env_state(agent_id)
            coros.append(runner.run_tick(agent_id, observation, env_state))

        # Run ALL agents truly in parallel
        tick_results = await asyncio.gather(*coros, return_exceptions=True)

        # Process results
        results = {}
        current_time = int(time.time() * 1000)

        for agent_id, tick_data in zip(agent_ids, tick_results, strict=False):
            # Handle exceptions from individual agents
            if isinstance(tick_data, Exception):
                logger.error(f"Agent {agent_id} tick failed: {tick_data}")
                continue

            tick_data.tick_number = self.current_tick
            tick_data.timestamp = current_time
            results[agent_id] = tick_data

            # Track in trajectory
            if agent_id not in self.agent_trajectories:
                self.agent_trajectories[agent_id] = []
            self.agent_trajectories[agent_id].append(tick_data)

            # Update metrics
            self.metrics.total_llm_calls += len(tick_data.llm_calls)
            if tick_data.action:
                self.metrics.total_actions += 1

        # Apply actions to game state
        await self._apply_actions(results)

        # Update state for next tick
        self._advance_tick()

        # Track timing
        self.metrics.total_ticks += 1

        return results

    async def _apply_actions(self, tick_results: dict[str, AgentTickData]) -> None:
        """Apply agent actions to game state"""
        for agent_id, tick_data in tick_results.items():
            if not tick_data.action:
                continue

            action = tick_data.action
            portfolio = self.game_state.portfolios.get(
                agent_id,
                {
                    "balance": 10000.0,
                    "pnl": 0.0,
                    "positions": 0,
                },
            )

            # Process action (simplified)
            if action.action_type in ["buy", "buy_prediction", "open_perp"]:
                portfolio["positions"] += 1
                # Simulate some cost
                cost = action.parameters.get("amount", 100)
                portfolio["balance"] -= cost

            elif action.action_type in ["sell", "sell_prediction", "close_perp"]:
                portfolio["positions"] = max(0, portfolio["positions"] - 1)
                # Simulate some profit/loss
                pnl = action.parameters.get("pnl", 0)
                portfolio["pnl"] += pnl
                portfolio["balance"] += pnl

            self.game_state.portfolios[agent_id] = portfolio
            # Don't override agent's success flag - agent determines trade success

    def _advance_tick(self) -> None:
        """Advance to next tick"""
        self.current_tick += 1

        if self.config.mode == "benchmark" and self.current_tick < len(self.benchmark_ticks):
            # Load next tick's state from benchmark
            tick_data = self.benchmark_ticks[self.current_tick]
            state = tick_data.get("state", {})
            self.game_state.tick = self.current_tick
            self.game_state.time = state.get("currentTime", self.game_state.time + 1000)
            self.game_state.markets = state.get("predictionMarkets", self.game_state.markets)
            self.game_state.perpetuals = state.get("perpetualMarkets", self.game_state.perpetuals)
            self.game_state.news = state.get("news", self.game_state.news)
            self.game_state.posts = state.get("socialFeed", self.game_state.posts)
        else:
            # Increment time
            self.game_state.tick = self.current_tick
            self.game_state.time += 1000  # 1 second per tick

    async def run_benchmark(
        self,
        agent_runners: dict[str, AgentRunner],
        progress_callback: Callable[[int, int], None] | None = None,
    ) -> dict[str, RolloutResult]:
        """
        Run complete benchmark for all agents.

        Args:
            agent_runners: Dict of agent_id -> AgentRunner
            progress_callback: Optional callback (current_tick, total_ticks)

        Returns:
            Dict of agent_id -> RolloutResult
        """
        await self.initialize()

        self.metrics.total_agents = len(agent_runners)
        total_ticks = len(self.benchmark_ticks)

        logger.info(f"Starting benchmark: {len(agent_runners)} agents, {total_ticks} ticks")

        # Run through all ticks
        while not self.is_complete():
            await self.run_tick(agent_runners)

            if progress_callback and self.current_tick % 10 == 0:
                progress_callback(self.current_tick, total_ticks)

        # Calculate results
        results = {}
        for agent_id, ticks in self.agent_trajectories.items():
            result = self._calculate_benchmark_result(agent_id, ticks)
            results[agent_id] = result

        self.metrics.end_time = time.time()
        self.metrics.finalize()

        # Log summary
        logger.info(
            f"Benchmark complete: {self.metrics.total_ticks} ticks "
            f"at {self.metrics.ticks_per_second:.1f} ticks/s"
        )

        await self.cleanup()

        return results

    async def generate_data(
        self,
        agent_runners: dict[str, AgentRunner],
        num_ticks: int | None = None,
    ) -> list[BabylonTrajectory]:
        """
        Generate training data by running agents.

        Args:
            agent_runners: Dict of agent_id -> AgentRunner
            num_ticks: Number of ticks to run (default: config.max_ticks)

        Returns:
            List of trajectories
        """
        await self.initialize()

        self.metrics.total_agents = len(agent_runners)
        max_ticks = num_ticks or self.config.max_ticks

        logger.info(f"Starting data generation: {len(agent_runners)} agents, {max_ticks} ticks")

        # Run through ticks
        while self.current_tick < max_ticks:
            await self.run_tick(agent_runners)

            if self.current_tick % 100 == 0:
                logger.info(f"Progress: {self.current_tick}/{max_ticks} ticks")

        # Build trajectories
        trajectories = []
        for agent_id, ticks in self.agent_trajectories.items():
            trajectory_id = f"traj-{agent_id}-{int(time.time() * 1000)}"
            trajectory = build_trajectory_from_ticks(
                trajectory_id=trajectory_id,
                agent_id=agent_id,
                ticks=ticks,
                min_steps=self.config.min_actions_per_trajectory,
            )
            if trajectory:
                trajectories.append(trajectory)
                self.metrics.successful_trajectories += 1
            else:
                self.metrics.failed_trajectories += 1

        # Save to database if configured
        if self.config.save_to_db and self.db_pool:
            await self._save_trajectories(trajectories)

        self.metrics.end_time = time.time()
        self.metrics.finalize()

        logger.info(
            f"Data generation complete: {len(trajectories)} trajectories, "
            f"{self.metrics.ticks_per_second:.1f} ticks/s"
        )

        await self.cleanup()

        return trajectories

    def _calculate_benchmark_result(
        self,
        agent_id: str,
        ticks: list[AgentTickData],
    ) -> RolloutResult:
        """Calculate benchmark result for an agent"""
        if not ticks:
            return RolloutResult(
                agent_id=agent_id,
                trajectory_id=f"bench-{agent_id}",
                ticks_completed=0,
                total_duration_ms=0,
                avg_tick_duration_ms=0,
                total_llm_calls=0,
                total_reward=0,
                final_pnl=0,
                quality_score=0,
            )

        total_llm_calls = sum(len(t.llm_calls) for t in ticks)
        total_reward = sum(t.reward for t in ticks)
        final_pnl = ticks[-1].environment_state.agent_pnl

        # Calculate quality score
        quality_score = calculate_trajectory_quality_score(ticks)

        # Calculate accuracy against ground truth
        if self.ground_truth:
            self._evaluate_against_ground_truth(agent_id, ticks)

        duration = (ticks[-1].timestamp - ticks[0].timestamp) if len(ticks) > 1 else 0
        trajectory_id = f"bench-{agent_id}-{int(time.time())}"

        return RolloutResult(
            agent_id=agent_id,
            trajectory_id=trajectory_id,
            ticks_completed=len(ticks),
            total_duration_ms=duration,
            avg_tick_duration_ms=duration / len(ticks) if ticks else 0,
            total_llm_calls=total_llm_calls,
            total_reward=total_reward,
            final_pnl=final_pnl,
            quality_score=quality_score,
            trajectory=build_trajectory_from_ticks(
                trajectory_id=trajectory_id,
                agent_id=agent_id,
                ticks=ticks,
                min_steps=self.config.min_actions_per_trajectory,
            ),
        )

    def _evaluate_against_ground_truth(
        self,
        agent_id: str,
        ticks: list[AgentTickData],
    ) -> None:
        """Evaluate agent actions against ground truth"""
        market_outcomes = self.ground_truth.get("marketOutcomes", {})

        correct_predictions = 0
        total_predictions = 0

        for tick in ticks:
            if not tick.action:
                continue

            if tick.action.action_type == "buy_prediction":
                market_id = tick.action.parameters.get("marketId")
                predicted = tick.action.parameters.get("outcome") == "YES"

                if market_id in market_outcomes:
                    actual = market_outcomes[market_id]
                    if predicted == actual:
                        correct_predictions += 1
                    total_predictions += 1

        if total_predictions > 0:
            accuracy = correct_predictions / total_predictions
            self.metrics.avg_accuracy = (
                self.metrics.avg_accuracy * (self.metrics.total_agents - 1) + accuracy
            ) / self.metrics.total_agents

    async def _save_trajectories(self, trajectories: list[BabylonTrajectory]) -> None:
        """Save trajectories to database"""
        if not self.db_pool:
            return

        async with self.db_pool.acquire() as conn:
            for traj in trajectories:
                steps_json = json.dumps(
                    [
                        {
                            "stepNumber": s.step_number,
                            "timestamp": s.timestamp,
                            "environmentState": {
                                "agentBalance": s.environment_state.agent_balance,
                                "agentPnL": s.environment_state.agent_pnl,
                                "openPositions": s.environment_state.open_positions,
                            },
                            "llmCalls": [
                                {
                                    "model": c.model,
                                    "systemPrompt": c.system_prompt,
                                    "userPrompt": c.user_prompt,
                                    "response": c.response,
                                    "reasoning": c.reasoning,
                                    "temperature": c.temperature,
                                    "maxTokens": c.max_tokens,
                                    "purpose": c.purpose,
                                }
                                for c in s.llm_calls
                            ],
                            "action": {
                                "actionType": s.action.action_type,
                                "parameters": s.action.parameters,
                                "success": s.action.success,
                                "reasoning": s.action.reasoning,
                            },
                            "reward": s.reward,
                        }
                        for s in traj.steps
                    ]
                )

                await conn.execute(
                    """
                    INSERT INTO trajectories (
                        id, "trajectoryId", "agentId", "windowId",
                        "startTime", "endTime", "durationMs",
                        "stepsJson", "totalReward", "finalPnL", "finalBalance",
                        "tradesExecuted", "episodeLength", "finalStatus",
                        "isTrainingData", "createdAt", "updatedAt"
                    ) VALUES (
                        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17
                    )
                """,
                    traj.id,
                    traj.trajectory_id,
                    traj.agent_id,
                    traj.window_id,
                    traj.start_time,
                    traj.end_time,
                    traj.duration_ms,
                    steps_json,
                    traj.total_reward,
                    traj.final_pnl,
                    traj.final_balance,
                    traj.trades_executed,
                    traj.episode_length,
                    traj.final_status,
                    True,  # isTrainingData
                    datetime.now(timezone.utc),
                    datetime.now(timezone.utc),
                )

        logger.info(f"Saved {len(trajectories)} trajectories to database")

    def get_metrics(self) -> SimulatorMetrics:
        """Get current metrics"""
        return self.metrics

    def print_metrics(self) -> None:
        """Print metrics summary"""
        m = self.metrics
        print("\n" + "=" * 60)
        print("  SIMULATOR METRICS")
        print("=" * 60)
        print(f"  Mode: {self.config.mode}")
        print(f"  Total ticks: {m.total_ticks}")
        print(f"  Total agents: {m.total_agents}")
        print(f"  Ticks/second: {m.ticks_per_second:.1f}")
        print(f"  Avg tick duration: {m.avg_tick_duration_ms:.2f}ms")
        print(f"  Total LLM calls: {m.total_llm_calls}")
        print(f"  Total actions: {m.total_actions}")
        if m.successful_trajectories or m.failed_trajectories:
            print(f"  Successful trajectories: {m.successful_trajectories}")
            print(f"  Failed trajectories: {m.failed_trajectories}")
        if m.avg_accuracy > 0:
            print(f"  Average accuracy: {m.avg_accuracy:.2%}")
        print("=" * 60 + "\n")
