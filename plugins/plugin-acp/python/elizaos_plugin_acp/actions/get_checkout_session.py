"""GET_CHECKOUT_SESSION Action."""

from __future__ import annotations

import os
from dataclasses import dataclass

from elizaos_plugin_acp.client import AcpApiError, create_acp_client_from_env
from elizaos_plugin_acp.types import CheckoutSession, TotalType

GET_CHECKOUT_SESSION_ACTION: dict[str, object] = {
    "name": "GET_CHECKOUT_SESSION",
    "similes": [
        "GET_CHECKOUT_SESSION",
        "CHECK_CART",
        "VIEW_CART",
        "CART_STATUS",
        "ORDER_STATUS",
        "CHECKOUT_STATUS",
        "WHATS_IN_MY_CART",
    ],
    "description": (
        "Retrieves and displays the current state of an ACP checkout session. "
        "Use this when the user wants to see their cart or check order status."
    ),
    "examples": [
        [
            {
                "name": "{{user1}}",
                "content": {"text": "What's in my cart?"},
            },
            {
                "name": "{{agent}}",
                "content": {
                    "text": "**Checkout Session:** cs_abc123\n**Status:** ready_for_payment\n\n**Items:**\n- 2x Blue Widget",
                    "actions": ["GET_CHECKOUT_SESSION_SUCCESS"],
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


def format_session_status(session: CheckoutSession) -> str:
    """Format a checkout session for display."""
    lines: list[str] = []

    # Session ID and status
    lines.append(f"**Checkout Session:** {session.id}")
    lines.append(f"**Status:** {session.status.value}")
    lines.append("")

    # Items
    if session.line_items:
        lines.append("**Items:**")
        for item in session.line_items:
            price_str = ""
            if item.unit_amount:
                price_str = f" - {item.unit_amount / 100:.2f} {session.currency}"
            lines.append(f"- {item.quantity}x {item.name or item.item.id}{price_str}")
        lines.append("")

    # Totals
    display_types = {
        TotalType.SUBTOTAL,
        TotalType.DISCOUNT,
        TotalType.FULFILLMENT,
        TotalType.TAX,
        TotalType.TOTAL,
    }
    display_totals = [t for t in session.totals if t.type in display_types]
    if display_totals:
        lines.append("**Totals:**")
        for total in display_totals:
            lines.append(f"- {total.display_text}: {total.amount / 100:.2f} {session.currency}")
        lines.append("")

    # Fulfillment
    if session.selected_fulfillment_options:
        selected_option = next(
            (
                opt
                for opt in session.fulfillment_options
                if any(sel.option_id == opt.id for sel in session.selected_fulfillment_options)
            ),
            None,
        )
        if selected_option:
            lines.append(f"**Fulfillment:** {selected_option.title}")
    elif session.fulfillment_options:
        lines.append("**Available Fulfillment Options:**")
        for option in session.fulfillment_options[:3]:
            lines.append(f"- {option.title}")
        if len(session.fulfillment_options) > 3:
            lines.append(f"  ... and {len(session.fulfillment_options) - 3} more")
        lines.append("")

    # Discounts
    if session.discounts and session.discounts.applied:
        lines.append("**Applied Discounts:**")
        for discount in session.discounts.applied:
            savings = discount.amount / 100
            lines.append(f"- {discount.coupon.name}: -{savings:.2f} {session.currency}")
        lines.append("")

    # Important messages
    important_messages = [m for m in session.messages if m.type.value != "info"]
    if important_messages:
        lines.append("**Notes:**")
        for msg in important_messages:
            icon = "⚠️" if msg.type.value == "error" else "ℹ️"
            lines.append(f"{icon} {msg.content}")
        lines.append("")

    # Next steps
    status_hints = {
        "incomplete": "_Next: Provide missing information to continue._",
        "not_ready_for_payment": "_Next: Select a fulfillment option to proceed._",
        "ready_for_payment": "_Ready to complete! Provide payment details._",
        "completed": "_Order completed!_",
        "canceled": "_This checkout has been canceled._",
        "expired": "_This checkout has expired._",
    }
    hint = status_hints.get(session.status.value, "")
    if hint:
        lines.append(hint)

    return "\n".join(lines)


async def validate_get_checkout_session(runtime, message) -> bool:  # noqa: ANN001
    """Validate the get checkout session action."""
    base_url = os.environ.get("ACP_MERCHANT_BASE_URL")
    return bool(base_url)


async def handle_get_checkout_session(  # noqa: ANN001
    runtime,
    message,
    state,
    options=None,
    callback=None,
    responses=None,
) -> ActionResult:
    """Handle the get checkout session action."""
    # Get active session ID
    session_id = None
    if state and hasattr(state, "data"):
        session_id = state.data.get("active_session_id")

    if not session_id:
        return ActionResult(
            success=False,
            text="You don't have an active checkout session. Would you like to start shopping?",
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
        session = await client.get_checkout_session(session_id)
        response_text = format_session_status(session)

        return ActionResult(
            success=True,
            text=response_text,
            data={
                "sessionId": session.id,
                "session": session.model_dump(),
            },
        )

    except AcpApiError:
        return ActionResult(
            success=False,
            text="I couldn't find your checkout session. It may have expired. Would you like to start a new checkout?",
            error="Session not found",
        )
    except Exception as e:
        return ActionResult(
            success=False,
            text=f"An unexpected error occurred: {e}",
            error=str(e),
        )
    finally:
        await client.close()
