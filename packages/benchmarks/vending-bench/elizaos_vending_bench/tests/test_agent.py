"""Tests for Vending-Bench agent."""

import json
from decimal import Decimal

import pytest

from elizaos_vending_bench.agent import MockLLMProvider, VendingAgent
from elizaos_vending_bench.environment import VendingEnvironment
from elizaos_vending_bench.types import ActionType


class TestVendingAgent:
    """Test VendingAgent class."""

    def test_create_agent(self) -> None:
        """Test creating an agent."""
        env = VendingEnvironment(seed=42)
        agent = VendingAgent(environment=env)

        assert agent.env == env
        assert agent.llm is None
        assert agent.temperature == 0.0

    def test_parse_action_valid_json(self) -> None:
        """Test parsing valid action JSON."""
        env = VendingEnvironment(seed=42)
        agent = VendingAgent(environment=env)

        response = '{"action": "VIEW_BUSINESS_STATE"}'
        action_type, params = agent._parse_action(response)

        assert action_type == ActionType.VIEW_STATE
        assert params == {}

    def test_parse_action_with_params(self) -> None:
        """Test parsing action with parameters."""
        env = VendingEnvironment(seed=42)
        agent = VendingAgent(environment=env)

        response = '{"action": "SET_PRICE", "row": 0, "column": 1, "price": 1.50}'
        action_type, params = agent._parse_action(response)

        assert action_type == ActionType.SET_PRICE
        assert params["row"] == 0
        assert params["column"] == 1
        assert params["price"] == 1.50

    def test_parse_action_place_order(self) -> None:
        """Test parsing place order action."""
        env = VendingEnvironment(seed=42)
        agent = VendingAgent(environment=env)

        response = (
            '{"action": "PLACE_ORDER", "supplier_id": "beverage_dist", "items": {"water": 12}}'
        )
        action_type, params = agent._parse_action(response)

        assert action_type == ActionType.PLACE_ORDER
        assert params["supplier_id"] == "beverage_dist"
        items = params["items"]
        assert isinstance(items, dict)
        assert items["water"] == 12

    def test_parse_action_with_code_block(self) -> None:
        """Test parsing action from markdown code block."""
        env = VendingEnvironment(seed=42)
        agent = VendingAgent(environment=env)

        response = '```json\n{"action": "COLLECT_CASH"}\n```'
        action_type, params = agent._parse_action(response)

        assert action_type == ActionType.COLLECT_CASH

    def test_parse_action_invalid_json(self) -> None:
        """Test parsing invalid JSON returns None."""
        env = VendingEnvironment(seed=42)
        agent = VendingAgent(environment=env)

        response = "This is not JSON"
        action_type, params = agent._parse_action(response)

        assert action_type is None
        assert params == {}

    def test_execute_action_view_state(self) -> None:
        """Test executing VIEW_STATE action."""
        env = VendingEnvironment(seed=42)
        agent = VendingAgent(environment=env)

        result, success = agent._execute_action(ActionType.VIEW_STATE, {})

        assert success
        assert "Business State" in result

    def test_execute_action_collect_cash(self) -> None:
        """Test executing COLLECT_CASH action."""
        env = VendingEnvironment(seed=42)
        env.state.machine.cash_in_machine = Decimal("100.00")
        agent = VendingAgent(environment=env)

        result, success = agent._execute_action(ActionType.COLLECT_CASH, {})

        assert success
        assert "Collected" in result
        assert env.state.machine.cash_in_machine == Decimal("0")

    def test_execute_action_advance_day(self) -> None:
        """Test executing ADVANCE_DAY action."""
        env = VendingEnvironment(seed=42)
        agent = VendingAgent(environment=env)
        initial_day = env.state.current_day

        result, success = agent._execute_action(ActionType.ADVANCE_DAY, {})

        assert success
        assert "Day" in result
        assert env.state.current_day == initial_day + 1

    def test_heuristic_decision_day_1(self) -> None:
        """Test heuristic agent on day 1."""
        env = VendingEnvironment(seed=42)
        agent = VendingAgent(environment=env)

        decision = agent._heuristic_decision(1, "")

        # Should view state first
        data = json.loads(decision)
        assert data["action"] == "VIEW_BUSINESS_STATE"

    def test_heuristic_decision_collect_cash(self) -> None:
        """Test heuristic agent collects cash when needed."""
        env = VendingEnvironment(seed=42)
        env.state.machine.cash_in_machine = Decimal("100.00")
        # Need enough inventory so it doesn't try to order first
        env.state.machine.slots[0].quantity = 50
        agent = VendingAgent(environment=env)

        decision = agent._heuristic_decision(5, "previous result")
        data = json.loads(decision)

        assert data["action"] == "COLLECT_CASH"


class TestMockLLMProvider:
    """Test MockLLMProvider class."""

    @pytest.mark.asyncio
    async def test_mock_provider_returns_responses(self) -> None:
        """Test mock provider returns configured responses."""
        responses = [
            '{"action": "VIEW_BUSINESS_STATE"}',
            '{"action": "ADVANCE_DAY"}',
        ]
        provider = MockLLMProvider(responses=responses)

        result1, tokens1 = await provider.generate("system", "user")
        assert result1 == responses[0]
        assert tokens1 == 100

        result2, tokens2 = await provider.generate("system", "user")
        assert result2 == responses[1]

    @pytest.mark.asyncio
    async def test_mock_provider_default_advance_day(self) -> None:
        """Test mock provider defaults to ADVANCE_DAY when responses exhausted."""
        provider = MockLLMProvider(responses=[])

        result, tokens = await provider.generate("system", "user")

        assert "ADVANCE_DAY" in result


class TestAgentSimulation:
    """Test agent simulation runs."""

    @pytest.mark.asyncio
    async def test_run_single_day(self) -> None:
        """Test running a single day."""
        env = VendingEnvironment(seed=42)
        agent = VendingAgent(environment=env)

        actions = await agent.run_day(day=1, max_actions=15)

        assert len(actions) > 0
        # Agent takes actions - verify we got meaningful data
        assert any(a.success for a in actions)

    @pytest.mark.asyncio
    async def test_run_simulation_short(self) -> None:
        """Test running a short simulation."""
        env = VendingEnvironment(initial_cash=Decimal("500.00"), seed=42)
        agent = VendingAgent(environment=env)

        result = await agent.run_simulation(max_days=3, run_id="test_run")

        assert result.run_id == "test_run"
        # Simulation may end early if bankrupt
        assert result.simulation_days <= 3
        assert result.initial_cash == Decimal("500.00")
        assert len(result.actions) > 0

    @pytest.mark.asyncio
    async def test_run_simulation_with_mock_llm(self) -> None:
        """Test simulation with mock LLM provider."""
        responses = [
            '{"action": "VIEW_BUSINESS_STATE"}',
            '{"action": "VIEW_SUPPLIERS"}',
            '{"action": "PLACE_ORDER", "supplier_id": "beverage_dist", "items": {"water": 12, "soda_cola": 12}}',
            '{"action": "ADVANCE_DAY"}',
            '{"action": "ADVANCE_DAY"}',
            '{"action": "CHECK_DELIVERIES"}',
            '{"action": "ADVANCE_DAY"}',
        ]
        provider = MockLLMProvider(responses=responses)

        env = VendingEnvironment(initial_cash=Decimal("500.00"), seed=42)
        agent = VendingAgent(environment=env, llm_provider=provider)

        result = await agent.run_simulation(max_days=3, run_id="mock_test")

        assert result.simulation_days == 3
        assert result.total_tokens > 0  # Mock returns 100 tokens per call

    @pytest.mark.asyncio
    async def test_run_simulation_calculates_metrics(self) -> None:
        """Test simulation calculates correct metrics."""
        env = VendingEnvironment(initial_cash=Decimal("500.00"), seed=42)
        agent = VendingAgent(environment=env)

        result = await agent.run_simulation(max_days=5, run_id="metrics_test")

        # Check metrics are calculated
        assert result.total_revenue >= Decimal("0")
        # Operational fees may be 0 if simulation ended very early
        assert result.total_operational_fees >= Decimal("0")
        assert result.profit == result.final_net_worth - result.initial_cash

    @pytest.mark.asyncio
    async def test_simulation_bankrupt_ends_early(self) -> None:
        """Test simulation ends early if bankrupt."""
        # Start with very little cash
        env = VendingEnvironment(initial_cash=Decimal("5.00"), seed=42)
        agent = VendingAgent(environment=env)

        result = await agent.run_simulation(max_days=30, run_id="bankrupt_test")

        # Should end early due to negative net worth
        # (operational fees are $11/day, starting with $5)
        assert result.simulation_days < 30
