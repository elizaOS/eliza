"""Tests for Vending-Bench type definitions."""

from datetime import date
from decimal import Decimal

from elizaos_vending_bench.types import (
    LEADERBOARD_SCORES,
    ActionType,
    CoherenceError,
    CoherenceErrorType,
    DailySummary,
    InventorySlot,
    ItemSize,
    Order,
    OrderStatus,
    Product,
    Sale,
    Season,
    Supplier,
    VendingBenchConfig,
    VendingBenchResult,
    VendingMachine,
    WeatherCondition,
)


class TestEnums:
    """Test enum definitions."""

    def test_item_size_values(self) -> None:
        """Test ItemSize enum values."""
        assert ItemSize.SMALL.value == "small"
        assert ItemSize.LARGE.value == "large"

    def test_order_status_values(self) -> None:
        """Test OrderStatus enum values."""
        assert OrderStatus.PENDING.value == "pending"
        assert OrderStatus.DELIVERED.value == "delivered"
        assert len(OrderStatus) == 5

    def test_weather_condition_values(self) -> None:
        """Test WeatherCondition enum values."""
        assert WeatherCondition.SUNNY.value == "sunny"
        assert WeatherCondition.HOT.value == "hot"
        assert len(WeatherCondition) == 6

    def test_season_values(self) -> None:
        """Test Season enum values."""
        assert Season.SPRING.value == "spring"
        assert Season.WINTER.value == "winter"
        assert len(Season) == 4

    def test_action_type_values(self) -> None:
        """Test ActionType enum values."""
        assert ActionType.VIEW_STATE.value == "VIEW_BUSINESS_STATE"
        assert ActionType.ADVANCE_DAY.value == "ADVANCE_DAY"
        assert len(ActionType) == 9

    def test_coherence_error_type_values(self) -> None:
        """Test CoherenceErrorType enum values."""
        assert CoherenceErrorType.DUPLICATE_ORDER.value == "duplicate_order"
        assert len(CoherenceErrorType) == 7


class TestProduct:
    """Test Product dataclass."""

    def test_create_product(self) -> None:
        """Test creating a product."""
        product = Product(
            product_id="test",
            name="Test Product",
            size=ItemSize.SMALL,
            cost_price=Decimal("1.00"),
            suggested_retail=Decimal("2.00"),
            shelf_life_days=90,
            popularity_base=0.5,
        )
        assert product.product_id == "test"
        assert product.cost_price == Decimal("1.00")
        assert product.popularity_base == 0.5

    def test_product_with_modifiers(self) -> None:
        """Test product with weather and season modifiers."""
        product = Product(
            product_id="soda",
            name="Soda",
            size=ItemSize.SMALL,
            cost_price=Decimal("0.50"),
            suggested_retail=Decimal("1.50"),
            shelf_life_days=180,
            popularity_base=0.8,
            weather_modifiers={WeatherCondition.HOT: 1.5},
            season_modifiers={Season.SUMMER: 1.3},
        )
        assert product.weather_modifiers[WeatherCondition.HOT] == 1.5
        assert product.season_modifiers[Season.SUMMER] == 1.3


class TestVendingMachine:
    """Test VendingMachine dataclass."""

    def test_create_vending_machine(self) -> None:
        """Test creating a vending machine."""
        slots = [
            InventorySlot(
                slot_id="slot_0_0",
                row=0,
                column=0,
                max_capacity=10,
            )
        ]
        machine = VendingMachine(
            machine_id="vm_001",
            location="Office",
            slots=slots,
            cash_in_machine=Decimal("0"),
        )
        assert machine.machine_id == "vm_001"
        assert len(machine.slots) == 1

    def test_get_slot(self) -> None:
        """Test getting a slot by position."""
        slots = [
            InventorySlot(slot_id="slot_0_0", row=0, column=0),
            InventorySlot(slot_id="slot_0_1", row=0, column=1),
            InventorySlot(slot_id="slot_1_0", row=1, column=0),
        ]
        machine = VendingMachine(
            machine_id="vm_001",
            location="Office",
            slots=slots,
        )

        slot = machine.get_slot(0, 1)
        assert slot is not None
        assert slot.slot_id == "slot_0_1"

        missing_slot = machine.get_slot(5, 5)
        assert missing_slot is None


class TestSupplier:
    """Test Supplier dataclass."""

    def test_create_supplier(self) -> None:
        """Test creating a supplier."""
        supplier = Supplier(
            supplier_id="snack_co",
            name="SnackCo",
            products=["chips", "cookies"],
            lead_time_days=2,
            minimum_order=10,
            bulk_discount_threshold=50,
            bulk_discount_percent=10.0,
        )
        assert supplier.supplier_id == "snack_co"
        assert len(supplier.products) == 2
        assert supplier.lead_time_days == 2


class TestOrder:
    """Test Order dataclass."""

    def test_create_order(self) -> None:
        """Test creating an order."""
        order = Order(
            order_id="ORD-0001",
            supplier_id="snack_co",
            items={"chips": 10, "cookies": 10},
            status=OrderStatus.PENDING,
            order_date=date(2025, 1, 1),
            expected_delivery=date(2025, 1, 3),
            total_cost=Decimal("15.00"),
        )
        assert order.order_id == "ORD-0001"
        assert order.items["chips"] == 10
        assert order.status == OrderStatus.PENDING


class TestDailySummary:
    """Test DailySummary dataclass."""

    def test_create_daily_summary(self) -> None:
        """Test creating a daily summary."""
        sales = [
            Sale(
                product_id="soda",
                quantity=5,
                unit_price=Decimal("1.50"),
                revenue=Decimal("7.50"),
                timestamp=date(2025, 1, 1),
            )
        ]
        summary = DailySummary(
            day_number=1,
            sim_date=date(2025, 1, 1),
            weather=WeatherCondition.SUNNY,
            season=Season.WINTER,
            sales=sales,
            total_revenue=Decimal("7.50"),
            operational_fees=Decimal("11.00"),
            ending_cash_on_hand=Decimal("489.00"),
            ending_cash_in_machine=Decimal("7.50"),
            ending_inventory_value=Decimal("50.00"),
            net_worth=Decimal("546.50"),
        )
        assert summary.day_number == 1
        assert summary.total_revenue == Decimal("7.50")


class TestVendingBenchConfig:
    """Test VendingBenchConfig dataclass."""

    def test_default_config(self) -> None:
        """Test default configuration values."""
        config = VendingBenchConfig()
        assert config.num_runs == 5
        assert config.max_days_per_run == 30
        assert config.initial_cash == Decimal("500.00")
        assert config.machine_rows == 4
        assert config.machine_columns == 3

    def test_custom_config(self) -> None:
        """Test custom configuration."""
        config = VendingBenchConfig(
            num_runs=10,
            max_days_per_run=60,
            initial_cash=Decimal("1000.00"),
            model_name="gpt-5",
        )
        assert config.num_runs == 10
        assert config.max_days_per_run == 60
        assert config.model_name == "gpt-5"


class TestVendingBenchResult:
    """Test VendingBenchResult dataclass."""

    def test_create_result(self) -> None:
        """Test creating a benchmark result."""
        result = VendingBenchResult(
            run_id="run_001",
            simulation_days=30,
            final_net_worth=Decimal("750.00"),
            initial_cash=Decimal("500.00"),
            profit=Decimal("250.00"),
            total_revenue=Decimal("500.00"),
            total_costs=Decimal("200.00"),
            total_operational_fees=Decimal("330.00"),
            items_sold=200,
            orders_placed=5,
            successful_deliveries=5,
            stockout_days=3,
        )
        assert result.run_id == "run_001"
        assert result.final_net_worth == Decimal("750.00")
        assert result.profit == Decimal("250.00")


class TestLeaderboard:
    """Test leaderboard constants."""

    def test_leaderboard_scores_exist(self) -> None:
        """Test that leaderboard scores are defined."""
        assert len(LEADERBOARD_SCORES) > 0

    def test_grok_4_top_score(self) -> None:
        """Test Grok 4 is in the leaderboard with known score."""
        assert "grok_4" in LEADERBOARD_SCORES
        assert LEADERBOARD_SCORES["grok_4"].top_score == Decimal("4694.15")

    def test_all_entries_have_required_fields(self) -> None:
        """Test all leaderboard entries have required fields."""
        for _key, entry in LEADERBOARD_SCORES.items():
            assert entry.model_name
            assert entry.top_score > 0


class TestCoherenceError:
    """Test CoherenceError dataclass."""

    def test_create_coherence_error(self) -> None:
        """Test creating a coherence error."""
        error = CoherenceError(
            error_type=CoherenceErrorType.DUPLICATE_ORDER,
            day=5,
            description="Ordered chips while chips order pending",
            severity=0.7,
        )
        assert error.error_type == CoherenceErrorType.DUPLICATE_ORDER
        assert error.day == 5
        assert error.severity == 0.7
