"""
Simulation Bridge Client

Python client for the TypeScript simulation bridge server.
Enables online training by calling TypeScript for scenarios and action execution.

Usage:
    async with SimulationBridge("http://localhost:3001") as bridge:
        await bridge.initialize(num_npcs=20, seed=12345)

        for npc_id in bridge.npc_ids:
            scenario = await bridge.get_scenario(npc_id)
            action = generate_action(scenario)
            outcome = await bridge.execute_action(npc_id, action)

        await bridge.tick()
"""

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any

import aiohttp

logger = logging.getLogger(__name__)


# =============================================================================
# Data Types
# =============================================================================


@dataclass
class PerpMarket:
    """Perpetual futures market data"""

    ticker: str
    current_price: float
    change_percent_24h: float
    volume_24h: float


@dataclass
class PredictionMarket:
    """Prediction market data"""

    id: str
    question: str
    yes_price: float
    no_price: float


@dataclass
class Position:
    """Agent's open position"""

    id: str
    market_type: str  # "perp" or "prediction"
    ticker: str | None = None
    market_id: str | None = None
    side: str = "long"
    size: float = 0.0
    unrealized_pnl: float = 0.0


@dataclass
class NewsItem:
    """Recent news or post"""

    content: str
    source: str
    timestamp: str
    sentiment: float | None = None


@dataclass
class Relationship:
    """Social relationship with another actor"""

    actor_id: str
    actor_name: str
    sentiment: float  # -1 to 1


@dataclass
class SocialContext:
    """Social context for agent"""

    relationships: list[Relationship] = field(default_factory=list)
    group_chats: list[str] = field(default_factory=list)
    recent_messages: list[dict[str, str]] = field(default_factory=list)


@dataclass
class MarketState:
    """Current market state"""

    perp_markets: list[PerpMarket] = field(default_factory=list)
    prediction_markets: list[PredictionMarket] = field(default_factory=list)


@dataclass
class Scenario:
    """Complete scenario for agent decision-making"""

    npc_id: str
    archetype: str
    market_state: MarketState
    positions: list[Position]
    balance: float
    recent_news: list[NewsItem]
    social_context: SocialContext

    def to_prompt_context(self) -> str:
        """Convert scenario to text context for LLM prompt"""
        lines = []

        lines.append(f"Agent ID: {self.npc_id}")
        lines.append(f"Archetype: {self.archetype}")
        lines.append(f"Balance: ${self.balance:,.2f}")
        lines.append("")

        lines.append("=== MARKETS ===")
        for m in self.market_state.perp_markets:
            sign = "+" if m.change_percent_24h >= 0 else ""
            lines.append(
                f"  {m.ticker}: ${m.current_price:.2f} ({sign}{m.change_percent_24h:.2f}%)"
            )

        if self.market_state.prediction_markets:
            lines.append("")
            lines.append("=== PREDICTIONS ===")
            for m in self.market_state.prediction_markets:
                lines.append(f"  [{m.id}] {m.question[:50]}...")
                lines.append(f"      YES: {m.yes_price:.0f}¢ | NO: {m.no_price:.0f}¢")

        if self.positions:
            lines.append("")
            lines.append("=== POSITIONS ===")
            for p in self.positions:
                symbol = p.ticker or f"Q{p.market_id}"
                pnl_sign = "+" if p.unrealized_pnl >= 0 else ""
                lines.append(
                    f"  {symbol} {p.side.upper()}: ${p.size:.2f} (PnL: {pnl_sign}${p.unrealized_pnl:.2f})"
                )

        if self.recent_news:
            lines.append("")
            lines.append("=== RECENT NEWS ===")
            for news in self.recent_news[:3]:
                lines.append(f"  [{news.source}]: {news.content[:80]}...")

        return "\n".join(lines)


@dataclass
class ActionOutcome:
    """Result of executing an action"""

    success: bool
    pnl: float
    new_balance: float
    new_positions: list[Position]
    social_impact: dict[str, int]
    events: list[dict[str, str]]
    error: str | None = None


@dataclass
class TickResult:
    """Result of advancing simulation"""

    tick_number: int
    events: list[dict[str, Any]]
    market_changes: list[dict[str, Any]]


# =============================================================================
# Client Implementation
# =============================================================================


class SimulationBridge:
    """
    Client for TypeScript simulation bridge.

    Provides async methods for interacting with the simulation:
    - initialize(): Start a new simulation
    - get_scenario(): Get current scenario for an NPC
    - execute_action(): Execute an action and get outcome
    - tick(): Advance simulation by one tick
    - reset(): Reset simulation state
    - poll_trajectories(): Poll new trajectory records from the bridge
    """

    def __init__(
        self,
        base_url: str = "http://localhost:3001",
        timeout: float = 30.0,
        max_retries: int = 3,
        auth_token: str | None = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.max_retries = max_retries
        self.auth_token = auth_token
        self._session: aiohttp.ClientSession | None = None
        self._npc_ids: list[str] = []
        self._archetypes: dict[str, str] = {}
        self._initialized: bool = False
        self._last_trajectory_id: str = ""
        self._server_epoch: str = ""
        self._trajectory_lock = asyncio.Lock()

    @property
    def is_initialized(self) -> bool:
        return self._initialized

    @property
    def npc_ids(self) -> list[str]:
        return self._npc_ids.copy()

    @property
    def archetypes(self) -> dict[str, str]:
        return self._archetypes.copy()

    async def __aenter__(self) -> "SimulationBridge":
        self._session = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=self.timeout),
            headers=self._auth_headers(),
        )
        return self

    async def __aexit__(self, *args) -> None:
        if self._session:
            await self._session.close()
            self._session = None

    def _auth_headers(self) -> dict[str, str]:
        """Build auth headers if token is configured."""
        if self.auth_token:
            return {"Authorization": f"Bearer {self.auth_token}"}
        return {}

    async def _ensure_session(self) -> aiohttp.ClientSession:
        if not self._session:
            self._session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=self.timeout),
                headers=self._auth_headers(),
            )
        return self._session

    async def _recreate_session(self) -> None:
        if self._session:
            try:
                await self._session.close()
            except Exception:
                pass
            self._session = None
        self._session = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=self.timeout),
            headers=self._auth_headers(),
        )

    async def _request(
        self,
        method: str,
        path: str,
        json_data: dict | None = None,
    ) -> dict[str, Any]:
        """Make HTTP request with retry logic.

        Retries on 5xx and network errors. Fails immediately on 4xx (client errors).
        """
        session = await self._ensure_session()
        url = f"{self.base_url}{path}"
        last_error: Exception | None = None

        for attempt in range(self.max_retries):
            try:
                if method == "GET":
                    async with session.get(url) as resp:
                        if resp.status == 200:
                            return await resp.json()
                        error_body = await resp.text()
                        if 400 <= resp.status < 500:
                            # Client error — don't retry
                            raise RuntimeError(f"HTTP {resp.status}: {error_body}")
                        # 5xx — retry
                        raise aiohttp.ClientResponseError(
                            resp.request_info, resp.history,
                            status=resp.status, message=error_body,
                        )
                else:
                    async with session.post(url, json=json_data or {}) as resp:
                        if resp.status == 200:
                            return await resp.json()
                        error_body = await resp.text()
                        if 400 <= resp.status < 500:
                            raise RuntimeError(f"HTTP {resp.status}: {error_body}")
                        raise aiohttp.ClientResponseError(
                            resp.request_info, resp.history,
                            status=resp.status, message=error_body,
                        )
            except asyncio.TimeoutError as e:
                last_error = e
                logger.warning(f"Request timeout (attempt {attempt + 1}/{self.max_retries})")
            except aiohttp.ClientError as e:
                last_error = e
                logger.warning(f"Client error (attempt {attempt + 1}/{self.max_retries}): {e}")
                if "Connector is closed" in str(e):
                    await self._recreate_session()
                    session = self._session  # type: ignore[assignment]

            await asyncio.sleep(min(0.5 * 2**attempt, 5.0))  # exponential backoff, max 5s

        raise RuntimeError(f"Request failed after {self.max_retries} attempts: {last_error}")

    async def health_check(self) -> dict[str, Any]:
        """Check server health"""
        return await self._request("GET", "/health")

    async def initialize(
        self,
        num_npcs: int = 20,
        seed: int | None = None,
        archetypes: list[str] | None = None,
    ) -> dict[str, Any]:
        """
        Initialize a new simulation.

        Args:
            num_npcs: Number of NPCs to create
            seed: Random seed for reproducibility
            archetypes: List of archetypes to assign to NPCs

        Returns:
            Initialization result with NPC IDs and archetypes
        """
        request_data = {
            "numNPCs": num_npcs,
            "seed": seed or int(time.time()),
        }

        if archetypes:
            request_data["archetypes"] = archetypes

        result = await self._request("POST", "/init", request_data)

        if result.get("status") == "initialized":
            self._npc_ids = result.get("npcIds", [])
            self._archetypes = result.get("archetypes", {})
            self._initialized = True
            logger.info(f"Simulation initialized with {len(self._npc_ids)} NPCs")
        else:
            raise RuntimeError(f"Initialization failed: {result.get('message', 'Unknown error')}")

        return result

    async def get_scenario(self, npc_id: str) -> Scenario:
        """
        Get current scenario for an NPC.

        Args:
            npc_id: NPC identifier

        Returns:
            Complete scenario with market state, positions, etc.
        """
        data = await self._request("GET", f"/scenario/{npc_id}")

        # Parse market state
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
                    question=m.get("question") or m.get("title", "Unknown"),
                    yes_price=m["yesPrice"],
                    no_price=m["noPrice"],
                )
                for m in data.get("marketState", {}).get("predictionMarkets", [])
            ],
        )

        # Parse positions
        positions = [
            Position(
                id=p["id"],
                market_type=p["marketType"],
                ticker=p.get("ticker"),
                market_id=p.get("marketId"),
                side=p["side"],
                size=p["size"],
                unrealized_pnl=p.get("unrealizedPnL", 0),
            )
            for p in data.get("positions", [])
        ]

        # Parse news
        recent_news = [
            NewsItem(
                content=n["content"],
                source=n["source"],
                timestamp=n["timestamp"],
                sentiment=n.get("sentiment"),
            )
            for n in data.get("recentNews", [])
        ]

        # Parse social context
        social_data = data.get("socialContext", {})
        social_context = SocialContext(
            relationships=[
                Relationship(
                    actor_id=r["actorId"],
                    actor_name=r["actorName"],
                    sentiment=r["sentiment"],
                )
                for r in social_data.get("relationships", [])
            ],
            group_chats=social_data.get("groupChats", []),
            recent_messages=social_data.get("recentMessages", []),
        )

        return Scenario(
            npc_id=data["npcId"],
            archetype=data["archetype"],
            market_state=market_state,
            positions=positions,
            balance=data["balance"],
            recent_news=recent_news,
            social_context=social_context,
        )

    async def execute_action(
        self,
        npc_id: str,
        action_type: str,
        ticker: str | None = None,
        market_id: str | None = None,
        amount: float | None = None,
        side: str | None = None,
        position_id: str | None = None,
        reasoning: str | None = None,
    ) -> ActionOutcome:
        """
        Execute an action for an NPC.

        Args:
            npc_id: NPC identifier
            action_type: Type of action (open_long, open_short, buy_yes, etc.)
            ticker: Ticker for perp trades
            market_id: Market ID for prediction trades
            amount: Trade amount
            side: Trade side (long/short or yes/no)
            position_id: Position ID for closing
            reasoning: Reasoning for the action (for logging)

        Returns:
            Action outcome with PnL, new balance, etc.
        """
        request_data = {
            "npcId": npc_id,
            "action": {
                "type": action_type,
            },
        }

        if ticker:
            request_data["action"]["ticker"] = ticker
        if market_id:
            request_data["action"]["marketId"] = market_id
        if amount is not None:
            request_data["action"]["amount"] = amount
        if side:
            request_data["action"]["side"] = side
        if position_id:
            request_data["action"]["positionId"] = position_id
        if reasoning:
            request_data["reasoning"] = reasoning

        data = await self._request("POST", "/execute", request_data)

        # Parse positions
        new_positions = [
            Position(
                id=p["id"],
                market_type=p["marketType"],
                ticker=p.get("ticker"),
                market_id=p.get("marketId"),
                side=p["side"],
                size=p["size"],
            )
            for p in data.get("newPositions", [])
        ]

        return ActionOutcome(
            success=data["success"],
            pnl=data["pnl"],
            new_balance=data["newBalance"],
            new_positions=new_positions,
            social_impact=data.get("socialImpact", {}),
            events=data.get("events", []),
            error=data.get("error"),
        )

    async def tick(self) -> TickResult:
        """
        Advance simulation by one tick.

        Returns:
            Tick result with events and market changes
        """
        data = await self._request("POST", "/tick")

        return TickResult(
            tick_number=data["tickNumber"],
            events=data.get("events", []),
            market_changes=data.get("marketChanges", []),
        )

    async def reset(self) -> None:
        """Reset simulation state"""
        await self._request("POST", "/reset")
        self._npc_ids = []
        self._archetypes = {}
        self._initialized = False
        logger.info("Simulation reset")

    async def list_npcs(self) -> list[dict[str, str]]:
        """Get list of all NPCs with their archetypes"""
        data = await self._request("GET", "/npcs")
        return data.get("npcs", [])

    async def get_all_scenarios(self) -> list[Scenario]:
        """Get scenarios for all NPCs (batch mode)"""
        data = await self._request("GET", "/scenarios")

        scenarios = []
        for scenario_data in data.get("scenarios", []):
            npc_id = scenario_data["npcId"]
            scenario = await self.get_scenario(npc_id)
            scenarios.append(scenario)

        return scenarios

    # ── Trajectory Streaming ──────────────────────────────────────────

    async def poll_trajectories(self, limit: int = 100) -> list[dict[str, Any]]:
        """
        Poll new trajectory records since last call.

        Returns list of trajectory records. Automatically tracks the last
        seen ID so subsequent calls only return new records.
        Thread-safe via asyncio.Lock. Detects server restarts via epoch.
        """
        async with self._trajectory_lock:
            params = f"?limit={limit}"
            if self._last_trajectory_id:
                params += f"&since_id={self._last_trajectory_id}"
            data = await self._request("GET", f"/trajectories{params}")

            # Detect server restart — reset cursor if epoch changed
            epoch = data.get("serverEpoch", "")
            if epoch and self._server_epoch and epoch != self._server_epoch:
                logger.warning(
                    f"Server restarted (epoch {self._server_epoch} → {epoch}), "
                    f"resetting trajectory cursor"
                )
                self._last_trajectory_id = ""
                # Re-fetch from beginning
                data = await self._request("GET", f"/trajectories?limit={limit}")
            if epoch:
                self._server_epoch = epoch

            records = data.get("trajectories", [])
            if records:
                self._last_trajectory_id = data.get("lastId", self._last_trajectory_id)
            return records

    async def trajectory_stats(self) -> dict[str, Any]:
        """Get trajectory buffer statistics."""
        return await self._request("GET", "/trajectories/stats")


# =============================================================================
# Convenience Functions
# =============================================================================


async def create_bridge(
    base_url: str = "http://localhost:3001",
    num_npcs: int = 20,
    seed: int | None = None,
    archetypes: list[str] | None = None,
    auth_token: str | None = None,
) -> SimulationBridge:
    """
    Create and initialize a simulation bridge.

    Convenience function for quick setup.
    """
    bridge = SimulationBridge(base_url, auth_token=auth_token)
    await bridge.__aenter__()
    await bridge.initialize(num_npcs=num_npcs, seed=seed, archetypes=archetypes)
    return bridge
