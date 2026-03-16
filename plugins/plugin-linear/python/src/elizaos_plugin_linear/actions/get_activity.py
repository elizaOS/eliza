import json
import logging
import re
from datetime import datetime, timedelta
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

GET_ACTIVITY_TEMPLATE = """Extract activity filter criteria from the user's request.

User request: "{user_message}"

Return ONLY a JSON object:
{{
  "timeRange": {{
    "period": "today/yesterday/this-week/last-week/this-month"
  }},
  "actionTypes": ["create_issue/update_issue/delete_issue/create_comment/etc"],
  "resourceTypes": ["issue/project/comment/team"],
  "resourceId": "Specific resource ID if mentioned (e.g., ENG-123)",
  "successFilter": "success/failed/all",
  "limit": number (default 10)
}}

Only include fields that are clearly mentioned."""


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

        content = message.get("content", {}).get("text", "")
        filters: dict[str, Any] = {}
        limit = 10

        if content:
            prompt = GET_ACTIVITY_TEMPLATE.format(user_message=content)
            response = await runtime.use_model("TEXT_LARGE", {"prompt": prompt})

            if response:
                try:
                    cleaned = re.sub(r"^```(?:json)?\n?", "", response)
                    cleaned = re.sub(r"\n?```$", "", cleaned).strip()
                    parsed = json.loads(cleaned)

                    if parsed.get("timeRange"):
                        period = parsed["timeRange"].get("period")
                        now = datetime.now()
                        from_date: datetime | None = None

                        if period == "today":
                            from_date = now.replace(hour=0, minute=0, second=0, microsecond=0)
                        elif period == "yesterday":
                            from_date = (now - timedelta(days=1)).replace(
                                hour=0, minute=0, second=0, microsecond=0
                            )
                        elif period == "this-week":
                            from_date = (now - timedelta(days=now.weekday())).replace(
                                hour=0, minute=0, second=0, microsecond=0
                            )
                        elif period == "last-week":
                            from_date = (now - timedelta(days=now.weekday() + 7)).replace(
                                hour=0, minute=0, second=0, microsecond=0
                            )
                        elif period == "this-month":
                            from_date = now.replace(
                                day=1, hour=0, minute=0, second=0, microsecond=0
                            )

                        if from_date:
                            filters["fromDate"] = from_date.isoformat()

                    if parsed.get("actionTypes"):
                        filters["action"] = parsed["actionTypes"][0]

                    if parsed.get("resourceTypes"):
                        filters["resource_type"] = parsed["resourceTypes"][0]

                    if parsed.get("resourceId"):
                        filters["resource_id"] = parsed["resourceId"]

                    if parsed.get("successFilter") and parsed["successFilter"] != "all":
                        filters["success"] = parsed["successFilter"] == "success"

                    limit = parsed.get("limit", 10)

                except json.JSONDecodeError:
                    logger.warning("Failed to parse activity filters")

        activity = linear_service.get_activity_log(limit * 2, filters if filters else None)

        if filters.get("fromDate"):
            from_time = datetime.fromisoformat(filters["fromDate"])
            activity = [
                item
                for item in activity
                if datetime.fromisoformat(
                    item.timestamp.replace("Z", "+00:00").replace("+00:00", "")
                )
                >= from_time
            ]

        activity = activity[:limit]

        if not activity:
            no_activity_msg = (
                "No Linear activity found for the specified filters."
                if filters.get("fromDate")
                else "No recent Linear activity found."
            )
            if callback:
                await callback(
                    {"text": no_activity_msg, "source": message.get("content", {}).get("source")}
                )
            return {"text": no_activity_msg, "success": True, "data": {"activity": []}}

        activity_text = []
        for i, item in enumerate(activity):
            time_str = datetime.fromisoformat(item.timestamp.replace("Z", "")).strftime(
                "%Y-%m-%d %H:%M"
            )
            status = "✅" if item.success else "❌"

            details_str = ", ".join(f"{k}: {v}" for k, v in item.details.items() if k != "filters")

            error_line = f"\n   Error: {item.error}" if item.error else ""
            details_line = f"Details: {details_str}" if details_str else ""
            activity_text.append(
                f"{i + 1}. {status} {item.action} on {item.resource_type} {item.resource_id}\n"
                f"   Time: {time_str}\n"
                f"   {details_line}{error_line}"
            )

        header_text = (
            f"📊 Linear activity {content}:"
            if filters.get("fromDate")
            else "📊 Recent Linear activity:"
        )

        result_message = f"{header_text}\n\n" + "\n\n".join(activity_text)
        if callback:
            await callback(
                {"text": result_message, "source": message.get("content", {}).get("source")}
            )

        return {
            "text": f"Found {len(activity)} activity item{'s' if len(activity) != 1 else ''}",
            "success": True,
            "data": {
                "activity": [
                    {
                        "id": item.id,
                        "timestamp": item.timestamp,
                        "action": item.action,
                        "resource_type": item.resource_type,
                        "resource_id": item.resource_id,
                        "success": item.success,
                        "error": item.error,
                    }
                    for item in activity
                ],
                "filters": filters,
                "count": len(activity),
            },
        }

    except Exception as error:
        logger.error(f"Failed to get activity: {error}")
        error_message = f"❌ Failed to get activity: {error}"
        if callback:
            await callback(
                {"text": error_message, "source": message.get("content", {}).get("source")}
            )
        return {"text": error_message, "success": False}


get_activity_action = create_action(
    name="GET_LINEAR_ACTIVITY",
    description="Get recent Linear activity log with optional filters",
    similes=["get-linear-activity", "show-linear-activity", "view-linear-activity"],
    examples=[
        [
            ActionExample(name="User", content={"text": "Show me recent Linear activity"}),
            ActionExample(
                name="Assistant",
                content={
                    "text": "I'll show you the recent Linear activity.",
                    "actions": ["GET_LINEAR_ACTIVITY"],
                },
            ),
        ],
    ],
    validate=validate,
    handler=handler,
)
