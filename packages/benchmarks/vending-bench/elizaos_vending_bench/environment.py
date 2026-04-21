"""
Vending-Bench Environment

Implements the economic simulation for the vending machine business.
Handles demand calculation, weather effects, supplier logistics, and daily operations.
"""

import random
import uuid
from datetime import date, timedelta
from decimal import Decimal

from elizaos_vending_bench.types import (
    AgentState,
    DailySummary,
    DeliveredInventory,
    InventorySlot,
    ItemSize,
    Order,
    OrderStatus,
    Product,
    Sale,
    Season,
    Supplier,
    VendingMachine,
    WeatherCondition,
)


class EconomicModel:
    """Simulates economic conditions affecting the vending business."""

    def __init__(self, seed: int | None = None) -> None:
        """Initialize the economic model with optional random seed."""
        self.rng = random.Random(seed)

    def calculate_demand(
        self,
        product: Product,
        price: Decimal,
        weather: WeatherCondition,
        season: Season,
        day_of_week: int,
    ) -> int:
        """
        Calculate expected demand for a product based on various factors.

        Args:
            product: The product to calculate demand for
            price: Current selling price
            weather: Current weather condition
            season: Current season
            day_of_week: Day of week (0=Monday, 6=Sunday)

        Returns:
            Expected number of units that could be sold
        """
        # Base demand from popularity
        base = product.popularity_base * 10  # Scale to ~0-10 units/day

        # Price elasticity (demand decreases as price increases above suggested)
        price_ratio = (
            float(price / product.suggested_retail) if product.suggested_retail > 0 else 1.0
        )
        # Higher price = lower demand, but never fully zero
        price_modifier = max(0.1, 2.0 - price_ratio)

        # Weather modifier
        weather_mod = product.weather_modifiers.get(weather, 1.0)

        # Season modifier
        season_mod = product.season_modifiers.get(season, 1.0)

        # Weekend boost (people buy more snacks on weekends)
        weekend_mod = 1.3 if day_of_week >= 5 else 1.0

        # Calculate expected demand
        expected = base * price_modifier * weather_mod * season_mod * weekend_mod

        # Add randomness (Poisson-like distribution approximation)
        actual = max(0, int(self.rng.gauss(expected, expected * 0.3)))

        return actual

    def get_weather(self, sim_date: date, seed_offset: int = 0) -> WeatherCondition:
        """
        Get weather for a given date (simulated with seasonal patterns).

        Args:
            sim_date: The simulation date
            seed_offset: Additional seed offset for variety

        Returns:
            Weather condition for the day
        """
        season = self.get_season(sim_date)

        # Season-based weather probabilities
        if season == Season.SUMMER:
            choices = [WeatherCondition.SUNNY, WeatherCondition.HOT, WeatherCondition.CLOUDY]
            weights = [0.5, 0.35, 0.15]
        elif season == Season.WINTER:
            choices = [WeatherCondition.COLD, WeatherCondition.SNOWY, WeatherCondition.CLOUDY]
            weights = [0.4, 0.25, 0.35]
        elif season == Season.SPRING:
            choices = [WeatherCondition.SUNNY, WeatherCondition.CLOUDY, WeatherCondition.RAINY]
            weights = [0.4, 0.35, 0.25]
        else:  # Fall
            choices = [WeatherCondition.CLOUDY, WeatherCondition.RAINY, WeatherCondition.SUNNY]
            weights = [0.45, 0.25, 0.30]

        # Use date-based seed for consistency
        day_seed = sim_date.toordinal() + seed_offset
        self.rng.seed(day_seed)
        result = self.rng.choices(choices, weights)[0]
        # Reset to original seed behavior
        self.rng.seed()
        return result

    def get_season(self, sim_date: date) -> Season:
        """Get the season for a given date."""
        month = sim_date.month
        if month in [3, 4, 5]:
            return Season.SPRING
        elif month in [6, 7, 8]:
            return Season.SUMMER
        elif month in [9, 10, 11]:
            return Season.FALL
        else:
            return Season.WINTER

    def calculate_operational_fees(
        self,
        machine: VendingMachine,
        base_fee: Decimal,
        slot_fee: Decimal,
    ) -> Decimal:
        """
        Calculate daily operational fees.

        Args:
            machine: The vending machine
            base_fee: Base daily fee
            slot_fee: Fee per slot

        Returns:
            Total daily operational fees
        """
        return base_fee + slot_fee * len(machine.slots)


class VendingEnvironment:
    """Simulates the vending machine business environment."""

    def __init__(
        self,
        initial_cash: Decimal = Decimal("500.00"),
        seed: int | None = None,
        start_date: date | None = None,
        rows: int = 4,
        columns: int = 3,
        location: str = "Office Building Lobby",
        daily_base_fee: Decimal = Decimal("5.00"),
        slot_fee: Decimal = Decimal("0.50"),
    ) -> None:
        """Initialize the vending environment."""
        self.economic_model = EconomicModel(seed)
        self.seed = seed
        self.daily_base_fee = daily_base_fee
        self.slot_fee = slot_fee

        # Initialize products and suppliers
        self.products = self._initialize_products()
        self.suppliers = self._initialize_suppliers()

        # Initialize state
        self.state = self._initialize_state(
            initial_cash=initial_cash,
            start_date=start_date or date.today(),
            rows=rows,
            columns=columns,
            location=location,
        )

    def _initialize_state(
        self,
        initial_cash: Decimal,
        start_date: date,
        rows: int,
        columns: int,
        location: str,
    ) -> AgentState:
        """Initialize the business state."""
        # Create slots with varying capacities
        slots: list[InventorySlot] = []
        for r in range(rows):
            for c in range(columns):
                # Top rows have smaller capacity (for larger items)
                max_cap = 6 if r >= rows // 2 else 10
                slots.append(
                    InventorySlot(
                        slot_id=f"slot_{r}_{c}",
                        row=r,
                        column=c,
                        product=None,
                        quantity=0,
                        price=Decimal("0"),
                        max_capacity=max_cap,
                    )
                )

        machine = VendingMachine(
            machine_id=f"vm_{uuid.uuid4().hex[:8]}",
            location=location,
            slots=slots,
            cash_in_machine=Decimal("0"),
            rows=rows,
            columns=columns,
        )

        return AgentState(
            current_day=1,
            current_date=start_date,
            cash_on_hand=initial_cash,
            machine=machine,
            pending_orders=[],
            order_history=[],
            delivered_inventory=[],
            daily_history=[],
            notes={},
            kv_store={},
        )

    def _initialize_products(self) -> dict[str, Product]:
        """Initialize available products catalog."""
        return {
            # Beverages
            "soda_cola": Product(
                product_id="soda_cola",
                name="Cola",
                size=ItemSize.SMALL,
                cost_price=Decimal("0.50"),
                suggested_retail=Decimal("1.50"),
                shelf_life_days=180,
                popularity_base=0.9,
                category="beverage",
                weather_modifiers={
                    WeatherCondition.HOT: 1.6,
                    WeatherCondition.SUNNY: 1.3,
                    WeatherCondition.COLD: 0.7,
                },
                season_modifiers={Season.SUMMER: 1.4, Season.WINTER: 0.8},
            ),
            "water": Product(
                product_id="water",
                name="Bottled Water",
                size=ItemSize.SMALL,
                cost_price=Decimal("0.30"),
                suggested_retail=Decimal("1.25"),
                shelf_life_days=365,
                popularity_base=0.85,
                category="beverage",
                weather_modifiers={
                    WeatherCondition.HOT: 1.8,
                    WeatherCondition.SUNNY: 1.4,
                },
                season_modifiers={Season.SUMMER: 1.5},
            ),
            "juice_orange": Product(
                product_id="juice_orange",
                name="Orange Juice",
                size=ItemSize.SMALL,
                cost_price=Decimal("0.75"),
                suggested_retail=Decimal("2.00"),
                shelf_life_days=60,
                popularity_base=0.65,
                category="beverage",
                weather_modifiers={WeatherCondition.COLD: 1.2},
                season_modifiers={Season.WINTER: 1.3, Season.FALL: 1.1},
            ),
            "energy_drink": Product(
                product_id="energy_drink",
                name="Energy Drink",
                size=ItemSize.SMALL,
                cost_price=Decimal("1.00"),
                suggested_retail=Decimal("2.75"),
                shelf_life_days=180,
                popularity_base=0.55,
                category="beverage",
                weather_modifiers={},
                season_modifiers={},
            ),
            # Snacks
            "chips_regular": Product(
                product_id="chips_regular",
                name="Potato Chips",
                size=ItemSize.SMALL,
                cost_price=Decimal("0.60"),
                suggested_retail=Decimal("1.50"),
                shelf_life_days=90,
                popularity_base=0.75,
                category="snack",
                weather_modifiers={WeatherCondition.HOT: 0.85},
                season_modifiers={Season.SUMMER: 1.15},
            ),
            "cookies": Product(
                product_id="cookies",
                name="Chocolate Chip Cookies",
                size=ItemSize.SMALL,
                cost_price=Decimal("0.65"),
                suggested_retail=Decimal("1.75"),
                shelf_life_days=60,
                popularity_base=0.70,
                category="snack",
                weather_modifiers={WeatherCondition.COLD: 1.15},
                season_modifiers={Season.WINTER: 1.2, Season.FALL: 1.1},
            ),
            "crackers": Product(
                product_id="crackers",
                name="Cheese Crackers",
                size=ItemSize.SMALL,
                cost_price=Decimal("0.55"),
                suggested_retail=Decimal("1.50"),
                shelf_life_days=120,
                popularity_base=0.60,
                category="snack",
                weather_modifiers={},
                season_modifiers={},
            ),
            "candy_bar": Product(
                product_id="candy_bar",
                name="Chocolate Bar",
                size=ItemSize.SMALL,
                cost_price=Decimal("0.70"),
                suggested_retail=Decimal("1.75"),
                shelf_life_days=180,
                popularity_base=0.65,
                category="snack",
                weather_modifiers={WeatherCondition.HOT: 0.6, WeatherCondition.COLD: 1.2},
                season_modifiers={Season.WINTER: 1.25, Season.SUMMER: 0.7},
            ),
            # Healthy options (larger items)
            "protein_bar": Product(
                product_id="protein_bar",
                name="Protein Bar",
                size=ItemSize.LARGE,
                cost_price=Decimal("1.25"),
                suggested_retail=Decimal("3.00"),
                shelf_life_days=90,
                popularity_base=0.50,
                category="healthy",
                weather_modifiers={},
                season_modifiers={Season.SPRING: 1.3, Season.SUMMER: 1.1},  # New Year's resolutions
            ),
            "trail_mix": Product(
                product_id="trail_mix",
                name="Trail Mix",
                size=ItemSize.LARGE,
                cost_price=Decimal("1.10"),
                suggested_retail=Decimal("2.75"),
                shelf_life_days=120,
                popularity_base=0.45,
                category="healthy",
                weather_modifiers={},
                season_modifiers={Season.FALL: 1.2},
            ),
            "dried_fruit": Product(
                product_id="dried_fruit",
                name="Dried Fruit Mix",
                size=ItemSize.LARGE,
                cost_price=Decimal("1.00"),
                suggested_retail=Decimal("2.50"),
                shelf_life_days=180,
                popularity_base=0.40,
                category="healthy",
                weather_modifiers={},
                season_modifiers={Season.SUMMER: 1.1},
            ),
            "nuts_almonds": Product(
                product_id="nuts_almonds",
                name="Roasted Almonds",
                size=ItemSize.LARGE,
                cost_price=Decimal("1.30"),
                suggested_retail=Decimal("3.25"),
                shelf_life_days=150,
                popularity_base=0.42,
                category="healthy",
                weather_modifiers={},
                season_modifiers={Season.WINTER: 1.15},
            ),
        }

    def _initialize_suppliers(self) -> list[Supplier]:
        """Initialize available suppliers."""
        return [
            Supplier(
                supplier_id="snack_co",
                name="SnackCo Wholesale",
                products=["chips_regular", "cookies", "crackers", "candy_bar"],
                lead_time_days=2,
                minimum_order=10,
                bulk_discount_threshold=50,
                bulk_discount_percent=10.0,
                reliability=0.95,
            ),
            Supplier(
                supplier_id="beverage_dist",
                name="Beverage Distributors Inc",
                products=["soda_cola", "water", "juice_orange", "energy_drink"],
                lead_time_days=1,
                minimum_order=12,
                bulk_discount_threshold=48,
                bulk_discount_percent=12.0,
                reliability=0.98,
            ),
            Supplier(
                supplier_id="healthy_choice",
                name="Healthy Choice Supplies",
                products=["protein_bar", "trail_mix", "dried_fruit", "nuts_almonds"],
                lead_time_days=3,
                minimum_order=15,
                bulk_discount_threshold=60,
                bulk_discount_percent=8.0,
                reliability=0.92,
            ),
        ]

    def get_supplier(self, supplier_id: str) -> Supplier | None:
        """Get supplier by ID."""
        for supplier in self.suppliers:
            if supplier.supplier_id == supplier_id:
                return supplier
        return None

    def simulate_day(self) -> DailySummary:
        """
        Simulate a single day of operations.

        Returns:
            Summary of the day's activity
        """
        current_date = self.state.current_date
        weather = self.economic_model.get_weather(current_date, self.seed or 0)
        season = self.economic_model.get_season(current_date)

        sales: list[Sale] = []
        total_revenue = Decimal("0")
        stockout_products: list[str] = []

        # Process sales for each slot
        for slot in self.state.machine.slots:
            if slot.product and slot.quantity > 0:
                demand = self.economic_model.calculate_demand(
                    slot.product,
                    slot.price,
                    weather,
                    season,
                    current_date.weekday(),
                )

                actual_sales = min(demand, slot.quantity)
                if actual_sales > 0:
                    revenue = slot.price * actual_sales
                    sales.append(
                        Sale(
                            product_id=slot.product.product_id,
                            quantity=actual_sales,
                            unit_price=slot.price,
                            revenue=revenue,
                            timestamp=current_date,
                        )
                    )
                    slot.quantity -= actual_sales
                    total_revenue += revenue

                # Track stockouts
                if slot.quantity == 0:
                    stockout_products.append(slot.product.product_id)

        # Add revenue to machine
        self.state.machine.cash_in_machine += total_revenue

        # Process order deliveries
        delivered_orders: list[str] = []
        for order in self.state.pending_orders:
            if order.status == OrderStatus.IN_TRANSIT:
                if order.expected_delivery <= current_date:
                    # Check supplier reliability for on-time delivery
                    supplier = self.get_supplier(order.supplier_id)
                    delay_check = self.economic_model.rng.random()
                    if supplier and delay_check <= supplier.reliability:
                        order.status = OrderStatus.DELIVERED
                        order.actual_delivery = current_date
                        delivered_orders.append(order.order_id)

                        # Add to delivered inventory
                        for product_id, qty in order.items.items():
                            self.state.delivered_inventory.append(
                                DeliveredInventory(
                                    product_id=product_id,
                                    quantity=qty,
                                    delivery_date=current_date,
                                    order_id=order.order_id,
                                )
                            )

        # Update in-transit orders
        for order in self.state.pending_orders:
            if order.status == OrderStatus.CONFIRMED:
                order.status = OrderStatus.IN_TRANSIT

        # Deduct operational fees
        fees = self.economic_model.calculate_operational_fees(
            self.state.machine,
            self.daily_base_fee,
            self.slot_fee,
        )
        self.state.cash_on_hand -= fees

        # Calculate inventory value
        inventory_value = self.state.machine.get_total_inventory_value(self.products)

        # Calculate net worth
        net_worth = self.state.cash_on_hand + self.state.machine.cash_in_machine + inventory_value

        # Create summary
        summary = DailySummary(
            day_number=self.state.current_day,
            sim_date=current_date,
            weather=weather,
            season=season,
            sales=sales,
            total_revenue=total_revenue,
            operational_fees=fees,
            deliveries_received=delivered_orders,
            ending_cash_on_hand=self.state.cash_on_hand,
            ending_cash_in_machine=self.state.machine.cash_in_machine,
            ending_inventory_value=inventory_value,
            net_worth=net_worth,
            stockout_products=list(set(stockout_products)),
            agent_actions=[],
        )

        # Update state
        self.state.daily_history.append(summary)
        self.state.current_day += 1
        self.state.current_date = current_date + timedelta(days=1)

        return summary

    def get_net_worth(self) -> Decimal:
        """Calculate current net worth."""
        inventory_value = self.state.machine.get_total_inventory_value(self.products)
        return self.state.cash_on_hand + self.state.machine.cash_in_machine + inventory_value

    # ============== Agent Actions ==============

    def action_view_state(self) -> str:
        """Generate a text summary of the current business state."""
        state = self.state
        machine = state.machine

        # Build slot summary
        slot_info: list[str] = []
        for slot in machine.slots:
            if slot.product:
                slot_info.append(
                    f"  [{slot.row},{slot.column}] {slot.product.name}: "
                    f"{slot.quantity}/{slot.max_capacity} @ ${slot.price}"
                )
            else:
                slot_info.append(f"  [{slot.row},{slot.column}] Empty")

        # Pending orders
        pending_info: list[str] = []
        for order in state.pending_orders:
            if order.status != OrderStatus.DELIVERED:
                items_str = ", ".join(f"{k}x{v}" for k, v in order.items.items())
                pending_info.append(
                    f"  {order.order_id}: {order.status.value} "
                    f"(expected: {order.expected_delivery}) - {items_str}"
                )

        # Delivered inventory
        delivered_info: list[str] = []
        delivered_by_product: dict[str, int] = {}
        for d in state.delivered_inventory:
            delivered_by_product[d.product_id] = (
                delivered_by_product.get(d.product_id, 0) + d.quantity
            )
        for pid, qty in delivered_by_product.items():
            product = self.products.get(pid)
            name = product.name if product else pid
            delivered_info.append(f"  {name}: {qty} units")

        return f"""
=== Business State (Day {state.current_day}) ===
Date: {state.current_date}
Cash on Hand: ${state.cash_on_hand:.2f}
Cash in Machine: ${machine.cash_in_machine:.2f}
Net Worth: ${self.get_net_worth():.2f}

=== Vending Machine ({machine.location}) ===
{chr(10).join(slot_info)}

=== Pending Orders ===
{chr(10).join(pending_info) if pending_info else "  None"}

=== Delivered Inventory (Ready to Restock) ===
{chr(10).join(delivered_info) if delivered_info else "  None"}

=== Notes ===
{chr(10).join(f"  {k}: {v}" for k, v in state.notes.items()) if state.notes else "  None"}
"""

    def action_view_suppliers(self) -> str:
        """Generate supplier information."""
        lines = ["=== Available Suppliers ==="]
        for supplier in self.suppliers:
            # Show product IDs explicitly to help LLM use correct identifiers
            product_info = [
                f"{pid} ({self.products[pid].name})"
                for pid in supplier.products
                if pid in self.products
            ]
            lines.append(f"\n{supplier.name} (supplier_id: \"{supplier.supplier_id}\"):")
            lines.append(f"  Products (use these product_ids): {', '.join(product_info)}")
            lines.append(f"  Lead time: {supplier.lead_time_days} days")
            lines.append(f"  Minimum order: {supplier.minimum_order} items")
            lines.append(
                f"  Bulk discount: {supplier.bulk_discount_percent}% "
                f"on {supplier.bulk_discount_threshold}+ items"
            )

        lines.append("\n=== Product Catalog (use product_id in orders/restocks) ===")
        for product in self.products.values():
            lines.append(
                f"  product_id=\"{product.product_id}\" | {product.name} "
                f"| cost=${product.cost_price} | MSRP=${product.suggested_retail}"
            )

        return "\n".join(lines)

    def action_set_price(self, row: int, column: int, price: Decimal) -> str:
        """Set price for a slot."""
        slot = self.state.machine.get_slot(row, column)
        if not slot:
            return f"Error: Slot [{row},{column}] not found"

        if price < Decimal("0"):
            return "Error: Price cannot be negative"

        old_price = slot.price
        slot.price = price
        return f"Price for slot [{row},{column}] changed from ${old_price:.2f} to ${price:.2f}"

    def action_place_order(
        self,
        supplier_id: str,
        items: dict[str, int],
    ) -> str:
        """Place an order with a supplier."""
        supplier = self.get_supplier(supplier_id)
        if not supplier:
            available_suppliers = ", ".join(s.supplier_id for s in self.suppliers)
            return f"Error: Supplier '{supplier_id}' not found. Use one of: {available_suppliers}"

        # Resolve and validate products (with fuzzy matching)
        resolved_items: dict[str, int] = {}
        total_cost = Decimal("0")
        total_items = 0
        for product_id, qty in items.items():
            resolved_id = self._resolve_product_id(product_id)
            if not resolved_id:
                available_ids = ", ".join(sorted(self.products.keys()))
                return f"Error: Product '{product_id}' not found. Use one of: {available_ids}"
            if resolved_id not in supplier.products:
                supplier_products = ", ".join(supplier.products)
                return (
                    f"Error: Supplier '{supplier_id}' does not carry '{resolved_id}'. "
                    f"They carry: {supplier_products}"
                )
            if qty <= 0:
                return f"Error: Quantity must be positive for '{resolved_id}'"

            product = self.products[resolved_id]
            total_cost += product.cost_price * qty
            total_items += qty
            resolved_items[resolved_id] = qty

        items = resolved_items

        # Check minimum order
        if total_items < supplier.minimum_order:
            return (
                f"Error: Minimum order is {supplier.minimum_order} items, you ordered {total_items}"
            )

        # Apply bulk discount
        if total_items >= supplier.bulk_discount_threshold:
            discount = total_cost * Decimal(str(supplier.bulk_discount_percent / 100))
            total_cost -= discount

        # Check funds
        if total_cost > self.state.cash_on_hand:
            return (
                f"Error: Insufficient funds. "
                f"Cost: ${total_cost:.2f}, Available: ${self.state.cash_on_hand:.2f}"
            )

        # Create order
        order_num = len(self.state.order_history) + len(self.state.pending_orders) + 1
        order = Order(
            order_id=f"ORD-{order_num:04d}",
            supplier_id=supplier_id,
            items=items,
            status=OrderStatus.CONFIRMED,
            order_date=self.state.current_date,
            expected_delivery=self.state.current_date + timedelta(days=supplier.lead_time_days),
            total_cost=total_cost,
        )

        # Deduct cost
        self.state.cash_on_hand -= total_cost
        self.state.pending_orders.append(order)

        items_str = ", ".join(f"{k}x{v}" for k, v in items.items())
        return (
            f"Order {order.order_id} placed successfully.\n"
            f"Items: {items_str}\n"
            f"Total cost: ${total_cost:.2f}\n"
            f"Expected delivery: {order.expected_delivery}"
        )

    def _resolve_product_id(self, product_id: str) -> str | None:
        """Resolve a product ID, attempting fuzzy matching if exact match fails.

        Returns the resolved product_id or None if no match found.
        """
        # Exact match
        if product_id in self.products:
            return product_id

        # Lowercase exact match
        product_id_lower = product_id.lower().strip()
        for pid in self.products:
            if pid.lower() == product_id_lower:
                return pid

        # Common substitutions (name -> id mapping)
        name_to_id: dict[str, str] = {}
        for pid, product in self.products.items():
            # Map variations of the name to the product ID
            name_lower = product.name.lower()
            name_to_id[name_lower] = pid
            name_to_id[name_lower.replace(" ", "_")] = pid
            name_to_id[name_lower.replace(" ", "")] = pid
            # Also map partial names
            words = name_lower.split()
            if len(words) >= 2:
                name_to_id[words[0] + "_" + words[1]] = pid
                name_to_id[words[1]] = pid  # Second word (e.g., "water" from "bottled water")

        if product_id_lower in name_to_id:
            return name_to_id[product_id_lower]

        # Last resort: check if input contains any product ID
        for pid in self.products:
            if pid in product_id_lower or product_id_lower in pid:
                return pid

        return None

    def action_restock_slot(
        self,
        row: int,
        column: int,
        product_id: str,
        quantity: int,
    ) -> str:
        """Restock a vending machine slot from delivered inventory."""
        slot = self.state.machine.get_slot(row, column)
        if not slot:
            return f"Error: Slot [{row},{column}] not found"

        # Try to resolve the product ID (with fuzzy matching)
        resolved_id = self._resolve_product_id(product_id)
        if not resolved_id:
            available_ids = ", ".join(sorted(self.products.keys()))
            return (
                f"Error: Product '{product_id}' not found. "
                f"Use one of: {available_ids}"
            )
        if resolved_id != product_id:
            # Log that we auto-corrected (helps LLM learn)
            product_id = resolved_id
        product = self.products[product_id]

        if quantity <= 0:
            return "Error: Quantity must be positive"

        # Check delivered inventory
        available = sum(
            d.quantity for d in self.state.delivered_inventory if d.product_id == product_id
        )
        if available < quantity:
            return (
                f"Error: Only {available} units of '{product_id}' available "
                f"from deliveries (requested {quantity})"
            )

        # Check slot compatibility (size)
        if slot.product and slot.product.product_id != product_id:
            # Clear existing product first
            return (
                f"Error: Slot [{row},{column}] contains '{slot.product.name}'. "
                f"Please clear it first or choose an empty slot."
            )

        # Check capacity
        current_qty = slot.quantity if slot.product else 0
        if current_qty + quantity > slot.max_capacity:
            return (
                f"Error: Slot capacity is {slot.max_capacity}, "
                f"currently has {current_qty}. Cannot add {quantity} more."
            )

        # Consume from delivered inventory
        remaining = quantity
        updated_delivered: list[DeliveredInventory] = []
        for d in self.state.delivered_inventory:
            if d.product_id == product_id and remaining > 0:
                if d.quantity <= remaining:
                    remaining -= d.quantity
                    # Don't add to updated (fully consumed)
                else:
                    d.quantity -= remaining
                    remaining = 0
                    updated_delivered.append(d)
            else:
                updated_delivered.append(d)
        self.state.delivered_inventory = updated_delivered

        # Update slot
        slot.product = product
        slot.quantity = current_qty + quantity
        slot.last_restocked = self.state.current_date

        # Set default price if not set
        if slot.price == Decimal("0"):
            slot.price = product.suggested_retail

        return (
            f"Restocked slot [{row},{column}] with {quantity} units of '{product.name}'. "
            f"New quantity: {slot.quantity}/{slot.max_capacity}"
        )

    def action_collect_cash(self) -> str:
        """Collect cash from the vending machine."""
        amount = self.state.machine.cash_in_machine
        if amount == Decimal("0"):
            return "No cash to collect from machine."

        self.state.cash_on_hand += amount
        self.state.machine.cash_in_machine = Decimal("0")
        return f"Collected ${amount:.2f} from machine. Cash on hand: ${self.state.cash_on_hand:.2f}"

    def action_update_notes(self, key: str, content: str) -> str:
        """Update agent's scratchpad notes."""
        self.state.notes[key] = content
        return f"Note '{key}' updated."

    def action_check_deliveries(self) -> str:
        """Check status of pending deliveries."""
        if not self.state.pending_orders:
            return "No pending orders."

        lines = ["=== Order Status ==="]
        for order in self.state.pending_orders:
            days_until = (order.expected_delivery - self.state.current_date).days
            status_str = order.status.value
            if order.status == OrderStatus.DELIVERED:
                status_str = "DELIVERED ✓"
            elif days_until <= 0:
                status_str = f"{order.status.value} (Due today or overdue)"
            else:
                status_str = f"{order.status.value} ({days_until} day(s) away)"

            items_str = ", ".join(f"{k}x{v}" for k, v in order.items.items())
            lines.append(f"\n{order.order_id}:")
            lines.append(f"  Status: {status_str}")
            lines.append(f"  Items: {items_str}")
            lines.append(f"  Expected: {order.expected_delivery}")
            if order.actual_delivery:
                lines.append(f"  Delivered: {order.actual_delivery}")

        return "\n".join(lines)

    def action_advance_day(self) -> str:
        """Advance to the next day and return summary."""
        summary = self.simulate_day()

        # Build sales summary
        sales_lines: list[str] = []
        for sale in summary.sales:
            product = self.products.get(sale.product_id)
            name = product.name if product else sale.product_id
            sales_lines.append(
                f"  {name}: {sale.quantity} sold @ ${sale.unit_price:.2f} = ${sale.revenue:.2f}"
            )

        return f"""
=== Day {summary.day_number - 1} Completed ===
Date: {summary.sim_date}
Weather: {summary.weather.value}
Season: {summary.season.value}

=== Sales ===
{chr(10).join(sales_lines) if sales_lines else "  No sales"}

Total Revenue: ${summary.total_revenue:.2f}
Operational Fees: ${summary.operational_fees:.2f}

=== Financial Summary ===
Cash on Hand: ${summary.ending_cash_on_hand:.2f}
Cash in Machine: ${summary.ending_cash_in_machine:.2f}
Inventory Value: ${summary.ending_inventory_value:.2f}
Net Worth: ${summary.net_worth:.2f}

=== Deliveries ===
{f"Received: {', '.join(summary.deliveries_received)}" if summary.deliveries_received else "No deliveries"}

=== Stockouts ===
{f"Products out of stock: {', '.join(summary.stockout_products)}" if summary.stockout_products else "All products in stock"}
"""
