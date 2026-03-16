"""
ACP Plugin for elizaOS - Python implementation.

Provides checkout and commerce capabilities using the Agentic Commerce Protocol.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from elizaos_plugin_acp.actions import (
    CANCEL_CHECKOUT_SESSION_ACTION,
    COMPLETE_CHECKOUT_SESSION_ACTION,
    CREATE_CHECKOUT_SESSION_ACTION,
    GET_CHECKOUT_SESSION_ACTION,
    UPDATE_CHECKOUT_SESSION_ACTION,
    handle_cancel_checkout_session,
    handle_complete_checkout_session,
    handle_create_checkout_session,
    handle_get_checkout_session,
    handle_update_checkout_session,
    validate_cancel_checkout_session,
    validate_complete_checkout_session,
    validate_create_checkout_session,
    validate_get_checkout_session,
    validate_update_checkout_session,
)
from elizaos_plugin_acp.providers import CHECKOUT_SESSION_PROVIDER, get_checkout_session_context

if TYPE_CHECKING:
    from elizaos.types import Action, ActionResult, Plugin, Provider

logger = logging.getLogger(__name__)


def _wrap_action(
    spec: dict[str, object],
    validate_fn,  # noqa: ANN001
    handler_fn,  # noqa: ANN001
) -> "Action":
    """Wrap action spec and handlers into an Action object."""
    from elizaos.types import Action, ActionResult

    name = str(spec.get("name", ""))
    description = str(spec.get("description", ""))
    similes_obj = spec.get("similes")
    similes = (
        [s for s in similes_obj if isinstance(s, str)] if isinstance(similes_obj, list) else None
    )
    examples = spec.get("examples")

    async def handler(runtime, message, state, options, callback, responses) -> ActionResult | None:  # noqa: ANN001
        res = await handler_fn(runtime, message, state, options, callback, responses)
        if res is None:
            return None
        return ActionResult(
            success=bool(getattr(res, "success", False)),
            text=getattr(res, "text", None),
            error=getattr(res, "error", None),
            data={
                **(getattr(res, "data", {}) if isinstance(getattr(res, "data", {}), dict) else {}),
                "actionName": name,
            },
        )

    return Action(
        name=name,
        description=description,
        similes=similes,
        examples=examples,
        validate=validate_fn,
        handler=handler,
    )


def _wrap_provider(
    spec: dict[str, object],
    get_fn,  # noqa: ANN001
) -> "Provider":
    """Wrap provider spec and handler into a Provider object."""
    from elizaos.types import Provider, ProviderResult

    name = str(spec.get("name", ""))
    description = str(spec.get("description", ""))

    async def get(runtime, message, state) -> ProviderResult:  # noqa: ANN001
        result = await get_fn(runtime, message, state)
        return ProviderResult(
            text=result.text,
            values=result.values,
            data=result.data,
        )

    return Provider(
        name=name,
        description=description,
        get=get,
    )


async def init_acp_plugin(config, runtime) -> None:  # noqa: ANN001
    """Initialize the ACP plugin."""
    import os

    base_url = os.environ.get("ACP_MERCHANT_BASE_URL")

    if base_url:
        logger.info(f"[AcpPlugin] Initialized with merchant URL: {base_url}")
    else:
        logger.warning(
            "[AcpPlugin] ACP_MERCHANT_BASE_URL not set - checkout actions will not be available"
        )

    logger.info("[AcpPlugin] Plugin initialized")


# Create the plugin
try:
    from elizaos.types import Plugin

    acp_plugin = Plugin(
        name="@elizaos/plugin-acp",
        description=(
            "Agentic Commerce Protocol plugin - enables AI agents to interact with "
            "merchants for checkout and commerce (Python runtime)"
        ),
        init=init_acp_plugin,
        actions=[
            _wrap_action(
                CREATE_CHECKOUT_SESSION_ACTION,
                validate_create_checkout_session,
                handle_create_checkout_session,
            ),
            _wrap_action(
                UPDATE_CHECKOUT_SESSION_ACTION,
                validate_update_checkout_session,
                handle_update_checkout_session,
            ),
            _wrap_action(
                COMPLETE_CHECKOUT_SESSION_ACTION,
                validate_complete_checkout_session,
                handle_complete_checkout_session,
            ),
            _wrap_action(
                CANCEL_CHECKOUT_SESSION_ACTION,
                validate_cancel_checkout_session,
                handle_cancel_checkout_session,
            ),
            _wrap_action(
                GET_CHECKOUT_SESSION_ACTION,
                validate_get_checkout_session,
                handle_get_checkout_session,
            ),
        ],
        providers=[
            _wrap_provider(CHECKOUT_SESSION_PROVIDER, get_checkout_session_context),
        ],
    )
except ImportError:
    # elizaos not installed, create a minimal placeholder
    acp_plugin = None  # type: ignore[assignment]
    logger.debug("[AcpPlugin] elizaos not installed, plugin object not created")
