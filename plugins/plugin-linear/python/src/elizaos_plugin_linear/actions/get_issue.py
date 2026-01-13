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

GET_ISSUE_TEMPLATE = """Extract issue identification from the user's request.

User request: "{user_message}"

The user might reference an issue by:
- Direct ID (e.g., "ENG-123", "COM2-7")
- Title keywords (e.g., "the login bug", "that payment issue")
- Assignee (e.g., "John's high priority task")
- Recency (e.g., "the latest bug", "most recent issue")

Return ONLY a JSON object:
{{
  "directId": "Issue ID if explicitly mentioned (e.g., ENG-123)",
  "searchBy": {{
    "title": "Keywords from issue title if mentioned",
    "assignee": "Name/email of assignee if mentioned",
    "priority": "Priority level if mentioned (urgent/high/normal/low or 1-4)",
    "team": "Team name or key if mentioned",
    "state": "Issue state if mentioned (todo/in-progress/done)",
    "recency": "latest/newest/recent/last if mentioned"
  }}
}}

Only include fields that are clearly mentioned or implied."""


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


async def format_issue_response(
    issue: dict[str, Any],
    callback: HandlerCallback | None,
    message: Memory,
) -> ActionResult:
    assignee = issue.get("assignee")
    state = issue.get("state")
    team = issue.get("team")
    labels = issue.get("labels", {}).get("nodes", [])
    project = issue.get("project")

    priority_labels = ["", "Urgent", "High", "Normal", "Low"]
    priority = priority_labels[issue.get("priority", 0)] or "No priority"

    label_text = f"Labels: {', '.join(lbl['name'] for lbl in labels)}" if labels else ""

    issue_message = f"""📋 **{issue["identifier"]}: {issue["title"]}**

Status: {state["name"] if state else "No status"}
Priority: {priority}
Team: {team["name"] if team else "No team"}
Assignee: {assignee["name"] if assignee else "Unassigned"}
{label_text}
{f"Project: {project['name']}" if project else ""}

{issue.get("description") or "No description"}

View in Linear: {issue["url"]}"""

    if callback:
        await callback({"text": issue_message, "source": message.get("content", {}).get("source")})

    return {
        "text": f"Retrieved issue {issue['identifier']}: {issue['title']}",
        "success": True,
        "data": {"issue": issue},
    }


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
            error_message = "Please specify which issue you want to see."
            if callback:
                await callback(
                    {"text": error_message, "source": message.get("content", {}).get("source")}
                )
            return {"text": error_message, "success": False}

        prompt = GET_ISSUE_TEMPLATE.format(user_message=content)
        response = await runtime.use_model("TEXT_LARGE", {"prompt": prompt})

        if not response:
            # Fallback to regex
            issue_match = re.search(r"(\w+-\d+)", content)
            if issue_match:
                issue = await linear_service.get_issue(issue_match.group(1))
                return await format_issue_response(issue, callback, message)
            raise RuntimeError("Could not understand issue reference")

        try:
            cleaned = re.sub(r"^```(?:json)?\n?", "", response)
            cleaned = re.sub(r"\n?```$", "", cleaned).strip()
            parsed = json.loads(cleaned)

            if parsed.get("directId"):
                issue = await linear_service.get_issue(parsed["directId"])
                return await format_issue_response(issue, callback, message)

            search_by = parsed.get("searchBy", {})
            if search_by:
                from elizaos_plugin_linear.types import LinearSearchFilters

                filters = LinearSearchFilters()

                if search_by.get("title"):
                    filters.query = search_by["title"]
                if search_by.get("assignee"):
                    filters.assignee = [search_by["assignee"]]
                if search_by.get("priority"):
                    priority_map = {"urgent": 1, "high": 2, "normal": 3, "low": 4}
                    p = search_by["priority"].lower()
                    if p in priority_map:
                        filters.priority = [priority_map[p]]
                if search_by.get("team"):
                    filters.team = search_by["team"]
                if search_by.get("state"):
                    filters.state = [search_by["state"]]

                default_team_key = runtime.get_setting("LINEAR_DEFAULT_TEAM_KEY")
                if default_team_key and not filters.team:
                    filters.team = default_team_key

                filters.limit = 10 if search_by.get("recency") else 5

                issues = await linear_service.search_issues(filters)

                if not issues:
                    no_results = "No issues found matching your criteria."
                    if callback:
                        await callback(
                            {"text": no_results, "source": message.get("content", {}).get("source")}
                        )
                    return {"text": no_results, "success": False}

                if search_by.get("recency"):
                    issues.sort(key=lambda x: x.get("createdAt", ""), reverse=True)
                    return await format_issue_response(issues[0], callback, message)

                if len(issues) == 1:
                    return await format_issue_response(issues[0], callback, message)

                issue_list = [
                    f"{i + 1}. {iss['identifier']}: {iss['title']} ({iss.get('state', {}).get('name', 'No state')})"
                    for i, iss in enumerate(issues[:5])
                ]

                clarify_msg = (
                    f"Found {len(issues)} issues:\n"
                    + "\n".join(issue_list)
                    + "\n\nPlease specify by ID."
                )
                if callback:
                    await callback(
                        {"text": clarify_msg, "source": message.get("content", {}).get("source")}
                    )

                return {
                    "text": clarify_msg,
                    "success": True,
                    "data": {"multipleResults": True, "issues": issues[:5]},
                }

        except json.JSONDecodeError:
            issue_match = re.search(r"(\w+-\d+)", content)
            if issue_match:
                issue = await linear_service.get_issue(issue_match.group(1))
                return await format_issue_response(issue, callback, message)

        error_message = (
            "Could not understand which issue you want to see. Please provide an issue ID."
        )
        if callback:
            await callback(
                {"text": error_message, "source": message.get("content", {}).get("source")}
            )
        return {"text": error_message, "success": False}

    except Exception as error:
        logger.error(f"Failed to get issue: {error}")
        error_message = f"❌ Failed to get issue: {error}"
        if callback:
            await callback(
                {"text": error_message, "source": message.get("content", {}).get("source")}
            )
        return {"text": error_message, "success": False}


get_issue_action = create_action(
    name="GET_LINEAR_ISSUE",
    description="Get details of a specific Linear issue",
    similes=["get-linear-issue", "show-linear-issue", "view-linear-issue"],
    examples=[
        [
            ActionExample(name="User", content={"text": "Show me issue ENG-123"}),
            ActionExample(
                name="Assistant",
                content={
                    "text": "I'll get the details for issue ENG-123.",
                    "actions": ["GET_LINEAR_ISSUE"],
                },
            ),
        ],
    ],
    validate=validate,
    handler=handler,
)
