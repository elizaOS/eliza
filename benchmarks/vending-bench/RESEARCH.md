# Vending-Bench Research & Implementation Plan

## Implementation Status: ✅ COMPLETE

The Vending-Bench benchmark has been fully implemented and tested with the ElizaOS Python agent. See `BENCHMARK-RESULTS.md` for the latest benchmark results.

### Quick Results (Heuristic Agent Baseline)

| Metric | Value |
|--------|-------|
| Best Net Worth | $559.60 |
| Average Net Worth | $530.15 |
| Profitability Rate | 100% |
| Leaderboard Rank | #7 of 7 |

---

## Overview

Vending-Bench is a benchmark designed to evaluate the long-term coherence of Large Language Model (LLM) agents by simulating the operation of a vending machine business. Agents are tasked with managing inventory, placing orders, setting prices, and handling daily operational fees over extended periods, testing their ability to maintain consistent and effective decision-making over long horizons.

## Key Resources

### Official Resources
- **Research Paper**: https://arxiv.org/abs/2502.15840
- **Paper PDF**: https://lukaspetersson.com/assets/pdf/vbench_paper.pdf
- **Andon Labs**: https://andonlabs.com/evals/vending-bench

### Framework
- Built using AISI's **inspect-ai** framework with custom multi-agent extensions

## Benchmark Structure

### Initial Conditions
- Starting balance: **$500**
- Vending machine configuration: **4 rows × 3 slots** (12 total slots)
- Accommodates both **small and large items**
- Daily operational fees apply

### Agent Responsibilities
1. **Inventory Management**: Track stock levels, decide when to reorder
2. **Order Placement**: Contact suppliers, manage delivery schedules
3. **Price Setting**: Optimize prices based on demand
4. **Financial Tracking**: Monitor revenue, costs, and net worth
5. **Customer Interaction**: Handle sales and service issues

### Economic Model
- **Price Elasticity**: Demand responds to price changes
- **Seasonal Variations**: Sales fluctuate with time of year
- **External Conditions**: Weather affects purchasing behavior
- **Supplier Relationships**: Lead times, minimum orders, bulk discounts

### Evaluation Metrics
- **Net Worth**: Cash on hand + Cash in machine + Value of unsold inventory
- **Consistency**: Ability to maintain coherent decisions over time
- **Error Recovery**: How well agent recovers from mistakes

## Current Leaderboard

| Model | Top Score |
|-------|-----------|
| Grok 4 | 4,694.15 |
| Claude 3.5 Sonnet | 2,217.93 |
| Claude Opus 4 | 2,077.41 |

### Common Failure Modes
- Misinterpreting delivery schedules
- Forgetting placed orders
- Entering unproductive loops
- Price optimization errors
- Inventory tracking mistakes

## Technical Architecture

### Environment Features
- **Context Window**: 30,000 tokens
- **External Memory Tools**:
  - Scratchpad for notes
  - Key-value store for structured data
  - Vector database for semantic retrieval (using text-embedding-3-small)

### Agent Interface
- **Remote Tasks**: Sending emails, web searches, placing orders
- **Physical Tasks**: Delegated to sub-agent (restocking, price changes)
- **Sub-Agent Tools**: `sub_agent_specs`, `run_sub_agent`, `chat_with_sub_agent`

## Implementation Plan for ElizaOS

### Phase 1: Core Types and Data Structures

```python
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional
from datetime import datetime, date
from decimal import Decimal

class ItemSize(Enum):
    SMALL = "small"
    LARGE = "large"

class OrderStatus(Enum):
    PENDING = "pending"
    CONFIRMED = "confirmed"
    IN_TRANSIT = "in_transit"
    DELIVERED = "delivered"
    CANCELLED = "cancelled"

class WeatherCondition(Enum):
    SUNNY = "sunny"
    CLOUDY = "cloudy"
    RAINY = "rainy"
    SNOWY = "snowy"
    HOT = "hot"
    COLD = "cold"

class Season(Enum):
    SPRING = "spring"
    SUMMER = "summer"
    FALL = "fall"
    WINTER = "winter"

@dataclass
class Product:
    """Represents a product that can be sold."""
    product_id: str
    name: str
    size: ItemSize
    cost_price: Decimal
    suggested_retail: Decimal
    shelf_life_days: int
    popularity_base: float  # 0-1 base demand
    weather_modifiers: dict[WeatherCondition, float] = field(default_factory=dict)
    season_modifiers: dict[Season, float] = field(default_factory=dict)

@dataclass
class InventorySlot:
    """Represents a slot in the vending machine."""
    row: int
    column: int
    product: Optional[Product]
    quantity: int
    price: Decimal
    max_capacity: int

@dataclass
class VendingMachine:
    """Represents the vending machine state."""
    slots: list[InventorySlot]
    cash_in_machine: Decimal
    location: str
    rows: int = 4
    columns: int = 3

@dataclass
class Supplier:
    """Represents a product supplier."""
    supplier_id: str
    name: str
    products: list[str]  # Product IDs
    lead_time_days: int
    minimum_order: int
    bulk_discount_threshold: int
    bulk_discount_percent: float

@dataclass
class Order:
    """Represents a supply order."""
    order_id: str
    supplier_id: str
    items: dict[str, int]  # Product ID -> quantity
    status: OrderStatus
    order_date: date
    expected_delivery: date
    actual_delivery: Optional[date]
    total_cost: Decimal

@dataclass
class DailySummary:
    """Summary of a single day's operations."""
    date: date
    weather: WeatherCondition
    season: Season
    sales: list[tuple[str, int, Decimal]]  # Product ID, quantity, revenue
    total_revenue: Decimal
    operational_fees: Decimal
    deliveries_received: list[str]  # Order IDs
    ending_cash: Decimal
    ending_inventory_value: Decimal

@dataclass
class AgentState:
    """Complete state of the vending business."""
    current_date: date
    cash_on_hand: Decimal
    machine: VendingMachine
    pending_orders: list[Order]
    order_history: list[Order]
    daily_history: list[DailySummary]
    notes: dict[str, str]  # Scratchpad
    kv_store: dict[str, str]  # Key-value store

@dataclass
class VendingBenchResult:
    """Result of a Vending-Bench simulation."""
    simulation_days: int
    final_net_worth: Decimal
    total_revenue: Decimal
    total_costs: Decimal
    total_operational_fees: Decimal
    items_sold: int
    orders_placed: int
    successful_deliveries: int
    stockout_days: int  # Days with zero inventory
    decision_errors: int  # Detected coherence failures
    daily_summaries: list[DailySummary]

@dataclass
class VendingBenchReport:
    """Aggregate report for multiple simulation runs."""
    runs: int
    avg_net_worth: Decimal
    max_net_worth: Decimal
    min_net_worth: Decimal
    success_rate: float  # Runs that ended profitable
    avg_simulation_days: float
    coherence_score: float  # 0-1 based on error rate
    results: list[VendingBenchResult]
```

### Phase 2: Economic Simulation

```python
import random
from decimal import Decimal

class EconomicModel:
    """Simulates economic conditions affecting the vending business."""
    
    def __init__(self, seed: Optional[int] = None):
        self.rng = random.Random(seed)
        
    def calculate_demand(
        self,
        product: Product,
        price: Decimal,
        weather: WeatherCondition,
        season: Season,
        day_of_week: int
    ) -> int:
        """Calculate expected demand for a product."""
        # Base demand
        base = product.popularity_base * 10  # Base sales per day
        
        # Price elasticity (demand decreases as price increases)
        price_ratio = float(price / product.suggested_retail)
        price_modifier = max(0.1, 2.0 - price_ratio)  # Higher price = lower demand
        
        # Weather modifier
        weather_mod = product.weather_modifiers.get(weather, 1.0)
        
        # Season modifier
        season_mod = product.season_modifiers.get(season, 1.0)
        
        # Weekend boost
        weekend_mod = 1.3 if day_of_week >= 5 else 1.0
        
        # Calculate expected demand
        expected = base * price_modifier * weather_mod * season_mod * weekend_mod
        
        # Add randomness
        actual = max(0, int(self.rng.gauss(expected, expected * 0.3)))
        
        return actual
    
    def get_weather(self, date: date) -> WeatherCondition:
        """Get weather for a given date (simulated)."""
        season = self.get_season(date)
        
        # Season-based weather probabilities
        if season == Season.SUMMER:
            choices = [WeatherCondition.SUNNY, WeatherCondition.HOT, WeatherCondition.CLOUDY]
            weights = [0.5, 0.3, 0.2]
        elif season == Season.WINTER:
            choices = [WeatherCondition.COLD, WeatherCondition.SNOWY, WeatherCondition.CLOUDY]
            weights = [0.4, 0.3, 0.3]
        else:
            choices = [WeatherCondition.SUNNY, WeatherCondition.CLOUDY, WeatherCondition.RAINY]
            weights = [0.4, 0.4, 0.2]
        
        return self.rng.choices(choices, weights)[0]
    
    def get_season(self, date: date) -> Season:
        """Get season for a given date."""
        month = date.month
        if month in [3, 4, 5]:
            return Season.SPRING
        elif month in [6, 7, 8]:
            return Season.SUMMER
        elif month in [9, 10, 11]:
            return Season.FALL
        else:
            return Season.WINTER
    
    def calculate_operational_fees(self, machine: VendingMachine) -> Decimal:
        """Calculate daily operational fees."""
        # Base fee + per-slot fee
        base_fee = Decimal("5.00")
        slot_fee = Decimal("0.50") * (machine.rows * machine.columns)
        return base_fee + slot_fee


class VendingEnvironment:
    """Simulates the vending machine business environment."""
    
    def __init__(
        self,
        initial_cash: Decimal = Decimal("500.00"),
        seed: Optional[int] = None
    ):
        self.economic_model = EconomicModel(seed)
        self.state = self._initialize_state(initial_cash)
        self.suppliers = self._initialize_suppliers()
        self.products = self._initialize_products()
    
    def _initialize_state(self, initial_cash: Decimal) -> AgentState:
        """Initialize the business state."""
        machine = VendingMachine(
            slots=[
                InventorySlot(
                    row=r, column=c,
                    product=None, quantity=0,
                    price=Decimal("0"), max_capacity=10 if r < 2 else 6
                )
                for r in range(4) for c in range(3)
            ],
            cash_in_machine=Decimal("0"),
            location="Office Building Lobby"
        )
        
        return AgentState(
            current_date=date.today(),
            cash_on_hand=initial_cash,
            machine=machine,
            pending_orders=[],
            order_history=[],
            daily_history=[],
            notes={},
            kv_store={}
        )
    
    def _initialize_suppliers(self) -> list[Supplier]:
        """Initialize available suppliers."""
        return [
            Supplier(
                supplier_id="snack_co",
                name="SnackCo Wholesale",
                products=["chips", "cookies", "crackers"],
                lead_time_days=2,
                minimum_order=10,
                bulk_discount_threshold=50,
                bulk_discount_percent=10
            ),
            Supplier(
                supplier_id="beverage_dist",
                name="Beverage Distributors",
                products=["soda", "water", "juice"],
                lead_time_days=1,
                minimum_order=12,
                bulk_discount_threshold=48,
                bulk_discount_percent=15
            ),
            Supplier(
                supplier_id="healthy_choice",
                name="Healthy Choice Supplies",
                products=["protein_bar", "nuts", "dried_fruit"],
                lead_time_days=3,
                minimum_order=20,
                bulk_discount_threshold=100,
                bulk_discount_percent=12
            )
        ]
    
    def _initialize_products(self) -> dict[str, Product]:
        """Initialize available products."""
        return {
            "chips": Product(
                product_id="chips",
                name="Potato Chips",
                size=ItemSize.SMALL,
                cost_price=Decimal("0.75"),
                suggested_retail=Decimal("1.50"),
                shelf_life_days=90,
                popularity_base=0.7,
                weather_modifiers={WeatherCondition.HOT: 0.8},
                season_modifiers={Season.SUMMER: 1.2}
            ),
            "soda": Product(
                product_id="soda",
                name="Cola",
                size=ItemSize.SMALL,
                cost_price=Decimal("0.50"),
                suggested_retail=Decimal("1.25"),
                shelf_life_days=180,
                popularity_base=0.9,
                weather_modifiers={WeatherCondition.HOT: 1.5, WeatherCondition.COLD: 0.7},
                season_modifiers={Season.SUMMER: 1.4}
            ),
            "water": Product(
                product_id="water",
                name="Bottled Water",
                size=ItemSize.SMALL,
                cost_price=Decimal("0.30"),
                suggested_retail=Decimal("1.00"),
                shelf_life_days=365,
                popularity_base=0.8,
                weather_modifiers={WeatherCondition.HOT: 1.8},
                season_modifiers={}
            ),
            "protein_bar": Product(
                product_id="protein_bar",
                name="Protein Bar",
                size=ItemSize.LARGE,
                cost_price=Decimal("1.50"),
                suggested_retail=Decimal("3.00"),
                shelf_life_days=60,
                popularity_base=0.5,
                weather_modifiers={},
                season_modifiers={Season.SPRING: 1.3}  # New Year resolutions
            )
        }
    
    def simulate_day(self) -> DailySummary:
        """Simulate a single day of operations."""
        current_date = self.state.current_date
        weather = self.economic_model.get_weather(current_date)
        season = self.economic_model.get_season(current_date)
        
        sales: list[tuple[str, int, Decimal]] = []
        total_revenue = Decimal("0")
        
        # Process sales for each slot
        for slot in self.state.machine.slots:
            if slot.product and slot.quantity > 0:
                demand = self.economic_model.calculate_demand(
                    slot.product, slot.price, weather, season,
                    current_date.weekday()
                )
                
                actual_sales = min(demand, slot.quantity)
                revenue = slot.price * actual_sales
                
                slot.quantity -= actual_sales
                sales.append((slot.product.product_id, actual_sales, revenue))
                total_revenue += revenue
        
        # Add revenue to machine
        self.state.machine.cash_in_machine += total_revenue
        
        # Process deliveries
        delivered = []
        for order in self.state.pending_orders:
            if order.expected_delivery <= current_date and order.status == OrderStatus.IN_TRANSIT:
                order.status = OrderStatus.DELIVERED
                order.actual_delivery = current_date
                delivered.append(order.order_id)
                # (Agent must restock manually)
        
        # Deduct operational fees
        fees = self.economic_model.calculate_operational_fees(self.state.machine)
        self.state.cash_on_hand -= fees
        
        # Calculate inventory value
        inventory_value = sum(
            slot.product.cost_price * slot.quantity
            for slot in self.state.machine.slots
            if slot.product
        )
        
        summary = DailySummary(
            date=current_date,
            weather=weather,
            season=season,
            sales=sales,
            total_revenue=total_revenue,
            operational_fees=fees,
            deliveries_received=delivered,
            ending_cash=self.state.cash_on_hand,
            ending_inventory_value=inventory_value
        )
        
        self.state.daily_history.append(summary)
        self.state.current_date = date.fromordinal(current_date.toordinal() + 1)
        
        return summary
    
    def get_net_worth(self) -> Decimal:
        """Calculate current net worth."""
        inventory_value = sum(
            slot.product.cost_price * slot.quantity
            for slot in self.state.machine.slots
            if slot.product
        )
        return (
            self.state.cash_on_hand +
            self.state.machine.cash_in_machine +
            inventory_value
        )
```

### Phase 3: ElizaOS Agent Actions

```python
from elizaos import Action, Plugin, Provider
from elizaos.runtime import AgentRuntime
from elizaos.types import Memory, State, Content

# View current state
view_state_action = Action(
    name="VIEW_BUSINESS_STATE",
    description="View the current state of your vending machine business",
    parameters={
        "type": "object",
        "properties": {},
        "required": []
    },
    handler=None
)

# Set price action
set_price_action = Action(
    name="SET_PRICE",
    description="Set the price for a product in a specific slot",
    parameters={
        "type": "object",
        "properties": {
            "row": {"type": "integer", "description": "Slot row (0-3)"},
            "column": {"type": "integer", "description": "Slot column (0-2)"},
            "price": {"type": "number", "description": "New price in dollars"}
        },
        "required": ["row", "column", "price"]
    },
    handler=None
)

# Place order action
place_order_action = Action(
    name="PLACE_ORDER",
    description="Place an order with a supplier",
    parameters={
        "type": "object",
        "properties": {
            "supplier_id": {"type": "string", "description": "ID of the supplier"},
            "items": {
                "type": "object",
                "description": "Product IDs mapped to quantities",
                "additionalProperties": {"type": "integer"}
            }
        },
        "required": ["supplier_id", "items"]
    },
    handler=None
)

# Restock slot action
restock_action = Action(
    name="RESTOCK_SLOT",
    description="Restock a vending machine slot from delivered inventory",
    parameters={
        "type": "object",
        "properties": {
            "row": {"type": "integer", "description": "Slot row (0-3)"},
            "column": {"type": "integer", "description": "Slot column (0-2)"},
            "product_id": {"type": "string", "description": "Product to stock"},
            "quantity": {"type": "integer", "description": "Number of items"}
        },
        "required": ["row", "column", "product_id", "quantity"]
    },
    handler=None
)

# Collect cash action
collect_cash_action = Action(
    name="COLLECT_CASH",
    description="Collect cash from the vending machine",
    parameters={
        "type": "object",
        "properties": {},
        "required": []
    },
    handler=None
)

# Update notes action
update_notes_action = Action(
    name="UPDATE_NOTES",
    description="Update your scratchpad notes for memory",
    parameters={
        "type": "object",
        "properties": {
            "key": {"type": "string", "description": "Note key/title"},
            "content": {"type": "string", "description": "Note content"}
        },
        "required": ["key", "content"]
    },
    handler=None
)

# View suppliers action
view_suppliers_action = Action(
    name="VIEW_SUPPLIERS",
    description="View available suppliers and their products",
    parameters={
        "type": "object",
        "properties": {},
        "required": []
    },
    handler=None
)

# Advance day action
advance_day_action = Action(
    name="ADVANCE_DAY",
    description="Finish your actions for today and move to the next day",
    parameters={
        "type": "object",
        "properties": {},
        "required": []
    },
    handler=None
)


class VendingAgent:
    """ElizaOS agent for Vending-Bench simulation."""
    
    def __init__(self, runtime: AgentRuntime, environment: VendingEnvironment):
        self.runtime = runtime
        self.environment = environment
        self._setup_actions()
    
    def _setup_actions(self) -> None:
        """Configure action handlers."""
        
        async def view_state_handler(params: dict, state: State) -> Content:
            env_state = self.environment.state
            machine = env_state.machine
            
            # Build slot summary
            slot_info = []
            for slot in machine.slots:
                if slot.product:
                    slot_info.append(
                        f"  [{slot.row},{slot.column}] {slot.product.name}: "
                        f"{slot.quantity}/{slot.max_capacity} @ ${slot.price}"
                    )
                else:
                    slot_info.append(f"  [{slot.row},{slot.column}] Empty")
            
            return Content(text=f"""
=== Business State ===
Date: {env_state.current_date}
Cash on Hand: ${env_state.cash_on_hand}
Cash in Machine: ${machine.cash_in_machine}
Net Worth: ${self.environment.get_net_worth()}

=== Vending Machine ===
{chr(10).join(slot_info)}

=== Pending Orders ===
{chr(10).join(f"  {o.order_id}: {o.status.value} (expected: {o.expected_delivery})" for o in env_state.pending_orders) or "  None"}

=== Notes ===
{chr(10).join(f"  {k}: {v}" for k, v in env_state.notes.items()) or "  None"}
""")
        
        async def set_price_handler(params: dict, state: State) -> Content:
            row, col = params["row"], params["column"]
            price = Decimal(str(params["price"]))
            
            for slot in self.environment.state.machine.slots:
                if slot.row == row and slot.column == col:
                    slot.price = price
                    return Content(text=f"Price set to ${price} for slot [{row},{col}]")
            
            return Content(text=f"Slot [{row},{col}] not found")
        
        async def place_order_handler(params: dict, state: State) -> Content:
            supplier_id = params["supplier_id"]
            items = params["items"]
            
            supplier = next(
                (s for s in self.environment.suppliers if s.supplier_id == supplier_id),
                None
            )
            if not supplier:
                return Content(text=f"Supplier '{supplier_id}' not found")
            
            # Calculate cost
            total_cost = Decimal("0")
            total_items = 0
            for product_id, qty in items.items():
                if product_id not in self.environment.products:
                    return Content(text=f"Product '{product_id}' not found")
                if product_id not in supplier.products:
                    return Content(text=f"Supplier doesn't carry '{product_id}'")
                
                product = self.environment.products[product_id]
                total_cost += product.cost_price * qty
                total_items += qty
            
            if total_items < supplier.minimum_order:
                return Content(text=f"Minimum order is {supplier.minimum_order} items")
            
            # Apply bulk discount
            if total_items >= supplier.bulk_discount_threshold:
                discount = total_cost * Decimal(str(supplier.bulk_discount_percent / 100))
                total_cost -= discount
            
            if total_cost > self.environment.state.cash_on_hand:
                return Content(text=f"Insufficient funds. Cost: ${total_cost}, Available: ${self.environment.state.cash_on_hand}")
            
            # Create order
            order = Order(
                order_id=f"ORD-{len(self.environment.state.order_history) + 1:04d}",
                supplier_id=supplier_id,
                items=items,
                status=OrderStatus.CONFIRMED,
                order_date=self.environment.state.current_date,
                expected_delivery=date.fromordinal(
                    self.environment.state.current_date.toordinal() + supplier.lead_time_days
                ),
                actual_delivery=None,
                total_cost=total_cost
            )
            
            self.environment.state.cash_on_hand -= total_cost
            self.environment.state.pending_orders.append(order)
            
            return Content(text=f"Order {order.order_id} placed. Cost: ${total_cost}. Expected delivery: {order.expected_delivery}")
        
        async def restock_handler(params: dict, state: State) -> Content:
            row, col = params["row"], params["column"]
            product_id = params["product_id"]
            quantity = params["quantity"]
            
            # Find slot
            slot = next(
                (s for s in self.environment.state.machine.slots 
                 if s.row == row and s.column == col),
                None
            )
            if not slot:
                return Content(text=f"Slot [{row},{col}] not found")
            
            # Check delivered orders for this product
            delivered_qty = 0
            for order in self.environment.state.pending_orders:
                if order.status == OrderStatus.DELIVERED:
                    delivered_qty += order.items.get(product_id, 0)
            
            if delivered_qty < quantity:
                return Content(text=f"Only {delivered_qty} units of {product_id} available from deliveries")
            
            product = self.environment.products.get(product_id)
            if not product:
                return Content(text=f"Product '{product_id}' not found")
            
            # Check capacity
            if slot.quantity + quantity > slot.max_capacity:
                return Content(text=f"Slot capacity is {slot.max_capacity}, currently has {slot.quantity}")
            
            slot.product = product
            slot.quantity += quantity
            
            return Content(text=f"Restocked slot [{row},{col}] with {quantity} {product.name}")
        
        async def collect_cash_handler(params: dict, state: State) -> Content:
            amount = self.environment.state.machine.cash_in_machine
            self.environment.state.cash_on_hand += amount
            self.environment.state.machine.cash_in_machine = Decimal("0")
            return Content(text=f"Collected ${amount} from machine")
        
        async def update_notes_handler(params: dict, state: State) -> Content:
            key = params["key"]
            content = params["content"]
            self.environment.state.notes[key] = content
            return Content(text=f"Note '{key}' updated")
        
        async def view_suppliers_handler(params: dict, state: State) -> Content:
            lines = ["=== Available Suppliers ==="]
            for s in self.environment.suppliers:
                lines.append(f"\n{s.name} ({s.supplier_id}):")
                lines.append(f"  Products: {', '.join(s.products)}")
                lines.append(f"  Lead time: {s.lead_time_days} days")
                lines.append(f"  Min order: {s.minimum_order} items")
                lines.append(f"  Bulk discount: {s.bulk_discount_percent}% on {s.bulk_discount_threshold}+ items")
            return Content(text="\n".join(lines))
        
        async def advance_day_handler(params: dict, state: State) -> Content:
            # Update order statuses
            for order in self.environment.state.pending_orders:
                if order.status == OrderStatus.CONFIRMED:
                    order.status = OrderStatus.IN_TRANSIT
            
            summary = self.environment.simulate_day()
            
            return Content(text=f"""
=== Day Completed: {summary.date} ===
Weather: {summary.weather.value}
Season: {summary.season.value}

Sales:
{chr(10).join(f"  {pid}: {qty} sold @ ${rev}" for pid, qty, rev in summary.sales) or "  No sales"}

Total Revenue: ${summary.total_revenue}
Operational Fees: ${summary.operational_fees}
Ending Cash: ${summary.ending_cash}
Inventory Value: ${summary.ending_inventory_value}

Deliveries Received: {', '.join(summary.deliveries_received) or 'None'}
""")
        
        view_state_action.handler = view_state_handler
        set_price_action.handler = set_price_handler
        place_order_action.handler = place_order_handler
        restock_action.handler = restock_handler
        collect_cash_action.handler = collect_cash_handler
        update_notes_action.handler = update_notes_handler
        view_suppliers_action.handler = view_suppliers_handler
        advance_day_action.handler = advance_day_handler
    
    async def run_simulation(
        self,
        max_days: int = 30,
        target_net_worth: Optional[Decimal] = None
    ) -> VendingBenchResult:
        """Run the vending business simulation."""
        system_prompt = self._build_system_prompt()
        
        tokens_used = 0
        decision_errors = 0
        
        for day in range(max_days):
            # Build context for the day
            user_prompt = self._build_daily_prompt()
            
            # Get agent's decisions
            max_actions_per_day = 10
            for _ in range(max_actions_per_day):
                response = await self.runtime.generate_response(
                    system_prompt=system_prompt,
                    user_prompt=user_prompt,
                    actions=[
                        view_state_action,
                        set_price_action,
                        place_order_action,
                        restock_action,
                        collect_cash_action,
                        update_notes_action,
                        view_suppliers_action,
                        advance_day_action
                    ]
                )
                
                tokens_used += response.tokens_used
                
                # Check for coherence errors
                if self._check_coherence_error(response):
                    decision_errors += 1
                
                # Execute action
                if response.action:
                    action_result = await response.action.handler(
                        response.action.parameters, {}
                    )
                    
                    if response.action.name == "ADVANCE_DAY":
                        break
                    
                    user_prompt = f"Action result:\n{action_result.text}\n\nWhat would you like to do next?"
            
            # Check termination conditions
            net_worth = self.environment.get_net_worth()
            if net_worth < 0:
                break  # Bankrupt
            if target_net_worth and net_worth >= target_net_worth:
                break  # Target reached
        
        # Calculate final results
        state = self.environment.state
        total_revenue = sum(s.total_revenue for s in state.daily_history)
        total_fees = sum(s.operational_fees for s in state.daily_history)
        total_costs = sum(o.total_cost for o in state.order_history)
        items_sold = sum(sum(qty for _, qty, _ in s.sales) for s in state.daily_history)
        
        return VendingBenchResult(
            simulation_days=len(state.daily_history),
            final_net_worth=self.environment.get_net_worth(),
            total_revenue=total_revenue,
            total_costs=total_costs,
            total_operational_fees=total_fees,
            items_sold=items_sold,
            orders_placed=len(state.order_history),
            successful_deliveries=sum(1 for o in state.order_history if o.status == OrderStatus.DELIVERED),
            stockout_days=sum(
                1 for s in state.daily_history
                if all(sale[1] == 0 for sale in s.sales)
            ),
            decision_errors=decision_errors,
            daily_summaries=state.daily_history
        )
    
    def _build_system_prompt(self) -> str:
        return """You are managing a vending machine business. Your goal is to maximize 
profit over the simulation period by:
1. Keeping the machine stocked with products
2. Setting optimal prices based on demand
3. Managing orders efficiently
4. Minimizing stockouts and waste

Available actions:
- VIEW_BUSINESS_STATE: Check current inventory, cash, orders
- VIEW_SUPPLIERS: See supplier options and pricing
- PLACE_ORDER: Order products from suppliers
- RESTOCK_SLOT: Put delivered products in machine slots
- SET_PRICE: Adjust product prices
- COLLECT_CASH: Collect revenue from machine
- UPDATE_NOTES: Keep notes for yourself
- ADVANCE_DAY: End your turn and proceed to next day

Tips:
- Track your orders and delivery dates
- Consider weather and season effects on demand
- Don't let products expire
- Watch your cash flow carefully
- Use notes to remember important information"""
    
    def _build_daily_prompt(self) -> str:
        state = self.environment.state
        yesterday = state.daily_history[-1] if state.daily_history else None
        
        prompt = f"Today is {state.current_date}.\n"
        
        if yesterday:
            prompt += f"\nYesterday's summary:\n"
            prompt += f"- Revenue: ${yesterday.total_revenue}\n"
            prompt += f"- Weather: {yesterday.weather.value}\n"
            prompt += f"- Items sold: {sum(qty for _, qty, _ in yesterday.sales)}\n"
        
        prompt += f"\nCurrent net worth: ${self.environment.get_net_worth()}"
        prompt += "\n\nWhat would you like to do today?"
        
        return prompt
    
    def _check_coherence_error(self, response) -> bool:
        """Check for signs of coherence failure."""
        # Examples of coherence errors:
        # - Ordering products that were just delivered
        # - Forgetting about pending orders
        # - Setting prices inconsistently
        # TODO: Implement detailed coherence checking
        return False
```

### Phase 4: Benchmark Runner

```python
import asyncio
from pathlib import Path
from typing import Optional
import json

class VendingBenchRunner:
    """Orchestrates Vending-Bench evaluation."""
    
    def __init__(
        self,
        runtime: AgentRuntime,
        output_path: Path,
        seed: Optional[int] = None
    ):
        self.runtime = runtime
        self.output_path = output_path
        self.seed = seed
    
    async def run(
        self,
        num_runs: int = 5,
        max_days_per_run: int = 30,
        initial_cash: Decimal = Decimal("500.00")
    ) -> VendingBenchReport:
        """Run multiple simulation trials."""
        results: list[VendingBenchResult] = []
        
        for run_idx in range(num_runs):
            print(f"Starting run {run_idx + 1}/{num_runs}")
            
            # Create fresh environment
            environment = VendingEnvironment(
                initial_cash=initial_cash,
                seed=self.seed + run_idx if self.seed else None
            )
            
            # Create agent
            agent = VendingAgent(self.runtime, environment)
            
            # Run simulation
            result = await agent.run_simulation(max_days=max_days_per_run)
            results.append(result)
            
            print(f"  Final net worth: ${result.final_net_worth}")
            print(f"  Days simulated: {result.simulation_days}")
        
        # Calculate aggregate metrics
        net_worths = [r.final_net_worth for r in results]
        
        report = VendingBenchReport(
            runs=num_runs,
            avg_net_worth=Decimal(str(sum(net_worths) / len(net_worths))),
            max_net_worth=max(net_worths),
            min_net_worth=min(net_worths),
            success_rate=sum(1 for nw in net_worths if nw > Decimal("500")) / num_runs,
            avg_simulation_days=sum(r.simulation_days for r in results) / num_runs,
            coherence_score=1.0 - sum(r.decision_errors for r in results) / (num_runs * 100),
            results=results
        )
        
        await self._save_report(report)
        
        return report
    
    async def _save_report(self, report: VendingBenchReport) -> None:
        """Save report to disk."""
        self.output_path.mkdir(parents=True, exist_ok=True)
        
        report_path = self.output_path / f"report_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        
        with open(report_path, 'w') as f:
            json.dump({
                "runs": report.runs,
                "avg_net_worth": str(report.avg_net_worth),
                "max_net_worth": str(report.max_net_worth),
                "min_net_worth": str(report.min_net_worth),
                "success_rate": report.success_rate,
                "avg_simulation_days": report.avg_simulation_days,
                "coherence_score": report.coherence_score
            }, f, indent=2)


# Plugin definition
vending_bench_plugin = Plugin(
    name="vending-bench",
    description="Vending-Bench simulation for ElizaOS",
    actions=[
        view_state_action,
        set_price_action,
        place_order_action,
        restock_action,
        collect_cash_action,
        update_notes_action,
        view_suppliers_action,
        advance_day_action
    ],
    providers=[],
    evaluators=[]
)
```

## Implementation Status

### Completed Components ✅

- [x] **Types Module** (`types.py`) - All data classes and enums
- [x] **Economic Model** (`environment.py`) - Demand calculation, weather, seasons
- [x] **Environment** (`environment.py`) - Full vending simulation with actions
- [x] **Agent** (`agent.py`) - LLM integration and heuristic baseline
- [x] **Evaluator** (`evaluator.py`) - Coherence error detection
- [x] **Runner** (`runner.py`) - Benchmark orchestration
- [x] **Reporter** (`reporting.py`) - Markdown report generation
- [x] **CLI** (`cli.py`) - Command-line interface
- [x] **Tests** (83 tests passing)
- [x] **Benchmark Results** - Published with leaderboard comparison

### Running the Benchmark

```bash
# Using CLI
cd benchmarks/vending-bench/python
vending-bench run --runs 10 --days 30

# Using Python directly
python run_benchmark.py

# Run tests
pytest elizaos_vending_bench/tests/ -v
```

## Key Challenges

1. **Long-term Memory**: Agent must remember orders, prices, and decisions across many days
2. **Economic Reasoning**: Understanding price elasticity and demand patterns
3. **Planning Ahead**: Anticipating supplier lead times and seasonal changes
4. **Error Recovery**: Handling mistakes gracefully without compounding errors
5. **Coherence Maintenance**: Avoiding contradictory decisions over time

## Success Metrics

- Primary: Final net worth (higher is better)
- Secondary: Coherence score (fewer decision errors)
- Tertiary: Efficiency (profit per action/token)
