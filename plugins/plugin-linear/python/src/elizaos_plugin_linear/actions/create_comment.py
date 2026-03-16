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
from elizaos_plugin_linear.types import LinearCommentInput

logger = logging.getLogger(__name__)

CREATE_COMMENT_TEMPLATE = """Extract comment details from the user's request to add a comment to a Linear issue.

User request: "{user_message}"

Return ONLY a JSON object:
{{
  "issueId": "Direct issue ID if explicitly mentioned (e.g., ENG-123)",
  "issueDescription": "Description/keywords of the issue if no ID provided",
  "commentBody": "The actual comment content to add"
}}

Extract the core message the user wants to convey as the comment body."""


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
            error_message = "Please provide a message with the issue and comment content."
            if callback:
                await callback(
                    {"text": error_message, "source": message.get("content", {}).get("source")}
                )
            return {"text": error_message, "success": False}

        issue_id: str = ""
        comment_body: str = ""

        if options and options.get("issueId") and options.get("body"):
            issue_id = str(options["issueId"])
            comment_body = str(options["body"])
        else:
            prompt = CREATE_COMMENT_TEMPLATE.format(user_message=content)
            response = await runtime.use_model("TEXT_LARGE", {"prompt": prompt})

            if not response:
                issue_match = re.search(
                    r"(?:comment on|add.*comment.*to|reply to|tell)\s+(\w+-\d+):?\s*(.*)",
                    content,
                    re.IGNORECASE,
                )
                if issue_match:
                    issue_id = issue_match.group(1)
                    comment_body = issue_match.group(2).strip()
                else:
                    raise RuntimeError("Could not understand comment request")
            else:
                try:
                    cleaned = re.sub(r"^```(?:json)?\n?", "", response)
                    cleaned = re.sub(r"\n?```$", "", cleaned).strip()
                    parsed = json.loads(cleaned)

                    if parsed.get("issueId"):
                        issue_id = parsed["issueId"]
                        comment_body = parsed.get("commentBody", "")
                    elif parsed.get("issueDescription"):
                        from elizaos_plugin_linear.types import LinearSearchFilters

                        filters = LinearSearchFilters(query=parsed["issueDescription"], limit=5)

                        default_team_key = runtime.get_setting("LINEAR_DEFAULT_TEAM_KEY")
                        if default_team_key:
                            filters.team = default_team_key

                        issues = await linear_service.search_issues(filters)

                        if not issues:
                            error_msg = f'No issues found matching "{parsed["issueDescription"]}". Please provide a specific issue ID.'
                            if callback:
                                await callback(
                                    {
                                        "text": error_msg,
                                        "source": message.get("content", {}).get("source"),
                                    }
                                )
                            return {"text": error_msg, "success": False}

                        if len(issues) == 1:
                            issue_id = issues[0]["identifier"]
                            comment_body = parsed.get("commentBody", "")
                        else:
                            issue_list = [
                                f"{i + 1}. {iss['identifier']}: {iss['title']}"
                                for i, iss in enumerate(issues)
                            ]
                            clarify_msg = (
                                f'Found multiple issues matching "{parsed["issueDescription"]}":\n'
                                + "\n".join(issue_list)
                                + "\n\nPlease specify by ID."
                            )
                            if callback:
                                await callback(
                                    {
                                        "text": clarify_msg,
                                        "source": message.get("content", {}).get("source"),
                                    }
                                )
                            return {
                                "text": clarify_msg,
                                "success": False,
                                "data": {
                                    "multipleMatches": True,
                                    "issues": [
                                        {
                                            "id": i["id"],
                                            "identifier": i["identifier"],
                                            "title": i["title"],
                                        }
                                        for i in issues
                                    ],
                                    "pendingComment": parsed.get("commentBody"),
                                },
                            }
                    else:
                        raise RuntimeError("No issue identifier or description found")

                except json.JSONDecodeError:
                    logger.warning("Failed to parse LLM response, falling back to regex")
                    issue_match = re.search(
                        r"(?:comment on|add.*comment.*to|reply to|tell)\s+(\w+-\d+):?\s*(.*)",
                        content,
                        re.IGNORECASE,
                    )

                    if not issue_match:
                        error_message = 'Please specify the issue ID and comment. Example: "Comment on ENG-123: This looks good"'
                        if callback:
                            await callback(
                                {
                                    "text": error_message,
                                    "source": message.get("content", {}).get("source"),
                                }
                            )
                        return {"text": error_message, "success": False}

                    issue_id = issue_match.group(1)
                    comment_body = issue_match.group(2).strip()

        if not comment_body:
            error_message = "Please provide the comment content."
            if callback:
                await callback(
                    {"text": error_message, "source": message.get("content", {}).get("source")}
                )
            return {"text": error_message, "success": False}

        issue = await linear_service.get_issue(issue_id)

        comment_input = LinearCommentInput(
            issue_id=issue["id"],
            body=comment_body,
        )
        comment = await linear_service.create_comment(comment_input)

        success_message = f'✅ Comment added to issue {issue["identifier"]}: "{comment_body}"'
        if callback:
            await callback(
                {"text": success_message, "source": message.get("content", {}).get("source")}
            )

        return {
            "text": f"Added comment to issue {issue['identifier']}",
            "success": True,
            "data": {
                "commentId": comment["id"],
                "issueId": issue["id"],
                "issueIdentifier": issue["identifier"],
                "commentBody": comment_body,
                "createdAt": comment.get("createdAt"),
            },
        }

    except Exception as error:
        logger.error(f"Failed to create comment: {error}")
        error_message = f"❌ Failed to create comment: {error}"
        if callback:
            await callback(
                {"text": error_message, "source": message.get("content", {}).get("source")}
            )
        return {"text": error_message, "success": False}


create_comment_action = create_action(
    name="CREATE_LINEAR_COMMENT",
    description="Add a comment to a Linear issue",
    similes=["create-linear-comment", "add-linear-comment", "comment-on-linear-issue"],
    examples=[
        [
            ActionExample(
                name="User", content={"text": "Comment on ENG-123: This looks good to me"}
            ),
            ActionExample(
                name="Assistant",
                content={
                    "text": "I'll add your comment to issue ENG-123.",
                    "actions": ["CREATE_LINEAR_COMMENT"],
                },
            ),
        ],
    ],
    validate=validate,
    handler=handler,
)
