"""
Vending-Bench ElizaOS Plugin - Canonical implementation using full ElizaOS runtime.

This plugin registers proper Actions and Providers for the vending machine benchmark,
allowing the agent to use the standard ElizaOS message handling flow.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import TYPE_CHECKING, Any

from elizaos.types import (
    Action,
    ActionExample,
    ActionParameter,
    ActionParameterSchema,
    ActionResult,
    Content,
    Plugin,
    Provider,
    ProviderResult,
)

if TYPE_CHECKING:
    from elizaos.types import (
        HandlerCallback,
        HandlerOptions,
        IAgentRuntime,
        Memory,
        State,
    )

from elizaos_vending_bench.environment import VendingEnvironment

# Store environments by agent_id (module-level dict since set_setting only accepts primitives)
_ENVIRONMENTS: dict[str, VendingEnvironment] = {}


def _get_env(runtime: IAgentRuntime) -> VendingEnvironment:
    """Get or create the VendingEnvironment for this runtime."""
    agent_key = str(runtime.agent_id)
    if agent_key not in _ENVIRONMENTS:
        _ENVIRONMENTS[agent_key] = VendingEnvironment()
    return _ENVIRONMENTS[agent_key]


def _reset_env(runtime: IAgentRuntime) -> VendingEnvironment:
    """Reset the environment for this runtime (for new benchmark runs)."""
    agent_key = str(runtime.agent_id)
    _ENVIRONMENTS[agent_key] = VendingEnvironment()
    return _ENVIRONMENTS[agent_key]


# ============================================================================
# PROVIDERS - Inject context into the agent's prompt
# ============================================================================


async def _get_business_state_context(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> ProviderResult:
    """Provider that injects current business state into context."""
    env = _get_env(runtime)
    state_text = env.action_view_state()

    return ProviderResult(
        text=f"# Current Vending Business State\n{state_text}",
        values={
            "currentDay": env.state.current_day,
            "cashOnHand": float(env.state.cash_on_hand),
            "netWorth": float(env.get_net_worth()),
        },
        data={
            "day": env.state.current_day,
            "cash": str(env.state.cash_on_hand),
            "netWorth": str(env.get_net_worth()),
            "pendingOrders": len(env.state.pending_orders),
            "deliveredInventory": len(env.state.delivered_inventory),
        },
    )


business_state_provider = Provider(
    name="VENDING_BUSINESS_STATE",
    description="Current state of the vending machine business including inventory, cash, and orders",
    get=_get_business_state_context,
    dynamic=True,
    position=10,
)


async def _get_suppliers_context(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> ProviderResult:
    """Provider that injects supplier information into context."""
    env = _get_env(runtime)
    suppliers_text = env.action_view_suppliers()

    return ProviderResult(
        text=f"# Available Suppliers and Products\n{suppliers_text}",
        values={
            "supplierCount": len(env.suppliers),
            "productCount": len(env.products),
        },
        data={
            "suppliers": [s.supplier_id for s in env.suppliers],
            "products": list(env.products.keys()),
        },
    )


suppliers_provider = Provider(
    name="VENDING_SUPPLIERS",
    description="Available suppliers and product catalog for the vending business",
    get=_get_suppliers_context,
    dynamic=False,  # Doesn't change during simulation
    position=11,
)


async def _get_deliveries_context(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> ProviderResult:
    """Provider that shows pending deliveries status."""
    env = _get_env(runtime)
    deliveries_text = env.action_check_deliveries()

    return ProviderResult(
        text=f"# Delivery Status\n{deliveries_text}",
        values={
            "pendingDeliveries": len(env.state.pending_orders),
            "hasDeliveredInventory": len(env.state.delivered_inventory) > 0,
        },
        data={
            "pendingOrders": [o.order_id for o in env.state.pending_orders],
            "deliveredProducts": list({d.product_id for d in env.state.delivered_inventory}),
        },
    )


deliveries_provider = Provider(
    name="VENDING_DELIVERIES",
    description="Status of pending orders and delivered inventory ready to restock",
    get=_get_deliveries_context,
    dynamic=True,
    position=12,
)


# ============================================================================
# ACTIONS - Operations the agent can perform
# ============================================================================


@dataclass
class PlaceOrderAction:
    """Action to place an order with a supplier."""

    name: str = "PLACE_ORDER"
    similes: list[str] = field(
        default_factory=lambda: ["ORDER", "BUY", "PURCHASE", "ORDER_PRODUCTS"]
    )
    description: str = (
        "Place an order with a supplier for products. "
        "Requires supplier_id and items (dict of product_id: quantity). "
        "Example: PLACE_ORDER with supplier_id='beverage_dist', items={'water': 12, 'soda_cola': 12}"
    )
    parameters: list[ActionParameter] = field(
        default_factory=lambda: [
            ActionParameter(
                name="supplier_id",
                description="The supplier ID to order from (e.g., 'beverage_dist', 'snack_co', 'healthy_choice')",
                required=True,
                schema=ActionParameterSchema(type="string"),
            ),
            ActionParameter(
                name="items",
                description="JSON object mapping product_id to quantity. Example: {\"water\": 12, \"soda_cola\": 12}",
                required=True,
                schema=ActionParameterSchema(type="string"),  # Accept string, we'll parse in handler
            ),
        ]
    )

    async def validate(
        self, runtime: IAgentRuntime, _message: Memory, _state: State | None = None
    ) -> bool:
        return True

    async def handler(
        self,
        runtime: IAgentRuntime,
        message: Memory,
        state: State | None = None,
        options: HandlerOptions | None = None,
        callback: HandlerCallback | None = None,
        responses: list[Memory] | None = None,
    ) -> ActionResult:
        import json as json_module

        env = _get_env(runtime)

        # Get parameters
        params: dict[str, Any] = {}
        if options and options.parameters:
            params = options.parameters
        supplier_id = str(params.get("supplier_id", ""))
        items_raw = params.get("items", {})

        # Convert items to dict[str, int]
        # Handle both dict and JSON string formats
        items: dict[str, int] = {}
        if isinstance(items_raw, str):
            # Try to parse as JSON string
            try:
                items_raw = json_module.loads(items_raw)
            except json_module.JSONDecodeError:
                items_raw = {}

        if isinstance(items_raw, dict):
            for k, v in items_raw.items():
                try:
                    items[str(k)] = int(v)
                except (ValueError, TypeError):
                    pass

        if not supplier_id or not items:
            return ActionResult(
                text="Error: Missing supplier_id or items parameter",
                success=False,
                values={"error": "missing_params"},
            )

        # Execute the action
        result = env.action_place_order(supplier_id, items)
        success = "Error" not in result

        if callback:
            await callback(Content(text=result, actions=["PLACE_ORDER"]))

        return ActionResult(
            text=result,
            success=success,
            values={
                "ordered": success,
                "supplier": supplier_id,
                "itemCount": sum(items.values()) if success else 0,
            },
            data={"result": result, "supplier_id": supplier_id, "items": items},
        )

    @property
    def examples(self) -> list[list[ActionExample]]:
        return [
            [
                ActionExample(
                    name="{{user}}",
                    content=Content(text="I need to order more drinks for the machine"),
                ),
                ActionExample(
                    name="{{agent}}",
                    content=Content(
                        text="I'll place an order for beverages.",
                        actions=["PLACE_ORDER"],
                    ),
                ),
            ],
        ]


place_order_action = Action(
    name=PlaceOrderAction.name,
    similes=PlaceOrderAction().similes,
    description=PlaceOrderAction.description,
    validate=PlaceOrderAction().validate,
    handler=PlaceOrderAction().handler,
    examples=PlaceOrderAction().examples,
    parameters=PlaceOrderAction().parameters,
)


@dataclass
class RestockSlotAction:
    """Action to restock a vending machine slot."""

    name: str = "RESTOCK_SLOT"
    similes: list[str] = field(default_factory=lambda: ["RESTOCK", "FILL_SLOT", "ADD_INVENTORY"])
    description: str = (
        "Restock a vending machine slot with delivered products. "
        "Requires row, column, product_id, and quantity. "
        "Each slot has max_capacity=10. Use delivered inventory only."
    )
    parameters: list[ActionParameter] = field(
        default_factory=lambda: [
            ActionParameter(
                name="row",
                description="Row index (0-3)",
                required=True,
                schema=ActionParameterSchema(type="number"),
            ),
            ActionParameter(
                name="column",
                description="Column index (0-2)",
                required=True,
                schema=ActionParameterSchema(type="number"),
            ),
            ActionParameter(
                name="product_id",
                description="Product ID to restock (e.g., 'water', 'soda_cola')",
                required=True,
                schema=ActionParameterSchema(type="string"),
            ),
            ActionParameter(
                name="quantity",
                description="Number of items to add (max 10 per slot)",
                required=True,
                schema=ActionParameterSchema(type="number"),
            ),
        ]
    )

    async def validate(
        self, runtime: IAgentRuntime, _message: Memory, _state: State | None = None
    ) -> bool:
        return True

    async def handler(
        self,
        runtime: IAgentRuntime,
        message: Memory,
        state: State | None = None,
        options: HandlerOptions | None = None,
        callback: HandlerCallback | None = None,
        responses: list[Memory] | None = None,
    ) -> ActionResult:
        env = _get_env(runtime)
        params: dict[str, Any] = {}
        if options and options.parameters:
            params = options.parameters

        try:
            row = int(params.get("row", 0))
            column = int(params.get("column", 0))
            product_id = str(params.get("product_id", ""))
            quantity = int(params.get("quantity", 0))
        except (ValueError, TypeError) as e:
            return ActionResult(
                text=f"Error: Invalid parameters - {e}",
                success=False,
            )

        result = env.action_restock_slot(row, column, product_id, quantity)
        success = "Error" not in result

        if callback:
            await callback(Content(text=result, actions=["RESTOCK_SLOT"]))

        return ActionResult(
            text=result,
            success=success,
            values={"restocked": success, "slot": f"[{row},{column}]"},
        )

    @property
    def examples(self) -> list[list[ActionExample]]:
        return [
            [
                ActionExample(
                    name="{{user}}",
                    content=Content(text="Fill slot 0,0 with water"),
                ),
                ActionExample(
                    name="{{agent}}",
                    content=Content(
                        text="I'll restock that slot with water.",
                        actions=["RESTOCK_SLOT"],
                    ),
                ),
            ],
        ]


restock_slot_action = Action(
    name=RestockSlotAction.name,
    similes=RestockSlotAction().similes,
    description=RestockSlotAction.description,
    validate=RestockSlotAction().validate,
    handler=RestockSlotAction().handler,
    examples=RestockSlotAction().examples,
    parameters=RestockSlotAction().parameters,
)


@dataclass
class SetPriceAction:
    """Action to set the price for a slot."""

    name: str = "SET_PRICE"
    similes: list[str] = field(default_factory=lambda: ["PRICE", "CHANGE_PRICE", "UPDATE_PRICE"])
    description: str = (
        "Set the price for a product in a vending machine slot. "
        "Higher prices reduce demand, lower prices increase it."
    )
    parameters: list[ActionParameter] = field(
        default_factory=lambda: [
            ActionParameter(
                name="row",
                description="Row index (0-3)",
                required=True,
                schema=ActionParameterSchema(type="number"),
            ),
            ActionParameter(
                name="column",
                description="Column index (0-2)",
                required=True,
                schema=ActionParameterSchema(type="number"),
            ),
            ActionParameter(
                name="price",
                description="New price in dollars (e.g., 1.50)",
                required=True,
                schema=ActionParameterSchema(type="number"),
            ),
        ]
    )

    async def validate(
        self, runtime: IAgentRuntime, _message: Memory, _state: State | None = None
    ) -> bool:
        return True

    async def handler(
        self,
        runtime: IAgentRuntime,
        message: Memory,
        state: State | None = None,
        options: HandlerOptions | None = None,
        callback: HandlerCallback | None = None,
        responses: list[Memory] | None = None,
    ) -> ActionResult:
        env = _get_env(runtime)
        params: dict[str, Any] = {}
        if options and options.parameters:
            params = options.parameters

        try:
            row = int(params.get("row", 0))
            column = int(params.get("column", 0))
            price = Decimal(str(params.get("price", 0)))
        except (ValueError, TypeError) as e:
            return ActionResult(text=f"Error: Invalid parameters - {e}", success=False)

        result = env.action_set_price(row, column, price)
        success = "Error" not in result

        if callback:
            await callback(Content(text=result, actions=["SET_PRICE"]))

        return ActionResult(
            text=result,
            success=success,
            values={"priceSet": success, "newPrice": float(price)},
        )

    @property
    def examples(self) -> list[list[ActionExample]]:
        return []


set_price_action = Action(
    name=SetPriceAction.name,
    similes=SetPriceAction().similes,
    description=SetPriceAction.description,
    validate=SetPriceAction().validate,
    handler=SetPriceAction().handler,
    examples=SetPriceAction().examples,
    parameters=SetPriceAction().parameters,
)


@dataclass
class CollectCashAction:
    """Action to collect cash from the vending machine."""

    name: str = "COLLECT_CASH"
    similes: list[str] = field(default_factory=lambda: ["COLLECT", "GET_CASH", "WITHDRAW"])
    description: str = (
        "Collect accumulated cash from the vending machine. "
        "This moves money from the machine to your cash on hand."
    )

    async def validate(
        self, runtime: IAgentRuntime, _message: Memory, _state: State | None = None
    ) -> bool:
        return True

    async def handler(
        self,
        runtime: IAgentRuntime,
        message: Memory,
        state: State | None = None,
        options: HandlerOptions | None = None,
        callback: HandlerCallback | None = None,
        responses: list[Memory] | None = None,
    ) -> ActionResult:
        env = _get_env(runtime)
        result = env.action_collect_cash()
        success = "Collected" in result or "No cash" in result

        if callback:
            await callback(Content(text=result, actions=["COLLECT_CASH"]))

        return ActionResult(
            text=result,
            success=success,
            values={"collected": "Collected" in result},
        )

    @property
    def examples(self) -> list[list[ActionExample]]:
        return []


collect_cash_action = Action(
    name=CollectCashAction.name,
    similes=CollectCashAction().similes,
    description=CollectCashAction.description,
    validate=CollectCashAction().validate,
    handler=CollectCashAction().handler,
    examples=CollectCashAction().examples,
)


@dataclass
class AdvanceDayAction:
    """Action to advance to the next day."""

    name: str = "ADVANCE_DAY"
    similes: list[str] = field(default_factory=lambda: ["NEXT_DAY", "END_DAY", "SKIP_DAY", "PASS"])
    description: str = (
        "Advance to the next day in the simulation. "
        "This processes sales, updates deliveries, and moves time forward. "
        "Use this when you've completed your actions for the day."
    )

    async def validate(
        self, runtime: IAgentRuntime, _message: Memory, _state: State | None = None
    ) -> bool:
        return True

    async def handler(
        self,
        runtime: IAgentRuntime,
        message: Memory,
        state: State | None = None,
        options: HandlerOptions | None = None,
        callback: HandlerCallback | None = None,
        responses: list[Memory] | None = None,
    ) -> ActionResult:
        env = _get_env(runtime)
        result = env.action_advance_day()

        if callback:
            await callback(Content(text=result, actions=["ADVANCE_DAY"]))

        return ActionResult(
            text=result,
            success=True,
            values={"dayAdvanced": True, "newDay": env.state.current_day},
        )

    @property
    def examples(self) -> list[list[ActionExample]]:
        return [
            [
                ActionExample(
                    name="{{user}}",
                    content=Content(text="I'm done for today"),
                ),
                ActionExample(
                    name="{{agent}}",
                    content=Content(
                        text="Advancing to the next day.",
                        actions=["ADVANCE_DAY"],
                    ),
                ),
            ],
        ]


advance_day_action = Action(
    name=AdvanceDayAction.name,
    similes=AdvanceDayAction().similes,
    description=AdvanceDayAction.description,
    validate=AdvanceDayAction().validate,
    handler=AdvanceDayAction().handler,
    examples=AdvanceDayAction().examples,
)


# ============================================================================
# PLUGIN DEFINITION
# ============================================================================

VENDING_ACTIONS = [
    place_order_action,
    restock_slot_action,
    set_price_action,
    collect_cash_action,
    advance_day_action,
]

VENDING_PROVIDERS = [
    business_state_provider,
    suppliers_provider,
    deliveries_provider,
]


async def _init_vending_plugin(
    config: dict[str, str | int | float | bool | None],
    runtime: IAgentRuntime,
) -> None:
    """Initialize the vending-bench plugin."""
    runtime.logger.info(
        "Initializing Vending-Bench plugin",
        src="plugin:vending-bench",
        agent_id=str(runtime.agent_id),
    )

    # Initialize a fresh environment using module-level storage
    _reset_env(runtime)

    runtime.logger.info(
        "Vending-Bench plugin initialized",
        src="plugin:vending-bench",
        agent_id=str(runtime.agent_id),
        actionCount=len(VENDING_ACTIONS),
        providerCount=len(VENDING_PROVIDERS),
    )


def create_vending_bench_plugin() -> Plugin:
    """Create the Vending-Bench plugin."""
    return Plugin(
        name="vending-bench",
        description=(
            "Vending-Bench benchmark plugin for evaluating LLM agent coherence "
            "in a simulated vending machine business. Provides actions for ordering, "
            "restocking, pricing, and cash collection, plus providers for business state."
        ),
        init=_init_vending_plugin,
        config={},
        actions=VENDING_ACTIONS,
        providers=VENDING_PROVIDERS,
        evaluators=[],
        services=[],
    )


vending_bench_plugin = create_vending_bench_plugin()

__all__ = [
    "vending_bench_plugin",
    "create_vending_bench_plugin",
    "VENDING_ACTIONS",
    "VENDING_PROVIDERS",
]
