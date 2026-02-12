"""
Action Executor for GRPO Training

Executes parsed actions against a simulated game state and calculates
resulting P&L for reward computation.

This is a lightweight executor for training that:
1. Takes parsed action JSON from model responses
2. Validates action parameters
3. Simulates execution against market state
4. Calculates simulated P&L based on scenario outcomes

The executor does NOT interact with real markets - it simulates outcomes
based on scenario data for training purposes.
"""

import logging
import random
from dataclasses import dataclass, field
from typing import Dict, List, Literal, Optional, Tuple

from .scenario_pool import Scenario, MarketState, PerpetualState

logger = logging.getLogger(__name__)

# Module-level RNG for reproducibility in testing
_rng: Optional[random.Random] = None


def set_simulation_seed(seed: int) -> None:
    """Set seed for deterministic P&L simulation. Useful for testing."""
    global _rng
    _rng = random.Random(seed)
    logger.debug(f"Action executor RNG seeded with {seed}")


def reset_simulation_rng() -> None:
    """Reset to non-deterministic mode (uses global random)."""
    global _rng
    _rng = None


def _gauss(mu: float, sigma: float) -> float:
    """Get gaussian random value, using seeded RNG if set."""
    if _rng is not None:
        return _rng.gauss(mu, sigma)
    return random.gauss(mu, sigma)


def _uniform(a: float, b: float) -> float:
    """Get uniform random value, using seeded RNG if set."""
    if _rng is not None:
        return _rng.uniform(a, b)
    return random.uniform(a, b)


# =============================================================================
# Execution Result
# =============================================================================


@dataclass
class ActionResult:
    """Result of executing an action"""
    success: bool
    action_type: str
    pnl: float = 0.0
    cost: float = 0.0
    message: str = ""
    
    # Trade details
    market_id: Optional[str] = None
    ticker: Optional[str] = None
    size: float = 0.0
    side: Optional[str] = None
    entry_price: float = 0.0
    
    # Portfolio after execution
    new_balance: float = 0.0
    new_positions: int = 0


@dataclass
class PortfolioState:
    """Current portfolio state"""
    balance: float = 10000.0
    pnl: float = 0.0
    positions: Dict[str, Dict] = field(default_factory=dict)
    trade_count: int = 0
    
    @property
    def position_count(self) -> int:
        return len(self.positions)


# =============================================================================
# Action Validation
# =============================================================================


def validate_action(action: Dict) -> Tuple[bool, str]:
    """
    Validate action parameters.
    
    Returns:
        (is_valid, error_message)
    """
    action_type = action.get("action")
    
    if not action_type:
        return False, "Missing 'action' field"
    
    valid_actions = {"buy", "sell", "open_perp", "close_perp", "wait"}
    if action_type not in valid_actions:
        return False, f"Invalid action type: {action_type}"
    
    if action_type == "wait":
        return True, ""
    
    # Validate trading actions
    if action_type in ("buy", "sell"):
        if "market" not in action:
            return False, "Buy/sell requires 'market' field"
        if "amount" not in action:
            return False, "Buy/sell requires 'amount' field"
        amount = action.get("amount")
        if not isinstance(amount, (int, float)) or amount <= 0:
            return False, f"Invalid amount: {amount}"
    
    if action_type in ("open_perp", "close_perp"):
        if "ticker" not in action:
            return False, "Perp trade requires 'ticker' field"
        if "size" not in action:
            return False, "Perp trade requires 'size' field"
        size = action.get("size")
        if not isinstance(size, (int, float)) or size <= 0:
            return False, f"Invalid size: {size}"
        
        if action_type == "open_perp":
            if "direction" not in action:
                return False, "open_perp requires 'direction' field"
            direction = action.get("direction")
            if direction not in ("long", "short"):
                return False, f"Invalid direction: {direction}"
    
    return True, ""


# =============================================================================
# Outcome Simulation
# =============================================================================


def simulate_market_outcome(
    market: MarketState,
    side: str,
    amount: float,
    hold_duration: Literal["short", "medium", "long"] = "short",
) -> Tuple[float, str]:
    """
    Simulate outcome for a prediction market trade.
    
    Uses market state to probabilistically determine outcome.
    
    Args:
        market: The market being traded
        side: "yes" or "no"
        amount: Trade size
        hold_duration: How long the position is held
    
    Returns:
        (pnl, outcome_description)
    """
    # Get current price
    entry_price = market.yes_price if side == "yes" else market.no_price
    
    # Simulate price movement based on market state
    # Higher volume = more stable, lower volume = more volatile
    volatility = 0.1 * (1 + 1 / (1 + market.volume_24h / 100000))
    
    # Duration affects expected return
    duration_multiplier = {"short": 0.5, "medium": 1.0, "long": 2.0}.get(hold_duration, 1.0)
    
    # Random price movement with slight mean reversion
    mean_reversion = (0.5 - entry_price) * 0.1  # Pull towards 50%
    drift = _gauss(mean_reversion, volatility * duration_multiplier)
    
    # Calculate new price (bounded 0-1)
    new_price = max(0.01, min(0.99, entry_price + drift))
    
    # Calculate P&L
    if side == "yes":
        pnl = (new_price - entry_price) * amount
    else:
        pnl = (entry_price - new_price) * amount
    
    # Apply transaction cost
    cost = amount * 0.002  # 0.2% fee
    pnl -= cost
    
    # Generate description
    price_change = (new_price - entry_price) / entry_price * 100
    direction = "up" if price_change > 0 else "down"
    outcome = f"Market moved {direction} {abs(price_change):.1f}%, P&L: ${pnl:.2f}"
    
    return round(pnl, 2), outcome


def simulate_perp_outcome(
    perp: PerpetualState,
    direction: str,
    size: float,
    hold_duration: Literal["short", "medium", "long"] = "short",
) -> Tuple[float, str]:
    """
    Simulate outcome for a perpetual trade.
    
    Uses current price and volatility to simulate outcome.
    
    Args:
        perp: The perpetual market
        direction: "long" or "short"
        size: Position size in units
        hold_duration: How long the position is held
    
    Returns:
        (pnl, outcome_description)
    """
    entry_price = perp.mark_price
    
    # Use 24h change as volatility indicator
    volatility = abs(perp.change_24h) * 2 + 0.02  # Minimum 2% volatility
    
    # Duration affects expected return
    duration_multiplier = {"short": 0.3, "medium": 1.0, "long": 2.5}.get(hold_duration, 1.0)
    
    # Funding rate impact
    funding_impact = -perp.funding_rate * size * entry_price * duration_multiplier
    
    # Random price movement
    price_change_pct = _gauss(0, volatility * duration_multiplier)
    new_price = entry_price * (1 + price_change_pct)
    
    # Calculate P&L based on direction
    if direction == "long":
        pnl = (new_price - entry_price) * size
    else:
        pnl = (entry_price - new_price) * size
    
    # Add funding impact
    pnl += funding_impact
    
    # Apply transaction cost
    cost = abs(size) * entry_price * 0.001  # 0.1% fee
    pnl -= cost
    
    # Generate description
    direction_str = "up" if price_change_pct > 0 else "down"
    outcome = f"{perp.ticker} moved {direction_str} {abs(price_change_pct * 100):.1f}%, P&L: ${pnl:.2f}"
    
    return round(pnl, 2), outcome


# =============================================================================
# Action Executor
# =============================================================================


class ActionExecutor:
    """
    Executes actions against simulated game state.
    
    For training, this simulates action outcomes based on scenario data.
    Does not interact with real markets.
    """
    
    def __init__(
        self,
        scenario: Scenario,
        starting_balance: float = 10000.0,
        max_positions: int = 10,
        max_position_size: float = 1000.0,
    ):
        self.scenario = scenario
        self.max_positions = max_positions
        self.max_position_size = max_position_size
        
        # Initialize portfolio
        starting = scenario.portfolio.balance if scenario.portfolio else starting_balance
        self.portfolio = PortfolioState(balance=starting)
        
        # Build market lookups
        self.markets: Dict[str, MarketState] = {}
        for market in scenario.markets:
            self.markets[market.market_id] = market
        
        self.perpetuals: Dict[str, PerpetualState] = {}
        for perp in scenario.perpetuals:
            self.perpetuals[perp.ticker] = perp
    
    def execute(self, action: Dict) -> ActionResult:
        """
        Execute an action and return the result.
        
        Args:
            action: Parsed action dictionary
        
        Returns:
            ActionResult with success status and P&L
        """
        # Validate action
        is_valid, error = validate_action(action)
        if not is_valid:
            return ActionResult(
                success=False,
                action_type=action.get("action", "unknown"),
                message=f"Invalid action: {error}",
            )
        
        action_type = action["action"]
        
        if action_type == "wait":
            return ActionResult(
                success=True,
                action_type="wait",
                message="Waiting for better opportunity",
                new_balance=self.portfolio.balance,
                new_positions=self.portfolio.position_count,
            )
        
        if action_type == "buy":
            return self._execute_prediction_buy(action)
        
        if action_type == "sell":
            return self._execute_prediction_sell(action)
        
        if action_type == "open_perp":
            return self._execute_perp_open(action)
        
        if action_type == "close_perp":
            return self._execute_perp_close(action)
        
        return ActionResult(
            success=False,
            action_type=action_type,
            message=f"Unhandled action type: {action_type}",
        )
    
    def _execute_prediction_buy(self, action: Dict) -> ActionResult:
        """Execute prediction market buy"""
        market_id = action["market"]
        amount = min(action["amount"], self.max_position_size)
        side = action.get("side", "yes")
        
        # Find market
        market = self.markets.get(market_id)
        if not market:
            # Try to find by partial match
            for mid, m in self.markets.items():
                if market_id in mid or mid in market_id:
                    market = m
                    market_id = mid
                    break
        
        if not market:
            return ActionResult(
                success=False,
                action_type="buy",
                message=f"Market not found: {market_id}",
            )
        
        # Check balance
        cost = amount
        if self.portfolio.balance < cost:
            return ActionResult(
                success=False,
                action_type="buy",
                message=f"Insufficient balance: ${self.portfolio.balance:.2f} < ${cost:.2f}",
            )
        
        # Check position limit
        if self.portfolio.position_count >= self.max_positions:
            return ActionResult(
                success=False,
                action_type="buy",
                message=f"Position limit reached: {self.max_positions}",
            )
        
        # Simulate outcome
        pnl, outcome_msg = simulate_market_outcome(market, side, amount)
        
        # Update portfolio
        self.portfolio.balance -= cost
        self.portfolio.balance += cost + pnl  # Return principal + P&L
        self.portfolio.pnl += pnl
        self.portfolio.trade_count += 1
        
        # Track position
        position_id = f"pred-{market_id}-{side}"
        self.portfolio.positions[position_id] = {
            "type": "prediction",
            "market_id": market_id,
            "side": side,
            "amount": amount,
            "entry_price": market.yes_price if side == "yes" else market.no_price,
            "pnl": pnl,
        }
        
        return ActionResult(
            success=True,
            action_type="buy",
            pnl=pnl,
            cost=cost,
            message=outcome_msg,
            market_id=market_id,
            side=side,
            size=amount,
            entry_price=market.yes_price if side == "yes" else market.no_price,
            new_balance=self.portfolio.balance,
            new_positions=self.portfolio.position_count,
        )
    
    def _execute_prediction_sell(self, action: Dict) -> ActionResult:
        """Execute prediction market sell"""
        market_id = action["market"]
        amount = action["amount"]
        side = action.get("side", "yes")
        
        # Find existing position
        position_id = f"pred-{market_id}-{side}"
        position = self.portfolio.positions.get(position_id)
        
        if not position:
            return ActionResult(
                success=False,
                action_type="sell",
                message=f"No position found for {market_id} {side}",
            )
        
        # Close position
        pnl = position.get("pnl", 0)
        del self.portfolio.positions[position_id]
        self.portfolio.trade_count += 1
        
        return ActionResult(
            success=True,
            action_type="sell",
            pnl=0,  # P&L was already realized on buy
            message=f"Closed position in {market_id}",
            market_id=market_id,
            side=side,
            new_balance=self.portfolio.balance,
            new_positions=self.portfolio.position_count,
        )
    
    def _execute_perp_open(self, action: Dict) -> ActionResult:
        """Execute perpetual position open"""
        ticker = action["ticker"]
        size = min(action["size"], self.max_position_size)
        direction = action["direction"]
        
        # Find perpetual market
        perp = self.perpetuals.get(ticker)
        if not perp:
            # Try uppercase
            perp = self.perpetuals.get(ticker.upper())
            if perp:
                ticker = ticker.upper()
        
        if not perp:
            return ActionResult(
                success=False,
                action_type="open_perp",
                message=f"Perpetual not found: {ticker}",
            )
        
        # Check margin
        margin_required = size * perp.mark_price * 0.1  # 10x leverage
        if self.portfolio.balance < margin_required:
            return ActionResult(
                success=False,
                action_type="open_perp",
                message=f"Insufficient margin: need ${margin_required:.2f}",
            )
        
        # Check position limit
        if self.portfolio.position_count >= self.max_positions:
            return ActionResult(
                success=False,
                action_type="open_perp",
                message=f"Position limit reached: {self.max_positions}",
            )
        
        # Simulate outcome
        pnl, outcome_msg = simulate_perp_outcome(perp, direction, size)
        
        # Update portfolio
        self.portfolio.balance += pnl
        self.portfolio.pnl += pnl
        self.portfolio.trade_count += 1
        
        # Track position
        position_id = f"perp-{ticker}-{direction}"
        self.portfolio.positions[position_id] = {
            "type": "perpetual",
            "ticker": ticker,
            "direction": direction,
            "size": size,
            "entry_price": perp.mark_price,
            "pnl": pnl,
        }
        
        return ActionResult(
            success=True,
            action_type="open_perp",
            pnl=pnl,
            cost=margin_required,
            message=outcome_msg,
            ticker=ticker,
            side=direction,
            size=size,
            entry_price=perp.mark_price,
            new_balance=self.portfolio.balance,
            new_positions=self.portfolio.position_count,
        )
    
    def _execute_perp_close(self, action: Dict) -> ActionResult:
        """Execute perpetual position close"""
        ticker = action["ticker"]
        size = action["size"]
        
        # Find existing position
        position_id_long = f"perp-{ticker}-long"
        position_id_short = f"perp-{ticker}-short"
        
        position_id = None
        if position_id_long in self.portfolio.positions:
            position_id = position_id_long
        elif position_id_short in self.portfolio.positions:
            position_id = position_id_short
        
        if not position_id:
            return ActionResult(
                success=False,
                action_type="close_perp",
                message=f"No position found for {ticker}",
            )
        
        position = self.portfolio.positions[position_id]
        pnl = position.get("pnl", 0)
        
        # Close position
        del self.portfolio.positions[position_id]
        self.portfolio.trade_count += 1
        
        return ActionResult(
            success=True,
            action_type="close_perp",
            pnl=0,  # P&L was realized on open
            message=f"Closed {ticker} position",
            ticker=ticker,
            new_balance=self.portfolio.balance,
            new_positions=self.portfolio.position_count,
        )
    
    def get_portfolio_summary(self) -> Dict:
        """Get current portfolio summary"""
        return {
            "balance": self.portfolio.balance,
            "pnl": self.portfolio.pnl,
            "position_count": self.portfolio.position_count,
            "trade_count": self.portfolio.trade_count,
            "positions": list(self.portfolio.positions.keys()),
        }
    
    def get_total_pnl(self) -> float:
        """Get total realized P&L"""
        return self.portfolio.pnl


def execute_action_for_training(
    action: Dict,
    scenario: Scenario,
) -> ActionResult:
    """
    Convenience function to execute a single action for training scoring.
    
    Creates a fresh executor and runs the action.
    """
    executor = ActionExecutor(scenario)
    return executor.execute(action)


def calculate_action_quality_bonus(result: ActionResult) -> float:
    """
    Calculate quality bonus based on action execution.
    
    Used in reward calculation to encourage:
    - Valid action formatting
    - Profitable trades
    - Risk-appropriate sizing
    """
    bonus = 0.0
    
    if result.success:
        bonus += 0.1  # Base bonus for valid action
        
        # P&L based bonus
        if result.pnl > 0:
            bonus += min(0.2, result.pnl / 1000)  # Up to 0.2 for profit
        elif result.pnl < -100:
            bonus -= 0.1  # Penalty for large losses
        
        # Bonus for trading (not just waiting)
        if result.action_type not in ["wait"]:
            bonus += 0.05
    else:
        bonus -= 0.1  # Penalty for failed actions
    
    return max(-0.3, min(0.3, bonus))

