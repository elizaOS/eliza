"""UPDATE_CHECKOUT_SESSION Action."""

from __future__ import annotations

import os
from dataclasses import dataclass

from elizaos_plugin_acp.client import AcpApiError, create_acp_client_from_env
from elizaos_plugin_acp.types import (
    TotalType,
    UpdateCheckoutSessionRequest,
)

UPDATE_CHECKOUT_SESSION_ACTION: dict[str, object] = {
    "name": "UPDATE_CHECKOUT_SESSION",
    "similes": [
        "UPDATE_CHECKOUT_SESSION",
        "MODIFY_CART",
        "UPDATE_CART",
        "CHANGE_QUANTITY",
        "ADD_DISCOUNT",
        "APPLY_COUPON",
        "SELECT_SHIPPING",
    ],
    "description": (
        "Updates an existing ACP checkout session. "
        "Use this when the user wants to modify cart items, apply discounts, or change shipping options."
    ),
    "examples": [
        [
            {
                "name": "{{user1}}",
                "content": {"text": "Change the quantity to 5"},
            },
            {
                "name": "{{agent}}",
                "content": {
                    "text": "I've updated your checkout session.\n\n**Items:** 5x Blue Widget\n**Total:** $49.95 USD\n**Status:** ready_for_payment",
                    "actions": ["UPDATE_CHECKOUT_SESSION_SUCCESS"],
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


async def validate_update_checkout_session(runtime, message) -> bool:  # noqa: ANN001
    """Validate the update checkout session action."""
    base_url = os.environ.get("ACP_MERCHANT_BASE_URL")
    if not base_url:
        return False

    # Check for active session (simplified - would check cache in real implementation)
    return True


async def handle_update_checkout_session(  # noqa: ANN001
    runtime,
    message,
    state,
    options=None,
    callback=None,
    responses=None,
) -> ActionResult:
    """Handle the update checkout session action."""
    # Get active session ID from state/cache
    session_id = None
    if state and hasattr(state, "data"):
        session_id = state.data.get("active_session_id")

    if not session_id:
        return ActionResult(
            success=False,
            text="There's no active checkout session to update. Would you like to start a new checkout?",
            error="No active session",
        )

    client = create_acp_client_from_env()
    if not client:
        return ActionResult(
            success=False,
            text="Checkout is not currently available.",
            error="ACP client not configured",
        )

    try:
        # Get current session
        current_session = await client.get_checkout_session(session_id)

        # Build update request (simplified)
        request = UpdateCheckoutSessionRequest()

        # Apply update
        import time

        idempotency_key = f"update_{session_id}_{int(time.time() * 1000)}"
        updated_session = await client.update_checkout_session(
            session_id, request, idempotency_key
        )

        # Format response
        total = next((t for t in updated_session.totals if t.type == TotalType.TOTAL), None)
        total_text = (
            f"{total.amount / 100:.2f} {updated_session.currency}"
            if total
            else "calculating..."
        )

        item_list = ", ".join(
            f"{item.quantity}x {item.name or item.item.id}"
            for item in updated_session.line_items
        )

        response_text = (
            f"I've updated your checkout session.\n\n"
            f"**Items:** {item_list}\n"
            f"**Total:** {total_text}\n"
            f"**Status:** {updated_session.status.value}"
        )

        return ActionResult(
            success=True,
            text=response_text,
            data={
                "sessionId": updated_session.id,
                "session": updated_session.model_dump(),
            },
        )

    except AcpApiError as e:
        return ActionResult(
            success=False,
            text=f"I encountered an error updating the checkout: {e}",
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
