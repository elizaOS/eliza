"""
Vending-Bench Agent

ElizaOS agent integration for the Vending-Bench benchmark.
Provides the interface between the LLM and the vending environment.
"""

import json
import time
from decimal import Decimal
from typing import Protocol

from elizaos_vending_bench.environment import VendingEnvironment
from elizaos_vending_bench.types import (
    ActionParameters,
    ActionType,
    AgentAction,
    VendingBenchResult,
)


class LLMProvider(Protocol):
    """Protocol for LLM providers."""

    async def generate(
        self,
        system_prompt: str,
        user_prompt: str,
        temperature: float = 0.0,
    ) -> tuple[str, int]:
        """
        Generate a response from the LLM.

        Returns:
            Tuple of (response_text, tokens_used)
        """
        ...


class VendingAgent:
    """Agent for managing the vending machine business."""

    def __init__(
        self,
        environment: VendingEnvironment,
        llm_provider: LLMProvider | None = None,
        temperature: float = 0.0,
    ) -> None:
        """
        Initialize the vending agent.

        Args:
            environment: The vending environment to operate in
            llm_provider: LLM provider for decision making
            temperature: Temperature for LLM generation
        """
        self.env = environment
        self.llm = llm_provider
        self.temperature = temperature
        self.actions_log: list[AgentAction] = []
        self.total_tokens = 0

    def _build_system_prompt(self) -> str:
        """Build the system prompt for the agent."""
        return """You are an AI managing a vending machine business. Your goal is to maximize profit over the simulation period.

## Your Responsibilities:
1. Keep the machine stocked with products customers want
2. Set optimal prices based on demand and conditions
3. Manage orders and supplier relationships efficiently
4. Track deliveries and restock on time
5. Collect cash from the machine regularly
6. Minimize stockouts and waste

## Turn Discipline (important):
- You have a limited number of actions per day. Avoid wasting actions.
- Do not spam information-gathering: in a given day, do **at most one** VIEW_BUSINESS_STATE and **at most one** VIEW_SUPPLIERS unless the previous call failed.
- Do not spam orders: in a given day, place **at most one** PLACE_ORDER. If you need multiple products, include them in a single order. If you already placed an order today, ADVANCE_DAY.
- Do not spam CHECK_DELIVERIES: if deliveries are "in_transit", ADVANCE_DAY to let time pass. Checking multiple times does nothing.
- When restocking: each slot has **max_capacity=10**. Restock ≤10 units per slot. If a slot is full, try a DIFFERENT slot.
- **If an action shows an error, do NOT retry the exact same parameters.** Try different parameters or ADVANCE_DAY.
- Always end each day with ADVANCE_DAY once you’ve finished necessary actions.
- If you’re unsure what to do next, ADVANCE_DAY.

## Available Actions (respond with JSON):

1. VIEW_BUSINESS_STATE - See current inventory, cash, orders
   {"action": "VIEW_BUSINESS_STATE"}

2. VIEW_SUPPLIERS - See suppliers and products available
   {"action": "VIEW_SUPPLIERS"}

3. PLACE_ORDER - Order products from a supplier
   {"action": "PLACE_ORDER", "supplier_id": "supplier_id", "items": {"product_id": quantity}}

4. RESTOCK_SLOT - Put delivered products in machine slots
   {"action": "RESTOCK_SLOT", "row": 0, "column": 0, "product_id": "product_id", "quantity": 5}

5. SET_PRICE - Adjust product prices
   {"action": "SET_PRICE", "row": 0, "column": 0, "price": 1.50}

6. COLLECT_CASH - Collect revenue from machine
   {"action": "COLLECT_CASH"}

7. UPDATE_NOTES - Keep notes for yourself
   {"action": "UPDATE_NOTES", "key": "strategy", "content": "Your note here"}

8. CHECK_DELIVERIES - Check order/delivery status
   {"action": "CHECK_DELIVERIES"}

9. ADVANCE_DAY - End your turn and proceed to next day
   {"action": "ADVANCE_DAY"}

## Important Tips:
- **Use exact product_ids** when ordering/restocking (e.g., "water" not "bottled_water", "soda_cola" not "cola")
- Track your orders carefully - note expected delivery dates
- Weather affects demand: hot weather = more drinks, cold = more snacks
- Don't let products run out (stockouts lose sales)
- Collect cash regularly to fund new orders
- Use notes to remember important information
- Consider bulk discounts when ordering
- Price higher than suggested retail reduces demand
- **Avoid repeating failed actions** - if an action fails, try something different

## Response Format:
Always respond with valid JSON containing your action. You may include a "reasoning" field to explain your decision:

{"action": "PLACE_ORDER", "supplier_id": "beverage_dist", "items": {"water": 20, "soda_cola": 20}, "reasoning": "Hot weather expected, stocking up on drinks"}
"""

    def _build_daily_prompt(self, day: int, previous_result: str = "") -> str:
        """Build the prompt for a day's decisions."""
        state = self.env.state
        yesterday = state.daily_history[-1] if state.daily_history else None

        prompt = f"## Day {day} of your vending business\n\n"
        prompt += f"Current Date: {state.current_date}\n"
        prompt += f"Cash on Hand: ${state.cash_on_hand:.2f}\n"
        prompt += f"Net Worth: ${self.env.get_net_worth():.2f}\n\n"

        if yesterday:
            prompt += "### Yesterday's Summary:\n"
            prompt += f"- Revenue: ${yesterday.total_revenue:.2f}\n"
            prompt += f"- Weather: {yesterday.weather.value}\n"
            prompt += f"- Items sold: {sum(s.quantity for s in yesterday.sales)}\n"
            if yesterday.stockout_products:
                prompt += f"- Stockouts: {', '.join(yesterday.stockout_products)}\n"
            if yesterday.deliveries_received:
                prompt += f"- Deliveries received: {', '.join(yesterday.deliveries_received)}\n"
            prompt += "\n"

        if previous_result:
            prompt += f"### Context (this day):\n{previous_result}\n\n"

        prompt += "What would you like to do? Respond with JSON."

        return prompt

    def _parse_action(self, response: str) -> tuple[ActionType | None, ActionParameters]:
        """Parse the LLM response into an action."""
        # Try to extract JSON from response
        try:
            # Handle potential markdown code blocks
            if "```json" in response:
                json_str = response.split("```json")[1].split("```")[0].strip()
            elif "```" in response:
                json_str = response.split("```")[1].split("```")[0].strip()
            else:
                json_str = response.strip()

            data = json.loads(json_str)
            action_name = data.get("action", "").upper()

            # Map to ActionType
            action_map = {
                "VIEW_BUSINESS_STATE": ActionType.VIEW_STATE,
                "VIEW_STATE": ActionType.VIEW_STATE,
                "VIEW_SUPPLIERS": ActionType.VIEW_SUPPLIERS,
                "SET_PRICE": ActionType.SET_PRICE,
                "PLACE_ORDER": ActionType.PLACE_ORDER,
                "RESTOCK_SLOT": ActionType.RESTOCK_SLOT,
                "COLLECT_CASH": ActionType.COLLECT_CASH,
                "UPDATE_NOTES": ActionType.UPDATE_NOTES,
                "CHECK_DELIVERIES": ActionType.CHECK_DELIVERIES,
                "ADVANCE_DAY": ActionType.ADVANCE_DAY,
            }

            action_type = action_map.get(action_name)
            params: ActionParameters = {}
            for k, v in data.items():
                if k in ("action", "reasoning"):
                    continue
                if k == "items" and isinstance(v, dict):
                    params["items"] = {str(item_k): int(item_v) for item_k, item_v in v.items()}
                    continue
                if isinstance(v, (str, int, float, bool)):
                    params[str(k)] = v
                    continue
                # Skip null/unsupported types rather than poisoning param typing
                if v is None:
                    continue
                params[str(k)] = str(v)

            return action_type, params

        except (json.JSONDecodeError, KeyError, IndexError):
            return None, {}

    def _execute_action(
        self,
        action_type: ActionType,
        params: ActionParameters,
    ) -> tuple[str, bool]:
        """Execute an action and return the result."""
        try:
            if action_type == ActionType.VIEW_STATE:
                return self.env.action_view_state(), True

            elif action_type == ActionType.VIEW_SUPPLIERS:
                return self.env.action_view_suppliers(), True

            elif action_type == ActionType.SET_PRICE:
                row_raw = params.get("row", 0)
                row = (
                    int(row_raw)
                    if isinstance(row_raw, (int, float, str)) and not isinstance(row_raw, bool)
                    else 0
                )

                column_raw = params.get("column", 0)
                column = (
                    int(column_raw)
                    if isinstance(column_raw, (int, float, str))
                    and not isinstance(column_raw, bool)
                    else 0
                )

                price_raw = params.get("price", 0)
                price = (
                    Decimal(str(price_raw))
                    if isinstance(price_raw, (int, float, str)) and not isinstance(price_raw, bool)
                    else Decimal("0")
                )
                return self.env.action_set_price(row, column, price), True

            elif action_type == ActionType.PLACE_ORDER:
                supplier_id = str(params.get("supplier_id", ""))
                items_raw = params.get("items")
                items: dict[str, int] = {}
                if isinstance(items_raw, dict):
                    items = {str(k): int(v) for k, v in items_raw.items()}
                return self.env.action_place_order(supplier_id, items), True

            elif action_type == ActionType.RESTOCK_SLOT:
                row_raw = params.get("row", 0)
                row = (
                    int(row_raw)
                    if isinstance(row_raw, (int, float, str)) and not isinstance(row_raw, bool)
                    else 0
                )

                column_raw = params.get("column", 0)
                column = (
                    int(column_raw)
                    if isinstance(column_raw, (int, float, str))
                    and not isinstance(column_raw, bool)
                    else 0
                )
                product_id = str(params.get("product_id", ""))
                quantity_raw = params.get("quantity", 0)
                quantity = (
                    int(quantity_raw)
                    if isinstance(quantity_raw, (int, float, str))
                    and not isinstance(quantity_raw, bool)
                    else 0
                )
                return self.env.action_restock_slot(row, column, product_id, quantity), True

            elif action_type == ActionType.COLLECT_CASH:
                return self.env.action_collect_cash(), True

            elif action_type == ActionType.UPDATE_NOTES:
                key = str(params.get("key", "note"))
                content = str(params.get("content", ""))
                return self.env.action_update_notes(key, content), True

            elif action_type == ActionType.CHECK_DELIVERIES:
                return self.env.action_check_deliveries(), True

            elif action_type == ActionType.ADVANCE_DAY:
                return self.env.action_advance_day(), True

            else:
                return "Unknown action", False

        except Exception as e:
            return f"Error executing action: {e}", False

    async def run_day(
        self,
        day: int,
        max_actions: int = 10,
    ) -> list[AgentAction]:
        """
        Run a single day's worth of agent interactions.

        Args:
            day: Current day number
            max_actions: Maximum actions allowed per day

        Returns:
            List of actions taken
        """
        actions_taken: list[AgentAction] = []
        previous_result = ""
        previous_action_type: ActionType | None = None

        cached_business_state: str | None = None
        cached_suppliers: str | None = None
        placed_order_today = False
        collected_cash_today = False
        checked_deliveries_today = False  # Track to prevent spam

        # Loop detection: track consecutive identical actions
        consecutive_same_action = 0
        last_action_sig: str | None = None

        system_prompt = self._build_system_prompt()

        for _action_num in range(max_actions):
            # Build a small rolling context so the LLM can "remember" earlier results
            context_parts: list[str] = []
            context_parts.append(
                f"[TODAY]\nplaced_order={placed_order_today}\n"
                f"collected_cash={collected_cash_today}\n"
                f"checked_deliveries={checked_deliveries_today}"
            )
            if cached_business_state:
                context_parts.append(f"[BUSINESS_STATE]\n{cached_business_state}")
            if cached_suppliers:
                context_parts.append(f"[SUPPLIERS]\n{cached_suppliers}")
            if previous_result and previous_action_type not in (
                ActionType.VIEW_STATE,
                ActionType.VIEW_SUPPLIERS,
            ):
                context_parts.append(f"[LAST_RESULT]\n{previous_result}")

            context = "\n\n".join(context_parts).strip()
            user_prompt = self._build_daily_prompt(day, context)

            start_time = time.time()
            tokens_used = 0

            if self.llm:
                response, tokens_used = await self.llm.generate(
                    system_prompt,
                    user_prompt,
                    self.temperature,
                )
                self.total_tokens += tokens_used
            else:
                # Fallback to simple heuristic agent
                response = self._heuristic_decision(day, previous_result)

            latency_ms = (time.time() - start_time) * 1000

            # Parse the action
            action_type, params = self._parse_action(response)

            if action_type is None:
                # Invalid response, try again
                action = AgentAction(
                    action_type=ActionType.VIEW_STATE,
                    day=day,
                    parameters={},
                    result="Failed to parse action",
                    success=False,
                    tokens_used=tokens_used,
                    latency_ms=latency_ms,
                )
                actions_taken.append(action)
                previous_result = "Invalid action format. Please respond with valid JSON."
                previous_action_type = None
                continue

            # Execute the action
            result, success = self._execute_action(action_type, params)

            action = AgentAction(
                action_type=action_type,
                day=day,
                parameters=params,
                result=result,
                success=success,
                tokens_used=tokens_used,
                latency_ms=latency_ms,
            )
            actions_taken.append(action)
            previous_action_type = action_type
            if success and action_type == ActionType.PLACE_ORDER:
                placed_order_today = True
            if success and action_type == ActionType.COLLECT_CASH:
                collected_cash_today = True
            if action_type == ActionType.CHECK_DELIVERIES:
                checked_deliveries_today = True

            # If action is ADVANCE_DAY, end the day
            if action_type == ActionType.ADVANCE_DAY:
                break

            # Loop detection: check if we're repeating the same action
            action_sig = f"{action_type.value}:{str(sorted(params.items()))}"
            if action_sig == last_action_sig:
                consecutive_same_action += 1
                # If repeated 3+ times, force ADVANCE_DAY
                if consecutive_same_action >= 2:
                    result, _success = self._execute_action(ActionType.ADVANCE_DAY, {})
                    actions_taken.append(
                        AgentAction(
                            action_type=ActionType.ADVANCE_DAY,
                            day=day,
                            parameters={},
                            result=f"Auto-advanced (loop detected: {action_type.value} x{consecutive_same_action + 1}). {result}",
                            success=True,
                            tokens_used=0,
                            latency_ms=0.0,
                        )
                    )
                    break
            else:
                consecutive_same_action = 0
                last_action_sig = action_sig

            previous_result = result

            # Cache expensive information-gathering results so the LLM doesn't need to re-request them
            if action_type == ActionType.VIEW_STATE:
                cached_business_state = result[:6000] + (
                    "\n...(truncated)..." if len(result) > 6000 else ""
                )
            elif action_type == ActionType.VIEW_SUPPLIERS:
                cached_suppliers = result[:6000] + (
                    "\n...(truncated)..." if len(result) > 6000 else ""
                )

        # If the agent never advanced the day (common for some LLMs), force progress
        if not actions_taken or actions_taken[-1].action_type != ActionType.ADVANCE_DAY:
            result, success = self._execute_action(ActionType.ADVANCE_DAY, {})
            actions_taken.append(
                AgentAction(
                    action_type=ActionType.ADVANCE_DAY,
                    day=day,
                    parameters={},
                    result=f"Auto-advanced day after reaching max_actions. {result}",
                    success=success,
                    tokens_used=0,
                    latency_ms=0.0,
                )
            )

        return actions_taken

    def _heuristic_decision(self, day: int, previous_result: str) -> str:
        """Simple heuristic-based decision making for testing without LLM."""
        state = self.env.state

        # Track what we've done this turn by parsing previous results
        viewed_state = "Business State" in previous_result
        placed_order = "Order" in previous_result and "placed" in previous_result
        collected_cash = "Collected" in previous_result

        # Day 1: View state first
        if day == 1 and not viewed_state:
            return '{"action": "VIEW_BUSINESS_STATE"}'

        # Check for delivered inventory to restock
        if state.delivered_inventory:
            for delivered in state.delivered_inventory:
                for slot in state.machine.slots:
                    if slot.product is None:
                        qty = min(delivered.quantity, slot.max_capacity)
                        if qty > 0:
                            return json.dumps(
                                {
                                    "action": "RESTOCK_SLOT",
                                    "row": slot.row,
                                    "column": slot.column,
                                    "product_id": delivered.product_id,
                                    "quantity": qty,
                                }
                            )
                    elif slot.product and slot.product.product_id == delivered.product_id:
                        available_space = slot.max_capacity - slot.quantity
                        if available_space > 0:
                            qty = min(delivered.quantity, available_space)
                            return json.dumps(
                                {
                                    "action": "RESTOCK_SLOT",
                                    "row": slot.row,
                                    "column": slot.column,
                                    "product_id": delivered.product_id,
                                    "quantity": qty,
                                }
                            )

        # Collect cash if machine has significant amount
        if state.machine.cash_in_machine > Decimal("30") and not collected_cash:
            return '{"action": "COLLECT_CASH"}'

        # Place orders when low on inventory or no pending orders
        total_inventory = sum(slot.quantity for slot in state.machine.slots)
        has_pending = any(
            o.status.value in ("pending", "confirmed", "in_transit") for o in state.pending_orders
        )

        if (
            total_inventory < 30
            and state.cash_on_hand > Decimal("50")
            and not has_pending
            and not placed_order
        ):
            # Order beverages (most popular)
            return json.dumps(
                {
                    "action": "PLACE_ORDER",
                    "supplier_id": "beverage_dist",
                    "items": {"water": 12, "soda_cola": 12},
                }
            )

        if total_inventory < 15 and state.cash_on_hand > Decimal("30") and not placed_order:
            # Urgent order for snacks
            return json.dumps(
                {
                    "action": "PLACE_ORDER",
                    "supplier_id": "snack_co",
                    "items": {"chips_regular": 10, "cookies": 10},
                }
            )

        # Set prices for stocked slots that don't have prices
        for slot in state.machine.slots:
            if slot.product and slot.quantity > 0 and slot.price == Decimal("0"):
                return json.dumps(
                    {
                        "action": "SET_PRICE",
                        "row": slot.row,
                        "column": slot.column,
                        "price": float(slot.product.suggested_retail),
                    }
                )

        # Default: advance day to let the simulation progress
        return '{"action": "ADVANCE_DAY"}'

    async def run_simulation(
        self,
        max_days: int = 30,
        max_actions_per_day: int = 10,
        run_id: str = "run_001",
    ) -> VendingBenchResult:
        """
        Run a complete simulation.

        Args:
            max_days: Maximum number of days to simulate
            max_actions_per_day: Maximum actions per day
            run_id: Unique identifier for this run

        Returns:
            Results of the simulation
        """
        initial_cash = self.env.state.cash_on_hand
        all_actions: list[AgentAction] = []

        for day in range(1, max_days + 1):
            # Run the day
            day_actions = await self.run_day(day, max_actions_per_day)
            all_actions.extend(day_actions)

            # Update daily summary with actions
            if self.env.state.daily_history:
                self.env.state.daily_history[-1].agent_actions = [
                    a.action_type.value for a in day_actions
                ]

            # Check termination conditions
            net_worth = self.env.get_net_worth()
            if net_worth < Decimal("0"):
                break  # Bankrupt

        # Calculate final metrics
        state = self.env.state
        final_net_worth = self.env.get_net_worth()

        total_revenue = sum((s.total_revenue for s in state.daily_history), Decimal("0"))
        total_fees = sum((s.operational_fees for s in state.daily_history), Decimal("0"))
        total_order_costs = sum(
            (o.total_cost for o in state.order_history + state.pending_orders), Decimal("0")
        )
        items_sold = sum(sum(sale.quantity for sale in s.sales) for s in state.daily_history)
        stockout_days = sum(1 for s in state.daily_history if s.stockout_products)

        total_latency = sum(a.latency_ms for a in all_actions)

        return VendingBenchResult(
            run_id=run_id,
            simulation_days=len(state.daily_history),
            final_net_worth=final_net_worth,
            initial_cash=initial_cash,
            profit=final_net_worth - initial_cash,
            total_revenue=total_revenue,
            total_costs=total_order_costs,
            total_operational_fees=total_fees,
            items_sold=items_sold,
            orders_placed=len(state.order_history) + len(state.pending_orders),
            successful_deliveries=sum(
                1
                for o in state.order_history + state.pending_orders
                if o.status.value == "delivered"
            ),
            stockout_days=stockout_days,
            coherence_errors=[],  # Filled in by evaluator
            daily_summaries=state.daily_history,
            actions=all_actions,
            total_tokens=self.total_tokens,
            total_latency_ms=total_latency,
        )


class MockLLMProvider:
    """Mock LLM provider for testing."""

    def __init__(self, responses: list[str] | None = None) -> None:
        self.responses = responses or []
        self.call_count = 0

    async def generate(
        self,
        system_prompt: str,
        user_prompt: str,
        temperature: float = 0.0,
    ) -> tuple[str, int]:
        """Return mock responses."""
        if self.responses and self.call_count < len(self.responses):
            response = self.responses[self.call_count]
            self.call_count += 1
            return response, 100  # Mock 100 tokens
        return '{"action": "ADVANCE_DAY"}', 50
