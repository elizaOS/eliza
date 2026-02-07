"""CHECKOUT_SESSION Provider."""

from __future__ import annotations

import logging
from dataclasses import dataclass

from elizaos_plugin_acp.client import create_acp_client_from_env
from elizaos_plugin_acp.types import CheckoutSession, TotalType

logger = logging.getLogger(__name__)

CHECKOUT_SESSION_PROVIDER: dict[str, object] = {
    "name": "CHECKOUT_SESSION",
    "description": (
        "Provides current ACP checkout session context including cart items, totals, and status"
    ),
}


@dataclass
class ProviderResult:
    """Provider result."""

    text: str
    values: dict[str, str]
    data: dict[str, object]


def format_session_for_context(session: CheckoutSession) -> str:
    """Format a checkout session for the agent context."""
    lines: list[str] = []

    lines.append(f"Active checkout session: {session.id}")
    lines.append(f"Status: {session.status.value}")
    lines.append(f"Currency: {session.currency}")

    # Items summary
    if session.line_items:
        item_list = ", ".join(
            f"{item.quantity}x {item.name or item.item.id}" for item in session.line_items
        )
        lines.append(f"Items: {item_list}")

    # Total
    total = next((t for t in session.totals if t.type == TotalType.TOTAL), None)
    if total:
        lines.append(f"Total: {total.amount / 100:.2f} {session.currency}")

    # Fulfillment status
    if session.selected_fulfillment_options:
        selected_types = ", ".join(o.type.value for o in session.selected_fulfillment_options)
        lines.append(f"Selected fulfillment: {selected_types}")
    elif session.fulfillment_options:
        options = ", ".join(o.title for o in session.fulfillment_options)
        lines.append(f"Available fulfillment options: {options}")

    # Discounts
    if session.discounts and session.discounts.applied:
        discount_names = ", ".join(d.coupon.name for d in session.discounts.applied)
        lines.append(f"Applied discounts: {discount_names}")

    # Warnings/errors
    issues = [m for m in session.messages if m.type.value in ("warning", "error")]
    if issues:
        issue_texts = "; ".join(m.content for m in issues)
        lines.append(f"Issues: {issue_texts}")

    # Next action hint
    status_hints = {
        "incomplete": "Action needed: Complete missing required information",
        "not_ready_for_payment": "Action needed: Select a fulfillment option",
        "ready_for_payment": "Ready for payment",
        "authentication_required": "Action needed: Complete authentication",
    }
    hint = status_hints.get(session.status.value)
    if hint:
        lines.append(hint)

    return "\n".join(lines)


async def get_checkout_session_context(  # noqa: ANN001
    runtime,
    message,
    state=None,
) -> ProviderResult:
    """Get the current checkout session context."""
    # Get active session ID from state/cache
    session_id = None
    if state and hasattr(state, "data"):
        session_id = state.data.get("active_session_id")

    if not session_id:
        return ProviderResult(
            text="No active checkout session",
            values={"hasActiveSession": "false"},
            data={"hasActiveSession": False},
        )

    client = create_acp_client_from_env()
    if not client:
        return ProviderResult(
            text="ACP checkout not configured",
            values={
                "hasActiveSession": "false",
                "configured": "false",
            },
            data={
                "hasActiveSession": False,
                "configured": False,
            },
        )

    try:
        session = await client.get_checkout_session(session_id)

        logger.debug(
            f"[CheckoutSessionProvider] Retrieved session {session_id}, "
            f"status={session.status.value}, items={len(session.line_items)}"
        )

        text = format_session_for_context(session)
        total = next((t for t in session.totals if t.type == TotalType.TOTAL), None)

        return ProviderResult(
            text=text,
            values={
                "hasActiveSession": "true",
                "sessionId": session.id,
                "status": session.status.value,
                "currency": session.currency,
                "itemCount": str(len(session.line_items)),
                "total": str(total.amount) if total else "0",
                "totalFormatted": f"{total.amount / 100:.2f} {session.currency}" if total else "0.00",
                "readyForPayment": str(session.status.value == "ready_for_payment"),
            },
            data={
                "hasActiveSession": True,
                "session": session.model_dump(),
                "lineItems": [item.model_dump() for item in session.line_items],
                "totals": [t.model_dump() for t in session.totals],
                "fulfillmentOptions": [o.model_dump() for o in session.fulfillment_options],
                "selectedFulfillment": (
                    [o.model_dump() for o in session.selected_fulfillment_options]
                    if session.selected_fulfillment_options
                    else []
                ),
                "discounts": session.discounts.model_dump() if session.discounts else None,
                "messages": [m.model_dump() for m in session.messages],
            },
        )

    except Exception as e:
        logger.warning(f"[CheckoutSessionProvider] Session {session_id} not found: {e}")

        return ProviderResult(
            text="Previous checkout session expired or not found",
            values={
                "hasActiveSession": "false",
                "sessionExpired": "true",
            },
            data={
                "hasActiveSession": False,
                "sessionExpired": True,
                "previousSessionId": session_id,
            },
        )
    finally:
        await client.close()
