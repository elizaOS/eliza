"""
Tests for Action Executor

Tests cover:
- Action validation
- Prediction market execution
- Perpetual execution
- Portfolio management
- P&L calculation
"""

import pytest

from src.training.action_executor import (
    ActionResult,
    PortfolioState,
    ActionExecutor,
    validate_action,
    simulate_market_outcome,
    simulate_perp_outcome,
    execute_action_for_training,
    calculate_action_quality_bonus,
)
from src.training.scenario_pool import (
    Scenario,
    MarketState,
    PerpetualState,
    PortfolioState as ScenarioPortfolio,
)


# =============================================================================
# Test Fixtures
# =============================================================================


def create_test_scenario() -> Scenario:
    """Create a test scenario with markets and perpetuals"""
    return Scenario(
        id="test-scenario",
        source="synthetic",
        markets=[
            MarketState(
                market_id="btc-100k",
                question="Will BTC hit $100K?",
                yes_price=0.65,
                no_price=0.35,
                volume_24h=500000.0,
                liquidity=1000000.0,
                expires_at=1735689600000,
            ),
            MarketState(
                market_id="eth-5k",
                question="Will ETH hit $5K?",
                yes_price=0.40,
                no_price=0.60,
                volume_24h=200000.0,
                liquidity=500000.0,
                expires_at=1735689600000,
            ),
        ],
        perpetuals=[
            PerpetualState(
                ticker="BTC",
                mark_price=100000.0,
                index_price=99990.0,
                funding_rate=0.0001,
                open_interest=50000000.0,
                volume_24h=500000000.0,
                change_24h=0.02,
                high_24h=102000.0,
                low_24h=98000.0,
            ),
            PerpetualState(
                ticker="ETH",
                mark_price=3500.0,
                index_price=3495.0,
                funding_rate=-0.0002,
                open_interest=25000000.0,
                volume_24h=100000000.0,
                change_24h=-0.01,
                high_24h=3600.0,
                low_24h=3400.0,
            ),
        ],
        portfolio=ScenarioPortfolio(balance=50000.0),
    )


# =============================================================================
# ActionResult Tests
# =============================================================================


class TestActionResult:
    """Tests for ActionResult dataclass"""

    def test_creation(self):
        result = ActionResult(
            success=True,
            action_type="buy",
            pnl=150.0,
            message="Trade executed",
        )
        
        assert result.success is True
        assert result.pnl == 150.0

    def test_defaults(self):
        result = ActionResult(success=False, action_type="invalid")
        
        assert result.pnl == 0.0
        assert result.cost == 0.0
        assert result.message == ""


# =============================================================================
# PortfolioState Tests
# =============================================================================


class TestPortfolioState:
    """Tests for PortfolioState dataclass"""

    def test_creation(self):
        portfolio = PortfolioState(balance=10000.0)
        
        assert portfolio.balance == 10000.0
        assert portfolio.position_count == 0
        assert portfolio.trade_count == 0

    def test_position_count(self):
        portfolio = PortfolioState()
        portfolio.positions["pos1"] = {"type": "test"}
        portfolio.positions["pos2"] = {"type": "test"}
        
        assert portfolio.position_count == 2


# =============================================================================
# Validation Tests
# =============================================================================


class TestValidateAction:
    """Tests for validate_action"""

    def test_valid_wait(self):
        is_valid, error = validate_action({"action": "wait"})
        
        assert is_valid is True
        assert error == ""

    def test_valid_buy(self):
        is_valid, error = validate_action({
            "action": "buy",
            "market": "btc-100k",
            "amount": 100,
            "side": "yes",
        })
        
        assert is_valid is True
        assert error == ""

    def test_valid_open_perp(self):
        is_valid, error = validate_action({
            "action": "open_perp",
            "ticker": "BTC",
            "size": 0.1,
            "direction": "long",
        })
        
        assert is_valid is True
        assert error == ""

    def test_missing_action(self):
        is_valid, error = validate_action({})
        
        assert is_valid is False
        assert "Missing" in error

    def test_invalid_action_type(self):
        is_valid, error = validate_action({"action": "invalid_type"})
        
        assert is_valid is False
        assert "Invalid action type" in error

    def test_buy_missing_market(self):
        is_valid, error = validate_action({
            "action": "buy",
            "amount": 100,
        })
        
        assert is_valid is False
        assert "market" in error.lower()

    def test_buy_missing_amount(self):
        is_valid, error = validate_action({
            "action": "buy",
            "market": "test",
        })
        
        assert is_valid is False
        assert "amount" in error.lower()

    def test_buy_invalid_amount(self):
        is_valid, error = validate_action({
            "action": "buy",
            "market": "test",
            "amount": -100,
        })
        
        assert is_valid is False
        assert "Invalid amount" in error

    def test_perp_missing_ticker(self):
        is_valid, error = validate_action({
            "action": "open_perp",
            "size": 0.1,
            "direction": "long",
        })
        
        assert is_valid is False
        assert "ticker" in error.lower()

    def test_perp_missing_direction(self):
        is_valid, error = validate_action({
            "action": "open_perp",
            "ticker": "BTC",
            "size": 0.1,
        })
        
        assert is_valid is False
        assert "direction" in error.lower()


# =============================================================================
# Outcome Simulation Tests
# =============================================================================


class TestSimulateMarketOutcome:
    """Tests for simulate_market_outcome"""

    def test_returns_pnl_and_message(self):
        market = MarketState(
            market_id="test",
            question="Test?",
            yes_price=0.5,
            no_price=0.5,
            volume_24h=100000.0,
            liquidity=500000.0,
            expires_at=1735689600000,
        )
        
        pnl, message = simulate_market_outcome(market, "yes", 100.0)
        
        assert isinstance(pnl, float)
        assert isinstance(message, str)
        assert "P&L" in message

    def test_pnl_bounded(self):
        market = MarketState(
            market_id="test",
            question="Test?",
            yes_price=0.5,
            no_price=0.5,
            volume_24h=100000.0,
            liquidity=500000.0,
            expires_at=1735689600000,
        )
        
        # Run multiple times to check bounds
        for _ in range(100):
            pnl, _ = simulate_market_outcome(market, "yes", 100.0)
            assert -150 < pnl < 150  # Reasonable bounds for 100 trade


class TestSimulatePerpOutcome:
    """Tests for simulate_perp_outcome"""

    def test_returns_pnl_and_message(self):
        perp = PerpetualState(
            ticker="BTC",
            mark_price=100000.0,
            index_price=100000.0,
            funding_rate=0.0001,
            open_interest=50000000.0,
            volume_24h=500000000.0,
            change_24h=0.02,
            high_24h=102000.0,
            low_24h=98000.0,
        )
        
        pnl, message = simulate_perp_outcome(perp, "long", 0.1)
        
        assert isinstance(pnl, float)
        assert isinstance(message, str)
        assert "BTC" in message


# =============================================================================
# ActionExecutor Tests
# =============================================================================


class TestActionExecutor:
    """Tests for ActionExecutor"""

    def test_creation(self):
        scenario = create_test_scenario()
        executor = ActionExecutor(scenario)
        
        assert executor.portfolio.balance == 50000.0
        assert len(executor.markets) == 2
        assert len(executor.perpetuals) == 2

    def test_execute_wait(self):
        scenario = create_test_scenario()
        executor = ActionExecutor(scenario)
        
        result = executor.execute({"action": "wait"})
        
        assert result.success is True
        assert result.action_type == "wait"
        assert result.pnl == 0.0
        assert result.new_balance == 50000.0

    def test_execute_buy(self):
        scenario = create_test_scenario()
        executor = ActionExecutor(scenario)
        
        result = executor.execute({
            "action": "buy",
            "market": "btc-100k",
            "amount": 100,
            "side": "yes",
        })
        
        assert result.success is True
        assert result.action_type == "buy"
        assert result.market_id == "btc-100k"
        assert executor.portfolio.trade_count == 1

    def test_execute_buy_unknown_market(self):
        scenario = create_test_scenario()
        executor = ActionExecutor(scenario)
        
        result = executor.execute({
            "action": "buy",
            "market": "unknown-market",
            "amount": 100,
            "side": "yes",
        })
        
        assert result.success is False
        assert "not found" in result.message.lower()

    def test_execute_buy_insufficient_balance(self):
        scenario = create_test_scenario()
        executor = ActionExecutor(scenario)
        executor.portfolio.balance = 50.0
        
        result = executor.execute({
            "action": "buy",
            "market": "btc-100k",
            "amount": 1000,
            "side": "yes",
        })
        
        assert result.success is False
        assert "balance" in result.message.lower()

    def test_execute_open_perp(self):
        scenario = create_test_scenario()
        executor = ActionExecutor(scenario)
        
        result = executor.execute({
            "action": "open_perp",
            "ticker": "BTC",
            "size": 0.1,
            "direction": "long",
        })
        
        assert result.success is True
        assert result.action_type == "open_perp"
        assert result.ticker == "BTC"
        assert executor.portfolio.position_count == 1

    def test_execute_perp_uppercase_match(self):
        scenario = create_test_scenario()
        executor = ActionExecutor(scenario)
        
        result = executor.execute({
            "action": "open_perp",
            "ticker": "btc",  # lowercase
            "size": 0.1,
            "direction": "long",
        })
        
        assert result.success is True
        assert result.ticker == "BTC"

    def test_execute_perp_unknown_ticker(self):
        scenario = create_test_scenario()
        executor = ActionExecutor(scenario)
        
        result = executor.execute({
            "action": "open_perp",
            "ticker": "UNKNOWN",
            "size": 0.1,
            "direction": "long",
        })
        
        assert result.success is False
        assert "not found" in result.message.lower()

    def test_execute_invalid_action(self):
        scenario = create_test_scenario()
        executor = ActionExecutor(scenario)
        
        result = executor.execute({"action": "invalid"})
        
        assert result.success is False
        assert "Invalid action" in result.message

    def test_position_limit_enforced(self):
        scenario = create_test_scenario()
        executor = ActionExecutor(scenario, max_positions=2)
        
        # Fill positions
        executor.execute({
            "action": "buy",
            "market": "btc-100k",
            "amount": 100,
            "side": "yes",
        })
        executor.execute({
            "action": "open_perp",
            "ticker": "ETH",
            "size": 0.1,
            "direction": "long",
        })
        
        # Third should fail
        result = executor.execute({
            "action": "open_perp",
            "ticker": "BTC",
            "size": 0.1,
            "direction": "long",
        })
        
        assert result.success is False
        assert "limit" in result.message.lower()

    def test_get_portfolio_summary(self):
        scenario = create_test_scenario()
        executor = ActionExecutor(scenario)
        
        executor.execute({
            "action": "buy",
            "market": "btc-100k",
            "amount": 100,
            "side": "yes",
        })
        
        summary = executor.get_portfolio_summary()
        
        assert "balance" in summary
        assert "pnl" in summary
        assert summary["trade_count"] == 1
        assert summary["position_count"] == 1


# =============================================================================
# Convenience Function Tests
# =============================================================================


class TestExecuteActionForTraining:
    """Tests for execute_action_for_training"""

    def test_convenience_function(self):
        scenario = create_test_scenario()
        action = {"action": "wait"}
        
        result = execute_action_for_training(action, scenario)
        
        assert result.success is True
        assert result.action_type == "wait"


class TestCalculateActionQualityBonus:
    """Tests for calculate_action_quality_bonus"""

    def test_successful_action_bonus(self):
        result = ActionResult(success=True, action_type="buy", pnl=100.0)
        
        bonus = calculate_action_quality_bonus(result)
        
        assert bonus > 0

    def test_failed_action_penalty(self):
        result = ActionResult(success=False, action_type="buy")
        
        bonus = calculate_action_quality_bonus(result)
        
        assert bonus < 0

    def test_wait_action_small_bonus(self):
        result = ActionResult(success=True, action_type="wait", pnl=0.0)
        
        bonus = calculate_action_quality_bonus(result)
        
        assert 0.05 < bonus < 0.2

    def test_large_profit_capped(self):
        result = ActionResult(success=True, action_type="buy", pnl=10000.0)
        
        bonus = calculate_action_quality_bonus(result)
        
        assert bonus <= 0.3  # Max cap

    def test_large_loss_penalized(self):
        result = ActionResult(success=True, action_type="open_perp", pnl=-500.0)
        
        bonus = calculate_action_quality_bonus(result)
        
        assert bonus < 0.1  # Loss penalty applied


# =============================================================================
# Integration Tests
# =============================================================================


class TestIntegration:
    """Integration tests for action execution flow"""

    def test_full_trading_sequence(self):
        """Test a realistic trading sequence"""
        scenario = create_test_scenario()
        executor = ActionExecutor(scenario)
        
        initial_balance = executor.portfolio.balance
        
        # Buy prediction market
        result1 = executor.execute({
            "action": "buy",
            "market": "btc-100k",
            "amount": 500,
            "side": "yes",
        })
        assert result1.success is True
        
        # Open perp long
        result2 = executor.execute({
            "action": "open_perp",
            "ticker": "ETH",
            "size": 1.0,
            "direction": "long",
        })
        assert result2.success is True
        
        # Wait
        result3 = executor.execute({"action": "wait"})
        assert result3.success is True
        
        # Check portfolio
        summary = executor.get_portfolio_summary()
        assert summary["position_count"] == 2
        assert summary["trade_count"] == 2
        # Balance should have changed due to P&L
        assert summary["balance"] != initial_balance or summary["pnl"] != 0

    def test_action_quality_integration(self):
        """Test action quality bonus calculation with real execution"""
        scenario = create_test_scenario()
        executor = ActionExecutor(scenario)
        
        # Execute valid action
        result = executor.execute({
            "action": "buy",
            "market": "btc-100k",
            "amount": 100,
            "side": "yes",
        })
        
        bonus = calculate_action_quality_bonus(result)
        
        # Should get base bonus for valid action
        assert bonus >= 0.1


