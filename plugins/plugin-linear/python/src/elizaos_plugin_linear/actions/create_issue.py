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
from elizaos_plugin_linear.types import LinearIssueInput

logger = logging.getLogger(__name__)

CREATE_ISSUE_TEMPLATE = """Given the user's request, extract the information needed to create a Linear issue.

User request: "{user_message}"

Extract and return ONLY a JSON object (no markdown formatting, no code blocks) with the following structure:
{{
  "title": "Brief, clear issue title",
  "description": "Detailed description of the issue (optional, omit or use null if not provided)",
  "teamKey": "Team key if mentioned (e.g., ENG, PROD) - omit or use null if not mentioned",
  "priority": "Priority level if mentioned (1=urgent, 2=high, 3=normal, 4=low) - omit or use null if not mentioned",
  "labels": ["label1", "label2"] (if any labels are mentioned, empty array if none),
  "assignee": "Assignee username or email if mentioned - omit or use null if not mentioned"
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
            error_message = "Please provide a description for the issue."
            if callback:
                await callback(
                    {"text": error_message, "source": message.get("content", {}).get("source")}
                )
            return {"text": error_message, "success": False}

        structured_data = options.get("issueData") if options else None

        if structured_data:
            issue_data = structured_data
        else:
            prompt = CREATE_ISSUE_TEMPLATE.format(user_message=content)
            response = await runtime.use_model("TEXT_LARGE", {"prompt": prompt})

            if not response:
                raise RuntimeError("Failed to extract issue information")

            try:
                cleaned = re.sub(r"^```(?:json)?\n?", "", response)
                cleaned = re.sub(r"\n?```$", "", cleaned).strip()
                parsed = json.loads(cleaned)

                issue_data: dict[str, Any] = {
                    "title": parsed.get("title"),
                    "description": parsed.get("description"),
                    "priority": int(parsed["priority"]) if parsed.get("priority") else None,
                }

                # Handle team assignment
                if parsed.get("teamKey"):
                    teams = await linear_service.get_teams()
                    team = next(
                        (t for t in teams if t["key"].lower() == parsed["teamKey"].lower()), None
                    )
                    if team:
                        issue_data["team_id"] = team["id"]

                if parsed.get("assignee"):
                    clean_assignee = parsed["assignee"].lstrip("@")
                    users = await linear_service.get_users()
                    user = next(
                        (
                            u
                            for u in users
                            if u["email"] == clean_assignee
                            or clean_assignee.lower() in u["name"].lower()
                        ),
                        None,
                    )
                    if user:
                        issue_data["assignee_id"] = user["id"]

                if parsed.get("labels") and isinstance(parsed["labels"], list):
                    labels = await linear_service.get_labels(issue_data.get("team_id"))
                    label_ids = []
                    for label_name in parsed["labels"]:
                        if label_name:
                            label = next(
                                (
                                    lbl
                                    for lbl in labels
                                    if lbl["name"].lower() == label_name.lower()
                                ),
                                None,
                            )
                            if label:
                                label_ids.append(label["id"])
                    if label_ids:
                        issue_data["label_ids"] = label_ids

                if not issue_data.get("team_id"):
                    default_team_key = runtime.get_setting("LINEAR_DEFAULT_TEAM_KEY")
                    if default_team_key:
                        teams = await linear_service.get_teams()
                        default_team = next(
                            (t for t in teams if t["key"].lower() == default_team_key.lower()), None
                        )
                        if default_team:
                            issue_data["team_id"] = default_team["id"]

                    if not issue_data.get("team_id"):
                        teams = await linear_service.get_teams()
                        if teams:
                            issue_data["team_id"] = teams[0]["id"]

            except json.JSONDecodeError as parse_error:
                logger.error(f"Failed to parse LLM response: {parse_error}")
                issue_data = {
                    "title": content[:100] + "..." if len(content) > 100 else content,
                    "description": content,
                }

                teams = await linear_service.get_teams()
                default_team_key = runtime.get_setting("LINEAR_DEFAULT_TEAM_KEY")

                if default_team_key:
                    default_team = next(
                        (t for t in teams if t["key"].lower() == default_team_key.lower()), None
                    )
                    if default_team:
                        issue_data["team_id"] = default_team["id"]

                if not issue_data.get("team_id") and teams:
                    issue_data["team_id"] = teams[0]["id"]

        if not issue_data.get("title"):
            error_message = "Could not determine issue title. Please provide more details."
            if callback:
                await callback(
                    {"text": error_message, "source": message.get("content", {}).get("source")}
                )
            return {"text": error_message, "success": False}

        if not issue_data.get("team_id"):
            error_message = "No Linear teams found. Please ensure at least one team exists."
            if callback:
                await callback(
                    {"text": error_message, "source": message.get("content", {}).get("source")}
                )
            return {"text": error_message, "success": False}

        issue_input = LinearIssueInput(
            title=issue_data["title"],
            team_id=issue_data["team_id"],
            description=issue_data.get("description"),
            priority=issue_data.get("priority"),
            assignee_id=issue_data.get("assignee_id"),
            label_ids=issue_data.get("label_ids", []),
        )

        issue = await linear_service.create_issue(issue_input)

        success_message = f"✅ Created Linear issue: {issue['title']} ({issue['identifier']})\n\nView it at: {issue['url']}"
        if callback:
            await callback(
                {"text": success_message, "source": message.get("content", {}).get("source")}
            )

        return {
            "text": f"Created issue: {issue['title']} ({issue['identifier']})",
            "success": True,
            "data": {
                "issueId": issue["id"],
                "identifier": issue["identifier"],
                "url": issue["url"],
            },
        }

    except Exception as error:
        logger.error(f"Failed to create issue: {error}")
        error_message = f"❌ Failed to create issue: {error}"
        if callback:
            await callback(
                {"text": error_message, "source": message.get("content", {}).get("source")}
            )
        return {"text": error_message, "success": False}


create_issue_action = create_action(
    name="CREATE_LINEAR_ISSUE",
    description="Create a new issue in Linear",
    similes=["create-linear-issue", "new-linear-issue", "add-linear-issue"],
    examples=[
        [
            ActionExample(
                name="User",
                content={
                    "text": "Create a new issue: Fix login button not working on mobile devices"
                },
            ),
            ActionExample(
                name="Assistant",
                content={
                    "text": "I'll create that issue for you in Linear.",
                    "actions": ["CREATE_LINEAR_ISSUE"],
                },
            ),
        ],
        [
            ActionExample(
                name="User",
                content={"text": "Create a bug report for the ENG team: API returns 500 error"},
            ),
            ActionExample(
                name="Assistant",
                content={
                    "text": "I'll create a bug report for the engineering team.",
                    "actions": ["CREATE_LINEAR_ISSUE"],
                },
            ),
        ],
    ],
    validate=validate,
    handler=handler,
)
