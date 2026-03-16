"""CANCEL_CHECKOUT_SESSION Action."""

from __future__ import annotations

import os
from dataclasses import dataclass

from elizaos_plugin_acp.client import AcpApiError, create_acp_client_from_env
from elizaos_plugin_acp.types import (
    CancelCheckoutSessionRequest,
    CheckoutSessionStatus,
    IntentTrace,
    IntentTraceReasonCode,
)

CANCEL_CHECKOUT_SESSION_ACTION: dict[str, object] = {
    "name": "CANCEL_CHECKOUT_SESSION",
    "similes": [
        "CANCEL_CHECKOUT_SESSION",
        "CANCEL_CHECKOUT",
        "CANCEL_ORDER",
        "ABANDON_CART",
        "CLEAR_CART",
        "STOP_CHECKOUT",
        "NEVERMIND",
    ],
    "description": (
        "Cancels an active ACP checkout session. "
        "Use this when the user wants to cancel their order or abandon their cart."
    ),
    "examples": [
        [
            {
                "name": "{{user1}}",
                "content": {"text": "Cancel my order"},
            },
            {
                "name": "{{agent}}",
                "content": {
                    "text": "Your checkout has been canceled. Let me know if you'd like to start a new order.",
                    "actions": ["CANCEL_CHECKOUT_SESSION_SUCCESS"],
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


async def validate_cancel_checkout_session(runtime, message) -> bool:  # noqa: ANN001
    """Validate the cancel checkout session action."""
    base_url = os.environ.get("ACP_MERCHANT_BASE_URL")
    return bool(base_url)


async def handle_cancel_checkout_session(  # noqa: ANN001
    runtime,
    message,
    state,
    options=None,
    callback=None,
    responses=None,
) -> ActionResult:
    """Handle the cancel checkout session action."""
    # Get active session ID
    session_id = None
    if state and hasattr(state, "data"):
        session_id = state.data.get("active_session_id")

    if not session_id:
        return ActionResult(
            success=False,
            text="There's no active checkout session to cancel.",
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
        # Get current session to check status
        try:
            current_session = await client.get_checkout_session(session_id)
        except AcpApiError:
            return ActionResult(
                success=True,
                text="The checkout session has already been canceled or expired.",
            )

        # Check if already completed or canceled
        if current_session.status == CheckoutSessionStatus.COMPLETED:
            return ActionResult(
                success=False,
                text="This checkout has already been completed. Contact support if you need to return your order.",
                error="Session already completed",
            )

        if current_session.status == CheckoutSessionStatus.CANCELED:
            return ActionResult(
                success=True,
                text="This checkout has already been canceled.",
            )

        # Determine cancellation reason from message (simplified)
        text = getattr(message.content, "text", "") if hasattr(message, "content") else ""
        text_lower = text.lower()

        reason_code = IntentTraceReasonCode.OTHER
        if "expensive" in text_lower or "price" in text_lower or "cost" in text_lower:
            reason_code = IntentTraceReasonCode.PRICE_SENSITIVITY
        elif "shipping" in text_lower and ("expensive" in text_lower or "cost" in text_lower):
            reason_code = IntentTraceReasonCode.SHIPPING_COST
        elif "slow" in text_lower or "delivery" in text_lower:
            reason_code = IntentTraceReasonCode.SHIPPING_SPEED
        elif "later" in text_lower or "not now" in text_lower:
            reason_code = IntentTraceReasonCode.TIMING_DEFERRED
        elif "compare" in text_lower or "shopping around" in text_lower:
            reason_code = IntentTraceReasonCode.COMPARISON

        # Build cancel request
        request = CancelCheckoutSessionRequest(
            intent_trace=IntentTrace(
                reason_code=reason_code,
                metadata={
                    "elizaos_room_id": str(getattr(message, "room_id", "")),
                    "canceled_at": str(__import__("datetime").datetime.now().isoformat()),
                },
            ),
        )

        canceled_session = await client.cancel_checkout_session(session_id, request)

        # Format response based on reason
        response_text = "Your checkout has been canceled."

        follow_up_messages = {
            IntentTraceReasonCode.PRICE_SENSITIVITY: " If you find a discount code, feel free to start a new checkout.",
            IntentTraceReasonCode.SHIPPING_COST: " If you find a discount code, feel free to start a new checkout.",
            IntentTraceReasonCode.SHIPPING_SPEED: " If faster shipping becomes available, I can help you start a new order.",
            IntentTraceReasonCode.TIMING_DEFERRED: " Just let me know when you're ready to complete your purchase.",
            IntentTraceReasonCode.COMPARISON: " Take your time. I'm here when you're ready to order.",
        }

        response_text += follow_up_messages.get(
            reason_code,
            " Let me know if you'd like to start a new order.",
        )

        return ActionResult(
            success=True,
            text=response_text,
            data={
                "sessionId": canceled_session.id,
                "reasonCode": reason_code.value,
                "session": canceled_session.model_dump(),
            },
        )

    except AcpApiError as e:
        return ActionResult(
            success=False,
            text=f"I encountered an error canceling the checkout: {e}",
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
