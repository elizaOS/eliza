"""CREATE_CHECKOUT_SESSION Action."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import TYPE_CHECKING

from elizaos_plugin_acp.client import AcpApiError, create_acp_client_from_env
from elizaos_plugin_acp.types import (
    CreateCheckoutSessionRequest,
    Item,
    TotalType,
)

if TYPE_CHECKING:
    pass

CREATE_CHECKOUT_SESSION_ACTION: dict[str, object] = {
    "name": "CREATE_CHECKOUT_SESSION",
    "similes": [
        "CREATE_CHECKOUT_SESSION",
        "START_CHECKOUT",
        "CREATE_CART",
        "BEGIN_PURCHASE",
        "ADD_TO_CART",
        "START_ORDER",
    ],
    "description": (
        "Creates a new ACP checkout session to begin a purchase flow. "
        "Use this when the user wants to buy items, start a checkout, or add items to cart."
    ),
    "examples": [
        [
            {
                "name": "{{user1}}",
                "content": {"text": "I'd like to buy 2 units of SKU-SHIRT-001"},
            },
            {
                "name": "{{agent}}",
                "content": {
                    "text": "I've created a checkout session with 1 item(s): 2x SKU-SHIRT-001.\n\n**Total:** $59.98 USD\n**Status:** incomplete",
                    "actions": ["CREATE_CHECKOUT_SESSION_SUCCESS"],
                },
            },
        ],
    ],
}


@dataclass
class ActionResult:
    """Action result."""

    success: bool
    text: str
    error: str | None = None
    data: dict[str, object] | None = None


async def validate_create_checkout_session(runtime, message) -> bool:  # noqa: ANN001
    """Validate the create checkout session action."""
    base_url = os.environ.get("ACP_MERCHANT_BASE_URL")
    return bool(base_url)


async def handle_create_checkout_session(  # noqa: ANN001
    runtime,
    message,
    state,
    options=None,
    callback=None,
    responses=None,
) -> ActionResult:
    """Handle the create checkout session action."""
    # Check for room/entity context
    if not hasattr(message, "room_id") or not message.room_id:
        return ActionResult(
            success=False,
            text="I cannot create a checkout session without a room context.",
            error="Missing room context",
        )

    # Create the ACP client
    client = create_acp_client_from_env()
    if not client:
        return ActionResult(
            success=False,
            text="Checkout is not currently available. The merchant connection has not been configured.",
            error="ACP client not configured",
        )

    # Extract items from message (simplified - in production would use LLM extraction)
    # For now, use a simple approach expecting structured input
    text = getattr(message.content, "text", "") if hasattr(message, "content") else ""

    # Simple parsing - in real implementation this would use LLM extraction
    items: list[Item] = []
    if "item" in text.lower() or "sku" in text.lower() or "buy" in text.lower():
        # Default to a sample item if we can't parse
        items.append(Item(id="item_default", quantity=1))

    if not items:
        return ActionResult(
            success=False,
            text="I couldn't determine which items you'd like to purchase. Could you please specify the items, quantities, and any other details?",
            error="Could not extract checkout items",
        )

    # Build the request
    request = CreateCheckoutSessionRequest(
        line_items=items,
        currency="USD",
        metadata={
            "elizaos_room_id": str(getattr(message, "room_id", "")),
            "elizaos_entity_id": str(getattr(message, "entity_id", "")),
        },
    )

    try:
        import time

        idempotency_key = f"create_{getattr(message, 'room_id', '')}_{int(time.time() * 1000)}"
        session = await client.create_checkout_session(request, idempotency_key)

        # Format the response
        item_summary = ", ".join(
            f"{item.quantity}x {item.name or item.item.id}" for item in session.line_items
        )

        total = next((t for t in session.totals if t.type == TotalType.TOTAL), None)
        total_text = f"{total.amount / 100:.2f} {session.currency}" if total else "calculating..."

        response_text = (
            f"I've created a checkout session with {len(session.line_items)} item(s): {item_summary}.\n\n"
            f"**Total:** {total_text}\n"
            f"**Status:** {session.status.value}"
        )

        return ActionResult(
            success=True,
            text=response_text,
            data={
                "sessionId": session.id,
                "session": session.model_dump(),
            },
        )

    except AcpApiError as e:
        return ActionResult(
            success=False,
            text=f"I encountered an error while creating the checkout session: {e}",
            error=str(e),
        )
    except Exception as e:
        return ActionResult(
            success=False,
            text=f"An unexpected error occurred: {e}",
            error=str(e),
        )
    finally:
        await client.close()
