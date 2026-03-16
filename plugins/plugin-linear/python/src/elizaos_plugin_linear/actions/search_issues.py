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
from elizaos_plugin_linear.types import LinearSearchFilters

logger = logging.getLogger(__name__)

SEARCH_TEMPLATE = """Extract search criteria from the user's request for Linear issues.

User request: "{user_message}"

Extract and return ONLY a JSON object:
{{
  "query": "General search text for title/description",
  "states": ["state names like In Progress, Done, Todo, Backlog"],
  "assignees": ["assignee names or emails, or 'me' for current user"],
  "priorities": ["urgent/high/normal/low or 1/2/3/4"],
  "teams": ["team names or keys"],
  "labels": ["label names"],
  "limit": number (default 10)
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
            error_message = "Please provide search criteria for issues."
            if callback:
                await callback(
                    {"text": error_message, "source": message.get("content", {}).get("source")}
                )
            return {"text": error_message, "success": False}

        filters = LinearSearchFilters()

        if options and options.get("filters"):
            opt_filters = options["filters"]
            if isinstance(opt_filters, dict):
                filters.query = opt_filters.get("query")
                filters.state = opt_filters.get("state")
                filters.assignee = opt_filters.get("assignee")
                filters.team = opt_filters.get("team")
                filters.priority = opt_filters.get("priority")
                filters.label = opt_filters.get("label")
                filters.limit = opt_filters.get("limit", 10)
        else:
            prompt = SEARCH_TEMPLATE.format(user_message=content)
            response = await runtime.use_model("TEXT_LARGE", {"prompt": prompt})

            if not response:
                filters.query = content
            else:
                try:
                    cleaned = re.sub(r"^```(?:json)?\n?", "", response)
                    cleaned = re.sub(r"\n?```$", "", cleaned).strip()
                    parsed = json.loads(cleaned)

                    filters.query = parsed.get("query")
                    filters.limit = parsed.get("limit", 10)

                    if parsed.get("states"):
                        filters.state = parsed["states"]

                    if parsed.get("assignees"):
                        processed = []
                        for assignee in parsed["assignees"]:
                            if assignee.lower() == "me":
                                try:
                                    current_user = await linear_service.get_current_user()
                                    processed.append(current_user["email"])
                                except Exception:
                                    logger.warning("Could not resolve 'me' to current user")
                            else:
                                processed.append(assignee)
                        if processed:
                            filters.assignee = processed

                    if parsed.get("priorities"):
                        priority_map = {"urgent": 1, "high": 2, "normal": 3, "low": 4}
                        priorities = []
                        for p in parsed["priorities"]:
                            p_lower = str(p).lower()
                            if p_lower in priority_map:
                                priorities.append(priority_map[p_lower])
                            elif p_lower.isdigit():
                                priorities.append(int(p_lower))
                        if priorities:
                            filters.priority = priorities

                    if parsed.get("teams"):
                        filters.team = parsed["teams"][0]

                    if parsed.get("labels"):
                        filters.label = parsed["labels"]

                except json.JSONDecodeError:
                    logger.error("Failed to parse search filters")
                    filters.query = content

        if not filters.team:
            default_team_key = runtime.get_setting("LINEAR_DEFAULT_TEAM_KEY")
            if default_team_key:
                searching_all = "all" in content.lower() and any(
                    kw in content.lower() for kw in ["issue", "bug", "task"]
                )
                if not searching_all:
                    filters.team = default_team_key
                    logger.info(f"Applying default team filter: {default_team_key}")

        if options and options.get("limit"):
            filters.limit = int(options["limit"])

        issues = await linear_service.search_issues(filters)

        if not issues:
            no_results = "No issues found matching your search criteria."
            if callback:
                await callback(
                    {"text": no_results, "source": message.get("content", {}).get("source")}
                )
            return {
                "text": no_results,
                "success": True,
                "data": {"issues": [], "filters": filters.__dict__, "count": 0},
            }

        priority_labels = ["", "Urgent", "High", "Normal", "Low"]

        issue_list = []
        for i, issue in enumerate(issues):
            state = issue.get("state", {})
            assignee = issue.get("assignee", {})
            priority = priority_labels[issue.get("priority", 0)] or "No priority"

            issue_list.append(
                f"{i + 1}. {issue['identifier']}: {issue['title']}\n"
                f"   Status: {state.get('name', 'No state')} | Priority: {priority} | "
                f"Assignee: {assignee.get('name', 'Unassigned') if assignee else 'Unassigned'}"
            )

        result_message = (
            f"📋 Found {len(issues)} issue{'s' if len(issues) != 1 else ''}:\n\n"
            + "\n\n".join(issue_list)
        )
        if callback:
            await callback(
                {"text": result_message, "source": message.get("content", {}).get("source")}
            )

        return {
            "text": f"Found {len(issues)} issue{'s' if len(issues) != 1 else ''}",
            "success": True,
            "data": {
                "issues": issues,
                "filters": filters.__dict__,
                "count": len(issues),
            },
        }

    except Exception as error:
        logger.error(f"Failed to search issues: {error}")
        error_message = f"❌ Failed to search issues: {error}"
        if callback:
            await callback(
                {"text": error_message, "source": message.get("content", {}).get("source")}
            )
        return {"text": error_message, "success": False}


search_issues_action = create_action(
    name="SEARCH_LINEAR_ISSUES",
    description="Search for issues in Linear with various filters",
    similes=["search-linear-issues", "find-linear-issues", "list-linear-issues"],
    examples=[
        [
            ActionExample(name="User", content={"text": "Show me all open bugs"}),
            ActionExample(
                name="Assistant",
                content={
                    "text": "I'll search for all open bug issues.",
                    "actions": ["SEARCH_LINEAR_ISSUES"],
                },
            ),
        ],
    ],
    validate=validate,
    handler=handler,
)
