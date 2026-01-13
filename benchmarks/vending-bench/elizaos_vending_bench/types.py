"""
Vending-Bench Type Definitions

Defines all data classes and enums used by the Vending-Bench benchmark implementation.
Based on the AISI inspect-ai framework patterns.
"""

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from enum import Enum


class ItemSize(str, Enum):
    """Size categories for vending machine items."""

    SMALL = "small"
    LARGE = "large"


class OrderStatus(str, Enum):
    """Status of supply orders."""

    PENDING = "pending"
    CONFIRMED = "confirmed"
    IN_TRANSIT = "in_transit"
    DELIVERED = "delivered"
    CANCELLED = "cancelled"


class WeatherCondition(str, Enum):
    """Weather conditions affecting sales."""

    SUNNY = "sunny"
    CLOUDY = "cloudy"
    RAINY = "rainy"
    SNOWY = "snowy"
    HOT = "hot"
    COLD = "cold"


class Season(str, Enum):
    """Seasons affecting demand patterns."""

    SPRING = "spring"
    SUMMER = "summer"
    FALL = "fall"
    WINTER = "winter"


class ActionType(str, Enum):
    """Types of agent actions."""

    VIEW_STATE = "VIEW_BUSINESS_STATE"
    SET_PRICE = "SET_PRICE"
    PLACE_ORDER = "PLACE_ORDER"
    RESTOCK_SLOT = "RESTOCK_SLOT"
    COLLECT_CASH = "COLLECT_CASH"
    UPDATE_NOTES = "UPDATE_NOTES"
    VIEW_SUPPLIERS = "VIEW_SUPPLIERS"
    ADVANCE_DAY = "ADVANCE_DAY"
    CHECK_DELIVERIES = "CHECK_DELIVERIES"


class CoherenceErrorType(str, Enum):
    """Types of coherence errors the agent can make."""

    DUPLICATE_ORDER = "duplicate_order"  # Ordering products already in pending delivery
    FORGOTTEN_ORDER = "forgotten_order"  # Not restocking delivered items
    INVENTORY_TRACKING = "inventory_tracking"  # Wrong inventory assumptions
    PRICE_INCONSISTENCY = "price_inconsistency"  # Contradictory pricing decisions
    SCHEDULE_CONFUSION = "schedule_confusion"  # Misremembering delivery dates
    LOOP_BEHAVIOR = "loop_behavior"  # Repeating same ineffective actions
    CASH_FLOW_ERROR = "cash_flow_error"  # Not collecting cash when low on funds


# Agent action parameter typing
# NOTE: Some actions (e.g. PLACE_ORDER) include a nested items mapping.
ActionParamValue = str | int | float | bool | dict[str, int]
ActionParameters = dict[str, ActionParamValue]


@dataclass
class Product:
    """Represents a product that can be sold."""

    product_id: str
    name: str
    size: ItemSize
    cost_price: Decimal
    suggested_retail: Decimal
    shelf_life_days: int
    popularity_base: float  # 0-1 base demand multiplier
    category: str = "general"
    weather_modifiers: dict[WeatherCondition, float] = field(default_factory=dict)
    season_modifiers: dict[Season, float] = field(default_factory=dict)


@dataclass
class InventorySlot:
    """Represents a slot in the vending machine."""

    slot_id: str
    row: int
    column: int
    product: Product | None = None
    quantity: int = 0
    price: Decimal = Decimal("0")
    max_capacity: int = 10
    last_restocked: date | None = None


@dataclass
class VendingMachine:
    """Represents the vending machine state."""

    machine_id: str
    location: str
    slots: list[InventorySlot] = field(default_factory=list)
    cash_in_machine: Decimal = Decimal("0")
    rows: int = 4
    columns: int = 3

    def get_slot(self, row: int, column: int) -> InventorySlot | None:
        """Get slot at specified position."""
        for slot in self.slots:
            if slot.row == row and slot.column == column:
                return slot
        return None

    def get_total_inventory_value(self, products: dict[str, Product]) -> Decimal:
        """Calculate total value of inventory at cost."""
        total = Decimal("0")
        for slot in self.slots:
            if slot.product and slot.quantity > 0:
                total += slot.product.cost_price * slot.quantity
        return total


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
    reliability: float = 1.0  # 0-1, chance of on-time delivery


@dataclass
class Order:
    """Represents a supply order."""

    order_id: str
    supplier_id: str
    items: dict[str, int]  # Product ID -> quantity
    status: OrderStatus
    order_date: date
    expected_delivery: date
    actual_delivery: date | None = None
    total_cost: Decimal = Decimal("0")
    notes: str = ""


@dataclass
class DeliveredInventory:
    """Inventory received from deliveries but not yet restocked."""

    product_id: str
    quantity: int
    delivery_date: date
    order_id: str


@dataclass
class Sale:
    """Record of a single sale."""

    product_id: str
    quantity: int
    unit_price: Decimal
    revenue: Decimal
    timestamp: date


@dataclass
class DailySummary:
    """Summary of a single day's operations."""

    day_number: int
    sim_date: date
    weather: WeatherCondition
    season: Season
    sales: list[Sale] = field(default_factory=list)
    total_revenue: Decimal = Decimal("0")
    operational_fees: Decimal = Decimal("0")
    deliveries_received: list[str] = field(default_factory=list)  # Order IDs
    ending_cash_on_hand: Decimal = Decimal("0")
    ending_cash_in_machine: Decimal = Decimal("0")
    ending_inventory_value: Decimal = Decimal("0")
    net_worth: Decimal = Decimal("0")
    stockout_products: list[str] = field(default_factory=list)
    agent_actions: list[str] = field(default_factory=list)


@dataclass
class AgentState:
    """Complete state of the vending business."""

    current_day: int
    current_date: date
    cash_on_hand: Decimal
    machine: VendingMachine
    pending_orders: list[Order] = field(default_factory=list)
    order_history: list[Order] = field(default_factory=list)
    delivered_inventory: list[DeliveredInventory] = field(default_factory=list)
    daily_history: list[DailySummary] = field(default_factory=list)
    notes: dict[str, str] = field(default_factory=dict)  # Agent's scratchpad
    kv_store: dict[str, str] = field(default_factory=dict)  # Structured memory


@dataclass
class CoherenceError:
    """Record of a detected coherence error."""

    error_type: CoherenceErrorType
    day: int
    description: str
    severity: float = 1.0  # 0-1


@dataclass
class AgentAction:
    """Record of an action taken by the agent."""

    action_type: ActionType
    day: int
    parameters: ActionParameters = field(default_factory=dict)
    result: str = ""
    success: bool = True
    tokens_used: int = 0
    latency_ms: float = 0.0


@dataclass
class VendingBenchResult:
    """Result of a single Vending-Bench simulation run."""

    run_id: str
    simulation_days: int
    final_net_worth: Decimal
    initial_cash: Decimal
    profit: Decimal
    total_revenue: Decimal
    total_costs: Decimal
    total_operational_fees: Decimal
    items_sold: int
    orders_placed: int
    successful_deliveries: int
    stockout_days: int  # Days with at least one product out of stock
    coherence_errors: list[CoherenceError] = field(default_factory=list)
    daily_summaries: list[DailySummary] = field(default_factory=list)
    actions: list[AgentAction] = field(default_factory=list)
    total_tokens: int = 0
    total_latency_ms: float = 0.0
    error: str | None = None


@dataclass
class VendingBenchMetrics:
    """Aggregate metrics from multiple benchmark runs."""

    # Overall performance
    avg_net_worth: Decimal
    max_net_worth: Decimal
    min_net_worth: Decimal
    std_net_worth: Decimal
    median_net_worth: Decimal

    # Success metrics
    success_rate: float  # Runs that ended profitable (net worth > initial)
    avg_profit: Decimal
    profitability_rate: float  # Percentage of runs with positive ROI

    # Operational metrics
    avg_items_sold: float
    avg_orders_placed: float
    avg_stockout_days: float
    avg_simulation_days: float

    # Coherence metrics
    coherence_score: float  # 0-1, based on error rate
    avg_coherence_errors: float

    # Efficiency metrics
    avg_tokens_per_run: float
    avg_tokens_per_day: float
    avg_latency_per_action_ms: float

    # Optional metrics with defaults
    error_breakdown: dict[CoherenceErrorType, int] = field(default_factory=dict)


@dataclass
class LeaderboardEntry:
    """Entry for comparison with published scores."""

    model_name: str
    top_score: Decimal
    avg_score: Decimal | None = None
    coherence_score: float | None = None


@dataclass
class LeaderboardComparison:
    """Comparison with published benchmark scores."""

    our_score: Decimal
    our_rank: int
    total_entries: int
    percentile: float
    comparisons: list[tuple[str, Decimal, str]] = field(
        default_factory=list
    )  # (model, score, comparison)


@dataclass
class VendingBenchConfig:
    """Configuration for Vending-Bench runner."""

    # Simulation settings
    num_runs: int = 5
    max_days_per_run: int = 30
    initial_cash: Decimal = Decimal("500.00")
    random_seed: int | None = None

    # Environment settings
    daily_base_fee: Decimal = Decimal("5.00")
    slot_fee: Decimal = Decimal("0.50")
    machine_rows: int = 4
    machine_columns: int = 3
    location: str = "Office Building Lobby"

    # Agent settings
    max_actions_per_day: int = 10
    context_window_tokens: int = 30000
    temperature: float = 0.0
    model_name: str = "gpt-4"

    # Output settings
    output_dir: str = "./benchmark_results/vending-bench"
    save_detailed_logs: bool = True
    save_trajectories: bool = True
    generate_report: bool = True
    compare_leaderboard: bool = True


@dataclass
class VendingBenchReport:
    """Full benchmark report with analysis."""

    metadata: dict[str, str | int | float | bool]
    config: VendingBenchConfig
    results: list[VendingBenchResult]
    metrics: VendingBenchMetrics
    leaderboard_comparison: LeaderboardComparison | None = None
    summary: dict[str, str | list[str]] = field(default_factory=dict)


# Current leaderboard scores from https://andonlabs.com/evals/vending-bench
LEADERBOARD_SCORES: dict[str, LeaderboardEntry] = {
    "grok_4": LeaderboardEntry(
        model_name="Grok 4",
        top_score=Decimal("4694.15"),
    ),
    "claude_3_5_sonnet": LeaderboardEntry(
        model_name="Claude 3.5 Sonnet",
        top_score=Decimal("2217.93"),
    ),
    "claude_opus_4": LeaderboardEntry(
        model_name="Claude Opus 4",
        top_score=Decimal("2077.41"),
    ),
    "gpt_4o": LeaderboardEntry(
        model_name="GPT-4o",
        top_score=Decimal("1850.00"),  # Estimated
    ),
    "gpt_4": LeaderboardEntry(
        model_name="GPT-4",
        top_score=Decimal("1500.00"),  # Estimated
    ),
    "claude_3_haiku": LeaderboardEntry(
        model_name="Claude 3 Haiku",
        top_score=Decimal("1200.00"),  # Estimated
    ),
}
