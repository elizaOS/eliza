import json
import logging
import re
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

DELETE_ISSUE_TEMPLATE = """Given the user's request to delete/archive a Linear issue, extract the issue identifier.

User request: "{user_message}"

Extract and return ONLY a JSON object:
{{
  "issueId": "The issue identifier (e.g., ENG-123, COM2-7)"
}}

Return only the JSON object, no other text."""


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
        if not content:
            error_message = "Please specify which issue to delete."
            if callback:
                await callback(
                    {"text": error_message, "source": message.get("content", {}).get("source")}
                )
            return {"text": error_message, "success": False}

        issue_id: str = ""

        if options and options.get("issueId"):
            issue_id = str(options["issueId"])
        else:
            prompt = DELETE_ISSUE_TEMPLATE.format(user_message=content)
            response = await runtime.use_model("TEXT_LARGE", {"prompt": prompt})

            if not response:
                raise RuntimeError("Failed to extract issue identifier")

            try:
                cleaned = re.sub(r"^```(?:json)?\n?", "", response)
                cleaned = re.sub(r"\n?```$", "", cleaned).strip()
                parsed = json.loads(cleaned)

                issue_id = parsed.get("issueId", "")
                if not issue_id:
                    raise ValueError("Issue ID not found")

            except json.JSONDecodeError:
                logger.warning("Failed to parse LLM response, falling back to regex")

                issue_match = re.search(r"(\w+-\d+)", content)
                if not issue_match:
                    error_message = "Please specify an issue ID (e.g., ENG-123) to delete."
                    if callback:
                        await callback(
                            {
                                "text": error_message,
                                "source": message.get("content", {}).get("source"),
                            }
                        )
                    return {"text": error_message, "success": False}

                issue_id = issue_match.group(1)

        issue = await linear_service.get_issue(issue_id)
        issue_title = issue.get("title", "Unknown")
        issue_identifier = issue.get("identifier", issue_id)

        logger.info(f"Archiving issue {issue_identifier}: {issue_title}")

        await linear_service.delete_issue(issue_id)

        success_message = f'✅ Successfully archived issue {issue_identifier}: "{issue_title}"\n\nThe issue has been moved to the archived state.'
        if callback:
            await callback(
                {"text": success_message, "source": message.get("content", {}).get("source")}
            )

        return {
            "text": f'Archived issue {issue_identifier}: "{issue_title}"',
            "success": True,
            "data": {
                "issueId": issue.get("id"),
                "identifier": issue_identifier,
                "title": issue_title,
                "archived": True,
            },
        }

    except Exception as error:
        logger.error(f"Failed to delete issue: {error}")
        error_message = f"❌ Failed to delete issue: {error}"
        if callback:
            await callback(
                {"text": error_message, "source": message.get("content", {}).get("source")}
            )
        return {"text": error_message, "success": False}


delete_issue_action = create_action(
    name="DELETE_LINEAR_ISSUE",
    description="Delete (archive) an issue in Linear",
    similes=["delete-linear-issue", "archive-linear-issue", "remove-linear-issue"],
    examples=[
        [
            ActionExample(name="User", content={"text": "Delete issue ENG-123"}),
            ActionExample(
                name="Assistant",
                content={
                    "text": "I'll archive issue ENG-123 for you.",
                    "actions": ["DELETE_LINEAR_ISSUE"],
                },
            ),
        ],
    ],
    validate=validate,
    handler=handler,
)
