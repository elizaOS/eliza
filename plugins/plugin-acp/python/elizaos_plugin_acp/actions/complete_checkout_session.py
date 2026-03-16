"""COMPLETE_CHECKOUT_SESSION Action."""

from __future__ import annotations

import os
from dataclasses import dataclass

from elizaos_plugin_acp.client import AcpApiError, create_acp_client_from_env
from elizaos_plugin_acp.types import (
    CheckoutSessionStatus,
    CompleteCheckoutSessionRequest,
    PaymentCredential,
    PaymentData,
    PaymentInstrument,
)

COMPLETE_CHECKOUT_SESSION_ACTION: dict[str, object] = {
    "name": "COMPLETE_CHECKOUT_SESSION",
    "similes": [
        "COMPLETE_CHECKOUT_SESSION",
        "COMPLETE_CHECKOUT",
        "FINISH_CHECKOUT",
        "PAY",
        "PROCESS_PAYMENT",
        "PLACE_ORDER",
        "CONFIRM_ORDER",
        "BUY_NOW",
    ],
    "description": (
        "Completes an ACP checkout session by processing payment. "
        "Use this when the user confirms they want to complete their purchase."
    ),
    "examples": [
        [
            {
                "name": "{{user1}}",
                "content": {"text": "Complete my order with payment token spt_abc123"},
            },
            {
                "name": "{{agent}}",
                "content": {
                    "text": "Your order has been completed successfully!\n\n**Order Number:** ORD-12345",
                    "actions": ["COMPLETE_CHECKOUT_SESSION_SUCCESS"],
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


async def validate_complete_checkout_session(runtime, message) -> bool:  # noqa: ANN001
    """Validate the complete checkout session action."""
    base_url = os.environ.get("ACP_MERCHANT_BASE_URL")
    return bool(base_url)


async def handle_complete_checkout_session(  # noqa: ANN001
    runtime,
    message,
    state,
    options=None,
    callback=None,
    responses=None,
) -> ActionResult:
    """Handle the complete checkout session action."""
    # Get active session ID
    session_id = None
    if state and hasattr(state, "data"):
        session_id = state.data.get("active_session_id")

    if not session_id:
        return ActionResult(
            success=False,
            text="There's no active checkout session to complete. Would you like to start a new checkout?",
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

        # Check if ready for payment
        if current_session.status != CheckoutSessionStatus.READY_FOR_PAYMENT:
            status_messages = {
                CheckoutSessionStatus.INCOMPLETE: "The checkout is missing required information.",
                CheckoutSessionStatus.NOT_READY_FOR_PAYMENT: "Please select a fulfillment option.",
                CheckoutSessionStatus.COMPLETED: "This checkout has already been completed.",
                CheckoutSessionStatus.CANCELED: "This checkout has been canceled.",
            }
            msg = status_messages.get(
                current_session.status,
                f"The checkout is not ready (status: {current_session.status.value}).",
            )
            return ActionResult(
                success=False,
                text=msg,
                error=msg,
            )

        # Extract payment token from message (simplified)
        text = getattr(message.content, "text", "") if hasattr(message, "content") else ""
        payment_token = None

        # Look for payment token in text
        if "spt_" in text:
            for word in text.split():
                if word.startswith("spt_"):
                    payment_token = word.rstrip(".,!?")
                    break

        if not payment_token:
            total = next(
                (
                    t
                    for t in current_session.totals
                    if t.type.value == "total"
                ),
                None,
            )
            total_text = (
                f"{total.amount / 100:.2f} {current_session.currency}"
                if total
                else "unknown"
            )
            return ActionResult(
                success=False,
                text=f"Your order total is {total_text}. To complete the checkout, please provide your payment token.",
                error="Payment information required",
            )

        # Build complete request
        request = CompleteCheckoutSessionRequest(
            payment_data=PaymentData(
                instrument=PaymentInstrument(
                    type="card",
                    credential=PaymentCredential(
                        type="spt",
                        token=payment_token,
                    ),
                ),
            ),
            buyer=current_session.buyer,
        )

        import time

        idempotency_key = f"complete_{session_id}_{int(time.time() * 1000)}"
        completed_session = await client.complete_checkout_session(
            session_id, request, idempotency_key
        )

        # Format success response
        response_text = "Your order has been completed successfully!\n\n"

        if completed_session.order:
            order = completed_session.order
            response_text += f"**Order Number:** {order.order_number or order.id}\n"

            if order.confirmation and order.confirmation.confirmation_number:
                response_text += f"**Confirmation:** {order.confirmation.confirmation_number}\n"

            if order.permalink_url:
                response_text += f"\n[Track your order]({order.permalink_url})"

        return ActionResult(
            success=True,
            text=response_text,
            data={
                "sessionId": completed_session.id,
                "orderId": completed_session.order.id if completed_session.order else None,
                "session": completed_session.model_dump(),
            },
        )

    except AcpApiError as e:
        return ActionResult(
            success=False,
            text=f"Payment processing failed: {e}. Please check your payment details.",
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
