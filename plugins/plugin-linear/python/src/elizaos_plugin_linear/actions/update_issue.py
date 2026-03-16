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

UPDATE_ISSUE_TEMPLATE = """Given the user's request to update a Linear issue, extract the information needed.

User request: "{user_message}"

Extract and return ONLY a JSON object:
{{
  "issueId": "The issue identifier (e.g., ENG-123, COM2-7)",
  "updates": {{
    "title": "New title if changing the title",
    "description": "New description if changing the description",
    "priority": "Priority level if changing (1=urgent, 2=high, 3=normal, 4=low)",
    "teamKey": "New team key if moving to another team (e.g., ENG, ELIZA)",
    "assignee": "New assignee username or email if changing",
    "status": "New status if changing (e.g., todo, in-progress, done)",
    "labels": ["label1", "label2"] (if changing labels)
  }}
}}

Only include fields that are being updated."""


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
            error_message = "Please provide update instructions for the issue."
            if callback:
                await callback(
                    {"text": error_message, "source": message.get("content", {}).get("source")}
                )
            return {"text": error_message, "success": False}

        prompt = UPDATE_ISSUE_TEMPLATE.format(user_message=content)
        response = await runtime.use_model("TEXT_LARGE", {"prompt": prompt})

        if not response:
            raise RuntimeError("Failed to extract update information")

        issue_id: str = ""
        updates: dict[str, Any] = {}

        try:
            cleaned = re.sub(r"^```(?:json)?\n?", "", response)
            cleaned = re.sub(r"\n?```$", "", cleaned).strip()
            parsed = json.loads(cleaned)

            issue_id = parsed.get("issueId", "")
            if not issue_id:
                raise ValueError("Issue ID not found")

            parsed_updates = parsed.get("updates", {})

            if parsed_updates.get("title"):
                updates["title"] = parsed_updates["title"]
            if parsed_updates.get("description"):
                updates["description"] = parsed_updates["description"]
            if parsed_updates.get("priority"):
                updates["priority"] = int(parsed_updates["priority"])

            if parsed_updates.get("teamKey"):
                teams = await linear_service.get_teams()
                team = next(
                    (t for t in teams if t["key"].lower() == parsed_updates["teamKey"].lower()),
                    None,
                )
                if team:
                    updates["teamId"] = team["id"]

            if parsed_updates.get("assignee"):
                clean_assignee = parsed_updates["assignee"].lstrip("@")
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
                    updates["assigneeId"] = user["id"]

            if parsed_updates.get("status"):
                issue = await linear_service.get_issue(issue_id)
                team = issue.get("team")
                team_id = updates.get("teamId") or (team["id"] if team else None)

                if team_id:
                    states = await linear_service.get_workflow_states(team_id)
                    state = next(
                        (
                            s
                            for s in states
                            if s["name"].lower() == parsed_updates["status"].lower()
                            or s["type"].lower() == parsed_updates["status"].lower()
                        ),
                        None,
                    )
                    if state:
                        updates["stateId"] = state["id"]

            if parsed_updates.get("labels") and isinstance(parsed_updates["labels"], list):
                team_id = updates.get("teamId")
                labels = await linear_service.get_labels(team_id)
                label_ids = []

                for label_name in parsed_updates["labels"]:
                    if label_name:
                        label = next(
                            (lbl for lbl in labels if lbl["name"].lower() == label_name.lower()),
                            None,
                        )
                        if label:
                            label_ids.append(label["id"])

                updates["labelIds"] = label_ids

        except json.JSONDecodeError:
            logger.warning("Failed to parse LLM response, falling back to regex")

            issue_match = re.search(r"(\w+-\d+)", content)
            if not issue_match:
                error_message = "Please specify an issue ID (e.g., ENG-123) to update."
                if callback:
                    await callback(
                        {"text": error_message, "source": message.get("content", {}).get("source")}
                    )
                return {"text": error_message, "success": False}

            issue_id = issue_match.group(1)

            title_match = re.search(r'title to ["\'](.+?)["\']', content, re.IGNORECASE)
            if title_match:
                updates["title"] = title_match.group(1)

            priority_match = re.search(r"priority (?:to |as )?(\w+)", content, re.IGNORECASE)
            if priority_match:
                priority_map = {"urgent": 1, "high": 2, "normal": 3, "medium": 3, "low": 4}
                p = priority_match.group(1).lower()
                if p in priority_map:
                    updates["priority"] = priority_map[p]

        if not updates:
            error_message = "No valid updates found. Please specify what to update."
            if callback:
                await callback(
                    {"text": error_message, "source": message.get("content", {}).get("source")}
                )
            return {"text": error_message, "success": False}

        updated_issue = await linear_service.update_issue(issue_id, updates)

        update_summary = []
        if updates.get("title"):
            update_summary.append(f'title: "{updates["title"]}"')
        if updates.get("priority"):
            priorities = ["", "urgent", "high", "normal", "low"]
            update_summary.append(f"priority: {priorities[updates['priority']]}")
        if updates.get("teamId"):
            update_summary.append("moved to team")
        if updates.get("assigneeId"):
            update_summary.append("assigned to user")
        if updates.get("stateId"):
            update_summary.append("status changed")
        if updates.get("labelIds"):
            update_summary.append("labels updated")

        success_message = f"✅ Updated issue {updated_issue['identifier']}: {', '.join(update_summary)}\n\nView it at: {updated_issue['url']}"
        if callback:
            await callback(
                {"text": success_message, "source": message.get("content", {}).get("source")}
            )

        return {
            "text": f"Updated issue {updated_issue['identifier']}: {', '.join(update_summary)}",
            "success": True,
            "data": {
                "issueId": updated_issue["id"],
                "identifier": updated_issue["identifier"],
                "updates": updates,
                "url": updated_issue["url"],
            },
        }

    except Exception as error:
        logger.error(f"Failed to update issue: {error}")
        error_message = f"❌ Failed to update issue: {error}"
        if callback:
            await callback(
                {"text": error_message, "source": message.get("content", {}).get("source")}
            )
        return {"text": error_message, "success": False}


update_issue_action = create_action(
    name="UPDATE_LINEAR_ISSUE",
    description="Update an existing Linear issue",
    similes=["update-linear-issue", "edit-linear-issue", "modify-linear-issue"],
    examples=[
        [
            ActionExample(
                name="User", content={"text": 'Update issue ENG-123 title to "Fix login button"'}
            ),
            ActionExample(
                name="Assistant",
                content={
                    "text": "I'll update the title of issue ENG-123.",
                    "actions": ["UPDATE_LINEAR_ISSUE"],
                },
            ),
        ],
    ],
    validate=validate,
    handler=handler,
)
