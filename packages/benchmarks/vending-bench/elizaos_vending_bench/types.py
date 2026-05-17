"""
Vending-Bench Type Definitions

Defines all data classes and enums used by the Vending-Bench benchmark implementation.
The tool surface mirrors Andon Labs' Vending-Bench paper (arXiv 2502.15840) — see
``RESEARCH.md`` for a side-by-side mapping between paper tools and ``ActionType``.
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
    """Types of agent actions.

    The structured-action interface mirrors the tool surface of the Vending-Bench
    paper (Andon Labs, arXiv 2502.15840). Each ActionType corresponds 1:1 to a
    paper tool, with three "eliza convenience actions" (``VIEW_STATE``,
    ``VIEW_SUPPLIERS``, ``UPDATE_NOTES``) kept for backward compatibility with
    the harness bridge.
    """

    # --- Paper-faithful tool surface ----------------------------------------
    # Email channel — primary supplier communication.
    SEND_EMAIL = "SEND_EMAIL"
    READ_EMAIL = "READ_EMAIL"
    # Free-text scratchpad (paper: ``scratchpad``).
    NOTEPAD_READ = "NOTEPAD_READ"
    NOTEPAD_WRITE = "NOTEPAD_WRITE"
    # Web research — calls a simulated search engine (paper: ``research_products``).
    SEARCH_WEB = "SEARCH_WEB"
    # Sub-agent delegation (paper: ``run_sub_agent`` / ``chat_with_sub_agent``).
    DELEGATE_EMAIL = "DELEGATE_EMAIL"
    DELEGATE_RESEARCH = "DELEGATE_RESEARCH"
    # Physical / on-site operations (paper sub-agent tools).
    SET_PRICE = "SET_PRICE"
    PLACE_ORDER = "PLACE_ORDER"
    RESTOCK_SLOT = "RESTOCK_SLOT"
    COLLECT_CASH = "COLLECT_CASH"
    CHECK_DELIVERIES = "CHECK_DELIVERIES"
    # Time control (paper: ``wait_for_next_day``).
    ADVANCE_DAY = "ADVANCE_DAY"

    # --- eliza convenience actions ------------------------------------------
    # Structured shortcuts not present in the paper. They are kept so that the
    # heuristic agent and the eliza bridge stay usable, but a paper-faithful run
    # should rely on the email/web/notepad tools above.
    VIEW_STATE = "VIEW_BUSINESS_STATE"
    VIEW_SUPPLIERS = "VIEW_SUPPLIERS"
    UPDATE_NOTES = "UPDATE_NOTES"


class CoherenceErrorType(str, Enum):
    """Types of coherence errors the agent can make.

    Covers the failure modes catalogued in Section 4 of the Vending-Bench paper
    (Andon Labs, arXiv 2502.15840), plus structural errors detectable from the
    action trace alone.
    """

    DUPLICATE_ORDER = "duplicate_order"  # Ordering products already in pending delivery
    FORGOTTEN_ORDER = "forgotten_order"  # Not restocking delivered items
    INVENTORY_TRACKING = "inventory_tracking"  # Wrong inventory assumptions
    PRICE_INCONSISTENCY = "price_inconsistency"  # Contradictory pricing decisions
    SCHEDULE_CONFUSION = "schedule_confusion"  # Misremembering delivery dates
    LOOP_BEHAVIOR = "loop_behavior"  # Repeating same ineffective actions
    CASH_FLOW_ERROR = "cash_flow_error"  # Not collecting cash when low on funds

    # Paper-catalogued failure modes (Section 4 "Failure Modes").
    HALLUCINATED_DELIVERY = "hallucinated_delivery"  # Assumed an order arrived before it actually did
    HALLUCINATED_SUPPLIER = "hallucinated_supplier"  # Emailed / referenced a supplier that doesn't exist
    CASH_MISREMEMBERED = "cash_misremembered"  # Agent's notes/reasoning disagree with actual cash
    PHANTOM_INVENTORY = "phantom_inventory"  # Acted as if a product is in stock when it isn't
    TOOL_FORMAT_DEGRADATION = "tool_format_degradation"  # Failed to use the structured tool call format
    TANGENTIAL_MELTDOWN = "tangential_meltdown"  # Repeated off-task escalations (e.g. "contact FBI")
    TASK_ABANDONMENT = "task_abandonment"  # Agent stops producing useful actions / refuses


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
    # Paper-faithful comms: each supplier has a simulated email address.
    email: str = ""
    response_lag_days: int = 1  # Email reply lag in sim-days


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
class EmailMessage:
    """A single email message — inbox or outbox.

    Paper analogue: the agent's primary supplier-communication channel uses
    free-form email (``send_email`` / ``read_emails``), with simulated
    wholesaler replies arriving on the next sim-day.
    """

    message_id: str
    direction: str  # "in" or "out"
    sender: str  # email address or supplier_id
    recipient: str
    subject: str
    body: str
    sent_day: int
    sent_date: date
    delivery_day: int | None = None  # Day the message becomes visible to the recipient
    read: bool = False
    in_reply_to: str | None = None
    metadata: dict[str, str] = field(default_factory=dict)


@dataclass
class WebSearchResult:
    """A single canned web-search snippet returned by the WebSimulator."""

    title: str
    url: str
    snippet: str


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
    notes: dict[str, str] = field(default_factory=dict)  # Agent notes (key/value)
    kv_store: dict[str, str] = field(default_factory=dict)  # Structured memory
    # Paper-faithful long-term memory and comms surface.
    notepad: list[str] = field(default_factory=list)  # Append-only free-text scratchpad
    inbox: list[EmailMessage] = field(default_factory=list)  # Received emails
    outbox: list[EmailMessage] = field(default_factory=list)  # Sent emails
    web_search_log: list[dict[str, str]] = field(default_factory=list)  # {query, day, top_url}
    consecutive_unpaid_fee_days: int = 0  # For paper-faithful bankruptcy detection


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
    raw_response: str = ""


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
    starter_baseline_revenue: Decimal = Decimal("0")
    incremental_revenue: Decimal = Decimal("0")
    # Paper-faithful auxiliary metrics.
    emails_sent: int = 0
    emails_received: int = 0
    web_searches: int = 0
    notepad_writes: int = 0
    sub_agent_calls: int = 0


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
    avg_revenue: Decimal
    total_revenue: Decimal
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
    avg_starter_baseline_revenue: Decimal = Decimal("0")
    avg_incremental_revenue: Decimal = Decimal("0")
    total_incremental_revenue: Decimal = Decimal("0")


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
    """Configuration for Vending-Bench runner.

    Defaults align with the paper (Andon Labs, arXiv 2502.15840 Section 3):
    starting cash $500, daily fee $2, 30k-token context window, 4x3 machine.
    The paper runs indefinitely until bankruptcy or a 2000-message limit; we
    default to 90 sim-days as a tractable middle-ground — increase
    ``max_days_per_run`` and ``max_messages_per_run`` to approach the paper's
    long-horizon regime (~25M tokens of context across a run).
    """

    # Simulation settings
    num_runs: int = 5
    max_days_per_run: int = 90  # Paper: unbounded until bankruptcy / message cap
    initial_cash: Decimal = Decimal("500.00")  # Paper: $500
    random_seed: int | None = None
    starter_inventory: bool = False

    # Environment settings
    daily_base_fee: Decimal = Decimal("2.00")  # Paper: $2/day daily fee
    slot_fee: Decimal = Decimal("0.00")  # Paper folds slot fees into the flat $2 fee
    machine_rows: int = 4
    machine_columns: int = 3
    location: str = "Office Building Lobby"
    bankruptcy_grace_days: int = 10  # Paper: bankrupt after 10 consecutive unpaid-fee days

    # Agent settings
    max_actions_per_day: int = 25
    max_messages_per_run: int = 2000  # Paper: hard cap on agent messages per run
    context_window_tokens: int = 30000  # Paper: primary experiments use 30k
    temperature: float = 0.0
    model_name: str = "gpt-4"
    enable_sub_agents: bool = True  # Spawn email/research sub-agents on DELEGATE_* actions

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
        model_name="Claude Sonnet 4.6",
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
