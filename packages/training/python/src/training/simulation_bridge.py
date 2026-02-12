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
from typing import Any, Dict, List, Optional

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
    ticker: Optional[str] = None
    market_id: Optional[str] = None
    side: str = "long"
    size: float = 0.0
    unrealized_pnl: float = 0.0


@dataclass
class NewsItem:
    """Recent news or post"""
    content: str
    source: str
    timestamp: str
    sentiment: Optional[float] = None


@dataclass
class Relationship:
    """Social relationship with another actor"""
    actor_id: str
    actor_name: str
    sentiment: float  # -1 to 1


@dataclass
class SocialContext:
    """Social context for agent"""
    relationships: List[Relationship] = field(default_factory=list)
    group_chats: List[str] = field(default_factory=list)
    recent_messages: List[Dict[str, str]] = field(default_factory=list)


@dataclass
class MarketState:
    """Current market state"""
    perp_markets: List[PerpMarket] = field(default_factory=list)
    prediction_markets: List[PredictionMarket] = field(default_factory=list)


@dataclass
class Scenario:
    """Complete scenario for agent decision-making"""
    npc_id: str
    archetype: str
    market_state: MarketState
    positions: List[Position]
    balance: float
    recent_news: List[NewsItem]
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
    new_positions: List[Position]
    social_impact: Dict[str, int]
    events: List[Dict[str, str]]
    error: Optional[str] = None


@dataclass
class TickResult:
    """Result of advancing simulation"""
    tick_number: int
    events: List[Dict[str, Any]]
    market_changes: List[Dict[str, Any]]


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
    """
    
    def __init__(
        self,
        base_url: str = "http://localhost:3001",
        timeout: float = 30.0,
        max_retries: int = 3,
    ):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.max_retries = max_retries
        self._session: Optional[aiohttp.ClientSession] = None
        self._npc_ids: List[str] = []
        self._archetypes: Dict[str, str] = {}
        self._initialized: bool = False
    
    @property
    def is_initialized(self) -> bool:
        return self._initialized
    
    @property
    def npc_ids(self) -> List[str]:
        return self._npc_ids.copy()
    
    @property
    def archetypes(self) -> Dict[str, str]:
        return self._archetypes.copy()
    
    async def __aenter__(self) -> "SimulationBridge":
        self._session = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=self.timeout)
        )
        return self
    
    async def __aexit__(self, *args) -> None:
        if self._session:
            await self._session.close()
            self._session = None
    
    async def _request(
        self,
        method: str,
        path: str,
        json_data: Optional[Dict] = None,
    ) -> Dict[str, Any]:
        """Make HTTP request with retry logic"""
        if not self._session:
            self._session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=self.timeout)
            )
        
        url = f"{self.base_url}{path}"
        last_error: Optional[Exception] = None
        
        for attempt in range(self.max_retries):
            try:
                if method == "GET":
                    async with self._session.get(url) as resp:
                        if resp.status != 200:
                            error_body = await resp.text()
                            raise RuntimeError(f"HTTP {resp.status}: {error_body}")
                        return await resp.json()
                else:  # POST
                    async with self._session.post(url, json=json_data or {}) as resp:
                        if resp.status != 200:
                            error_body = await resp.text()
                            raise RuntimeError(f"HTTP {resp.status}: {error_body}")
                        return await resp.json()
            except asyncio.TimeoutError as e:
                last_error = e
                logger.warning(f"Request timeout (attempt {attempt + 1}/{self.max_retries})")
                await asyncio.sleep(0.5 * (attempt + 1))
            except aiohttp.ClientError as e:
                last_error = e
                logger.warning(f"Client error (attempt {attempt + 1}/{self.max_retries}): {e}")
                # Recreate session if connector is closed
                if "Connector is closed" in str(e):
                    if self._session:
                        try:
                            await self._session.close()
                        except Exception:
                            pass
                        self._session = None
                    self._session = aiohttp.ClientSession(
                        timeout=aiohttp.ClientTimeout(total=self.timeout)
                    )
                await asyncio.sleep(0.5 * (attempt + 1))
        
        raise RuntimeError(f"Request failed after {self.max_retries} attempts: {last_error}")
    
    async def health_check(self) -> Dict[str, Any]:
        """Check server health"""
        return await self._request("GET", "/health")
    
    async def initialize(
        self,
        num_npcs: int = 20,
        seed: Optional[int] = None,
        archetypes: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
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
        ticker: Optional[str] = None,
        market_id: Optional[str] = None,
        amount: Optional[float] = None,
        side: Optional[str] = None,
        position_id: Optional[str] = None,
        reasoning: Optional[str] = None,
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
    
    async def list_npcs(self) -> List[Dict[str, str]]:
        """Get list of all NPCs with their archetypes"""
        data = await self._request("GET", "/npcs")
        return data.get("npcs", [])
    
    async def get_all_scenarios(self) -> List[Scenario]:
        """Get scenarios for all NPCs (batch mode)"""
        data = await self._request("GET", "/scenarios")
        
        scenarios = []
        for scenario_data in data.get("scenarios", []):
            # Re-parse each scenario
            npc_id = scenario_data["npcId"]
            scenario = await self.get_scenario(npc_id)
            scenarios.append(scenario)
        
        return scenarios


# =============================================================================
# Convenience Functions
# =============================================================================


async def create_bridge(
    base_url: str = "http://localhost:3001",
    num_npcs: int = 20,
    seed: Optional[int] = None,
    archetypes: Optional[List[str]] = None,
) -> SimulationBridge:
    """
    Create and initialize a simulation bridge.
    
    Convenience function for quick setup.
    """
    bridge = SimulationBridge(base_url)
    await bridge.__aenter__()
    await bridge.initialize(num_npcs=num_npcs, seed=seed, archetypes=archetypes)
    return bridge


