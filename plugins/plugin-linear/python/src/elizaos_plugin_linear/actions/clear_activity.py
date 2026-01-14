import logging
from typing import Any

from elizaos_plugin_linear.actions.base import (
    ActionExample,
    ActionResult,
    HandlerCallback,
    Memory,
    RuntimeProtocol,
    State,
    create_action,
)
from elizaos_plugin_linear.services.linear import LinearService

logger = logging.getLogger(__name__)


async def validate(
    runtime: RuntimeProtocol,
    _message: Memory,
    _state: State | None = None,
) -> bool:
    try:
        api_key = runtime.get_setting("LINEAR_API_KEY")
        return bool(api_key)
    except Exception:
        return False


async def handler(
    runtime: RuntimeProtocol,
    message: Memory,
    _state: State | None = None,
    options: dict[str, Any] | None = None,
    callback: HandlerCallback | None = None,
) -> ActionResult:
    try:
        linear_service: LinearService = runtime.get_service("linear")
        if not linear_service:
            raise RuntimeError("Linear service not available")

        linear_service.clear_activity_log()

        success_message = "✅ Linear activity log has been cleared."
        if callback:
            await callback(
                {"text": success_message, "source": message.get("content", {}).get("source")}
            )

        return {"text": success_message, "success": True}

    except Exception as error:
        logger.error(f"Failed to clear Linear activity: {error}")
        error_message = f"❌ Failed to clear Linear activity: {error}"
        if callback:
            await callback(
                {"text": error_message, "source": message.get("content", {}).get("source")}
            )
        return {"text": error_message, "success": False}


clear_activity_action = create_action(
    name="CLEAR_LINEAR_ACTIVITY",
    description="Clear the Linear activity log",
    similes=["clear-linear-activity", "reset-linear-activity", "delete-linear-activity"],
    examples=[
        [
            ActionExample(name="User", content={"text": "Clear the Linear activity log"}),
            ActionExample(
                name="Assistant",
                content={
                    "text": "I'll clear the Linear activity log.",
                    "actions": ["CLEAR_LINEAR_ACTIVITY"],
                },
            ),
        ],
    ],
    validate=validate,
    handler=handler,
)
