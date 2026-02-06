"""
Vending-Bench ElizaOS Plugin

Provides proper ElizaOS integration for the Vending-Bench benchmark with:
- OpenAI/Anthropic model provider for LLM calls
- Actions for vending machine operations
- Provider for business state context
- Evaluator for coherence validation
"""

from __future__ import annotations

import logging
import os
from decimal import Decimal
from typing import TYPE_CHECKING

from elizaos_vending_bench.environment import VendingEnvironment

if TYPE_CHECKING:
    from elizaos.types.components import (
        Action,
        ActionResult,
        HandlerCallback,
        HandlerOptions,
        Provider,
        ProviderResult,
    )
    from elizaos.types.memory import Memory
    from elizaos.types.plugin import Plugin
    from elizaos.types.runtime import IAgentRuntime
    from elizaos.types.state import State

logger = logging.getLogger(__name__)

# Shared environment instance per benchmark run
_environment: VendingEnvironment | None = None


def set_environment(env: VendingEnvironment) -> None:
    """Set the shared environment for the plugin actions."""
    global _environment
    _environment = env


def get_environment() -> VendingEnvironment | None:
    """Get the shared environment."""
    return _environment


async def openai_model_handler(
    runtime: IAgentRuntime,
    params: dict[str, object],
) -> str:
    """
    OpenAI model handler for TEXT_LARGE requests.

    Args:
        runtime: The agent runtime
        params: Parameters including 'prompt' or 'messages', 'temperature', etc.

    Returns:
        Generated text response
    """
    import aiohttp

    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        # Try to get from runtime settings
        api_key_setting = runtime.get_setting("OPENAI_API_KEY")
        if isinstance(api_key_setting, str):
            api_key = api_key_setting

    if not api_key:
        raise ValueError(
            "OPENAI_API_KEY not found. Set it as an environment variable or in character settings."
        )

    # Build messages from params
    messages: list[dict[str, str]] = []
    messages_raw = params.get("messages")

    if isinstance(messages_raw, list):
        for item in messages_raw:
            if not isinstance(item, dict):
                continue
            role_obj = item.get("role")
            content_obj = item.get("content")
            role = str(role_obj) if role_obj is not None else "user"
            content = str(content_obj) if content_obj is not None else ""
            messages.append({"role": role, "content": content})
    else:
        # Build messages from prompt/system
        system = params.get("system")
        if system is not None:
            messages.append({"role": "system", "content": str(system)})

        prompt = params.get("prompt")
        if prompt is not None:
            messages.append({"role": "user", "content": str(prompt)})

    if not messages:
        raise ValueError("No messages or prompt provided to model handler")

    # Get model parameters
    model = str(params.get("model", "gpt-4"))

    temperature_raw = params.get("temperature", 0.0)
    temperature = float(temperature_raw) if isinstance(temperature_raw, (int, float, str)) else 0.0

    max_tokens_raw = params.get("max_tokens", params.get("maxTokens", 4096))
    max_tokens = int(max_tokens_raw) if isinstance(max_tokens_raw, (int, str)) else 4096

    async with aiohttp.ClientSession() as session:
        async with session.post(
            "https://api.openai.com/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                # Avoid brotli ("br") responses unless brotli libs are installed.
                "Accept-Encoding": "gzip, deflate",
            },
            json={
                "model": model,
                "messages": messages,
                "temperature": temperature,
                "max_tokens": max_tokens,
            },
        ) as response:
            if response.status != 200:
                error_text = await response.text()
                raise RuntimeError(f"OpenAI API error ({response.status}): {error_text}")

            data = await response.json()

    # Extract response text
    choices = data.get("choices", [])
    if not choices:
        raise ValueError("No choices in OpenAI response")

    message = choices[0].get("message", {})
    content = message.get("content", "")

    return content


def create_vending_actions() -> list[Action]:
    """
    Create ElizaOS Action objects for vending machine operations.
    """
    from elizaos.types.components import (
        Action,
        ActionParameter,
        ActionParameterSchema,
        ActionResult,
    )

    actions: list[Action] = []

    # Validation function (always allow)
    async def always_valid(
        runtime: IAgentRuntime,
        message: Memory,
        state: State | None = None,
    ) -> bool:
        return _environment is not None

    # VIEW_BUSINESS_STATE Action
    async def view_state_handler(
        runtime: IAgentRuntime,
        message: Memory,
        state: State | None = None,
        options: HandlerOptions | None = None,
        callback: HandlerCallback | None = None,
        responses: list[Memory] | None = None,
    ) -> ActionResult:
        if _environment is None:
            return ActionResult(
                text="Environment not initialized",
                success=False,
                error="No environment",
            )

        result = _environment.action_view_state()
        return ActionResult(
            text=result,
            data={"actionName": "VIEW_BUSINESS_STATE"},
            success=True,
        )

    actions.append(
        Action(
            name="VIEW_BUSINESS_STATE",
            description="View the current state of your vending machine business including inventory, cash, and orders",
            similes=["check status", "view inventory", "check business"],
            handler=view_state_handler,
            validate=always_valid,
        )
    )

    # VIEW_SUPPLIERS Action
    async def view_suppliers_handler(
        runtime: IAgentRuntime,
        message: Memory,
        state: State | None = None,
        options: HandlerOptions | None = None,
        callback: HandlerCallback | None = None,
        responses: list[Memory] | None = None,
    ) -> ActionResult:
        if _environment is None:
            return ActionResult(
                text="Environment not initialized", success=False, error="No environment"
            )

        result = _environment.action_view_suppliers()
        return ActionResult(
            text=result,
            data={"actionName": "VIEW_SUPPLIERS"},
            success=True,
        )

    actions.append(
        Action(
            name="VIEW_SUPPLIERS",
            description="View available suppliers and their products, prices, and lead times",
            similes=["check suppliers", "list products", "view catalog"],
            handler=view_suppliers_handler,
            validate=always_valid,
        )
    )

    # PLACE_ORDER Action
    async def place_order_handler(
        runtime: IAgentRuntime,
        message: Memory,
        state: State | None = None,
        options: HandlerOptions | None = None,
        callback: HandlerCallback | None = None,
        responses: list[Memory] | None = None,
    ) -> ActionResult:
        if _environment is None:
            return ActionResult(
                text="Environment not initialized", success=False, error="No environment"
            )

        supplier_id = ""
        items: dict[str, int] = {}

        if options and options.parameters:
            supplier_id = str(options.parameters.get("supplier_id", ""))
            items_raw = options.parameters.get("items", {})
            if isinstance(items_raw, dict):
                items = {str(k): int(v) for k, v in items_raw.items()}

        result = _environment.action_place_order(supplier_id, items)
        success = "Error" not in result

        return ActionResult(
            text=result,
            data={"actionName": "PLACE_ORDER", "supplier_id": supplier_id},
            success=success,
            error=result if not success else None,
        )

    actions.append(
        Action(
            name="PLACE_ORDER",
            description="Place an order with a supplier for products",
            similes=["order products", "buy inventory", "restock"],
            handler=place_order_handler,
            validate=always_valid,
            parameters=[
                ActionParameter(
                    name="supplier_id",
                    description="The ID of the supplier (e.g., 'beverage_dist', 'snack_co', 'healthy_choice')",
                    required=True,
                    schema=ActionParameterSchema(type="string"),
                ),
                ActionParameter(
                    name="items",
                    description="Object mapping product IDs to quantities (e.g., {'water': 12, 'soda_cola': 12})",
                    required=True,
                    schema=ActionParameterSchema(type="object"),
                ),
            ],
        )
    )

    # RESTOCK_SLOT Action
    async def restock_handler(
        runtime: IAgentRuntime,
        message: Memory,
        state: State | None = None,
        options: HandlerOptions | None = None,
        callback: HandlerCallback | None = None,
        responses: list[Memory] | None = None,
    ) -> ActionResult:
        if _environment is None:
            return ActionResult(
                text="Environment not initialized", success=False, error="No environment"
            )

        row = 0
        column = 0
        product_id = ""
        quantity = 0

        if options and options.parameters:
            row = int(options.parameters.get("row", 0))
            column = int(options.parameters.get("column", 0))
            product_id = str(options.parameters.get("product_id", ""))
            quantity = int(options.parameters.get("quantity", 0))

        result = _environment.action_restock_slot(row, column, product_id, quantity)
        success = "Error" not in result

        return ActionResult(
            text=result,
            data={"actionName": "RESTOCK_SLOT", "slot": f"{row},{column}"},
            success=success,
            error=result if not success else None,
        )

    actions.append(
        Action(
            name="RESTOCK_SLOT",
            description="Restock a vending machine slot with delivered inventory",
            similes=["fill slot", "add products", "restock machine"],
            handler=restock_handler,
            validate=always_valid,
            parameters=[
                ActionParameter(
                    name="row",
                    description="Slot row (0-3)",
                    required=True,
                    schema=ActionParameterSchema(type="number", minimum=0, maximum=3),
                ),
                ActionParameter(
                    name="column",
                    description="Slot column (0-2)",
                    required=True,
                    schema=ActionParameterSchema(type="number", minimum=0, maximum=2),
                ),
                ActionParameter(
                    name="product_id",
                    description="Product ID to stock",
                    required=True,
                    schema=ActionParameterSchema(type="string"),
                ),
                ActionParameter(
                    name="quantity",
                    description="Number of items to stock",
                    required=True,
                    schema=ActionParameterSchema(type="number", minimum=1),
                ),
            ],
        )
    )

    # SET_PRICE Action
    async def set_price_handler(
        runtime: IAgentRuntime,
        message: Memory,
        state: State | None = None,
        options: HandlerOptions | None = None,
        callback: HandlerCallback | None = None,
        responses: list[Memory] | None = None,
    ) -> ActionResult:
        if _environment is None:
            return ActionResult(
                text="Environment not initialized", success=False, error="No environment"
            )

        row = 0
        column = 0
        price = Decimal("0")

        if options and options.parameters:
            row = int(options.parameters.get("row", 0))
            column = int(options.parameters.get("column", 0))
            price = Decimal(str(options.parameters.get("price", 0)))

        result = _environment.action_set_price(row, column, price)
        success = "Error" not in result

        return ActionResult(
            text=result,
            data={"actionName": "SET_PRICE", "slot": f"{row},{column}", "price": str(price)},
            success=success,
        )

    actions.append(
        Action(
            name="SET_PRICE",
            description="Set the price for a product in a vending machine slot",
            similes=["change price", "update price", "set cost"],
            handler=set_price_handler,
            validate=always_valid,
            parameters=[
                ActionParameter(
                    name="row",
                    description="Slot row (0-3)",
                    required=True,
                    schema=ActionParameterSchema(type="number", minimum=0, maximum=3),
                ),
                ActionParameter(
                    name="column",
                    description="Slot column (0-2)",
                    required=True,
                    schema=ActionParameterSchema(type="number", minimum=0, maximum=2),
                ),
                ActionParameter(
                    name="price",
                    description="New price in dollars",
                    required=True,
                    schema=ActionParameterSchema(type="number", minimum=0),
                ),
            ],
        )
    )

    # COLLECT_CASH Action
    async def collect_cash_handler(
        runtime: IAgentRuntime,
        message: Memory,
        state: State | None = None,
        options: HandlerOptions | None = None,
        callback: HandlerCallback | None = None,
        responses: list[Memory] | None = None,
    ) -> ActionResult:
        if _environment is None:
            return ActionResult(
                text="Environment not initialized", success=False, error="No environment"
            )

        result = _environment.action_collect_cash()
        return ActionResult(
            text=result,
            data={"actionName": "COLLECT_CASH"},
            success=True,
        )

    actions.append(
        Action(
            name="COLLECT_CASH",
            description="Collect cash from the vending machine",
            similes=["get money", "empty machine", "collect revenue"],
            handler=collect_cash_handler,
            validate=always_valid,
        )
    )

    # CHECK_DELIVERIES Action
    async def check_deliveries_handler(
        runtime: IAgentRuntime,
        message: Memory,
        state: State | None = None,
        options: HandlerOptions | None = None,
        callback: HandlerCallback | None = None,
        responses: list[Memory] | None = None,
    ) -> ActionResult:
        if _environment is None:
            return ActionResult(
                text="Environment not initialized", success=False, error="No environment"
            )

        result = _environment.action_check_deliveries()
        return ActionResult(
            text=result,
            data={"actionName": "CHECK_DELIVERIES"},
            success=True,
        )

    actions.append(
        Action(
            name="CHECK_DELIVERIES",
            description="Check the status of pending orders and deliveries",
            similes=["check orders", "delivery status", "order status"],
            handler=check_deliveries_handler,
            validate=always_valid,
        )
    )

    # UPDATE_NOTES Action
    async def update_notes_handler(
        runtime: IAgentRuntime,
        message: Memory,
        state: State | None = None,
        options: HandlerOptions | None = None,
        callback: HandlerCallback | None = None,
        responses: list[Memory] | None = None,
    ) -> ActionResult:
        if _environment is None:
            return ActionResult(
                text="Environment not initialized", success=False, error="No environment"
            )

        key = "note"
        content = ""

        if options and options.parameters:
            key = str(options.parameters.get("key", "note"))
            content = str(options.parameters.get("content", ""))

        result = _environment.action_update_notes(key, content)
        return ActionResult(
            text=result,
            data={"actionName": "UPDATE_NOTES", "key": key},
            success=True,
        )

    actions.append(
        Action(
            name="UPDATE_NOTES",
            description="Save notes for yourself to remember important information",
            similes=["save note", "remember", "write down"],
            handler=update_notes_handler,
            validate=always_valid,
            parameters=[
                ActionParameter(
                    name="key",
                    description="Note title/key",
                    required=True,
                    schema=ActionParameterSchema(type="string"),
                ),
                ActionParameter(
                    name="content",
                    description="Note content",
                    required=True,
                    schema=ActionParameterSchema(type="string"),
                ),
            ],
        )
    )

    # ADVANCE_DAY Action
    async def advance_day_handler(
        runtime: IAgentRuntime,
        message: Memory,
        state: State | None = None,
        options: HandlerOptions | None = None,
        callback: HandlerCallback | None = None,
        responses: list[Memory] | None = None,
    ) -> ActionResult:
        if _environment is None:
            return ActionResult(
                text="Environment not initialized", success=False, error="No environment"
            )

        result = _environment.action_advance_day()
        return ActionResult(
            text=result,
            data={"actionName": "ADVANCE_DAY"},
            success=True,
        )

    actions.append(
        Action(
            name="ADVANCE_DAY",
            description="End your turn for today and advance to the next day",
            similes=["next day", "finish day", "end turn"],
            handler=advance_day_handler,
            validate=always_valid,
        )
    )

    return actions


def create_vending_provider() -> Provider:
    """Create a provider for vending business state context."""
    from elizaos.types.components import Provider, ProviderResult

    async def get_business_state(
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
    ) -> ProviderResult:
        if _environment is None:
            return ProviderResult(text="Business not initialized")

        env_state = _environment.state
        net_worth = _environment.get_net_worth()

        # Build context for the LLM
        context = f"""Current Business State:
- Day: {env_state.current_day}
- Date: {env_state.current_date}
- Cash on Hand: ${env_state.cash_on_hand:.2f}
- Cash in Machine: ${env_state.machine.cash_in_machine:.2f}
- Net Worth: ${net_worth:.2f}
- Pending Orders: {len([o for o in env_state.pending_orders if o.status.value != "delivered"])}
- Delivered Inventory: {len(env_state.delivered_inventory)} items to restock
"""

        return ProviderResult(
            text=context,
            data={
                "day": env_state.current_day,
                "cash_on_hand": str(env_state.cash_on_hand),
                "net_worth": str(net_worth),
            },
        )

    return Provider(
        name="vending_business_state",
        description="Provides current vending business state context",
        get=get_business_state,
        position=10,  # Run early to provide context
    )


def create_vending_bench_plugin() -> Plugin:
    """
    Create the Vending-Bench ElizaOS plugin.

    This plugin provides:
    - OpenAI model handler for TEXT_LARGE
    - Actions for all vending machine operations
    - Provider for business state context

    Returns:
        Plugin configured for Vending-Bench
    """
    from elizaos.types.model import ModelType
    from elizaos.types.plugin import Plugin

    actions = create_vending_actions()
    provider = create_vending_provider()

    async def init_plugin(
        config: dict[str, str | int | float | bool | None],
        runtime: IAgentRuntime,
    ) -> None:
        """Initialize the Vending-Bench plugin."""
        runtime.logger.info("Initializing Vending-Bench plugin")

        # Verify API key is available
        api_key = os.getenv("OPENAI_API_KEY") or runtime.get_setting("OPENAI_API_KEY")
        if not api_key:
            runtime.logger.warning(
                "OPENAI_API_KEY not found. LLM calls will fail. "
                "Set it as an environment variable or use heuristic agent."
            )

        runtime.logger.info(f"Vending-Bench plugin initialized with {len(actions)} actions")

    return Plugin(
        name="vending-bench",
        description="Vending-Bench benchmark plugin for evaluating LLM coherence on business simulation",
        init=init_plugin,
        config={},
        actions=actions,
        providers=[provider],
        models={
            ModelType.TEXT_LARGE: openai_model_handler,
            ModelType.TEXT_SMALL: openai_model_handler,
        },
    )


# Default plugin instance
vending_bench_plugin = create_vending_bench_plugin()
