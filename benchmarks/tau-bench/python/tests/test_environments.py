"""
Tests for domain environments.
"""

import pytest
from elizaos_tau_bench.types import TauBenchTask, TauDomain, ToolCall
from elizaos_tau_bench.environments.retail import RetailEnvironment
from elizaos_tau_bench.environments.airline import AirlineEnvironment


@pytest.fixture
def retail_task():
    """Create a minimal retail task."""
    return TauBenchTask(
        task_id="test_retail",
        domain=TauDomain.RETAIL,
        user_instruction="Test instruction",
        success_criteria=["return_initiated"],
    )


@pytest.fixture
def airline_task():
    """Create a minimal airline task."""
    return TauBenchTask(
        task_id="test_airline",
        domain=TauDomain.AIRLINE,
        user_instruction="Test instruction",
        success_criteria=["booking_cancelled"],
    )


class TestRetailEnvironment:
    """Tests for RetailEnvironment."""

    @pytest.mark.asyncio
    async def test_initialize(self, retail_task):
        """Test environment initialization."""
        env = RetailEnvironment(retail_task)
        await env.initialize()

        assert env.initialized
        assert "orders" in env.state
        assert "customers" in env.state
        assert "products" in env.state

    @pytest.mark.asyncio
    async def test_get_order_details(self, retail_task):
        """Test getting order details."""
        env = RetailEnvironment(retail_task)
        await env.initialize()

        call = ToolCall(
            tool_name="get_order_details",
            arguments={"order_id": "ORD-12345"},
        )
        result = await env.execute_tool(call)

        assert "order_id" in result
        assert result["order_id"] == "ORD-12345"
        assert result["status"] == "delivered"

    @pytest.mark.asyncio
    async def test_get_order_not_found(self, retail_task):
        """Test getting non-existent order."""
        env = RetailEnvironment(retail_task)
        await env.initialize()

        call = ToolCall(
            tool_name="get_order_details",
            arguments={"order_id": "INVALID"},
        )
        result = await env.execute_tool(call)

        assert "error" in result

    @pytest.mark.asyncio
    async def test_cancel_order(self, retail_task):
        """Test cancelling an order."""
        env = RetailEnvironment(retail_task)
        await env.initialize()

        call = ToolCall(
            tool_name="cancel_order",
            arguments={"order_id": "ORD-12346", "reason": "Test cancellation"},
        )
        result = await env.execute_tool(call)

        assert result["success"]
        assert env.state["orders"]["ORD-12346"]["status"] == "cancelled"

    @pytest.mark.asyncio
    async def test_initiate_return(self, retail_task):
        """Test initiating a return."""
        env = RetailEnvironment(retail_task)
        await env.initialize()

        call = ToolCall(
            tool_name="initiate_return",
            arguments={"order_id": "ORD-12345", "reason": "Defective"},
        )
        result = await env.execute_tool(call)

        assert result["success"]
        assert "return_id" in result
        assert env.state["returns"]

    @pytest.mark.asyncio
    async def test_check_goal_achieved_return(self, retail_task):
        """Test goal achievement check for return."""
        env = RetailEnvironment(retail_task)
        await env.initialize()

        # Initially, goal not achieved
        assert not await env.check_goal_achieved()

        # Initiate return
        call = ToolCall(
            tool_name="initiate_return",
            arguments={"order_id": "ORD-12345"},
        )
        await env.execute_tool(call)

        # Now goal should be achieved
        assert await env.check_goal_achieved()

    @pytest.mark.asyncio
    async def test_get_available_tools(self, retail_task):
        """Test getting available tools."""
        env = RetailEnvironment(retail_task)
        tools = env.get_available_tools()

        tool_names = [t.name for t in tools]
        assert "get_order_details" in tool_names
        assert "cancel_order" in tool_names
        assert "initiate_return" in tool_names

    @pytest.mark.asyncio
    async def test_get_policy_constraints(self, retail_task):
        """Test getting policy constraints."""
        env = RetailEnvironment(retail_task)
        constraints = env.get_policy_constraints()

        policy_ids = [c.policy_id for c in constraints]
        assert "RETURN_WINDOW" in policy_ids
        assert "REFUND_AUTH" in policy_ids


class TestAirlineEnvironment:
    """Tests for AirlineEnvironment."""

    @pytest.mark.asyncio
    async def test_initialize(self, airline_task):
        """Test environment initialization."""
        env = AirlineEnvironment(airline_task)
        await env.initialize()

        assert env.initialized
        assert "bookings" in env.state
        assert "passengers" in env.state
        assert "flights" in env.state

    @pytest.mark.asyncio
    async def test_get_booking_details(self, airline_task):
        """Test getting booking details."""
        env = AirlineEnvironment(airline_task)
        await env.initialize()

        call = ToolCall(
            tool_name="get_booking_details",
            arguments={"booking_id": "BK-123456"},
        )
        result = await env.execute_tool(call)

        assert "booking_id" in result
        assert result["booking_id"] == "BK-123456"
        assert "flights" in result

    @pytest.mark.asyncio
    async def test_cancel_booking(self, airline_task):
        """Test cancelling a booking."""
        env = AirlineEnvironment(airline_task)
        await env.initialize()

        call = ToolCall(
            tool_name="cancel_booking",
            arguments={"booking_id": "BK-123456", "reason": "Test"},
        )
        result = await env.execute_tool(call)

        assert result["success"]
        assert "refund_amount" in result
        assert env.state["bookings"]["BK-123456"]["status"] == "cancelled"

    @pytest.mark.asyncio
    async def test_search_flights(self, airline_task):
        """Test searching for flights."""
        env = AirlineEnvironment(airline_task)
        await env.initialize()

        call = ToolCall(
            tool_name="search_flights",
            arguments={"origin": "JFK", "destination": "LAX"},
        )
        result = await env.execute_tool(call)

        assert "flights" in result
        assert len(result["flights"]) > 0

    @pytest.mark.asyncio
    async def test_select_seat(self, airline_task):
        """Test selecting a seat."""
        env = AirlineEnvironment(airline_task)
        await env.initialize()

        call = ToolCall(
            tool_name="select_seat",
            arguments={
                "booking_id": "BK-123456",
                "flight_id": "FL-AA100",
                "seat": "25A",
            },
        )
        result = await env.execute_tool(call)

        assert result["success"]
        assert result["seat"] == "25A"

    @pytest.mark.asyncio
    async def test_check_goal_achieved_cancel(self, airline_task):
        """Test goal achievement check for cancellation."""
        env = AirlineEnvironment(airline_task)
        await env.initialize()

        # Initially, goal not achieved
        assert not await env.check_goal_achieved()

        # Cancel booking
        call = ToolCall(
            tool_name="cancel_booking",
            arguments={"booking_id": "BK-123456"},
        )
        await env.execute_tool(call)

        # Now goal should be achieved
        assert await env.check_goal_achieved()

    @pytest.mark.asyncio
    async def test_get_available_tools(self, airline_task):
        """Test getting available tools."""
        env = AirlineEnvironment(airline_task)
        tools = env.get_available_tools()

        tool_names = [t.name for t in tools]
        assert "get_booking_details" in tool_names
        assert "cancel_booking" in tool_names
        assert "search_flights" in tool_names
        assert "select_seat" in tool_names
